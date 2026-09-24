/**
 * Faberun's fx client: one prompt on stdin, one JSONL transcript on stdout,
 * no interactive surface. The adapter runs this file under
 * `process.execPath`, so spawning it never depends on a shebang, an
 * executable bit, or `node` being on the provider's PATH.
 *
 * Why ACP instead of `fx ask --json`: `ask` prints its JSON once, at exit, so
 * the controller's stall detector would see a silent worker for the whole
 * turn, and its only permission choices are "everything" or "let the model
 * review itself". `fx acp` streams every tool call as it happens and, in
 * `ask` mode, sends each shell command and file mutation to this client as
 * `session/request_permission`, so the file-effect boundary the contract
 * names is decided here, per path. Measured 2026-09-24 against
 * api.deepseek.com: seven permission requests for one parseDuration turn,
 * every file mutation carrying its `path` in `rawInput`.
 *
 * Usage and provider failures come from the loopback relay in
 * `usage-proxy.mjs`, never from fx: fx's usage omits the cache split and its
 * provider errors arrive as prose.
 *
 * Transcript, the only thing this process writes to stdout:
 *   {"type":"fx.started","sessionId":string}
 *   {"type":"fx.tool","name":string,"target":string|null}      one per tool call
 *   {"type":"fx.request","status":number,"usage":Usage|null}   one per provider request
 *   {"type":"fx.message","text":string}                        one per non-empty assistant message
 *   {"type":"fx.completed","sessionId":string,"result":string,"usage":Usage|null}
 *   {"type":"fx.failed","sessionId":string|null,"kind":string,"error":{...},"usage":Usage|null}
 * where Usage is `{inputTokens, outputTokens, cacheReadInputTokens}` with
 * `inputTokens` excluding the cached prefix, matching `canonicalUsage`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnInvocation } from "../../host/platform.mjs";
import { emit, readPrompt } from "../runner-io.mjs";
import { prepareFxHome } from "./home.mjs";
import { permissionVerdict } from "./permissions.mjs";
import { startUsageProxy } from "./usage-proxy.mjs";

/** The provider name the generated settings give the relay connection. */
const PROVIDER = "faberun";
/** Measured: DeepSeek's `max_tokens` ceiling on deepseek-flash; fx needs a declared value. */
const MAX_OUTPUT_TOKENS = 8192;

/** @typedef {{fx: string, model: string, sandbox: string, baseUrl: string, keyEnv: string, contextWindow: number}} RunnerOptions */

/**
 * @param {string[]} argv
 * @returns {RunnerOptions}
 */
function parseArgs(argv) {
  /** @type {RunnerOptions} */
  const options = {
    fx: "fx",
    model: "",
    sandbox: "workspace-write",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_000_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== "string") throw new Error(`${flag} needs a value`);
    if (flag === "--fx") options.fx = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--sandbox") options.sandbox = value;
    else if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--key-env") options.keyEnv = value;
    else if (flag === "--context-window") options.contextWindow = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.model) throw new Error("--model is required");
  return options;
}

/**
 * @param {Record<string, any>} toolCall
 * @returns {string|null}
 */
function toolTarget(toolCall) {
  const input = toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
  const value = input.path ?? input.command ?? input.pattern ?? input.url ?? null;
  return typeof value === "string" ? value.slice(0, 200) : null;
}

/** @param {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} totals @param {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} usage */
function addUsage(totals, usage) {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens;
}

/**
 * The failure a provider status means. 402 is DeepSeek's "Insufficient
 * Balance" and 429 its rate limit; both name the exhaustion the declared
 * failover edge exists for.
 *
 * @param {{status: number, error: string|null, retryAfterMs: number|null}} request
 * @returns {{kind: string, error: {code: string, message: string, retryAfterMs?: number}}}
 */
function providerFailure(request) {
  const code = request.status === 429 ? "RATE_LIMIT" : request.status === 402 ? "QUOTA" : `http_${request.status}`;
  const message = `${request.status} ${request.error ?? ""}`.trim().slice(0, 512);
  return { kind: "error", error: { code, message, ...(request.retryAfterMs ? { retryAfterMs: request.retryAfterMs } : {}) } };
}

const options = parseArgs(process.argv.slice(2));
const prompt = await readPrompt();
const workspace = realpathSync(process.cwd());
const home = mkdtempSync(join(tmpdir(), "faberun-fx-home-"));
const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
let sawUsage = false;
/** @type {{status: number, error: string|null, retryAfterMs: number|null}|null} */
let lastFailure = null;
/** @type {string[]} */
const texts = [];
let segment = "";
let sessionId = /** @type {string|null} */ (null);
let settled = false;

const proxy = await startUsageProxy({
  upstream: options.baseUrl,
  onRequest(request) {
    if (request.usage) {
      addUsage(usage, request.usage);
      sawUsage = true;
    }
    lastFailure = request.status >= 400 ? request : null;
    emit({ type: "fx.request", status: request.status, usage: request.usage });
  },
});

prepareFxHome(homedir(), home, {
  provider: PROVIDER,
  models: { [PROVIDER]: options.model },
  permission_mode: "ask",
  providers: {
    [PROVIDER]: {
      protocol: "openai-chat-completions",
      base_url: proxy.url,
      auth: { type: "bearer", env: options.keyEnv },
      model_metadata: {
        [options.model]: { context_window: options.contextWindow, max_output_tokens: MAX_OUTPUT_TOKENS, supports_tool_use: true },
      },
    },
  },
});

// FX_SOUND: fx plays a sound on every send and response, which a detached
// campaign of parallel workers turns into noise on the operator's machine.
const env = { ...process.env, HOME: home, FX_PROVIDER: PROVIDER, FX_PERMISSION_MODE: "ask", FX_AUTO_UPGRADE: "0", FX_SOUND: "0" };
const invocation = spawnInvocation(options.fx, ["acp"]);
const child = spawn(invocation.command, invocation.args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], ...invocation.options });

function flushSegment() {
  if (!segment.trim()) return;
  texts.push(segment);
  emit({ type: "fx.message", text: segment });
  segment = "";
}

/** @param {Record<string, unknown>} event @param {number} exitCode */
async function settle(event, exitCode) {
  if (settled) return;
  settled = true;
  emit({ ...event, usage: sawUsage ? usage : null });
  child.kill("SIGTERM");
  await proxy.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(exitCode);
}

/** @param {string} kind @param {{code: string, message: string, retryAfterMs?: number}} error */
function fail(kind, error) {
  flushSegment();
  // A provider status beats fx's prose about it: it is the fact failover keys on.
  const failure = lastFailure ? providerFailure(lastFailure) : { kind, error };
  return settle({ type: "fx.failed", sessionId, ...failure }, 1);
}

let nextId = 0;
/** @type {Map<number, (message: Record<string, any>) => void>} */
const pending = new Map();
/** @param {string} method @param {Record<string, unknown>} params @returns {Promise<Record<string, any>>} */
function request(method, params) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolveReply) => pending.set(id, resolveReply));
}
/** @param {number|string} id @param {Record<string, unknown>} body */
function reply(id, body) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

/** @param {Record<string, any>} message */
function onServerRequest(message) {
  if (message.method !== "session/request_permission") {
    reply(message.id, { error: { code: -32601, message: `faberun does not serve ${message.method}` } });
    return;
  }
  const toolCall = message.params?.toolCall ?? {};
  const verdict = permissionVerdict(options.sandbox, workspace, toolCall);
  const wanted = verdict.allow ? "allow_once" : "reject_once";
  const option = (message.params?.options ?? []).find((/** @type {{kind: string}} */ candidate) => candidate.kind === wanted);
  if (!verdict.allow) process.stderr.write(`faberun denied ${toolCall.title ?? "a tool call"}: ${verdict.reason}\n`);
  reply(message.id, { result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
}

/** @param {Record<string, any>} update */
function onUpdate(update) {
  if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
    segment += update.content.text;
  } else if (update.sessionUpdate === "tool_call") {
    // A tool call ends the message before it, the boundary a judge's
    // verdicts are counted on.
    flushSegment();
    emit({ type: "fx.tool", name: typeof update.kind === "string" ? update.kind : "tool", target: toolTarget(update) });
  }
}

let buffered = "";
let stderrTail = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout carries the JSON-RPC transport only; a non-JSON line is a
      // harness defect, not provider prose, and must not be silently dropped.
      fail("invalid_protocol", { code: "invalid_protocol", message: `fx wrote a non-JSON line: ${line.slice(0, 200)}` });
      return;
    }
    if (message.method && message.id !== undefined) onServerRequest(message);
    else if (message.method === "session/update") onUpdate(message.params?.update ?? {});
    else if (message.id !== undefined && pending.has(message.id)) {
      const resolveReply = pending.get(message.id);
      pending.delete(message.id);
      resolveReply?.(message);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-4096);
  process.stderr.write(chunk);
});
child.on("error", (error) => {
  fail("harness_exit", { code: "harness_exit", message: `cannot start ${options.fx}: ${error.message}` });
});
child.on("close", (code) => {
  const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-512)}` : "";
  fail("harness_exit", { code: "harness_exit", message: `fx exited with code ${code ?? 1} before the turn ended${detail}` });
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    child.kill(/** @type {NodeJS.Signals} */ (signal));
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  });
}
process.on("exit", () => {
  if (!settled) child.kill("SIGKILL");
});

const initialized = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
if (initialized.error) {
  await fail("initialize_failed", { code: "initialize_failed", message: JSON.stringify(initialized.error).slice(0, 512) });
}
const session = await request("session/new", { cwd: workspace, mcpServers: [] });
if (session.error || typeof session.result?.sessionId !== "string") {
  await fail("session_failed", { code: "session_failed", message: JSON.stringify(session.error ?? session.result).slice(0, 512) });
}
sessionId = session.result.sessionId;
emit({ type: "fx.started", sessionId });
const turn = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
flushSegment();
if (turn.error) {
  await fail("prompt_failed", { code: "prompt_failed", message: JSON.stringify(turn.error).slice(0, 512) });
}
const stopReason = turn.result?.stopReason;
if (stopReason === "end_turn") {
  if (!sawUsage) {
    // No request reached the relay with usage; fx's own totals are the
    // fallback, without the cache split it cannot report.
    const reported = turn.result?.usage;
    if (reported && typeof reported === "object") {
      usage.inputTokens = Number(reported.inputTokens) || 0;
      usage.outputTokens = Number(reported.outputTokens) || 0;
      sawUsage = true;
    }
  }
  await settle({ type: "fx.completed", sessionId, result: texts.at(-1) ?? "" }, 0);
}
await fail(stopReason === "cancelled" ? "aborted" : String(stopReason ?? "unknown"), {
  code: String(stopReason ?? "unknown"),
  message: `the turn ended: ${stopReason}`,
});
