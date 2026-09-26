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
const NATIVE_RUNNER = join(HERE, "..", "..", "src", "harnesses", "fx", "native", "zig-out", "bin", process.platform === "win32" ? "faberun-fx-runner.exe" : "faberun-fx-runner");
/**
 * Every runner this checkout can run: the Node client always, the Zig client
 * once `zig build` has produced it. Both must write the same transcript.
 *
 * @type {{name: string, argv: string[]}[]}
 */
const RUNNERS = [
  { name: "runner.mjs", argv: [process.execPath, RUNNER] },
  ...(existsSync(NATIVE_RUNNER) ? [{ name: "native", argv: [NATIVE_RUNNER] }] : []),
];
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
 * @param {{argv: string[]}} runner
 * @param {{path: string, status: number, sandbox?: string}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, authorization: string|undefined}>}
 */
async function runRunner(runner, { path, status, sandbox }) {
  const upstream = await fakeUpstream(status);
  const workspace = scratch("runner-fx-workspace-");
  const home = scratch("runner-fx-real-home-");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  const args = [...runner.argv.slice(1), "--fx", fakeFx(path), "--model", "deepseek-flash", "--base-url", upstream.url, "--key-env", "FABERUN_TEST_FX_KEY"];
  if (sandbox) args.push("--sandbox", sandbox);
  const child = spawn(runner.argv[0], args, {
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

test("the fx command runs Faberun's ACP client, never fx directly", () => {
  const command = providerCommand(runtime({ sandbox: "read-only", config: { base_url: "https://api.example.test", "api_key.env_key": "EXAMPLE_KEY", context_window: 200000 } }), "hello", {});
  // The native client when this checkout has built it, the Node one otherwise.
  const launcher = existsSync(NATIVE_RUNNER) ? [NATIVE_RUNNER] : [process.execPath, RUNNER];
  assert.deepEqual([command.executable, ...command.args], [
    ...launcher, "--fx", "fx", "--model", "deepseek-flash", "--sandbox", "read-only",
    "--base-url", "https://api.example.test", "--key-env", "EXAMPLE_KEY", "--context-window", "200000",
  ]);
  assert.equal(command.promptTransport, "stdin");
  assert.equal(command.input, "hello");
  assert.ok(existsSync(RUNNER), "the Node client ships beside the adapter");
  const codex = providerCommand(runtime({ model: "gpt-5.6-sol", config: { provider: "codex" } }), "hi", {});
  assert.deepEqual(codex.args.slice(-2), ["--provider", "codex"]);
  const plain = providerCommand(runtime(), "hi", {});
  assert.deepEqual([plain.executable, ...plain.args], [...launcher, "--fx", "fx", "--model", "deepseek-flash"]);
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
  assert.deepEqual(
    canonicalRequestUsage({ input_tokens: 1000, input_tokens_details: { cached_tokens: 700 }, output_tokens: 40 }),
    { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 700 },
  );
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

for (const runner of RUNNERS) {
  test(`${runner.name}: a turn relays through the meter, reports the cache split, and keeps writes in the workspace`, async () => {
    const inside = await runRunner(runner, { path: "src/a.mjs", status: 200 });
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

    const outside = await runRunner(runner, { path: "../escape.txt", status: 200 });
    assert.equal(outside.code, 0, outside.stderr);
    assert.ok(outside.stdout.includes("permission no"), "a mutation outside the workspace is rejected");
    assert.match(outside.stderr, /faberun denied file_mutation: \.\.\/escape\.txt is outside the workspace/u);
  });

  test(`${runner.name}: a provider refusal is exhaustion with the reset instant the relay saw`, async () => {
    const refused = await runRunner(runner, { path: "src/a.mjs", status: 402 });
    assert.equal(refused.code, 1);
    const envelope = normalizeProviderResult(runtime(), refused.stdout, 1, null, {});
    assert.equal(envelope.status, "exhausted");
    assert.equal(envelope.error?.code, "QUOTA");
    assert.match(String(envelope.error?.message), /Insufficient Balance/u);
    assert.ok(envelope.exhaustedUntil, "the Retry-After header becomes the reset instant");
  });
}

/**
 * A stand-in for `fx acp` on its Codex provider: it checks that the runner
 * chose `codex` in the throwaway settings and pointed `FX_AUTH_HOME` at the
 * real profile, then posts one Responses request to the loopback override
 * with the headers fx sends, and answers with a final message.
 *
 * @returns {string}
 */
function fakeCodexFx() {
  return writeExecutable(join(scratch("runner-fake-codex-fx-"), "fake-fx.mjs"), `import { readFileSync } from "node:fs";
import { join } from "node:path";
const settings = JSON.parse(readFileSync(join(process.env.HOME, ".fx", "settings.json"), "utf8"));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffered = "";
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
      const response = await fetch(process.env.FX_E2E_OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: { authorization: "Bearer chatgpt-access", "chatgpt-account-id": "acct-1", originator: "fx", "content-type": "application/json" },
        body: JSON.stringify({ model: settings.models.codex, stream: true, input: [] }),
      });
      await response.text();
      const facts = [settings.provider, process.env.FX_PROVIDER, process.env.FX_AUTH_HOME === process.env.FABERUN_TEST_REAL_HOME].join(" ");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: facts } } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
});
`);
}

for (const runner of RUNNERS) {
  test(`${runner.name}: the codex provider keeps the login in the real profile and meters the Responses stream`, async () => {
    /** @type {Record<string, string|string[]|undefined>} */
    let seen = {};
    let path = "";
    // Measured 2026-09-26: the Codex endpoint streams SSE with no content-type.
    const upstream = createServer((req, res) => {
      seen = req.headers;
      path = req.url ?? "";
      req.resume();
      res.writeHead(200);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 700 }, output_tokens: 40 } } })}\n\n`);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (upstream.address());
    const home = scratch("runner-fx-real-home-");
    const child = spawn(runner.argv[0], [
      ...runner.argv.slice(1), "--fx", fakeCodexFx(), "--provider", "codex", "--model", "gpt-5.6-sol",
      "--base-url", `http://127.0.0.1:${address.port}/backend-api/codex`,
    ], { cwd: scratch("runner-fx-workspace-"), env: { ...process.env, HOME: home, FABERUN_TEST_REAL_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end("review");
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    upstream.close();
    assert.equal(code, 0, stdout);
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.find((event) => event.type === "fx.completed");
    assert.equal(completed.result, "codex codex true");
    assert.deepEqual(completed.usage, { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 700 });
    assert.equal(path, "/backend-api/codex/responses");
    assert.equal(seen["chatgpt-account-id"], "acct-1", "provider headers pass through the relay");
    assert.equal(seen.originator, "fx");
  });
}
