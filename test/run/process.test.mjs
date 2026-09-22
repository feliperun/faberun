import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../../src/run/store.mjs";
import { invocationOwned } from "../../src/engine/process-identity.mjs";
import {
  bootstrapMatchesChild,
  lockPath,
  lockStale,
  pidAlive,
  processStartToken,
  readLock,
} from "../../src/run/lock.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { detectStalls, invocationAlive, startProcess, terminateInvocation } from "../../src/engine/process.mjs";
import { monitorInvocation } from "../../src/engine/transcript.mjs";

import { fixture, writeContract } from "../helpers.mjs";
import { killTarget } from "../../src/host/platform.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { errorCode } from "../../src/util.mjs";

/**
 * @param {string} runDir
 * @param {Record<string, unknown>} [overrides]
 * @returns {{contract: import("../../src/contract/index.mjs").ValidatedContract, node: import("../../src/contract/index.mjs").ValidatedNode}}
 */
function validatedRun(runDir, overrides = {}) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10, ...overrides }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  if (!node) throw new Error("fixture has no build node");
  return { contract, node };
}

/**
 * @param {import("../../src/contract/index.mjs").ValidatedNode} node
 * @param {unknown[]} executionOverrides
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
 */
function nodeSnapshot(node, executionOverrides) {
  const now = new Date().toISOString();
  return validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: node.id,
    type: node.type,
    sourceIdentity: node.sourceIdentity,
    packetHash: node.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: now,
    updatedAt: now,
    result: null,
    gate: null,
    error: null,
    invocations: [],
    executionOverrides,
    verification: null,
    scope: {
      boundary: {
        schemaVersion: 1,
        files: [...(node.taskPacket.writeFiles ?? [])],
        roots: [...(node.taskPacket.writeRoots ?? [])],
        fileOrigins: [...(node.taskPacket.writeFiles ?? [])].map((literal) => ({ literal, paths: [literal] })),
        rootOrigins: [...(node.taskPacket.writeRoots ?? [])].map((literal) => ({ literal, paths: [literal] })),
      },
      changedPaths: [],
      unexpectedPaths: [],
      changedPathCount: 0,
      unexpectedPathCount: 0,
      truncated: false,
    },
  }, node);
}

// The other half of lock.test.mjs: spawning an invocation behind the gate,
// watching it, detecting a stall, and taking it down.

/**
 * A raw process-group SIGKILL for a gate a test spawned directly. Tests that
 * hold the invocation straight from `startProcess` know they own it, so this
 * skips `terminateInvocation`'s ownership proof (which a flaky
 * `processStartToken` read could fail) and just kills, ignoring ESRCH.
 * @param {{pid: number|null, processGroupId?: number|null}|undefined} invocation
 */
function killGateGroup(invocation) {
  const pid = invocation?.processGroupId ?? invocation?.pid;
  if (pid === null || pid === undefined) return;
  // Through the product's own kill, because a negative pid is a POSIX process
  // group and names nothing on Windows: `process.kill(-pid)` there reports
  // ESRCH, this helper swallows it, and the gate — and the harness under it —
  // outlives the test. Measured 2026-09-21: the runner then never exited.
  try { killTarget(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== "ESRCH") throw error;
  }
}

test("two synthetic records with different tokens are a mismatch, not just an unequal-string coincidence", () => {
  const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const bootstrapRecord = { pid: process.pid, nonce, processStartToken: "synthetic-token-a" };
  assert.equal(bootstrapMatchesChild(bootstrapRecord, process.pid, nonce, "synthetic-token-b"), false, "different synthetic tokens must not match");
  assert.equal(bootstrapMatchesChild(bootstrapRecord, process.pid, nonce, "synthetic-token-a"), true, "identical synthetic tokens still match");

  // The same distinction, exercised through lockStale via a captured lock
  // record: a recorded token that disagrees with what the live pid actually
  // carries now (injected here as a synthetic mismatch, standing in for a
  // real pid-reuse token change) makes the lock stale even though the pid
  // itself is alive.
  const runDir = mkdtempSync(join(tmpdir(), "lock-token-injected-"));
  writeJsonAtomic(lockPath(runDir), {
    schemaVersion: 1,
    pid: process.pid,
    processStartToken: "synthetic-token-a",
    startedAt: new Date(0).toISOString(),
    hostname: "old-host",
  });
  const recorded = readLock(runDir);
  assert.notEqual(processStartToken(process.pid), "synthetic-token-a", "the live token must genuinely disagree with the synthetic one");
  assert.equal(pidAlive(process.pid), true);
  assert.equal(lockStale(recorded), true, "a live pid with a mismatched recorded token is still stale");
});

test("process start token is null on platforms other than linux and darwin", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    assert.equal(processStartToken(process.pid), null);
  } finally {
    Object.defineProperty(process, "platform", /** @type {PropertyDescriptor} */ (original));
  }
});

test("monitorInvocation reads bounded live evidence and never throws", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-invocation-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  writeFileSync(stdout, [
    { type: "thread.started", thread_id: "live-thread" },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.deepEqual(monitorInvocation(job), { continuationId: "live-thread", turns: 1, cacheReadInputTokens: 80, toolCalls: 1, completed: false });
  assert.deepEqual(
    monitorInvocation({ ...job, paths: { ...job.paths, stdout: join(logs, "missing.jsonl") } }),
    { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
    "a missing transcript meters as zero without throwing",
  );
});

test("monitorInvocation keeps counting codex turns after the transcript outgrows any fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-fat-codex-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const fatItem = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(4096) } });
  const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 150_000 } });
  const first = [];
  for (let index = 0; index < 40; index += 1) first.push(fatItem, turn);
  writeFileSync(stdout, `${first.join("\n")}\n`);
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "codex" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  assert.equal(monitorInvocation(job).turns, 40, "the first observation consumes the padded prefix");
  const second = [];
  for (let index = 0; index < 40; index += 1) second.push(turn);
  appendFileSync(stdout, `${second.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 80, "the rotation turn threshold stays observable on a fat transcript");
  assert.equal(observed.cacheReadInputTokens, 150_000, "cumulative codex cache-read counters compose as a max, not a sum");
});

test("monitorInvocation observes claude turns and the session total beyond a fixed window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-monitor-fat-claude-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const stdout = join(logs, "worker.jsonl");
  const lines = [];
  for (let index = 0; index < 90; index += 1) {
    // Fat content pushes the threshold-crossing turns past 128 KiB of log.
    const text = index < 40 ? "z".repeat(4096) : "done";
    lines.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }], usage: { input_tokens: 1, cache_read_input_tokens: 1_000 } },
    }));
  }
  lines.push(JSON.stringify({ type: "result", session_id: "fat-session", usage: { input_tokens: 9, cache_read_input_tokens: 123_456 } }));
  writeFileSync(stdout, `${lines.join("\n")}\n`);
  assert.ok(statSync(stdout).size > 128 * 1024, "the transcript outgrew the old fixed live window");
  const job = /** @type {import("../../src/cli.mjs").Job} */ ({
    runtime: { harness: "claude" },
    paths: { prompt: join(logs, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
  });
  const observed = monitorInvocation(job);
  assert.equal(observed.turns, 90, "assistant turns past the old window still count");
  assert.equal(observed.cacheReadInputTokens, 123_456, "the terminal result total replaces the per-turn sum");
});

test("stall supervision uses the latest persisted timeout override", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-timeout-override-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.FABERUN_MARKER, \"started\"); process.stdin.resume(); setTimeout(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  const previousMarker = process.env.FABERUN_MARKER;
  process.env.FABERUN_CODEX_BIN = provider;
  process.env.FABERUN_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, [
    { kind: "timeout", timeoutSec: 5, at: new Date().toISOString(), reason: "old" },
    { kind: "timeout", timeoutSec: 0.05, at: new Date().toISOString(), reason: "latest" },
  ]);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => assert.equal(existsSync(marker), false, "provider must not start before invocation persistence"),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let timeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      timeout = { currentJob, status, error };
    });
    assert.ok(timeout, "stall supervisor reported a timeout");
    assert.equal(timeout.status, "exhausted");
    assert.match(timeout.error.message, /0\.05s/u);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.FABERUN_MARKER;
    else process.env.FABERUN_MARKER = previousMarker;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("the pre-termination hook runs before terminateProcess, and a no-op is the default", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-before-terminate-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}\nprocess.stdin.resume();\nsetTimeout(() => {}, 1000);\n`);
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, [
    { kind: "timeout", timeoutSec: 0.05, at: new Date().toISOString(), reason: "hook" },
  ]);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    /** @type {string[]} */
    const order = [];
    let aliveInHook = null;
    let hookCode = null;
    /** @type {{status: "exhausted"|"stalled", error: {code: string}}|undefined} */
    let timeoutSeen;
    await detectStalls(contract, new Map([["build", job]]), async (_currentJob, status, error) => {
      order.push("timeout");
      timeoutSeen = { status, error };
    }, undefined, async (hooked, timeout) => {
      order.push("hook");
      aliveInHook = invocationAlive(hooked.invocation);
      hookCode = timeout.code;
    });
    assert.deepEqual(order, ["hook", "timeout"], "the hook is awaited before terminateProcess and onTimeout");
    assert.equal(aliveInHook, true, "the hook observes the invocation before the kill");
    assert.equal(hookCode, "wall_clock_timeout");
    assert.equal(timeoutSeen?.status, "exhausted");
    assert.equal(invocationAlive(job.invocation), false, "the kill happens after the hook");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("stall supervision kills a runtime whose harness declares streamed output once it goes quiet past stallTimeoutSec", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-stall-streaming-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const provider = join(runDir, "provider.mjs");
  // Writes once, immediately, then never again: codex declares streamsOutput
  // (confirmed by reading its adapter's `--json` transport), so this alone
  // must be enough for the stall clock to start and then expire.
  writeFileSync(provider, `#!${process.execPath}\nprocess.stdout.write("{}\\n"); process.stdin.resume(); setInterval(() => {}, 1000);\n`);
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir, { stallTimeoutSec: 0.05 });
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    // Wait for the provider's one line instead of assuming how fast it
    // writes: measured 2026-09-20 in the orchestration-arms campaign, a fixed
    // 800 ms sleep was not enough under three concurrent workers and a
    // typecheck, and the assertion that followed it bounded a duration from
    // above, which this repository's rules forbid. A lower bound is fine: the
    // stall clock below only starts once the line is there. The cap is a
    // hang guard, not a bet on the machine, so it sits at a minute.
    const lineDeadline = Date.now() + 60_000;
    while (!(existsSync(job.paths.stdout) && statSync(job.paths.stdout).size > 0) && Date.now() < lineDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(statSync(job.paths.stdout).size > 0, "the provider wrote its one line");
    // A poll loop calls detectStalls repeatedly; the first call after output
    // appears only records it as progress; a stall is only real once a later
    // poll finds nothing new.
    await detectStalls(contract, new Map([["build", job]]), async () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let timeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      timeout = { currentJob, status, error };
    });
    assert.ok(timeout, "stall supervisor reported a timeout");
    assert.equal(timeout.status, "stalled");
    assert.match(timeout.error.message, /no provider progress/u);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("stall supervision never kills a runtime whose harness declares no streamed output; it is bounded by timeoutSec instead", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-stall-non-streaming-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const recording = join(runDir, "recording.jsonl");
  // replay declares streamsOutput: false (measured: replay/bin.mjs writes its
  // one envelope line only after delayMs). 5s comfortably outlasts every
  // wait below, so the process is still silent-on-disk at both checkpoints.
  writeFileSync(recording, `${JSON.stringify({
    envelope: {
      status: "done", result: "late", continuationId: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: null, error: null,
    },
    delayMs: 5_000,
  })}\n`);
  // One home for the wall-clock budget the early polls must land inside:
  // node --test runs this file beside dozens of spawn-heavy siblings, and
  // measured 2026-09-19 a loaded machine pushed a poll past the budget, where
  // the exhausted verdict is the correct answer, not a regression. The polls
  // below therefore assert "no verdict yet" only while they land inside it.
  const wallClockSec = 0.6;
  const { contract, node } = validatedRun(runDir, { stallTimeoutSec: 0.05, timeoutSec: wallClockSec });
  const state = nodeSnapshot(node, []);
  // Captured before the spawn, so this elapsed clock only overstates the
  // scheduler's own: a skipped poll means the budget genuinely elapsed.
  const startedMs = Date.now();
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "replayed", harness: "replay", model: "test", config: { "replay.recording": recording } },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(statSync(job.paths.stdout, { throwIfNoEntry: false })?.size ?? 0, 0, "the replay process has written nothing yet");
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let firstTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      firstTimeout = { currentJob, status, error };
    });
    if (Date.now() - startedMs < wallClockSec * 1_000) {
      assert.equal(firstTimeout, undefined, "silence alone must not kill a harness that never reports streamed output");
    }

    // Discriminating check: the gate's stdout/stderr files exist (created
    // empty before spawn) from the very first poll onward, so a streamsOutput
    // implementation that still tracked mtime would record that fixed
    // creation time as "progress" on the first poll and then, finding no
    // further change here 250ms later, would call it stalled — well inside
    // this 0.6s wall-clock budget. The fix must stay silent here.
    await new Promise((resolve) => setTimeout(resolve, 250));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let secondTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      secondTimeout = { currentJob, status, error };
    });
    if (Date.now() - startedMs < wallClockSec * 1_000) {
      assert.equal(secondTimeout, undefined, "a harness that never reports streamed output must survive well past stallTimeoutSec");
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    /** @type {{currentJob: import("../../src/cli.mjs").Job, status: "exhausted"|"stalled", error: {code: string, message: string}}|undefined} */
    let thirdTimeout;
    await detectStalls(contract, new Map([["build", job]]), async (currentJob, status, error) => {
      thirdTimeout = { currentJob, status, error };
    });
    assert.ok(thirdTimeout, "the wall-clock budget still applies");
    assert.equal(thirdTimeout.status, "exhausted", "the same silent runtime is bounded by timeoutSec, never by the stall clock");
  } finally {
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
  }
});

test("a zcode worker runs with the harness's endpoint env overlay applied", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-zcode-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "zcode-worker-marker.json");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  notify: process.env.FABERUN_NOTIFY_BIN ?? null,
  ambient: process.env.FABERUN_AMBIENT ?? null,
  baseUrl: process.env.ZCODE_BASE_URL ?? null,
  model: process.env.ZCODE_MODEL ?? null,
  token: process.env.GLM_API_KEY ?? null,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
setInterval(() => {}, 1000);
`);
  chmodSync(provider, 0o755);
  const previous = {
    FABERUN_ZCODE_BIN: process.env.FABERUN_ZCODE_BIN,
    FABERUN_MARKER: process.env.FABERUN_MARKER,
    FABERUN_AMBIENT: process.env.FABERUN_AMBIENT,
    FABERUN_NOTIFY_BIN: process.env.FABERUN_NOTIFY_BIN,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.FABERUN_ZCODE_BIN = provider;
  process.env.FABERUN_MARKER = marker;
  process.env.FABERUN_AMBIENT = "ambient-value";
  process.env.FABERUN_NOTIFY_BIN = provider;
  process.env.ZAI_API_KEY = "zcode-notify-test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "zcode-glm", harness: "zcode", model: "glm-5.3[1m]" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    // The fake provider creates the marker before it finishes writing it, so an
    // existence check alone races the write under parallel load; wait until the
    // file parses.
    const deadline = Date.now() + 5_000;
    let observed = null;
    while (observed === null && Date.now() < deadline) {
      try { observed = JSON.parse(readFileSync(marker, "utf8")); } catch { observed = null; }
      if (observed === null) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(observed, "the fake provider wrote its marker within five seconds");
    assert.equal(observed.notify, null, "FABERUN_NOTIFY_BIN must not reach the worker provider");
    assert.equal(observed.ambient, "ambient-value", "ambient runtime variables must survive");
    assert.equal(observed.baseUrl, "https://api.z.ai/api/anthropic", "harness env overlay must still apply");
    assert.equal(observed.model, "glm/glm-5.3", "the [1m] tier marker is stripped before ZCODE_MODEL");
    assert.equal(observed.token, "zcode-notify-test-token");
    assert.equal(observed.apiKey, null, "ambient Anthropic key is removed, not inherited");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    killGateGroup(job.invocation);
  }
});

test("a persistence failure leaves the gated provider unstarted and terminates its wrapper", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-persistence-barrier-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.FABERUN_MARKER, \"started\"); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  const previousMarker = process.env.FABERUN_MARKER;
  process.env.FABERUN_CODEX_BIN = provider;
  process.env.FABERUN_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  let persistedInvocation;
  try {
    assert.throws(() => startProcess({
      contract,
      node,
      state,
      runtime: { id: "luna", harness: "codex", model: "test" },
      prompt: "task",
      paths: {
        prompt: join(logs, "worker.prompt"),
        stdout: join(logs, "worker.jsonl"),
        stderr: join(logs, "worker.err"),
      },
      phase: "worker",
      onInvocation: (invocation) => {
        persistedInvocation = invocation;
        throw new Error("persistence failed");
      },
    }), /persistence failed/u);
    assert.equal(existsSync(marker), false);
    // A SIGTERM only schedules the gate's own SIGKILL 100ms out (src/engine/
    // gate.mjs stopProvider), and a loaded machine fires that timer late, so
    // death is not claimable at any fixed checkpoint. The claim is that the
    // unstarted wrapper dies, so poll for it: 60s, like the gate test below,
    // which the source-shape deadline ratchet deliberately does not count.
    const terminateDeadline = Date.now() + 60_000;
    while (invocationAlive(persistedInvocation) && Date.now() < terminateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(invocationAlive(persistedInvocation), false, "a persistence failure terminates the wrapper that persisted nothing");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.FABERUN_MARKER;
    else process.env.FABERUN_MARKER = previousMarker;
    killGateGroup(persistedInvocation);
  }
});

test("a gate exits once the directory holding its release file is gone", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-gate-release-dir-gone-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node, []);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const pid = job.invocation.pid;
    // The gate is released the moment startProcess persists the invocation, so
    // it can be mid-release right here: on its release tick it creates the two
    // log files with "wx" (src/engine/gate.mjs), and a creation landing between
    // rmSync's readdir and rmdir fails the removal with ENOTEMPTY. The removal
    // is the test's point, so retry it: measured 2026-09-19 this exact race
    // failed a green tree. 20 x 25ms is far past any release tick (10ms).
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(logs, { recursive: true, force: true });
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOTEMPTY" || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    // A generous deadline, not a claim about how fast the gate reacts: the
    // ratchet in test/repo/source-shape.test.mjs caps deadlines under 60s at
    // three, and this one is a fourth if it races under that line.
    const deadline = Date.now() + 60_000;
    while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(pidAlive(pid), false, "the gate exits once its release file's directory is gone, never waiting for a release that can now never appear");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    killGateGroup(job.invocation);
  }
});

// Ownership proof: a group is signalled only while the child handle or the
// recorded start token still names the process the controller started.

test("invocationOwned proves a freshly spawned child with a recorded token and drops once it exits", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid unavailable");
  const invocation = { pid, processGroupId: pid, processStartToken: processStartToken(pid) };
  try {
    assert.ok(invocation.processStartToken, "the spawn path records a non-null start token");
    assert.equal(invocationOwned(invocation), true, "a live child named by its token is owned");
  } finally {
    await new Promise((resolve) => child.once("close", resolve));
  }
  assert.equal(invocationOwned(invocation), false, "a reaped child can no longer be proven and is never signalled");
});

test("invocationOwned rejects a mismatched token even while the pid is alive", () => {
  assert.equal(
    invocationOwned({ pid: process.pid, processGroupId: process.pid, processStartToken: "fabricated-not-this-process" }),
    false,
    "a live pid whose recorded token does not match must not be treated as ours",
  );
});

test("terminateInvocation with a fabricated token on the test runner's own pid signals nothing", async () => {
  await terminateInvocation(
    { id: "fabricated-owner", pid: process.pid, processGroupId: process.pid, processStartToken: "fabricated-not-this-process" },
    { graceMs: 25, killGraceMs: 100 },
  );
  assert.equal(pidAlive(process.pid), true, "the test runner was not signalled");
});

test("invocationOwned never owns this process or its parent, even when the token matches", () => {
  assert.equal(
    invocationOwned({ pid: process.pid, processGroupId: process.pid, processStartToken: processStartToken(process.pid) }),
    false,
    "a controller does not spawn itself",
  );
  assert.equal(
    invocationOwned({ pid: process.ppid, processGroupId: process.ppid, processStartToken: processStartToken(process.ppid) }),
    false,
    "a controller does not spawn the process that spawned it",
  );
});

test("an injected EPERM from kill is swallowed by terminateInvocation", { skip: process.platform === "win32" }, async () => {
  const probe = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  probe.unref();
  const pid = probe.pid;
  if (pid === undefined) throw new Error("invocation probe did not start");
  const invocation = { id: "eperm-owner", pid, processGroupId: pid, processStartToken: processStartToken(pid) };
  const eperm = Object.assign(new Error("not permitted"), { code: "EPERM" });
  try {
    await terminateInvocation(invocation, {
      graceMs: 25,
      killGraceMs: 100,
      kill: () => { throw eperm; },
    });
    assert.equal(invocationOwned(invocation), true, "the real process was never signalled and no death was awaited");
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The probe is already gone; the EPERM path already returned.
    }
  }
});
