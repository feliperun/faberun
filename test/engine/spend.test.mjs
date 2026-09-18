import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { forceFreshSession } from "../../src/engine/dispatch.mjs";
import { applyRejection } from "../../src/engine/settle.mjs";
import { emitNodeAdvisory, emitNodeAdvisories, nodeAdvisoryCrossings, notifyQueuesByRun } from "../../src/engine/notify-queue.mjs";
import {
  CACHE_READ_PER_REVISION_ARTIFACT,
  cacheReadPerRevisionArtifact,
  measureCacheReadPerRevision,
  writeCacheReadPerRevisionArtifact,
} from "../../src/run/usage.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { nodeState, withBrokenGateCodex } from "../runner-helpers.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * A codex-shaped provider whose worker prompts are logged, and whose judge
 * rejects with a cited critical finding on its first round and passes after,
 * so a bounded gate revision spends exactly one retry worker dispatch.
 *
 * @param {string} directory
 * @returns {{executable: string, promptLog: string}}
 */
function retryPromptCodex(directory) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-spend-retry-")), "retry-prompt.mjs");
  const promptLog = join(runsRoot(directory), "spend-retry-prompts.txt");
  const judges = join(runsRoot(directory), "spend-retry-judges");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const promptLog = ${JSON.stringify(promptLog)};
const judges = ${JSON.stringify(judges)};
if (process.argv.includes("--version")) {
  console.log("spend-retry 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    const resultPath = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1];
    if (judge) {
      appendFileSync(judges, "x\\n");
      const round = readFileSync(judges, "utf8").trim().split("\\n").filter(Boolean).length;
      const text = round === 1
        ? JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "item [works] is not satisfied", evidence: "quality is below the bar" }] })
        : JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
      console.log(JSON.stringify({ type: "thread.started", thread_id: "judge-thread-" + round }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } }));
      return;
    }
    appendFileSync(promptLog, prompt + "\\n=====SPEND-PROMPT=====\\n");
    const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "thread.started", thread_id: "worker-thread-" + (readFileSync(promptLog, "utf8").split("=====SPEND-PROMPT=====").length - 1) }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(executable, 0o755);
  return { executable, promptLog };
}

/** @template T @param {string} executable @param {() => T | Promise<T>} body @returns {Promise<T>} */
async function withCodex(executable, body) {
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = executable;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
}

/**
 * A codex-shaped provider whose worker writes the canonical result and then
 * stays alive briefly, so a duration advisory can fire while the node is still
 * running and is proven not to kill it.
 *
 * @param {number} [waitMs]
 * @returns {string}
 */
function slowResultCodex(waitMs = 400) {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-spend-slow-")), "slow-result.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const waitMs = ${waitMs};
if (process.argv.includes("--version")) {
  console.log("spend-slow 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const judge = input.startsWith("Review node");
    const resultPath = /canonical result file: (\\S+\\.json)/.exec(input)?.[1];
    console.log(JSON.stringify({ type: "thread.started", thread_id: "spend-slow-thread" }));
    const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    if (!judge && resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  });
}
`);
  chmodSync(executable, 0o755);
  return executable;
}

/**
 * Done-when 1. A gate retry dispatches with no continuation, through the real
 * scheduler, and the retry prompt still carries the bounded `## Previous
 * attempt` evidence. `forceFreshSession` is the carrier that survives the
 * scheduler's own policy-less `startWorker` call.
 */
test("a gate retry dispatches fresh through the real path and carries the previous-attempt evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-retry-"));
  const { executable, promptLog } = retryPromptCodex(directory);
  const path = writeContract(directory, fixture({
    id: "spend-retry-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const result = await withCodex(executable, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, state.error?.message);
  const workers = (state.invocations ?? []).filter((invocation) => invocation.role === "worker");
  assert.equal(workers.length, 2, "the gate spent one revision");
  assert.equal(workers[1].continuationMode, "fresh", "the retry does not reuse the failed transcript");
  const prompts = readFileSync(promptLog, "utf8").split("=====SPEND-PROMPT=====").map((entry) => entry.trim()).filter(Boolean);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /## Previous attempt/u, "the retry prompt carries the bounded evidence");
  assert.match(prompts[1], /item \[works\] is not satisfied/u, "the gate finding travels in the section");
  assert.match(prompts[1], /quality gate rejected/u);
});

test("forceFreshSession carries a persisted rejection policy into dispatch and consumes it once", () => {
  const state = { id: "build", sessionPolicy: { forceFresh: true } };
  assert.deepEqual(forceFreshSession(state), { forceFresh: true }, "the persisted policy reaches the planner");
  assert.equal(state.sessionPolicy, null, "the policy is one-shot");
  assert.deepEqual(forceFreshSession(state), {}, "a consumed policy does not govern later attempts");
  assert.deepEqual(forceFreshSession(state, { forceFresh: true }), { forceFresh: true }, "an explicit decision still wins on the spot");
});

test("applyRejection with no live dispatch persists the fresh-session policy on the node", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-reject-"));
  const contractPath = writeContract(directory, fixture({
    id: "spend-reject-run",
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  const runDir = runDirectory(directory, "spend-reject-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const state = /** @type {import("../../src/contract/index.mjs").NodeSnapshot} */ ({
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
    judgeFailures: 0,
    runtime: null,
    blockedBy: [],
    startedAt: NOW,
    updatedAt: NOW,
    result: null,
    gate: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    routing: null,
    progress: null,
    worktree: null,
    invocations: [],
    executionOverrides: [],
    verification: null,
    scope: null,
    scopeFindings: null,
  });
  const verdict = /** @type {import("../../src/engine/prompts.mjs").JudgeVerdict} */ ({ verdict: "fail", maxSeverity: "critical", summary: "critical defect", findings: [{ severity: "critical", description: "broken [works]", evidence: "e" }] });
  applyRejection(contract, node, state, runDir, null, /** @type {any} */ (null), new Map([[node.id, state]]), contractPath, verdict, { code: "revision_cap", label: "gate", phase: "judge" });
  assert.equal(state.status, "pending", "the retry is handed to the scheduler");
  assert.deepEqual(state.sessionPolicy, { forceFresh: true }, "the fresh-session decision travels with the node");
  const persisted = JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8"));
  assert.deepEqual(persisted.sessionPolicy, { forceFresh: true }, "the policy survives on disk for the scheduler dispatch");
  // The scheduler's own `startWorker` call carries no argument; this is exactly
  // the resolution it performs.
  assert.deepEqual(forceFreshSession(state), { forceFresh: true });
  assert.equal(state.sessionPolicy, null);
});

/**
 * Done-when 5, the integration half: `skipWhen` with both conditions true skips
 * a judge that would otherwise reject, even though the node carries a judgment
 * item. The provider's judge always fails, so a `done` node proves it never ran.
 */
test("skipWhen skips a judge that would reject when verification is green and the change is small", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-skip-"));
  const path = writeContract(directory, fixture({
    id: "spend-skip-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0, skipWhen: { verificationGreen: true, maxChangedPaths: 5 } },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.role === "judge").length, 0, "the judge is skipped despite the judgment item");
});

/**
 * Done-when 6 and 7. A node crossing its configured duration emits the advisory
 * through the inbox and is not killed: it completes on its own. The advisory is
 * one-shot per node per threshold, and a restarted controller that reloads the
 * durable receipts does not re-fire it.
 */
test("a duration advisory is delivered through the inbox, never kills the node, and is one-shot across a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-advisory-"));
  const path = writeContract(directory, fixture({
    id: "spend-advisory-run",
    pollIntervalMs: 10,
    nodeAdvisory: { durationSec: 0 },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const executable = slowResultCodex(400);
  const result = await withCodex(executable, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, state.error?.message);
  assert.equal(state.status, "done", "the advisory never stops the node");
  const runsDir = runsRoot(directory);
  const inbox = readFileSync(join(runsDir, "inbox.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "advisory");
  assert.equal(inbox.length, 1, "exactly one advisory for the one crossed threshold");
  assert.equal(inbox[0].nodeId, "build");
  assert.match(inbox[0].dedupeKey, /node\.advisory:spend-advisory-run:build:duration/u);
  assert.match(inbox[0].summary, /advisory duration/u);
  const receipts = readFileSync(join(result.runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(receipts.some((receipt) => receipt.dedupeKey === inbox[0].dedupeKey), "the line reached the run queue too");
  // A fresh controller has an empty in-memory registry; the durable receipt is
  // what keeps it from re-firing.
  notifyQueuesByRun.clear();
  const refired = await emitNodeAdvisory(result.runDir, "test-campaign", state, { kind: "duration", threshold: 0, value: 1 });
  assert.equal(refired, false, "a restarted controller reads the receipt and does not re-fire");
  assert.equal(readFileSync(join(runsDir, "inbox.jsonl"), "utf8").trim().split("\n").length, 1);
  // The one-shot is per node per threshold, not per node per kind: a raised
  // ceiling is a new crossing and must not be silenced by the old receipt.
  const reThresholded = await emitNodeAdvisory(result.runDir, "test-campaign", state, { kind: "duration", threshold: 120, value: 150 });
  assert.equal(reThresholded, true, "a different threshold is a new one-shot key");
  assert.equal(readFileSync(join(runsDir, "inbox.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("cost advisories fire once when a new usage record arrives, with a null cost never crossing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-cost-"));
  const runDir = runDirectory(directory, "run-a");
  mkdirSync(runDir, { recursive: true });
  const policy = { costUsd: 1 };
  assert.deepEqual(nodeAdvisoryCrossings({ id: "build", startedAt: NOW, costUsd: null }, policy), [], "an unavailable cost never fabricates a crossing");
  assert.deepEqual(nodeAdvisoryCrossings({ id: "build", startedAt: NOW, costUsd: 0.5 }, policy), [], "below threshold");
  const crossings = nodeAdvisoryCrossings({ id: "build", startedAt: NOW, costUsd: 2.5 }, policy);
  assert.deepEqual(crossings, [{ kind: "cost", threshold: 1, value: 2.5 }]);
  const state = { id: "build", startedAt: NOW, costUsd: 2.5 };
  assert.equal(await emitNodeAdvisory(runDir, "camp", state, crossings[0]), true);
  assert.equal(await emitNodeAdvisory(runDir, "camp", state, crossings[0]), false, "one-shot per node per threshold");
  // `emitNodeAdvisories` is the per-tick entry the control loop calls.
  const tick = await emitNodeAdvisories({ campaignId: "camp", nodeAdvisory: policy, nodes: [{ id: "build" }] }, runDir, new Map([["build", state]]));
  assert.equal(tick, 0);
  const inbox = readFileSync(join(dirname(runDir), "inbox.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].summary, /\$1\.000000/u);
  assert.match(inbox[0].summary, /\$2\.500000/u);
});

/**
 * Done-when 2. `cacheReadPerRevision` is the measured metric over the declared
 * before/after cohorts; when the after cohort records no gate revision the
 * artifact says so explicitly rather than presenting an empty comparison.
 */
test("the cacheReadPerRevision artifact records the measurement and an absent after cohort explicitly", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-spend-artifact-"));
  const beforeDir = join(directory, "before");
  const afterDir = join(directory, "after");
  writeCohortRun(beforeDir, "cohort-before", { revisions: 2, retries: [{ attempt: 2, cacheRead: 1000 }] });
  writeCohortRun(afterDir, "cohort-after", { revisions: 0, retries: [] });
  const before = measureCacheReadPerRevision([join(beforeDir, "cohort-before")]);
  const after = measureCacheReadPerRevision([join(afterDir, "cohort-after")]);
  assert.equal(before.gateRevisions, 2);
  assert.equal(before.cacheReadTokens, 1000);
  assert.equal(before.cacheReadPerRevision, 500, "cache-read tokens divided by gate revisions");
  assert.equal(after.gateRevisions, 0);
  assert.equal(after.cacheReadPerRevision, null, "no division by zero");
  const artifact = cacheReadPerRevisionArtifact(before, after, { changeCommit: "deadbeef", generatedAt: NOW, runDirs: { before: ["cohort-before"], after: ["cohort-after"] } });
  assert.equal(artifact.metric, "cacheReadPerRevision");
  assert.equal(artifact.status, "no_post_change_revision");
  assert.match(/** @type {string} */ (artifact.note), /no post-change gate revision/u);
  const written = writeCacheReadPerRevisionArtifact(join(directory, CACHE_READ_PER_REVISION_ARTIFACT), before, after, { changeCommit: "deadbeef", generatedAt: NOW });
  assert.equal(written, join(directory, CACHE_READ_PER_REVISION_ARTIFACT));
  assert.equal(existsSync(written), true);
  const reread = JSON.parse(readFileSync(written, "utf8"));
  assert.equal(reread.status, "no_post_change_revision");
  assert.equal(reread.after.cacheReadPerRevision, null);
  // A post-change revision flips the artifact to a real comparison.
  writeCohortRun(afterDir, "cohort-after", { revisions: 1, retries: [{ attempt: 2, cacheRead: 300 }] });
  const measured = cacheReadPerRevisionArtifact(before, measureCacheReadPerRevision([join(afterDir, "cohort-after")]), { changeCommit: "deadbeef" });
  assert.equal(measured.status, "measured");
});

/**
 * @param {string} base
 * @param {string} name
 * @param {{revisions: number, retries: {attempt: number, cacheRead: number}[]}} run
 */
function writeCohortRun(base, name, run) {
  const runDir = join(base, name);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const invocations = [
    { role: "worker", attempt: 1, usage: { cacheReadInputTokens: 500 } },
    ...run.retries.map((retry) => ({ role: "worker", attempt: retry.attempt, usage: { cacheReadInputTokens: retry.cacheRead } })),
  ];
  writeFileSync(join(runDir, "nodes", "build.json"), `${JSON.stringify({ revisions: run.revisions, invocations })}\n`);
}
