import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_SOCKET_ENV,
  CLAUDE_TOKEN_ENV,
  CODEX_THREAD_ENV,
  NOTIFY_SESSION_ENV,
  createClaudeSessionNotifier,
  createCodexSessionNotifier,
  deliverToSessions,
  resolveSessionTargets,
  sessionSettingProblem,
  sessionWakeNotice,
} from "../../src/notify/session.mjs";
import { NotifyQueue, noTransportWarning, wakeCapabilityNotice } from "../../src/notify/index.mjs";
import { notifyTransportCheck } from "../../src/host/preflight.mjs";

/**
 * A stand-in for a harness session's inbox: a local socket that records every
 * line each connection sends and resolves once that connection closes. The
 * path is kept short on purpose -- macOS caps a Unix socket path near 104
 * bytes, and `tmpdir()` alone is already half of that.
 *
 * On Windows the local socket is a named pipe: `listen` on a filesystem path
 * there is EACCES. The product does not choose either shape -- it connects to
 * whatever path the harness put in the environment -- so a pipe is the same
 * test of the same code, spelled the way that platform spells a socket.
 *
 * @returns {Promise<{socketPath: string, next(): Promise<string[]>, close(): Promise<void>}>}
 */
function inboxServer() {
  const directory = mkdtempSync(join(tmpdir(), "fbs-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\faberun-test-${basename(directory)}`
    : join(directory, "s.sock");
  /** @type {((lines: string[]) => void)[]} */
  const waiters = [];
  /** @type {string[][]} */
  const received = [];
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => { buffer += chunk; });
    connection.on("end", () => {
      const lines = buffer.split("\n").filter((line) => line.length > 0);
      const waiter = waiters.shift();
      if (waiter) waiter(lines);
      else received.push(lines);
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      socketPath,
      next: () => {
        const ready = received.shift();
        return ready ? Promise.resolve(ready) : new Promise((resolveLines) => waiters.push(resolveLines));
      },
      close: () => new Promise((resolveClose) => server.close(() => {
        rmSync(directory, { recursive: true, force: true });
        resolveClose();
      })),
    }));
  });
}

test("resolveSessionTargets: unset and off name no session; auto takes every address present, claude first", () => {
  assert.deepEqual(resolveSessionTargets({}), []);
  assert.deepEqual(resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "off", [CLAUDE_SOCKET_ENV]: "/tmp/x.sock" }), []);
  assert.deepEqual(resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "auto" }), [], "auto with no address resolves to nothing, never to a guess");
  assert.deepEqual(
    resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "auto", [CLAUDE_SOCKET_ENV]: "/tmp/x.sock", [CLAUDE_TOKEN_ENV]: "tok" }),
    [{ kind: "claude", id: "claude-session", socketPath: "/tmp/x.sock", token: "tok" }],
  );
  assert.deepEqual(
    resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "auto", [CLAUDE_SOCKET_ENV]: "/tmp/x.sock" }),
    [{ kind: "claude", id: "claude-session", socketPath: "/tmp/x.sock", token: null }],
    "a missing token is null, and the auth line is simply not sent",
  );
  assert.deepEqual(
    resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "auto", [CLAUDE_SOCKET_ENV]: "/tmp/x.sock", [CODEX_THREAD_ENV]: "t-1" }).map((target) => target.id),
    ["claude-session", "codex-session"],
    "both sessions are supervising when both addresses are inherited",
  );
});

test("resolveSessionTargets: an explicit kind takes only its own address, and codex:<thread> names the thread itself", () => {
  const both = { [CLAUDE_SOCKET_ENV]: "/tmp/x.sock", [CODEX_THREAD_ENV]: "t-1" };
  assert.deepEqual(resolveSessionTargets({ ...both, [NOTIFY_SESSION_ENV]: "claude" }).map((target) => target.id), ["claude-session"]);
  assert.deepEqual(resolveSessionTargets({ ...both, [NOTIFY_SESSION_ENV]: "codex" }).map((target) => target.id), ["codex-session"]);
  assert.deepEqual(resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "claude" }), [], "claude without a socket is nothing, not an error");
  assert.deepEqual(
    resolveSessionTargets({ ...both, [NOTIFY_SESSION_ENV]: "codex:named-thread" }),
    [{ kind: "codex", id: "codex-session", thread: "named-thread" }],
    "an explicit thread wins over the inherited one and never adds the claude session",
  );
});

test("sessionSettingProblem and sessionWakeNotice say why nothing will be woken, or what will", () => {
  assert.equal(sessionSettingProblem({}), null);
  assert.equal(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "off" }), null);
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "auto" }) ?? "", new RegExp(`${CLAUDE_SOCKET_ENV} nor ${CODEX_THREAD_ENV}`, "u"));
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "claude" }) ?? "", /not started from inside a Claude Code session/u);
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "codex" }) ?? "", /not started from inside a Codex session/u);
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "yes" }) ?? "", /not one of off, auto, claude, codex, codex:<thread>/u);
  assert.equal(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "auto", [CODEX_THREAD_ENV]: "t" }), null);

  assert.match(sessionWakeNotice({}), /unset: no harness session is woken/u);
  assert.match(sessionWakeNotice({ [NOTIFY_SESSION_ENV]: "claude" }), /not started from inside a Claude Code session; no harness session is woken/u);
  const woken = sessionWakeNotice({ [NOTIFY_SESSION_ENV]: "auto", [CLAUDE_SOCKET_ENV]: "/tmp/x.sock", [CODEX_THREAD_ENV]: "t" });
  assert.match(woken, /claude-session \+ codex-session wakes the launching harness session \(canWake: true\)/u);
});

test("the claude adapter posts the auth line then the user message, one JSON object per line, and reports delivered on a clean close", async () => {
  const inbox = await inboxServer();
  try {
    const notifier = createClaudeSessionNotifier();
    assert.equal(notifier.capabilities.canWake, true);
    const summary = "🐦 Faberun · node build ✅ done · phase 1/1 · campaign 100% · $0.10 · needs you: 0\n📦 phase p · complete";
    const result = await notifier.deliver({ type: "node.terminal", summary }, { kind: "claude", id: "claude-session", socketPath: inbox.socketPath, token: "secret-token" });
    assert.deepEqual(result, { ok: true });
    const lines = await inbox.next();
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { type: "auth", token: "secret-token" });
    assert.deepEqual(JSON.parse(lines[1]), { type: "user", message: { role: "user", content: summary } }, "the session reads exactly the rendered text, newlines included");

    const noToken = await notifier.deliver({ type: "attention", summary: "🐦 Faberun · needs you" }, { kind: "claude", id: "claude-session", socketPath: inbox.socketPath, token: null });
    assert.deepEqual(noToken, { ok: true });
    const unauthenticated = await inbox.next();
    assert.equal(unauthenticated.length, 1, "no token, no auth line");
    assert.equal(JSON.parse(unauthenticated[0]).type, "user");
  } finally {
    await inbox.close();
  }
});

test("the claude adapter fails, never throws, on a dead socket and on a session that never answers the connect", async () => {
  const dead = await createClaudeSessionNotifier().deliver(
    { type: "node.terminal", summary: "x" },
    { kind: "claude", id: "claude-session", socketPath: join(mkdtempSync(join(tmpdir(), "fbs-")), "gone.sock"), token: null },
  );
  assert.equal(dead.ok, false);
  assert.match(dead.error ?? "", /ENOENT|connect/u);

  const silent = createClaudeSessionNotifier({
    connect: () => ({ once() {}, end() {}, destroy() {} }),
    timeoutMs: 20,
  });
  const timedOut = await silent.deliver({ type: "node.terminal", summary: "x" }, { kind: "claude", id: "claude-session", socketPath: "/tmp/never.sock", token: null });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /did not take the message within 20ms/u);
});

/**
 * @param {{code: number, stderr?: string}} outcome
 * @returns {{spawn: import("../../src/notify/session.mjs").SpawnFunction, calls: {command: string, args: string[]}[]}}
 */
function fakeCodexSpawn(outcome) {
  /** @type {{command: string, args: string[]}[]} */
  const calls = [];
  return {
    calls,
    spawn(command, args) {
      calls.push({ command, args });
      return {
        stderr: { on(event, listener) { const text = outcome.stderr; if (event === "data" && text) setImmediate(() => listener(text)); } },
        once(event, listener) { if (event === "exit") setImmediate(() => listener(outcome.code)); },
        kill() {},
      };
    },
  };
}

test("the codex adapter queues the rendered text on the named thread through `codex queue`, honouring FABERUN_CODEX_BIN", async () => {
  const passing = fakeCodexSpawn({ code: 0 });
  const notifier = createCodexSessionNotifier({ spawn: passing.spawn, env: { FABERUN_CODEX_BIN: "/opt/codex" } });
  assert.equal(notifier.capabilities.canWake, true);
  const result = await notifier.deliver({ type: "node.terminal", summary: "🐦 Faberun · node build ✅ done" }, { kind: "codex", id: "codex-session", thread: "0198-thread" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(passing.calls, [{ command: "/opt/codex", args: ["queue", "--thread", "0198-thread", "--message", "🐦 Faberun · node build ✅ done"] }]);

  const failing = fakeCodexSpawn({ code: 1, stderr: "no such thread\n" });
  const failed = await createCodexSessionNotifier({ spawn: failing.spawn, env: {} }).deliver({ type: "node.terminal", summary: "x" }, { kind: "codex", id: "codex-session", thread: "t" });
  assert.deepEqual(failed, { ok: false, error: "no such thread" });
  assert.equal(failing.calls[0].command, "codex", "no override, the binary on PATH");

  const unrendered = fakeCodexSpawn({ code: 0 });
  await createCodexSessionNotifier({ spawn: unrendered.spawn, env: {} }).deliver({ type: "attention", campaignId: "c", runId: "r", nodeId: "n" }, { kind: "codex", id: "codex-session", thread: "t" });
  assert.equal(unrendered.calls[0].args.at(-1), "🐦 faberun · attention · c · r · n", "an event that arrives unrendered still names itself");
});

test("deliverToSessions reports one outcome per target, each under its own id", async () => {
  const inbox = await inboxServer();
  try {
    const codex = fakeCodexSpawn({ code: 0 });
    const outcomes = await deliverToSessions(
      { type: "node.terminal", summary: "🐦 Faberun · both" },
      [
        { kind: "claude", id: "claude-session", socketPath: inbox.socketPath, token: "t" },
        { kind: "codex", id: "codex-session", thread: "th" },
      ],
      { spawn: codex.spawn, env: {} },
    );
    assert.deepEqual(outcomes, [{ id: "claude-session", address: inbox.socketPath, ok: true }, { id: "codex-session", address: "th", ok: true }], "each outcome names the address it went to, so a receipt with two claude sessions is readable");
    assert.equal((await inbox.next()).length, 2);
    assert.equal(codex.calls.length, 1);
  } finally {
    await inbox.close();
  }
});

test("NotifyQueue fans out to the session transport with no external bin, and the receipt names which transport took the message", async () => {
  const inbox = await inboxServer();
  const runDir = mkdtempSync(join(tmpdir(), "fbs-run-"));
  const saved = { bin: process.env.FABERUN_NOTIFY_BIN, session: process.env[NOTIFY_SESSION_ENV], socket: process.env[CLAUDE_SOCKET_ENV], token: process.env[CLAUDE_TOKEN_ENV], thread: process.env[CODEX_THREAD_ENV] };
  delete process.env.FABERUN_NOTIFY_BIN;
  delete process.env[CODEX_THREAD_ENV];
  process.env[NOTIFY_SESSION_ENV] = "auto";
  process.env[CLAUDE_SOCKET_ENV] = inbox.socketPath;
  process.env[CLAUDE_TOKEN_ENV] = "queue-token";
  try {
    const queue = new NotifyQueue({ runDir, now: () => 1_700_000_000_000 });
    await queue.enqueue({ type: "run.terminal", runId: "r", done: 2, total: 2, dedupeKey: "run.terminal:r:0" });
    const receipt = JSON.parse(readFileSync(join(runDir, "notify.jsonl"), "utf8").trim());
    assert.equal(receipt.status, "delivered", "a session that took the message is a delivery, with or without a phone");
    assert.deepEqual(receipt.transports, [{ id: "claude-session", address: inbox.socketPath, ok: true }]);
    const lines = await inbox.next();
    assert.deepEqual(JSON.parse(lines[0]), { type: "auth", token: "queue-token" });
    assert.equal(JSON.parse(lines[1]).message.content, receipt.summary, "the session reads the receipt's own summary, byte for byte");

    assert.equal(noTransportWarning(process.env), null, "a session transport is a transport: no warning");
    const check = notifyTransportCheck(process.env);
    assert.equal(check.advisory, false, "a bound session transport passes the check outright");
    assert.match(check.detail, /FABERUN_NOTIFY_BIN unset · session transport claude-session wakes the launching harness session \(canWake: true\)/u);
    assert.match(wakeCapabilityNotice(undefined, process.env), /canWake: true/u);
  } finally {
    for (const [key, value] of /** @type {[string, string|undefined][]} */ ([["FABERUN_NOTIFY_BIN", saved.bin], [NOTIFY_SESSION_ENV, saved.session], [CLAUDE_SOCKET_ENV, saved.socket], [CLAUDE_TOKEN_ENV, saved.token], [CODEX_THREAD_ENV, saved.thread]])) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await inbox.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a session transport that fails beside a phone that delivers is still a delivery, and the receipt keeps both outcomes", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "fbs-run-"));
  const saved = { session: process.env[NOTIFY_SESSION_ENV], socket: process.env[CLAUDE_SOCKET_ENV], thread: process.env[CODEX_THREAD_ENV] };
  process.env[NOTIFY_SESSION_ENV] = "claude";
  process.env[CLAUDE_SOCKET_ENV] = join(mkdtempSync(join(tmpdir(), "fbs-")), "dead.sock");
  delete process.env[CODEX_THREAD_ENV];
  try {
    /** @type {{type: string}[]} */
    const delivered = [];
    const queue = new NotifyQueue({
      runDir,
      deliver: async (event) => {
        delivered.push(event);
        return { ok: true, transports: [{ id: "bin", ok: true }, { id: "claude-session", ok: false, error: "connect ENOENT" }] };
      },
    });
    await queue.enqueue({ type: "run.terminal", runId: "r", done: 1, total: 1, dedupeKey: "run.terminal:r:1" });
    const receipt = JSON.parse(readFileSync(join(runDir, "notify.jsonl"), "utf8").trim());
    assert.equal(receipt.status, "delivered");
    assert.deepEqual(receipt.transports.map((/** @type {{id: string, ok: boolean}} */ entry) => [entry.id, entry.ok]), [["bin", true], ["claude-session", false]]);
    assert.equal(delivered.length, 1);
  } finally {
    for (const [key, value] of /** @type {[string, string|undefined][]} */ ([[NOTIFY_SESSION_ENV, saved.session], [CLAUDE_SOCKET_ENV, saved.socket], [CODEX_THREAD_ENV, saved.thread]])) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the setting is a list: claude:<socket> adds the operator's own session, duplicates collapse, the token travels only to the inherited inbox, and off wins", () => {
  const inherited = { [CLAUDE_SOCKET_ENV]: "/tmp/own.sock", [CLAUDE_TOKEN_ENV]: "tok", [CODEX_THREAD_ENV]: "t-1" };
  assert.deepEqual(
    resolveSessionTargets({ ...inherited, [NOTIFY_SESSION_ENV]: "auto, claude:/tmp/operator.sock" }),
    [
      { kind: "claude", id: "claude-session", socketPath: "/tmp/own.sock", token: "tok" },
      { kind: "codex", id: "codex-session", thread: "t-1" },
      { kind: "claude", id: "claude-session", socketPath: "/tmp/operator.sock", token: null },
    ],
    "the launching session keeps its token; a foreign inbox gets none, because the token belongs to one session",
  );
  assert.deepEqual(
    resolveSessionTargets({ ...inherited, [NOTIFY_SESSION_ENV]: "auto,claude:/tmp/own.sock" }).map((target) => target.kind === "claude" ? target.socketPath : target.thread),
    ["/tmp/own.sock", "t-1"],
    "naming the inherited socket again is one target, not two messages",
  );
  assert.deepEqual(
    resolveSessionTargets({ [NOTIFY_SESSION_ENV]: "claude:/tmp/operator.sock" }),
    [{ kind: "claude", id: "claude-session", socketPath: "/tmp/operator.sock", token: null }],
    "an explicit socket needs no inherited address at all: a plain shell can point a run at a session",
  );
  assert.deepEqual(resolveSessionTargets({ ...inherited, [NOTIFY_SESSION_ENV]: "auto,off" }), [], "off anywhere wins");
  assert.deepEqual(resolveSessionTargets({ ...inherited, [NOTIFY_SESSION_ENV]: "claude:" }), [], "an empty address is nothing");

  assert.equal(sessionSettingProblem({ ...inherited, [NOTIFY_SESSION_ENV]: "auto,claude:/tmp/operator.sock" }), null);
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "auto,yes" }) ?? "", /item "yes" is not one of off, auto, claude, codex, codex:<thread>, claude:<socket>/u);
  assert.match(sessionSettingProblem({ [NOTIFY_SESSION_ENV]: "claude:" }) ?? "", /item "claude:" is not one of/u);
  assert.match(sessionWakeNotice({ [NOTIFY_SESSION_ENV]: "claude:/tmp/operator.sock" }), /claude-session wakes the launching harness session \(canWake: true\)/u);
});

test("a message addressed to another session's inbox by socket path arrives there without a token", async () => {
  const inbox = await inboxServer();
  try {
    const outcomes = await deliverToSessions(
      { type: "node.terminal", summary: "🐦 faberun · for the operator" },
      resolveSessionTargets({ [NOTIFY_SESSION_ENV]: `claude:${inbox.socketPath}` }),
    );
    assert.deepEqual(outcomes, [{ id: "claude-session", address: inbox.socketPath, ok: true }]);
    const lines = await inbox.next();
    assert.equal(lines.length, 1, "no token for a session that is not the launching one, so no auth line");
    assert.equal(JSON.parse(lines[0]).message.content, "🐦 faberun · for the operator");
  } finally {
    await inbox.close();
  }
});
