import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, persistFailure, RUNNER_CLI } from "../runner-helpers.mjs";
import { snapshot } from "../contract/helpers.mjs";
import { envelope, workerResult, writeRecording } from "../harnesses/replay-helpers.mjs";

/**
 * The persisted execution overrides of a node, read back from disk.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {Record<string, unknown>[]}
 */
function persistedOverrides(runDir, nodeId) {
  const state = JSON.parse(readFileSync(join(runDir, "nodes", `${nodeId}.json`), "utf8"));
  return /** @type {Record<string, unknown>[]} */ (state.executionOverrides ?? []);
}

test("resume --answer records an operator-answer override and re-dispatches only the answered node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-record-"));
  const path = writeContract(directory, fixture({
    id: "answer-record-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet({ objective: "Alpha" }), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Beta" }), gate: false },
    ],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  persistFailure(runDir, "alpha", { status: "blocked", code: "context_missing" });
  persistFailure(runDir, "beta", { status: "blocked", code: "context_missing" });

  const answerPath = join(directory, "answer.txt");
  writeFileSync(answerPath, "The missing context is the API key.");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir, { answer: { node: "alpha", path: answerPath } }));
  const alpha = nodeState(resumed, "alpha");
  const beta = nodeState(resumed, "beta");

  assert.equal(alpha.attempt, 2, "the answered node is re-dispatched");
  const overrides = persistedOverrides(runDir, "alpha");
  const answerOverride = overrides.find((item) => item.kind === "operator-answer");
  assert.ok(answerOverride, "the answer is persisted as an operator-answer override");
  assert.equal(answerOverride.text, "The missing context is the API key.");
  assert.equal(typeof answerOverride.at, "string", "the override carries at");
  assert.equal(typeof answerOverride.reason, "string", "the override carries reason");

  assert.equal(beta.attempt, 1, "another blocked_context node stays skipped");
  assert.equal(beta.status, "blocked");
  assert.equal(persistedOverrides(runDir, "beta").some((item) => item.kind === "operator-answer"), false);
});

test("without --answer a blocked_context node stays blocked and unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-noop-"));
  const path = writeContract(directory, fixture({ id: "answer-noop-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  persistFailure(runDir, "build", { status: "blocked", code: "context_missing" });

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "context_missing");
  assert.equal(state.attempt, 1, "no attempt is spent without the flag");
  assert.equal(persistedOverrides(runDir, "build").length, 0);
});

test("a second resume --answer appends a second operator-answer record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-append-"));
  const path = writeContract(directory, fixture({ id: "answer-append-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);

  persistFailure(runDir, "build", { status: "blocked", code: "context_missing" });
  const first = join(directory, "first.txt");
  writeFileSync(first, "first answer");
  await withFakeCodex(directory, "pass", () => resumeRun(runDir, { answer: { node: "build", path: first } }));

  // The answered node was re-dispatched; re-block it before the second answer.
  persistFailure(runDir, "build", { status: "blocked", code: "context_missing" });
  const second = join(directory, "second.txt");
  writeFileSync(second, "second answer");
  await withFakeCodex(directory, "pass", () => resumeRun(runDir, { answer: { node: "build", path: second } }));

  const answers = persistedOverrides(runDir, "build").filter((item) => item.kind === "operator-answer");
  assert.equal(answers.length, 2, "a repeated answer appends rather than replaces");
  assert.equal(answers[0]?.text, "first answer");
  assert.equal(answers[1]?.text, "second answer");
});

test("resume --answer refuses an unknown node, a non-blocked node, an unreadable file, and an oversized file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-refusals-"));
  const path = writeContract(directory, fixture({ id: "answer-refusals-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);

  const okFile = join(directory, "ok.txt");
  writeFileSync(okFile, "an answer");
  const big = join(directory, "big.txt");
  writeFileSync(big, "x".repeat(8 * 1024 + 1));

  await withFakeCodex(directory, "pass", async () => {
    await assert.rejects(
      () => resumeRun(runDir, { answer: { node: "missing", path: okFile } }),
      /unknown node id: missing/u,
    );
    // `build` is done, not blocked on context, so the answer is refused.
    await assert.rejects(
      () => resumeRun(runDir, { answer: { node: "build", path: okFile } }),
      /not blocked on missing context/u,
    );
  });

  // Block the node first, so the file itself is what is refused next.
  persistFailure(runDir, "build", { status: "blocked", code: "context_missing" });
  await withFakeCodex(directory, "pass", async () => {
    await assert.rejects(
      () => resumeRun(runDir, { answer: { node: "build", path: join(directory, "nope.txt") } }),
      /cannot read answer file/u,
    );
    await assert.rejects(
      () => resumeRun(runDir, { answer: { node: "build", path: big } }),
      /answer file exceeds 8192 bytes/u,
    );
  });
});

test("resume --answer rejects a malformed value before touching the run", () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ["badvalue", /--answer must be <node-id>=<path>/u],
    ["=path", /--answer node id must not be empty/u],
    ["node=", /--answer path must not be empty/u],
  ];
  for (const [value, expected] of cases) {
    const result = spawnSync(process.execPath, [RUNNER_CLI, "resume", "--answer", value, "/nonexistent/run-dir"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, expected);
  }
});

test("resume --answer combined with a different --node is refused, not silently mis-scoped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-node-conflict-"));
  const path = writeContract(directory, fixture({
    id: "answer-node-conflict-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet({ objective: "Alpha" }), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Beta" }), dependsOn: ["alpha"], gate: false },
      { id: "gamma", type: "backend", taskPacket: packet({ objective: "Gamma" }), gate: false },
    ],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  persistFailure(runDir, "alpha", { status: "blocked", code: "context_missing" });
  persistFailure(runDir, "beta", { status: "blocked", code: "dependency_failed", blockedBy: ["alpha"] });
  persistFailure(runDir, "gamma", { status: "failed", code: "provider_error", attempt: 1 });
  const answerPath = join(directory, "answer.txt");
  writeFileSync(answerPath, "the answer");

  // The engine refuses the conflicting selectors before taking the lock.
  await withFakeCodex(directory, "pass", () => assert.rejects(
    () => resumeRun(runDir, { node: "gamma", answer: { node: "alpha", path: answerPath } }),
    /--answer alpha conflicts with --node gamma/u,
  ));

  // The CLI refuses the same combination before spawning or touching the run.
  const result = spawnSync(process.execPath, [RUNNER_CLI, "resume", "--answer", `alpha=${answerPath}`, "--node", "gamma", runDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /--answer alpha conflicts with --node gamma/u);
});

test("an operator-answer override round-trips through validateNodeSnapshot", () => {
  assert.doesNotThrow(() => validateNodeSnapshot(snapshot({
    executionOverrides: [{ kind: "operator-answer", at: "2026-01-01T00:00:00.000Z", reason: "operator answered", text: "the answer" }],
  })));
  assert.throws(
    () => validateNodeSnapshot(snapshot({
      executionOverrides: [{ kind: "operator-answer", at: "2026-01-01T00:00:00.000Z", reason: "operator answered", answer: "typo" }],
    })),
    /unexpected field answer/u,
  );
  assert.throws(
    () => validateNodeSnapshot(snapshot({
      executionOverrides: [{ kind: "operator-answer", at: "2026-01-01T00:00:00.000Z", reason: "operator answered", text: "x".repeat(8 * 1024 + 1) }],
    })),
    /exceeds 8192 bytes/u,
  );
});

test("resume --answer delivers the answer into the re-dispatched worker and judge prompts and reaches done", async () => {
  // The replay harness stands in for both roles, so no token is spent and the
  // first worker turn deterministically blocks on a named missing path.
  const directory = mkdtempSync(join(tmpdir(), "answer-delivery-e2e-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "answer-delivery-e2e-rec-"));
  const workerRecording = writeRecording(recordingDir, [
    {
      envelope: envelope({ result: JSON.stringify({ status: "blocked_context", summary: "missing a required path", verification: [], artifacts: [], missingContext: ["missing.txt"] }) }),
    },
    {
      envelope: envelope({ result: JSON.stringify(workerResult("answered and done")) }),
    },
  ], "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, [
    {
      envelope: envelope({ result: JSON.stringify({ verdict: "pass", findings: [], maxSeverity: "none", summary: "clean" }) }),
    },
  ], "judge.jsonl");
  const path = writeContract(directory, fixture({
    id: "answer-delivery-e2e-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
    },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { failOn: ["critical"] },
    }],
  }));

  const first = await runContract(path);
  const blocked = nodeState(first);
  assert.equal(blocked.status, "blocked", blocked.error?.message);
  assert.equal(blocked.error?.code, "context_missing");
  assert.equal(blocked.attempt, 1);

  const answerText = "The missing file must say hello.";
  const answerPath = join(directory, "answer.txt");
  writeFileSync(answerPath, answerText);

  const resumed = await resumeRun(first.runDir, { answer: { node: "build", path: answerPath } });
  const state = nodeState(resumed);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.attempt, 2, "the answered node is re-dispatched exactly once");
  const result = /** @type {{status?: string}|null} */ (state.result);
  assert.equal(result?.status, "done", "the answered node adopts the new result, never the stale blocked_context result");

  // The answer is rendered under its own heading into the same bounded
  // previous-attempt section that both regenerated prompts carry.
  const workerPrompt = readFileSync(join(first.runDir, "logs", "build.2.worker.prompt"), "utf8");
  assert.ok(workerPrompt.includes("Operator answer:"), "the worker prompt carries the answer heading");
  assert.ok(workerPrompt.indexOf(answerText) > workerPrompt.indexOf("Operator answer:"), "the answer text sits under its own heading in the worker prompt");

  const judgePrompt = readFileSync(join(first.runDir, "logs", "build.2.judge.prompt"), "utf8");
  assert.ok(judgePrompt.includes("Operator answer:"), "the judge prompt carries the answer heading");
  assert.ok(judgePrompt.indexOf(answerText) > judgePrompt.indexOf("Operator answer:"), "the answer text sits under its own heading in the judge prompt");
});
