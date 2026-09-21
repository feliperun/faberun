import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyQueue, readInbox, renderNotification } from "../../src/notify/index.mjs";
import { emitScheduledAttention } from "../../src/engine/notify-queue.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { nodeState, recordingNotifyTransport, resultFileCodex, withResultFileCodex } from "../runner-helpers.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

const SUMMARY_CHARS = 200;

// These calls omit `runDir` (or, for the two that supply one, name a
// directory with no readable run scaffold), so every one of them exercises
// `renderNotification`'s degraded, one-line fallback template -- the same
// text this module rendered before `renderRunProgress` existed. The primary,
// `renderRunProgress`-delegating path is exercised further down, against a
// real run.

test("renderNotification: node.terminal done names the run and attempt, no resume", async () => {
  const summary = await renderNotification({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "done", attempt: 1 });
  assert.equal(summary, "node build done · run run-a · attempt 1");
});

test("renderNotification: node.terminal failure adds the error code and a resume path", async () => {
  const summary = await renderNotification({
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

test("renderNotification: node.terminal done never shows a resume path even when one is present", async () => {
  const summary = await renderNotification({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "done", attempt: 1, runDir: "/repo/.runs/run-a" });
  assert.equal(summary, "node build done · run run-a · attempt 1");
});

test("renderNotification: run.terminal done names the done/total count and cost when known", async () => {
  const summary = await renderNotification({ type: "run.terminal", runId: "run-a", done: 3, total: 3, costUsd: 4.212 });
  assert.equal(summary, "run run-a done · 3/3 nodes · $4.21");
});

test("renderNotification: run.terminal with unfinished nodes is attention, and omits cost when unknown", async () => {
  const summary = await renderNotification({ type: "run.terminal", runId: "run-a", done: 2, total: 3 });
  assert.equal(summary, "run run-a attention · 2/3 nodes");
});

test("renderNotification: attention names the node and error code", async () => {
  const summary = await renderNotification({ type: "attention", runId: "run-a", nodeId: "build", errorCode: "judge_unavailable" });
  assert.equal(summary, "node build needs you · run run-a · judge_unavailable");
});

test("renderNotification: a run-level attention with no node still names the run", async () => {
  const summary = await renderNotification({ type: "attention", runId: "run-a", errorCode: "judge_unavailable" });
  assert.equal(summary, "run run-a needs you · judge_unavailable");
});

test("renderNotification: an unknown event type throws synchronously rather than guessing a template", () => {
  assert.throws(() => renderNotification(/** @type {any} */ ({ type: "bogus", runId: "run-a" })), /unknown event type bogus/u);
});

test("renderNotification: the degraded fallback stays under the 200-character bound", async () => {
  const long = "x".repeat(500);
  const summaries = await Promise.all([
    renderNotification({ type: "node.terminal", runId: long, nodeId: long, status: "failed", attempt: 99, errorCode: long, runDir: long }),
    renderNotification({ type: "run.terminal", runId: long, done: 1, total: 2, costUsd: 123456.789 }),
    renderNotification({ type: "attention", runId: long, nodeId: long, errorCode: long }),
  ]);
  for (const summary of summaries) {
    assert.ok(summary.length <= SUMMARY_CHARS, `${summary.length} > ${SUMMARY_CHARS}`);
    assert.ok(summary.endsWith("…"), "an over-long summary is marked as cut");
  }
});

test("renderNotification: delegates to renderRunProgress for a real run, and both callers of it get the exact same string", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notify-delegates-"));
  const path = writeContract(directory, fixture({
    id: "delegates-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withResultFileCodex(directory, "file-first", path);
  assert.equal(nodeState(result).status, "done");

  const { renderRunProgress } = await import("../../src/report/message.mjs");
  const event = { type: /** @type {const} */ ("run.terminal"), runId: "delegates-run", runDir: result.runDir, done: 1, total: 1 };
  const [fromNotify, fromProgress] = await Promise.all([
    renderNotification(event),
    renderRunProgress(result.runDir, event),
  ]);
  assert.equal(fromNotify, fromProgress, "renderNotification must render exactly what renderRunProgress renders, not a template of its own");
  assert.match(fromNotify, /campaign test-campaign/u, "the primary path renders the rich, multi-line progress message, not the degraded template");
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

test("spawnDeliver (through NotifyQueue's default transport) resolves on the bin's own exit, not on a grandchild holding stderr open", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-grandchild-"));
  const bin = join(mkdtempSync(join(tmpdir(), "notify-grandchild-bin-")), "holds-stderr.mjs");
  // The bin exits immediately after spawning a detached grandchild that
  // inherits its own fd 2 -- the write end of the pipe spawnDeliver reads as
  // `child.stderr` -- and holds it open for 3s. If delivery ever again waits
  // on `close` instead of `exit`, this test takes >3s (or times out at 5s);
  // resolving on `exit` settles in well under a second.
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { spawn } from "node:child_process";\n` +
      `process.stdin.resume();\n` +
      `process.stdin.on("end", () => {\n` +
      `  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "ignore", 2], detached: true });\n` +
      `  grandchild.unref();\n` +
      `  process.exit(0);\n` +
      `});\n`,
  );
  chmodSync(bin, 0o755);
  const previous = process.env.FABERUN_NOTIFY_BIN;
  process.env.FABERUN_NOTIFY_BIN = bin;
  try {
    const queue = new NotifyQueue({ runDir });
    const startedAt = Date.now();
    await queue.enqueue({ type: "run.terminal", runId: "run-a", done: 1, total: 1 });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2_000, `delivery should settle on the bin's own exit, not the grandchild's; took ${elapsedMs}ms`);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_NOTIFY_BIN;
    else process.env.FABERUN_NOTIFY_BIN = previous;
  }
  const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts[0].status, "delivered", "the bin's own exit code 0 is what determines delivery, independent of the grandchild");
});

test("emitScheduledAttention renders the message once: the inbox summary and the recording transport's stdin are byte-identical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notify-attention-parity-"));
  const path = writeContract(directory, fixture({
    id: "attention-parity-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previousCodex = process.env.FABERUN_CODEX_BIN;
  const previousNotify = process.env.FABERUN_NOTIFY_BIN;
  process.env.FABERUN_CODEX_BIN = resultFileCodex(directory, "file-first");
  const { executable, log } = recordingNotifyTransport(directory);
  process.env.FABERUN_NOTIFY_BIN = executable;
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "done");

    const runsDir = runsRoot(directory);
    // 15 minutes ago crosses the schedule's first (10-minute) slot.
    const anchor = new Date(Date.now() - 15 * 60_000).toISOString();
    const slot = await emitScheduledAttention(result.runDir, { anchor, code: "judge_unavailable", campaignId: null });
    assert.equal(slot, 0);

    const inboxEntry = readInbox(runsDir).find((entry) => entry.type === "attention");
    assert.ok(inboxEntry, "the scheduled attention line reached the campaign inbox");

    const events = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const delivered = events.find((event) => event.type === "attention");
    assert.ok(delivered, "the recording transport received the attention event");
    assert.equal(delivered.summary, inboxEntry.summary, "the inbox and the transport must carry the exact same rendered text");
  } finally {
    if (previousCodex === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previousCodex;
    if (previousNotify === undefined) delete process.env.FABERUN_NOTIFY_BIN;
    else process.env.FABERUN_NOTIFY_BIN = previousNotify;
  }
});

test("a run driven through withResultFileCodex never reaches a FABERUN_NOTIFY_BIN left bound in the environment", async () => {
  // Simulates the owner's shell, where FABERUN_NOTIFY_BIN already names the
  // real transport before any test runs: the poison program marks that it
  // ran, which the assertion below refuses.
  const directory = mkdtempSync(join(tmpdir(), "notify-isolation-"));
  const poisonMarker = join(directory, "poison-ran.txt");
  const poison = join(mkdtempSync(join(tmpdir(), "notify-poison-bin-")), "poison.mjs");
  writeFileSync(poison, `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(poisonMarker)}, "ran");
  process.exit(0);
});
`);
  chmodSync(poison, 0o755);

  const path = writeContract(directory, fixture({
    id: "notify-isolation-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));

  const previous = process.env.FABERUN_NOTIFY_BIN;
  process.env.FABERUN_NOTIFY_BIN = poison;
  try {
    const result = await withResultFileCodex(directory, "file-first", path);
    assert.equal(nodeState(result).status, "done");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_NOTIFY_BIN;
    else process.env.FABERUN_NOTIFY_BIN = previous;
  }

  assert.equal(existsSync(poisonMarker), false, "the transport left bound in the environment must never run during a test");
  const events = readFileSync(join(runsRoot(directory), "notify-record.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(
    events.some((event) => event.type === "node.terminal" && event.nodeId === "build"),
    "the recording fixture bound in place of the poisoned transport captured the terminal event",
  );
});

