/**
 * The session transports: the channel that wakes the harness session an
 * operator is sitting in, rather than a phone.
 *
 * A controller launched from inside a Claude Code or Codex session inherits
 * that session's own address. Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET`
 * (a Unix socket, the session's inbox) and `CLAUDE_CODE_MESSAGING_TOKEN` to
 * every Bash command and hook it runs; Codex exports `CODEX_THREAD_ID` and
 * accepts `codex queue --thread <id> --message <text>` for a running thread.
 * Posting the rendered message there is what `canWake: true` means: the
 * session gets a turn and reads the same text the phone gets, so the two
 * never differ. It is a module apart from `index.mjs` because that module is
 * the dispatcher and the receipt log; this one knows two wire protocols and
 * nothing about receipts.
 *
 * Measured 2026-09-21 against a live Claude Code 2.1.269 session: the inbox
 * accepts `{"type":"auth","token"}` and then
 * `{"type":"user","message":{"role":"user","content"}}`, one JSON object per
 * line, answers nothing, and delivered the line to the session mid-turn; the
 * session closes a connection that has not sent a complete line within 30 s.
 * The token is what lets the session verify a poster whose process has
 * already exited (macOS cannot check process ancestry after exit), so it is
 * always sent when present and never logged.
 *
 * Opt-in by `FABERUN_NOTIFY_SESSION`, never by detection alone: a test suite
 * running inside a session would otherwise wake it on every fixture's
 * terminal node, the hazard `FABERUN_NOTIFY_BIN` already has and guards
 * against. The seat sets the variable to `auto` on the window it launches, so
 * everything under a seat inherits the opt-in and nothing else does.
 */
import { spawn as defaultSpawn } from "node:child_process";
import { createConnection as defaultConnect } from "node:net";
import { errorMessage } from "../util.mjs";
import { spawnInvocation } from "../host/platform.mjs";

export const NOTIFY_SESSION_ENV = "FABERUN_NOTIFY_SESSION";
export const CLAUDE_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_MESSAGING_TOKEN";
export const CODEX_THREAD_ENV = "CODEX_THREAD_ID";

/**
 * Measured 2026-09-21: one post to a live inbox completed well under a
 * second, and Claude Code's own peer sender gives up at 5 s; the same budget
 * `index.mjs` gives an external transport.
 */
export const SESSION_DELIVERY_TIMEOUT_MS = 5_000;

/** The bare words an item of the setting may be; `codex:<thread>` and `claude:<socket>` carry an address. */
const SETTINGS = new Set(["off", "auto", "claude", "codex"]);

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{kind: "claude", id: "claude-session", socketPath: string, token: string|null}} ClaudeTarget */
/** @typedef {{kind: "codex", id: "codex-session", thread: string}} CodexTarget */
/** @typedef {ClaudeTarget|CodexTarget} SessionTarget */
/** @typedef {{type: string, summary?: unknown, campaignId?: unknown, runId?: unknown, nodeId?: unknown}} SessionEvent */
/** @typedef {{ok: boolean, error?: string}} SessionDelivery */
/** @typedef {{once(event: string, listener: (...args: any[]) => void): unknown, kill(signal?: any): unknown, stderr?: {on(event: string, listener: (chunk: string|Buffer) => void): unknown}|null}} SpawnedChild */
/** @typedef {(command: string, args?: any, options?: any) => SpawnedChild} SpawnFunction */
/** @typedef {{once(event: string, listener: (...args: any[]) => void): unknown, end(data: string, callback?: () => void): unknown, destroy(): unknown}} SessionSocket */
/** @typedef {(path: string) => SessionSocket} ConnectFunction */

/**
 * The sessions the variable and the environment together name. The value is
 * a comma-separated list; each item is one of:
 *
 *   auto             every session whose address this process inherited --
 *                    a Codex thread opened from a Claude Code shell inherits
 *                    both, and both are supervising
 *   claude           the inherited Claude Code inbox alone
 *   codex            the inherited Codex thread alone
 *   codex:<thread>   a Codex thread by id or name
 *   claude:<socket>  a Claude Code inbox by socket path -- the operator's
 *                    own interactive session, which did not launch the run
 *                    and would otherwise never hear of it (the session that
 *                    launches a campaign is often a background one nobody
 *                    reads); the token travels only to the inherited inbox,
 *                    since it belongs to that session and no other
 *   off              nothing, whatever else the list says
 *
 * An item whose address is absent resolves to nothing; the doctor reports
 * why through `sessionSettingProblem`. This function never throws, because it
 * backs a lossy dispatcher. Duplicates collapse: `auto,claude:<own socket>`
 * is one target.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {SessionTarget[]}
 */
export function resolveSessionTargets(env = process.env) {
  const items = settingItems(env);
  if (!items.length || items.includes("off")) return [];
  /** @type {SessionTarget[]} */
  const targets = [];
  /** @param {SessionTarget} target */
  const add = (target) => {
    const address = target.kind === "claude" ? target.socketPath : target.thread;
    if (!targets.some((known) => known.kind === target.kind && (known.kind === "claude" ? known.socketPath : known.thread) === address)) targets.push(target);
  };
  const inheritedSocket = env[CLAUDE_SOCKET_ENV];
  const inheritedThread = env[CODEX_THREAD_ENV];
  for (const item of items) {
    if ((item === "auto" || item === "claude") && inheritedSocket) {
      add({ kind: "claude", id: "claude-session", socketPath: inheritedSocket, token: env[CLAUDE_TOKEN_ENV] || null });
    }
    if ((item === "auto" || item === "codex") && inheritedThread) {
      add({ kind: "codex", id: "codex-session", thread: inheritedThread });
    }
    if (item.startsWith("codex:") && item.slice("codex:".length).trim()) {
      add({ kind: "codex", id: "codex-session", thread: item.slice("codex:".length).trim() });
    }
    if (item.startsWith("claude:") && item.slice("claude:".length).trim()) {
      const socketPath = item.slice("claude:".length).trim();
      add({ kind: "claude", id: "claude-session", socketPath, token: socketPath === inheritedSocket ? env[CLAUDE_TOKEN_ENV] || null : null });
    }
  }
  return targets;
}

/** @param {NodeJS.ProcessEnv} env @returns {string[]} the non-empty items of the setting */
function settingItems(env) {
  return (env[NOTIFY_SESSION_ENV] ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Why the setting names no session, in one sentence for `doctor` and
 * `--wake`; `null` when it is unset, `off`, or resolves to at least one.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function sessionSettingProblem(env = process.env) {
  const items = settingItems(env);
  if (!items.length || items.includes("off")) return null;
  const unknown = items.find((item) => !SETTINGS.has(item) && !(item.startsWith("codex:") && item.length > "codex:".length) && !(item.startsWith("claude:") && item.length > "claude:".length));
  if (unknown !== undefined) {
    return `${NOTIFY_SESSION_ENV} item "${unknown}" is not one of off, auto, claude, codex, codex:<thread>, claude:<socket>`;
  }
  if (resolveSessionTargets(env).length) return null;
  const [setting] = items;
  if (setting === "claude") return `${NOTIFY_SESSION_ENV}=claude but ${CLAUDE_SOCKET_ENV} is not set: this process was not started from inside a Claude Code session`;
  if (setting === "codex") return `${NOTIFY_SESSION_ENV}=codex but ${CODEX_THREAD_ENV} is not set: this process was not started from inside a Codex session`;
  return `${NOTIFY_SESSION_ENV}=auto found neither ${CLAUDE_SOCKET_ENV} nor ${CODEX_THREAD_ENV}: no harness session to wake`;
}

/**
 * What `campaign watch --wake` and `doctor` say about waking a session.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function sessionWakeNotice(env = process.env) {
  const targets = resolveSessionTargets(env);
  if (targets.length) {
    return `session transport ${targets.map((target) => target.id).join(" + ")} wakes the launching harness session (canWake: true)`;
  }
  const problem = sessionSettingProblem(env);
  if (problem) return `${problem}; no harness session is woken`;
  return `${NOTIFY_SESSION_ENV} unset: no harness session is woken (a seat window sets it to auto)`;
}

/**
 * The text a session reads: the rendered summary, whose first line already
 * names the sender; a counters-only fallback for an event that reaches a
 * transport unrendered.
 *
 * @param {SessionEvent} event
 * @returns {string}
 */
function messageText(event) {
  if (typeof event.summary === "string" && event.summary.trim()) return event.summary;
  return ["🐦 faberun", event.type, event.campaignId, event.runId, event.nodeId].filter((part) => typeof part === "string" && part).join(" · ");
}

/**
 * @param {{connect?: ConnectFunction, timeoutMs?: number}} [options]
 * @returns {{id: "claude-session", capabilities: {canPush: boolean, canWake: boolean, canRenderAmbient: boolean}, deliver(event: SessionEvent, target: ClaudeTarget): Promise<SessionDelivery>}}
 */
export function createClaudeSessionNotifier({ connect = /** @type {ConnectFunction} */ (defaultConnect), timeoutMs = SESSION_DELIVERY_TIMEOUT_MS } = {}) {
  return {
    id: "claude-session",
    capabilities: { canPush: false, canWake: true, canRenderAmbient: false },
    deliver(event, target) {
      return new Promise((resolve) => {
        /** @type {string[]} */
        const lines = [];
        if (target.token) lines.push(JSON.stringify({ type: "auth", token: target.token }));
        lines.push(JSON.stringify({ type: "user", message: { role: "user", content: messageText(event) } }));
        let socket;
        try {
          socket = connect(target.socketPath);
        } catch (error) {
          resolve({ ok: false, error: errorMessage(error) });
          return;
        }
        let settled = false;
        /** @param {SessionDelivery} result */
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          socket.destroy();
          finish({ ok: false, error: `session inbox ${target.socketPath} did not take the message within ${timeoutMs}ms` });
        }, timeoutMs);
        socket.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
        // The inbox answers nothing, so a flushed write and a clean close is
        // the whole evidence of delivery there is.
        socket.once("connect", () => socket.end(`${lines.join("\n")}\n`, () => finish({ ok: true })));
      });
    },
  };
}

/**
 * @param {{spawn?: SpawnFunction, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{id: "codex-session", capabilities: {canPush: boolean, canWake: boolean, canRenderAmbient: boolean}, deliver(event: SessionEvent, target: CodexTarget): Promise<SessionDelivery>}}
 */
export function createCodexSessionNotifier({ spawn = /** @type {SpawnFunction} */ (defaultSpawn), timeoutMs = SESSION_DELIVERY_TIMEOUT_MS, env = process.env } = {}) {
  return {
    id: "codex-session",
    capabilities: { canPush: false, canWake: true, canRenderAmbient: false },
    deliver(event, target) {
      return new Promise((resolve) => {
        const executable = env.FABERUN_CODEX_BIN ?? "codex";
        let child;
        try {
          // The harness CLI, reached the way this platform reaches one: the
          // `codex` a Windows machine has is `codex.cmd`, and a raw spawn of
          // the bare name is ENOENT — a wake that silently never arrives.
          const invocation = spawnInvocation(executable, ["queue", "--thread", target.thread, "--message", messageText(event)]);
          child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "ignore", "pipe"], env, ...invocation.options });
        } catch (error) {
          resolve({ ok: false, error: errorMessage(error) });
          return;
        }
        let settled = false;
        let stderr = "";
        /** @param {SessionDelivery} result */
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // ESRCH: the child already exited before the timeout kill; finish still resolves.
          }
          finish({ ok: false, error: `codex queue did not return within ${timeoutMs}ms` });
        }, timeoutMs);
        child.stderr?.on("data", (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-1024);
        });
        child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
        child.once("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `codex queue exited ${code}` }));
      });
    },
  };
}

/**
 * Deliver one event to every resolved session, each through its own adapter,
 * and report per target: the receipt names which session took the message.
 *
 * @param {SessionEvent} event
 * @param {SessionTarget[]} targets
 * @param {{connect?: ConnectFunction, spawn?: SpawnFunction, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{id: string, address: string, ok: boolean, error?: string}[]>}
 */
export function deliverToSessions(event, targets, options = {}) {
  return Promise.all(targets.map(async (target) => {
    const result = target.kind === "claude"
      ? await createClaudeSessionNotifier(options).deliver(event, target)
      : await createCodexSessionNotifier(options).deliver(event, target);
    return { id: target.id, address: target.kind === "claude" ? target.socketPath : target.thread, ...result };
  }));
}
