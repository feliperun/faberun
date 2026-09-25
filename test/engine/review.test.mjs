import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { SPAWN_WAIT_FACTOR, fakeCodex, fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, notifications, withAdvisoryGateCodex, withBrokenGateCodex, withJudgeDefectCodex, withStallingJudgeCodex } from "../runner-helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";



test("marks a silent provider stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-stall-"));
  mkdirSync(join(directory, "work"));
  writeFileSync(join(directory, "work", "README.md"), "read me");
  const path = writeContract(directory, fixture({
    id: "stall-run",
    cwd: "work",
    pollIntervalMs: 10,
    stallTimeoutSec: 0.05,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"] }), gate: false }],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = fakeCodex(directory, "silent");
  try {
    const result = await runContract(path);
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "stalled");
    const records = readFileSync(join(result.runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].unknownReason, "invocation-killed", "the scheduler records the stall kill before settling the node");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});


test("default review is advisory and the node records that it reviewed advisorially", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-default-"));
  const path = writeContract(directory, fixture({
    id: "review-default-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["minor", "major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.review, "advisory", "an omitted review mode reviews advisorially");
  assert.equal(state.revisions, 0, "an advisory finding never consumes a revision");
  assert.equal(state.gate?.verdict, "fail");
  assert.equal(state.gate?.findings.length, 1);
});


test("an advisory fail verdict reaches done with findings and a gate.advisory event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-advisory-"));
  const path = writeContract(directory, fixture({
    id: "review-advisory-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "advisory", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done");
  assert.equal(state.review, "advisory");
  assert.equal(state.revisions, 0, "an advisory review never consumes a revision");
  assert.equal(state.gate?.verdict, "fail", "the fail verdict is recorded with its findings");
  assert.equal(state.gate?.maxSeverity, "critical");
  assert.equal(state.gate?.findings[0].description, "broken [works]");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const advisory = events.find((event) => event.type === "gate.advisory");
  assert.ok(advisory, "the advisory settle appends a gate.advisory event");
  assert.equal(advisory.verdict, "fail");
  assert.equal(advisory.node, "build");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /advisory: 1 finding/u, "the status note leads with the advisory finding the gate summary would hide");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-dispatched");
});


test("blocking review is unchanged: a cited fail at the threshold consumes its revision and exhausts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-blocking-"));
  const path = writeContract(directory, fixture({
    id: "review-blocking-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, false);
  assert.equal(state.status, "exhausted");
  assert.equal(state.review, "blocking");
  assert.equal(state.error?.code, "revision_cap");
  assert.equal(state.revisions, 0);
  assert.equal(state.attempt, 1, "maxRevisions 0 grants no revision");
});


test("review none skips the judge and settles on the mechanical verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-none-"));
  const path = writeContract(directory, fixture({
    id: "review-none-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "none" },
    }],
  }));
  // A provider whose judge would reject everything proves the judge never runs.
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done");
  assert.equal(state.review, "none");
  assert.equal(state.gate?.verdict, "pass", "the checklist settles mechanically");
  assert.equal(state.gate?.findings.length, 0);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge is ever dispatched");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});


test("two separate agent-message verdicts re-ask once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-two-verdicts-"));
  const path = writeContract(directory, fixture({
    id: "review-two-verdicts-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.revisions, 0, "a judge protocol defect never consumes a revision");
  assert.equal(state.attempt, 1);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask");
  assert.equal(state.gate?.summary, "clean re-ask");
});


test("a provider failure on the bounded re-ask blocks, then gets its one automatic retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-reask-fail-"));
  const path = writeContract(directory, fixture({
    id: "review-reask-fail-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts-then-fail", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge", "the node is left exactly as one awaiting its judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "the failed re-ask settles, then the one automatic retry runs before blocking");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
});


test("an empty judge output re-asks once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-empty-output-"));
  const path = writeContract(directory, fixture({
    id: "review-empty-output-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "empty-output", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask after empty output");
  assert.equal(state.gate?.summary, "clean re-ask");
});


test("a missing terminal envelope re-asks once and the re-ask recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-no-terminal-"));
  const path = writeContract(directory, fixture({
    id: "review-no-terminal-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "no-terminal", {}, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask after an incomplete stream");
  assert.equal(state.gate?.summary, "clean re-ask");
});


test("a judge timeout re-asks once then blocks as judge_unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-judge-timeout-"));
  const path = writeContract(directory, fixture({
    id: "review-judge-timeout-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      // The worker has to finish inside this for the judge to be reached at
      // all. Measured: at 1s the worker itself timed out on Windows CI
      // (2026-09-21) and under parallel load on macOS (RM-056), and the
      // test proved nothing about the judge. The judge spends it three times.
      timeoutSec: 3 * SPAWN_WAIT_FACTOR,
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withStallingJudgeCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "the wall-clock kill earns one bounded re-ask plus the one automatic retry");
  assert.equal(state.gate, null, "no verdict is fabricated for a judge that never returned one");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
});


test("advisory review settles invalid_judge_output and completes with the work recorded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-invalid-advisory-"));
  const path = writeContract(directory, fixture({
    id: "review-invalid-advisory-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "advisory", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", { again: true }, () => runContract(path));
  const state = nodeState(result);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.gate?.verdict, "invalid_judge_output");
  assert.equal(state.gate?.findings.length, 0, "an invalid verdict records no findings");
  assert.match(state.gate?.summary ?? "", /2 separate verdicts/u);
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "exactly one bounded re-ask");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "gate.advisory" && event.verdict === "invalid_judge_output"));
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "invalid_judge_output"), "the defective review is never silent");
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /judge: invalid output/u);
});


test("blocking review enters judge_unavailable with the worker result and verification preserved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-invalid-blocking-"));
  const path = writeContract(directory, fixture({
    id: "review-invalid-blocking-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withJudgeDefectCodex(directory, "two-verdicts", { again: true }, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge", "the node is left exactly as one awaiting its judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal(state.gate, null, "the gate state stays empty until a verdict exists");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete", "the accepted worker result is preserved");
  assert.equal(state.verification?.passed, true, "the verification records are preserved");
  assert.equal(state.revisions, 0, "a review that never arbitrated consumes no revision");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "the bounded re-ask plus the one automatic retry");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
  assert.match(readFileSync(join(result.runDir, "STATUS.md"), "utf8"), /needs you: judge unavailable/u);
});


test("a verification proof reuses the recorded result and executes nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-review-proof-reuse-"));
  // Writing into the run directory keeps the counter outside the workspace
  // snapshot, so the scope gate never sees the probe.
  const executions = join(runDirectory(directory, "proof-reuse-run"), "verification-executions");
  const path = writeContract(directory, fixture({
    id: "proof-reuse-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({
        verification: [{ argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(executions)}, "x\\n")`] }],
      }),
      definitionOfDone: [
        { id: "verified", text: "the controller verification passed", proof: { kind: "verification", ref: 0 } },
        { id: "works", text: "It works", judgment: true },
      ],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withAdvisoryGateCodex(directory, () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  // Phase 1 added a second, independent run of the same verification
  // commands: the integration transaction re-verifies the sealed candidate
  // in its own scratch worktree before advancing the run ref. The judge's
  // "verified" proof still reuses the attempt's own recorded result rather
  // than triggering a run of its own — the candidate check is the only
  // reason this count is 2, not 1.
  assert.equal(readFileSync(executions, "utf8").trim().split("\n").filter(Boolean).length, 2, "the judge's verification proof reused the recorded result; only the candidate integration check re-ran the command");
  const proof = state.gate?.findings ?? [];
  assert.equal(proof.length, 1, "the advisory verdict is the only finding on the node");
  const prompt = readFileSync(join(result.runDir, "logs", "build.1.judge.jsonl"), "utf8");
  assert.ok(prompt.length > 0);
});



test("enforces the wall-clock cap even while output changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-timeout-"));
  const path = writeContract(directory, fixture({
    id: "timeout-run",
    pollIntervalMs: 10,
    stallTimeoutSec: 1,
    timeoutSec: 0.05,
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = fakeCodex(directory, "heartbeat");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "exhausted");
    const timedOut = nodeState(result);
    assert.ok(timedOut.error, "timeout records an error");
    assert.equal(timedOut.error.code, "wall_clock_timeout");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});


test("spends the wall-clock budget per phase, not per node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-budget-"));
  const path = writeContract(directory, fixture({
    id: "phase-budget-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  // The worker takes 3.5s of a 5s budget. A node-wide clock leaves the judge
  // 1.5s for work that needs 2s and kills a healthy reviewer.
  const result = await withFakeCodex(directory, "slow", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.ok(state.gate, "judge gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
});

// R14 across the review path: the revision boundary clears the routing
// override, so the next attempt's runtime is decided by attempt affinity --
// the previous attempt's runtime while it stays healthy -- not by bouncing
// back to the assignment the failover hop left.

/**
 * A judge provider whose first review rejects with a cited finding and whose
 * second passes, counting reviews in a file kept outside the workspace so the
 * unexpected-write gate never sees the counter.
 *
 * @param {string} path @param {string} counter @returns {void}
 */
function writeReReviewJudge(path, counter) {
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("re-review-judge 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  console.log(JSON.stringify({ type: "thread.started", thread_id: "re-review-judge" }));
  if (!prompt.startsWith("Review node")) {
    const text = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  appendFileSync(${JSON.stringify(counter)}, "review\\n");
  const seen = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").length;
  const verdict = seen === 1
    ? { verdict: "fail", maxSeverity: "major", summary: "defect", findings: [{ severity: "major", description: "broken [works]", evidence: "test failed" }] }
    : { verdict: "pass", maxSeverity: "none", summary: "clean re-review", findings: [] };
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
});
`);
  chmodSync(path, 0o755);
}

const RE_REVIEW_NODE = {
  id: "build",
  type: "backend",
  taskPacket: packet(),
  definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  gate: { review: "blocking", failOn: ["major", "critical"] },
};

test("attempt affinity holds the failover runtime across the review path's next revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-affinity-review-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-affinity-reviews-"));
  const judge = join(outside, "affinity-judge.mjs");
  writeReReviewJudge(judge, join(outside, "reviews.txt"));
  const path = writeContract(directory, fixture({
    id: "affinity-review-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "primary", judge: "arbiter" },
    runtimes: {
      primary: { harness: "codex", model: "primary", executable: fakeCodex(directory, "quota-429"), fallback: "backup" },
      backup: { harness: "codex", model: "backup", executable: fakeCodex(directory, "pass") },
      arbiter: { harness: "codex", model: "arbiter", config: { model_provider: "deepseek" }, executable: judge },
    },
    nodes: [RE_REVIEW_NODE],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.gate?.summary, "clean re-review", "the node settled on the second review, not the first");
  assert.deepEqual(
    (state.invocations ?? []).filter((invocation) => invocation.phase === "worker").map((invocation) => invocation.runtimeId),
    ["primary", "backup", "backup"],
    "revision 1 reuses the runtime that finished revision 0, not the assignment the hop left",
  );
  assert.deepEqual(
    (state.routing?.history ?? []).map((entry) => entry.nextRuntime),
    ["backup"],
    "the only route the failure earned was the declared edge",
  );
});

test("attempt affinity holds the judge's failover runtime across the revision it rejected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-affinity-judge-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-affinity-judge-reviews-"));
  const reserve = join(outside, "reserve-judge.mjs");
  writeReReviewJudge(reserve, join(outside, "judge-reviews.txt"));
  const path = writeContract(directory, fixture({
    id: "affinity-judge-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "primary", judge: "first" },
    runtimes: {
      primary: { harness: "codex", model: "primary", executable: fakeCodex(directory, "pass") },
      first: { harness: "codex", model: "first", config: { model_provider: "deepseek" }, executable: fakeCodex(directory, "quota-429"), fallback: "second" },
      second: { harness: "codex", model: "second", config: { model_provider: "deepseek" }, executable: reserve },
    },
    nodes: [RE_REVIEW_NODE],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.gate?.summary, "clean re-review", "the node settled on the second review, not the first");
  assert.deepEqual(
    (state.invocations ?? []).filter((invocation) => invocation.phase === "judge").map((invocation) => invocation.runtimeId),
    ["first", "second", "second"],
    "the re-review reuses the judge runtime that holds the review's context, not the assignment the hop left",
  );
  assert.deepEqual(
    (state.invocations ?? []).filter((invocation) => invocation.phase === "worker").map((invocation) => invocation.runtimeId),
    ["primary", "primary"],
  );
});
