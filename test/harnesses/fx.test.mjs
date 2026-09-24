import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fxHarness } from "../../src/harnesses/fx/index.mjs";
import { prepareFxHome } from "../../src/harnesses/fx/home.mjs";
import { permissionVerdict } from "../../src/harnesses/fx/permissions.mjs";
import { canonicalRequestUsage } from "../../src/harnesses/fx/usage-proxy.mjs";
import { normalizeProviderResult, providerCommand } from "../../src/harnesses/index.mjs";
import { liveSessionMetrics } from "../../src/harnesses/session-metrics.mjs";
import { writeExecutable } from "../write-executable.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "..", "src", "harnesses", "fx", "runner.mjs");
const DONE = JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] });

/** @param {Record<string, unknown>} [patch] */
function runtime(patch = {}) {
  return { id: "fx", harness: "fx", model: "deepseek-flash", executable: "fx", vendor: "deepseek", ...patch };
}

/** @param {string} prefix */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A stand-in for `fx acp`: it reads the provider connection the runner wrote
 * into `$HOME/.fx/settings.json`, sends one Chat Completions request through
 * it, asks permission for one file mutation at `path`, and reports the
 * permission outcome in its final message.
 *
 * @param {string} path the file the fake mutation names
 * @returns {string}
 */
function fakeFx(path) {
  return writeExecutable(join(scratch("runner-fake-fx-"), "fake-fx.mjs"), `import { readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("0.0.11"); process.exit(0); }
const settings = JSON.parse(readFileSync(join(process.env.HOME, ".fx", "settings.json"), "utf8"));
const connection = settings.providers[settings.provider];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
let buffered = "";
let promptId = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\\n");
  buffered = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1" } });
    if (message.method === "session/prompt") {
      promptId = message.id;
      const response = await fetch(connection.base_url + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + process.env[connection.auth.env], "content-type": "application/json" },
        body: JSON.stringify({ model: settings.models[settings.provider], stream: true, messages: [] }),
      });
      await response.text();
      if (!response.ok) { send({ jsonrpc: "2.0", id: promptId, error: { code: -32603, message: "provider error" } }); continue; }
      const toolCall = { toolCallId: "t1", title: "file_mutation", kind: "edit", rawInput: { path: ${JSON.stringify(path)}, content: "x" } };
      update("s1", { sessionUpdate: "tool_call", ...toolCall });
      send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "s1", toolCall,
        options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
    }
    if (message.id === 99) {
      update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission " + message.result.outcome.optionId + " " } });
      update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(DONE)} } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
    }
  }
});
`);
}

/**
 * A Chat Completions endpoint on loopback that streams one answer with the
 * usage frame DeepSeek sends, or refuses with `status`.
 *
 * @param {number} status
 * @returns {Promise<{url: string, authorization: () => string|undefined, close: () => void}>}
 */
async function fakeUpstream(status) {
  /** @type {string|undefined} */
  let authorization;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    req.resume();
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${address.port}`, authorization: () => authorization, close: () => server.close() };
}

/**
 * @param {{path: string, status: number, sandbox?: string}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, authorization: string|undefined}>}
 */
async function runRunner({ path, status, sandbox }) {
  const upstream = await fakeUpstream(status);
  const workspace = scratch("runner-fx-workspace-");
  const home = scratch("runner-fx-real-home-");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  const args = [RUNNER, "--fx", fakeFx(path), "--model", "deepseek-flash", "--base-url", upstream.url, "--key-env", "FABERUN_TEST_FX_KEY"];
  if (sandbox) args.push("--sandbox", sandbox);
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: { ...process.env, HOME: home, FABERUN_TEST_FX_KEY: "sk-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("do the thing");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  upstream.close();
  return { code, stdout, stderr, authorization: upstream.authorization() };
}

test("the fx command runs Faberun's ACP client under this node, never fx directly", () => {
  const command = providerCommand(runtime({ sandbox: "read-only", config: { base_url: "https://api.example.test", "api_key.env_key": "EXAMPLE_KEY", context_window: 200000 } }), "hello", {});
  assert.equal(command.executable, process.execPath);
  assert.equal(command.promptTransport, "stdin");
  assert.equal(command.input, "hello");
  assert.deepEqual(command.args, [
    RUNNER, "--fx", "fx", "--model", "deepseek-flash", "--sandbox", "read-only",
    "--base-url", "https://api.example.test", "--key-env", "EXAMPLE_KEY", "--context-window", "200000",
  ]);
  assert.ok(existsSync(command.args[0]), "the client ships beside the adapter");
  assert.deepEqual(providerCommand(runtime(), "hi", {}).args, [RUNNER, "--fx", "fx", "--model", "deepseek-flash"]);
  const previous = process.env.FABERUN_FX_BIN;
  process.env.FABERUN_FX_BIN = "/env/fx";
  try {
    assert.equal(fxHarness.executable(runtime()), "/env/fx");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_FX_BIN;
    else process.env.FABERUN_FX_BIN = previous;
  }
});

test("the permission verdict bounds file mutations by path and lets commands run", () => {
  const workspace = "/work/tree";
  assert.deepEqual(permissionVerdict("workspace-write", workspace, { kind: "edit", rawInput: { path: "src/a.mjs" } }), { allow: true, reason: null });
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "edit", rawInput: { path: "/work/tree/src/a.mjs" } }).allow, true);
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "edit", rawInput: { path: "../escape.txt" } }).allow, false);
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "edit", rawInput: { path: "/etc/hosts" } }).allow, false);
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "edit", rawInput: {} }).allow, false);
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "execute", rawInput: { command: "npm test" } }).allow, true);
  assert.equal(permissionVerdict("workspace-write", workspace, { kind: "fetch" }).allow, false);
  assert.equal(permissionVerdict("read-only", workspace, { kind: "edit", rawInput: { path: "src/a.mjs" } }).allow, false);
  assert.equal(permissionVerdict("danger-full-access", workspace, { kind: "edit", rawInput: { path: "/etc/hosts" } }).allow, true);
});

test("provider usage becomes the ledger's shape with the cached prefix split out", () => {
  assert.deepEqual(
    canonicalRequestUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }),
    { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900 },
  );
  assert.deepEqual(
    canonicalRequestUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 } }),
    { inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 600 },
  );
  assert.deepEqual(canonicalRequestUsage({ prompt_tokens: 10, completion_tokens: 2 }), { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 });
  assert.equal(canonicalRequestUsage(null), null);
  assert.equal(canonicalRequestUsage({ completion_tokens: 2 }), null);
});

test("the worker HOME withholds every skill root and links the rest of the real one", () => {
  const real = scratch("runner-fx-real-");
  for (const entry of [".fx", ".claude", ".codex", ".agents", ".gitconfig", ".npm"]) mkdirSync(join(real, entry));
  mkdirSync(join(real, ".config", "opencode"), { recursive: true });
  mkdirSync(join(real, ".config", "git"), { recursive: true });
  const home = scratch("runner-fx-home-");
  prepareFxHome(real, home, { provider: "faberun" });
  for (const withheld of [".claude", ".codex", ".agents", join(".config", "opencode")]) {
    assert.equal(existsSync(join(home, withheld)), false, `${withheld} must not reach the worker`);
  }
  assert.equal(readlinkSync(join(home, ".gitconfig")), join(real, ".gitconfig"));
  assert.equal(readlinkSync(join(home, ".config", "git")), join(real, ".config", "git"));
  assert.equal(lstatSync(join(home, ".fx")).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".fx", "settings.json"), "utf8")), { provider: "faberun" });
});

test("a turn relays through the meter, reports the cache split, and keeps writes in the workspace", async () => {
  const inside = await runRunner({ path: "src/a.mjs", status: 200 });
  assert.equal(inside.code, 0, inside.stderr);
  assert.equal(inside.authorization, "Bearer sk-test", "the relay forwards the credential unchanged");
  const events = inside.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["fx.started", "fx.request", "fx.tool", "fx.message", "fx.completed"]);
  assert.deepEqual(events[1], { type: "fx.request", status: 200, usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900 } });
  assert.deepEqual(events[2], { type: "fx.tool", name: "edit", target: "src/a.mjs" });
  const envelope = normalizeProviderResult(runtime(), inside.stdout, 0, null, { preferStructured: true });
  assert.equal(envelope.status, "done");
  assert.deepEqual(envelope.usage, { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 900 });
  assert.ok(String(inside.stdout).includes("permission yes"));
  const metrics = liveSessionMetrics("fx", inside.stdout);
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.completed, true);

  const outside = await runRunner({ path: "../escape.txt", status: 200 });
  assert.equal(outside.code, 0, outside.stderr);
  assert.ok(outside.stdout.includes("permission no"), "a mutation outside the workspace is rejected");
  assert.match(outside.stderr, /faberun denied file_mutation: \.\.\/escape\.txt is outside the workspace/u);
});

test("a provider refusal is exhaustion with the reset instant the relay saw", async () => {
  const refused = await runRunner({ path: "src/a.mjs", status: 402 });
  assert.equal(refused.code, 1);
  const envelope = normalizeProviderResult(runtime(), refused.stdout, 1, null, {});
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.error?.code, "QUOTA");
  assert.match(String(envelope.error?.message), /Insufficient Balance/u);
  assert.ok(envelope.exhaustedUntil, "the Retry-After header becomes the reset instant");
});
