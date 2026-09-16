import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyQueue, notificationDeliveryTimeoutMs, renderNotification } from "../../src/notify/index.mjs";

const SUMMARY_CHARS = 200;

test("renderNotification: node.terminal done names the run and attempt, no resume", () => {
  const summary = renderNotification({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "done", attempt: 1 });
  assert.equal(summary, "node build done · run run-a · attempt 1");
});

test("renderNotification: node.terminal failure adds the error code and a resume path", () => {
  const summary = renderNotification({
    type: "node.terminal",
    runId: "run-a",
    nodeId: "build",
    status: "failed",
    attempt: 2,
    errorCode: "verification_failed",
    runDir: "/repo/.runs/run-a",
  });
  assert.equal(summary, "node build failed · run run-a · attempt 2 · verification_failed · resume /repo/.runs/run-a");
});

test("renderNotification: node.terminal done never shows a resume path even when one is present", () => {
  const summary = renderNotification({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "done", attempt: 1, runDir: "/repo/.runs/run-a" });
  assert.equal(summary, "node build done · run run-a · attempt 1");
});

test("renderNotification: run.terminal done names the done/total count and cost when known", () => {
  const summary = renderNotification({ type: "run.terminal", runId: "run-a", done: 3, total: 3, costUsd: 4.212 });
  assert.equal(summary, "run run-a done · 3/3 nodes · $4.21");
});

test("renderNotification: run.terminal with unfinished nodes is attention, and omits cost when unknown", () => {
  const summary = renderNotification({ type: "run.terminal", runId: "run-a", done: 2, total: 3 });
  assert.equal(summary, "run run-a attention · 2/3 nodes");
});

test("renderNotification: attention names the node and error code", () => {
  const summary = renderNotification({ type: "attention", runId: "run-a", nodeId: "build", errorCode: "judge_unavailable" });
  assert.equal(summary, "node build needs you · run run-a · judge_unavailable");
});

test("renderNotification: a run-level attention with no node still names the run", () => {
  const summary = renderNotification({ type: "attention", runId: "run-a", errorCode: "judge_unavailable" });
  assert.equal(summary, "run run-a needs you · judge_unavailable");
});

test("renderNotification: an unknown event type throws rather than guessing a template", () => {
  assert.throws(() => renderNotification(/** @type {any} */ ({ type: "bogus", runId: "run-a" })), /unknown event type bogus/u);
});

test("renderNotification: every template stays under the 200-character bound", () => {
  const long = "x".repeat(500);
  const summaries = [
    renderNotification({ type: "node.terminal", runId: long, nodeId: long, status: "failed", attempt: 99, errorCode: long, runDir: long }),
    renderNotification({ type: "run.terminal", runId: long, done: 1, total: 2, costUsd: 123456.789 }),
    renderNotification({ type: "attention", runId: long, nodeId: long, errorCode: long }),
  ];
  for (const summary of summaries) {
    assert.ok(summary.length <= SUMMARY_CHARS, `${summary.length} > ${SUMMARY_CHARS}`);
    assert.ok(summary.endsWith("…"), "an over-long summary is marked as cut");
  }
});

test("NotifyQueue.enqueue reads the run's own status.json for the resume path and cost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-queue-"));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ usage: { costUsd: 1.5 } }));
  /** @type {unknown[]} */
  const delivered = [];
  const queue = new NotifyQueue({ runDir, deliver: async (event) => { delivered.push(event); return { ok: true }; } });

  await queue.enqueue({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "failed", attempt: 1, errorCode: "verification_failed" });
  await queue.enqueue({ type: "run.terminal", runId: "run-a", done: 1, total: 1 });

  assert.equal(/** @type {{summary: string}} */ (delivered[0]).summary, `node build failed · run run-a · attempt 1 · verification_failed · resume ${runDir}`);
  assert.equal(/** @type {{summary: string}} */ (delivered[1]).summary, "run run-a done · 1/1 nodes · $1.50");

  const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["delivered", "delivered"]);
});

test("NotifyQueue.enqueue tolerates a missing status.json: no resume cost, no crash", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-queue-missing-"));
  /** @type {unknown[]} */
  const delivered = [];
  const queue = new NotifyQueue({ runDir, deliver: async (event) => { delivered.push(event); return { ok: true }; } });
  await queue.enqueue({ type: "run.terminal", runId: "run-a", done: 1, total: 1 });
  assert.equal(/** @type {{summary: string}} */ (delivered[0]).summary, "run run-a done · 1/1 nodes");
});

test("notify is lossy", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-lossy-"));
  let attempts = 0;
  const queue = new NotifyQueue({
    runDir,
    now: () => 1_700_000_000_000,
    deliver: async () => {
      attempts += 1;
      return { ok: false, error: "transport unavailable" };
    },
  });

  await queue.enqueue({
    type: "node.terminal",
    runId: "run-a",
    nodeId: "build",
    status: "failed",
    attempt: 1,
    dedupeKey: "node.terminal:run-a:build:failed:1:0",
  });

  // One attempt: the failure is dropped, never requeued and never rescheduled.
  assert.equal(attempts, 1, "a failed delivery is attempted exactly once");
  assert.equal(Object.hasOwn(queue, "pending"), false, "no pending queue exists to hold another attempt");
  const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts.length, 1, "exactly one receipt is written");
  assert.equal(receipts[0].status, "failed");
  assert.equal(receipts[0].attempt, 1);
  assert.equal(receipts[0].error, "transport unavailable");
  assert.equal(receipts[0].dedupeKey, "node.terminal:run-a:build:failed:1:0");

  // A transport that rejects is not a special case: it is a failed delivery
  // too. The receipt is still written, the rejection never escapes enqueue,
  // and no second attempt is scheduled.
  const rejectingRunDir = mkdtempSync(join(tmpdir(), "notify-lossy-reject-"));
  let rejectingAttempts = 0;
  const rejecting = new NotifyQueue({
    runDir: rejectingRunDir,
    now: () => 1_700_000_000_000,
    deliver: async () => {
      rejectingAttempts += 1;
      throw new Error("transport exploded");
    },
  });

  await rejecting.enqueue({
    type: "node.terminal",
    runId: "run-a",
    nodeId: "build",
    status: "failed",
    attempt: 1,
    dedupeKey: "node.terminal:run-a:build:failed:1:0",
  });

  assert.equal(rejectingAttempts, 1, "a rejected delivery is attempted exactly once and never requeued");
  assert.equal(Object.hasOwn(rejecting, "pending"), false, "no pending queue exists to hold another attempt");
  const rejectedReceipts = readFileSync(join(rejectingRunDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rejectedReceipts.length, 1, "a rejected delivery still writes exactly one receipt");
  assert.equal(rejectedReceipts[0].status, "failed");
  assert.equal(rejectedReceipts[0].attempt, 1);
  assert.equal(rejectedReceipts[0].error, "transport exploded");
});

test("notificationDeliveryTimeoutMs is measured headroom above the old 5s budget, within the 15s ceiling", () => {
  assert.ok(notificationDeliveryTimeoutMs > 5_000, "raised past the budget that measurably timed out under load");
  assert.ok(notificationDeliveryTimeoutMs <= 15_000, "a genuinely wedged transport still settles in bounded time");
});

test("spawnDeliver (through NotifyQueue's default transport) survives a bin slower than the old 5s budget", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-slow-transport-"));
  const bin = join(mkdtempSync(join(tmpdir(), "notify-slow-bin-")), "slow-notify.mjs");
  writeFileSync(bin, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 5300);\n`);
  chmodSync(bin, 0o755);
  const previous = process.env.FABERUN_NOTIFY_BIN;
  process.env.FABERUN_NOTIFY_BIN = bin;
  try {
    const queue = new NotifyQueue({ runDir });
    await queue.enqueue({ type: "run.terminal", runId: "run-a", done: 1, total: 1 });
  } finally {
    if (previous === undefined) delete process.env.FABERUN_NOTIFY_BIN;
    else process.env.FABERUN_NOTIFY_BIN = previous;
  }
  const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts[0].status, "delivered", "a bin slower than the old 5000ms default still delivers under the raised budget");
});

