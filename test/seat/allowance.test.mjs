import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { appendSeatAllowanceEvent, readJournal } from "../../src/campaign/journal.mjs";
import { allowanceDelta, allowanceEventFields, defaultInvoke, sampleAllowance } from "../../src/seat/allowance.mjs";
import { normalizeClaudeResult } from "../../src/harnesses/protocol.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

/** The `rate_limit_event` line as measured 2026-09-17 against a live `claude -p` probe, verbatim. */
const MEASURED_RATE_LIMIT_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1789837200,
    rateLimitType: "seven_day",
    utilization: 0.77,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1789663200 }, seven_day: { utilization: 0.77, resetsAt: 1789837200 } },
  },
});

/**
 * A claude stream-json recording carrying one `rate_limit_event` at the given
 * utilization, followed by an ordinary result.
 *
 * @param {number} utilization
 * @returns {string}
 */
function claudeStreamWithUtilization(utilization) {
  const info = {
    status: "allowed_warning",
    resetsAt: 1789837200,
    rateLimitType: "seven_day",
    utilization,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
    unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1789663200 }, seven_day: { utilization, resetsAt: 1789837200 } },
  };
  const lines = [
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }),
    JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", usage: {}, total_cost_usd: 0 }),
  ];
  return `${lines.join("\n")}\n`;
}

const RESULT_ONLY_STREAM = `${JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", usage: {}, total_cost_usd: 0 })}\n`;

test("allowance delta replays the measured rate_limit_event line", async () => {
  const start = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: `${MEASURED_RATE_LIMIT_LINE}\n${JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", usage: {}, total_cost_usd: 0 })}\n`, exitCode: 0, signal: null }),
  });
  assert.deepEqual(start, { remaining: 0.22999999999999998, limit: 1, resetsAt: new Date(1789837200 * 1000).toISOString(), window: "seven_day" });
});

test("allowance delta", async () => {
  const start = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.77), exitCode: 0, signal: null }),
  });
  assert.deepEqual(start, { remaining: 0.22999999999999998, limit: 1, resetsAt: new Date(1789837200 * 1000).toISOString(), window: "seven_day" });

  const freeze = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.5), exitCode: 0, signal: null }),
  });
  assert.ok(freeze);
  assert.equal(freeze.remaining, 0.5);
  assert.equal(freeze.window, "seven_day");

  const delta = allowanceDelta(start, freeze);
  assert.ok(delta !== null);
  assert.ok(Math.abs(delta - (0.5 - 0.22999999999999998)) < 1e-9);

  assert.equal(allowanceDelta(null, freeze), null);
  assert.equal(allowanceDelta(start, null), null);
  assert.equal(allowanceDelta({ remaining: null, limit: 1, resetsAt: null, window: "seven_day" }, freeze), null);
});

test("allowance delta is null across two differently-governed windows", async () => {
  // The measured line: unifiedWindows carries five_hour: 0.1 alongside
  // seven_day: 0.77 at the same instant. A start sample pinned to five_hour
  // and a freeze sample pinned to seven_day must not subtract: neither
  // utilization says anything about the other window's remaining allowance.
  const fiveHourStart = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({
      stdout: `${JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          utilization: 0.1,
          unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1789663200 }, seven_day: { utilization: 0.77, resetsAt: 1789837200 } },
        },
      })}\n${JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", usage: {}, total_cost_usd: 0 })}\n`,
      exitCode: 0,
      signal: null,
    }),
  });
  assert.equal(fiveHourStart?.window, "five_hour");
  assert.equal(fiveHourStart?.remaining, 0.9);

  const sevenDayFreeze = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.77), exitCode: 0, signal: null }),
  });
  assert.equal(sevenDayFreeze?.window, "seven_day");

  assert.equal(allowanceDelta(fiveHourStart, sevenDayFreeze), null);
  // Two samples of the same window still subtract normally.
  assert.equal(allowanceDelta(sevenDayFreeze, sevenDayFreeze), 0);
});

test("allowance absent", async () => {
  // The harness reports no rate_limit_event on this call: null, not a throw.
  const noSignal = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: RESULT_ONLY_STREAM, exitCode: 0, signal: null }),
  });
  assert.equal(noSignal, null);

  // No harness at all: never invoked, never throws.
  const noHarness = await sampleAllowance({
    harness: null,
    invoke: async () => { throw new Error("must not be invoked without a harness"); },
  });
  assert.equal(noHarness, null);

  // The invocation itself fails to produce anything: still null, no throw.
  const noInvocation = await sampleAllowance({ harness: "claude", invoke: async () => null });
  assert.equal(noInvocation, null);

  // The invoke seam itself throws: still null, no throw escapes.
  const invokeThrows = await sampleAllowance({
    harness: "claude",
    invoke: async () => { throw new Error("spawn failed"); },
  });
  assert.equal(invokeThrows, null);
});

test("an out-of-range utilization is no signal, not a clamped remaining of 0", async () => {
  const outOfRange = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(77), exitCode: 0, signal: null }),
  });
  assert.equal(outOfRange, null, "a percentage-scaled utilization (77) must not silently clamp to remaining: 0");
});

test("normalizeClaudeResult cancellation is byte-identical whether or not stdout's tail is parseable", () => {
  // Field defect: the allowance signal used to be extracted before the signal
  // check, so parseJsonLines ran on stdout even for a killed process.
  // parseJsonLines only tolerates a partial *first* non-empty line, and a
  // signal-killed process routinely leaves a truncated *later* line, which
  // turned a clean `canceled` envelope into a thrown error.
  const truncatedTail = '{"type":"system","subtype":"init"}\n{"type":"assistant","messa';
  const canceled = normalizeClaudeResult(truncatedTail, null, "SIGKILL");
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.error?.code, "canceled");
  assert.deepEqual(/** @type {any} */ (canceled).allowance, { remaining: null, limit: null, resetsAt: null, window: null });

  const cleanTail = normalizeClaudeResult('{"type":"system","subtype":"init"}\n', null, "SIGKILL");
  assert.equal(cleanTail.status, "canceled");
  assert.deepEqual(/** @type {any} */ (cleanTail).allowance, { remaining: null, limit: null, resetsAt: null, window: null });
});

test("journal event shape", () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-journal-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-shape", goal: "measure the seat's allowance" });

  const startResult = appendSeatAllowanceEvent(created.path, {
    sample: "start", harness: "claude", remaining: 0.77, limit: 1, resetsAt: "2026-09-17T00:00:00.000Z", delta: null,
  });
  const startEntry = /** @type {any} */ (startResult.entry);
  assert.equal(startEntry.type, "seat.allowance");
  assert.equal(startEntry.sample, "start");
  assert.equal(startEntry.delta, null);

  const freezeResult = appendSeatAllowanceEvent(created.path, {
    sample: "freeze", harness: "claude", remaining: 0.5, limit: 1, resetsAt: "2026-09-17T01:00:00.000Z", delta: -0.27,
  });
  const freezeEntry = /** @type {any} */ (freezeResult.entry);
  assert.equal(freezeEntry.sample, "freeze");
  assert.equal(freezeEntry.delta, -0.27);

  const journal = /** @type {any[]} */ (readJournal(created.path));
  const allowanceEvents = journal.filter((event) => event.type === "seat.allowance");
  assert.equal(allowanceEvents.length, 2);
  assert.deepEqual(allowanceEvents.map((event) => event.sample), ["start", "freeze"]);
});

test("journal event carries the window a sample measured", () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-window-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-window", goal: "measure the seat's allowance" });

  const startResult = appendSeatAllowanceEvent(created.path, {
    sample: "start", harness: "claude", remaining: 0.23, limit: 1, resetsAt: "2026-09-17T00:00:00.000Z", delta: null, window: "seven_day",
  });
  assert.equal(/** @type {any} */ (startResult.entry).window, "seven_day");

  const journal = /** @type {any[]} */ (readJournal(created.path));
  const allowanceEvent = journal.find((event) => event.type === "seat.allowance");
  assert.equal(allowanceEvent.window, "seven_day");
});

test("a start sample and a freeze sample of the same window journal a delta and both events carry that window", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-writers-same-window-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-writers-same-window", goal: "measure the seat's allowance" });

  const start = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.77), exitCode: 0, signal: null }),
  });
  appendSeatAllowanceEvent(created.path, { sample: "start", harness: "claude", delta: null, ...allowanceEventFields(start) });

  const freeze = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.5), exitCode: 0, signal: null }),
  });
  appendSeatAllowanceEvent(created.path, {
    sample: "freeze", harness: "claude", delta: allowanceDelta(start, freeze), ...allowanceEventFields(freeze),
  });

  const [startEvent, freezeEvent] = /** @type {any[]} */ (readJournal(created.path)).filter((event) => event.type === "seat.allowance");
  assert.equal(startEvent.window, "seven_day");
  assert.equal(freezeEvent.window, "seven_day");
  assert.ok(freezeEvent.delta !== null);
  assert.ok(Math.abs(freezeEvent.delta - (0.5 - 0.22999999999999998)) < 1e-9);
});

test("a start/freeze pair whose windows differ journals a null delta with both windows visible", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-writers-diff-window-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-writers-diff-window", goal: "measure the seat's allowance" });

  const fiveHourStart = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({
      stdout: `${JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          utilization: 0.1,
          unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1789663200 }, seven_day: { utilization: 0.77, resetsAt: 1789837200 } },
        },
      })}\n${JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s1", usage: {}, total_cost_usd: 0 })}\n`,
      exitCode: 0,
      signal: null,
    }),
  });
  appendSeatAllowanceEvent(created.path, { sample: "start", harness: "claude", delta: null, ...allowanceEventFields(fiveHourStart) });

  const sevenDayFreeze = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: claudeStreamWithUtilization(0.77), exitCode: 0, signal: null }),
  });
  appendSeatAllowanceEvent(created.path, {
    sample: "freeze", harness: "claude", delta: allowanceDelta(fiveHourStart, sevenDayFreeze), ...allowanceEventFields(sevenDayFreeze),
  });

  const [startEvent, freezeEvent] = /** @type {any[]} */ (readJournal(created.path)).filter((event) => event.type === "seat.allowance");
  assert.equal(startEvent.window, "five_hour");
  assert.equal(freezeEvent.window, "seven_day");
  assert.equal(freezeEvent.delta, null);
});

test("the absent-signal path still records nulls without throwing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-writers-absent-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-writers-absent", goal: "measure the seat's allowance" });

  const noSignal = await sampleAllowance({
    harness: "claude",
    invoke: async () => ({ stdout: RESULT_ONLY_STREAM, exitCode: 0, signal: null }),
  });
  assert.equal(noSignal, null);

  assert.doesNotThrow(() => appendSeatAllowanceEvent(created.path, {
    sample: "start", harness: "claude", delta: null, ...allowanceEventFields(noSignal),
  }));

  const startEvent = /** @type {any[]} */ (readJournal(created.path)).find((event) => event.type === "seat.allowance");
  assert.deepEqual(
    { remaining: startEvent.remaining, limit: startEvent.limit, resetsAt: startEvent.resetsAt, window: startEvent.window },
    { remaining: null, limit: null, resetsAt: null, window: null },
  );
});

test("the probe's argv is built by the claude adapter, not a hand-written command line", async () => {
  let capturedExecutable = /** @type {string|null} */ (null);
  let capturedArgs = /** @type {string[]|null} */ (null);
  let writtenToStdin = "";
  /** @param {string} executable @param {string[]} args */
  const fakeSpawn = (executable, args) => {
    capturedExecutable = executable;
    capturedArgs = args;
    const child = /** @type {any} */ (new EventEmitter());
    child.stdin = /** @type {any} */ (new EventEmitter());
    child.stdin.end = (/** @type {string} */ input) => { writtenToStdin = input ?? ""; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };

  const result = await defaultInvoke("claude", { spawn: /** @type {any} */ (fakeSpawn) });

  assert.equal(capturedExecutable, "claude");
  // The adapter's own preamble discipline (harnesses/claude/index.mjs
  // claudePreambleArgs), not a raw `claude -p ... --output-format
  // stream-json --verbose` command line the probe used to build by hand.
  assert.ok(capturedArgs?.includes("--disable-slash-commands"));
  assert.ok(capturedArgs?.includes("--strict-mcp-config"));
  assert.ok(capturedArgs?.includes("--output-format"));
  assert.ok(capturedArgs?.includes("--model"));
  assert.equal(writtenToStdin, "Reply with exactly OK and use no tools.");
  assert.equal(result?.exitCode, 0);
});

test("a stdin EPIPE on the probe yields null instead of throwing", async () => {
  const fakeSpawn = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdin = /** @type {any} */ (new EventEmitter());
    child.stdin.end = () => {
      // A dead child's stdin write fails asynchronously on its own stream,
      // never on the child process object -- the same shape `engine/process.mjs`
      // guards against for the same reason. The child having already exited is
      // why the write failed, so its own "close" follows with no output and a
      // signal, which is what actually settles the probe; the stdin listener
      // only keeps the unhandled "error" from throwing.
      queueMicrotask(() => {
        child.stdin.emit("error", new Error("EPIPE"));
        child.emit("close", null, "SIGPIPE");
      });
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };

  const allowance = await sampleAllowance({
    harness: "claude",
    invoke: (harness) => defaultInvoke(harness, { spawn: /** @type {any} */ (fakeSpawn) }),
  });
  assert.equal(allowance, null);
});

test("journal event shape rejects an unknown sample", () => {
  const cwd = mkdtempSync(join(tmpdir(), "seat-allowance-invalid-"));
  const runsDir = runsRoot(cwd);
  const created = initializeCampaign(runsDir, { campaignId: "seat-allowance-invalid", goal: "measure the seat's allowance" });
  assert.throws(() => appendSeatAllowanceEvent(created.path, {
    sample: /** @type {"start"} */ ("mid"), harness: null, remaining: null, limit: null, resetsAt: null, delta: null,
  }));
});
