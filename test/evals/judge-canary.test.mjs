import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANARY_KINDS,
  assertDiscriminatingArtifacts,
  buildCanaryArtifacts,
  corpusShortfalls,
  discoverCanaryCaseIds,
  loadCanaryCase,
  loadCorpusSpec,
  sealedDiffPaths,
  verifyCanaryCorpus,
} from "../../evals/judge-canary.mjs";
import { runJudgeCanaryClass } from "../../evals/judge-canary/class.mjs";
import { canaryJudgePrompt } from "../../evals/judge-canary/judge.mjs";

const CASES = discoverCanaryCaseIds().map(loadCanaryCase);
const DENY_TASK = "deny-the-out-of-scope-write-before-the-file-exists";

/** @param {import("../../evals/judge-canary.mjs").CanaryArtifact} entry @returns {import("../../evals/judge-canary.mjs").CanaryArtifact} */
function cleanOf(entry) {
  const clean = CASES.find((candidate) => candidate.label === "clean" && candidate.sourceTask === entry.sourceTask);
  assert.ok(clean, `${entry.sourceTask} has a clean control`);
  return clean;
}

/** @param {string} prompt @returns {string[]} */
function promptDiffPaths(prompt) {
  const section = prompt.split("Controller diff paths:\n")[1]?.split("\n\n")[0] ?? "";
  return section.split("\n").map((line) => line.replace(/^- /u, "")).filter((line) => line && line !== "(none)");
}

test("the judge canary corpus has every defect kind and clean controls", () => {
  const ids = CASES.map((entry) => entry.id);
  assert.ok(ids.length >= 35, `expected at least 35 canary cases, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "case ids are unique");
  assert.deepEqual(corpusShortfalls(CASES), [], "8+ golden tasks, 10+ clean controls and 5+ cases per kind, each over distinct tasks");
  for (const entry of CASES) {
    assert.equal(entry.schemaVersion, 2, `${entry.id} is versioned`);
    assert.ok(entry.sourceTask, `${entry.id} names its golden task`);
    assert.ok(entry.diff.length > 0, `${entry.id} carries a sealed diff`);
    assert.ok(entry.verification.some((command) => command.argv[1] === "--test"), `${entry.id}'s verification runs a test, not only a syntax check`);
    assert.ok(Array.isArray(entry.definitionOfDone) && entry.definitionOfDone.some((item) => item.judgment === true), `${entry.id} carries a DoD with judgment items`);
    if (entry.label.startsWith("defect:")) assert.ok(entry.mutation, `${entry.id} describes its defect mutation`);
  }
});

test("every clean control is its golden task's real sealed diff", () => {
  for (const entry of CASES.filter((candidate) => candidate.label === "clean")) {
    const golden = execFileSync("git", ["diff", "--binary", "--no-renames", entry.source.parentSha, entry.source.commitSha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(entry.diff, golden, `${entry.id} is the golden diff of ${entry.sourceTask}, byte for byte`);
  }
});

test("every canary defect is an edit to its own task's declared files", () => {
  const defects = CASES.filter((entry) => entry.label.startsWith("defect:"));
  assert.ok(defects.length >= 25);
  for (const entry of defects) {
    const clean = cleanOf(entry);
    const writeFiles = /** @type {string[]} */ (entry.taskPacket.writeFiles);
    assert.deepEqual(writeFiles, clean.taskPacket.writeFiles, `${entry.id} declares exactly its task's writeFiles, nothing appended`);
    assert.deepEqual(entry.taskPacket, clean.taskPacket, `${entry.id} carries the same packet as its clean control`);
    assert.deepEqual(entry.definitionOfDone, clean.definitionOfDone, `${entry.id} carries the same DoD as its clean control`);
    assert.notEqual(entry.diff, clean.diff, `${entry.id} changes its task's diff`);
    for (const path of sealedDiffPaths(entry.diff)) {
      assert.ok(writeFiles.includes(path), `${entry.id} changes ${path}, inside its writeFiles`);
      assert.ok(!path.startsWith("canary/"), `${entry.id} plants no canary/ file`);
    }
    for (const edit of entry.mutation?.edits ?? []) assert.ok(writeFiles.includes(edit.path), `${entry.id} edits ${edit.path}, a file the task changes`);
    if (entry.label === "defect:nongoal-violated") {
      assert.ok(/** @type {string[]} */ (entry.taskPacket.nonGoals).length > 0, `${entry.id} has a declared non-goal to violate`);
    }
    if (entry.label === "defect:test-weakened") {
      const tested = entry.verification.filter((command) => command.argv[1] === "--test").map((command) => command.argv[2]);
      assert.ok(entry.mutation?.edits.some((edit) => tested.includes(edit.path)), `${entry.id} weakens a test file its verification runs`);
    }
  }
});

test("every canary defect passes the mechanical proof it hides behind", {
  // The golden tasks' verification is this repository's own 2026-09 suite, which
  // writes shebang providers, chmods them, symlinks node_modules and reads
  // `ps`; it predates docs/adr/0010 and was never run on Windows.
  skip: process.platform === "win32" ? "the golden tasks' historical tests are POSIX-only" : false,
}, async () => {
  const results = await verifyCanaryCorpus();
  const defects = results.filter((result) => result.label.startsWith("defect:"));
  assert.equal(defects.length >= 25, true, "all five defect kinds have five cases before verification");
  const brokenControls = results.filter((result) => result.label === "clean" && !result.ok);
  assert.deepEqual(brokenControls, [], "every clean control passes its own verification, so a passing defect means something");
  const caught = defects.filter((result) => !result.ok);
  assert.deepEqual(caught, [], `a mechanical verification caught canary case(s): ${caught.map((result) => result.id).join(", ")}`);
});

test("the builder rejects by name a defect its verification catches", async () => {
  const spec = loadCorpusSpec();
  const task = spec.tasks.find((entry) => entry.task === DENY_TASK);
  assert.ok(task);
  const decisions = /** @type {string[]} */ (cleanOf({ ...CASES[0], sourceTask: DENY_TASK }).taskPacket.writeFiles)
    .find((path) => path.endsWith("/src/host/tool-policy-decisions.mjs"));
  assert.ok(decisions);
  const caughtSpec = {
    schemaVersion: spec.schemaVersion,
    tasks: [task],
    defects: [{
      task: DENY_TASK,
      kind: "requirement-half-done",
      description: "writeScopeDecision passes every write, which the task's own test catches",
      edits: [{ path: decisions, find: ["  return denyPreTool(writeScopeDenialReason(writeFiles, writeRoots));"], replace: ["  return null;"] }],
    }],
  };
  const artifacts = buildCanaryArtifacts(caughtSpec);
  await assert.rejects(
    assertDiscriminatingArtifacts(artifacts),
    new RegExp(`canary case defect-requirement-half-done-${DENY_TASK} was caught by its verification`, "u"),
  );
  assert.throws(
    () => buildCanaryArtifacts({ ...caughtSpec, defects: [{ ...caughtSpec.defects[0], edits: [{ path: "canary/planted.mjs", find: ["x"], replace: ["y"] }] }] }),
    /canary\/planted\.mjs is outside the task's writeFiles/u,
    "a defect can only edit a file the task already changes",
  );
});

test("no label, kind, case id or defect description reaches the judge prompt", () => {
  /** @type {Map<string, string>} */
  const promptByTask = new Map();
  for (const entry of CASES) {
    const prompt = canaryJudgePrompt(entry);
    assert.ok(prompt.startsWith(`Review node ${entry.nodeId} independently.`), `${entry.id} is asked through the product's judgePrompt`);
    for (const secret of [entry.label, entry.id, ...CANARY_KINDS, entry.mutation?.description, "canary", "defect:"]) {
      if (secret) assert.ok(!prompt.toLowerCase().includes(secret.toLowerCase()), `${entry.id}'s judge prompt names ${JSON.stringify(secret)}`);
    }
    // Only the tree under review tells one case of a task from another: with
    // the diff-path list set aside, every case of a task reads the same prompt.
    const withoutPaths = prompt.replace(/Controller diff paths:\n[\s\S]*?\n\n/u, "");
    const first = promptByTask.get(entry.sourceTask);
    if (first === undefined) promptByTask.set(entry.sourceTask, withoutPaths);
    else assert.equal(withoutPaths, first, `${entry.id} reads the same prompt as the other cases of ${entry.sourceTask}`);
  }
});

test("the judge is told the paths the sealed diff changes, not the packet's writeFiles", () => {
  for (const entry of CASES) {
    const numstat = execFileSync("git", ["apply", "--numstat"], { input: entry.diff, encoding: "utf8" })
      .split("\n").filter(Boolean).map((line) => line.split("\t")[2]);
    assert.deepEqual(promptDiffPaths(canaryJudgePrompt(entry)), numstat, `${entry.id} lists what git reads from its sealed diff`);
  }
  const deny = CASES.find((entry) => entry.label === "clean" && entry.sourceTask === DENY_TASK);
  assert.ok(deny);
  const firstFile = `${deny.diff.split(/\n(?=diff --git )/u)[0]}\n`;
  const narrowed = { ...deny, diff: firstFile };
  const paths = promptDiffPaths(canaryJudgePrompt(narrowed));
  assert.deepEqual(paths, sealedDiffPaths(firstFile));
  assert.equal(paths.length, 1, "a diff that changes one of two declared files lists that one file");
  assert.equal(/** @type {string[]} */ (deny.taskPacket.writeFiles).length, 2);
});

/**
 * A replay judge: a deterministic stand-in for a judge runtime that always
 * answers the same way. Its failure finding cites a judgment item every case
 * carries, so the score's citation rule is exercised rather than bypassed.
 *
 * @param {"pass"|"fail"} verdict
 * @returns {() => string}
 */
function replayJudge(verdict) {
  return () => JSON.stringify(verdict === "pass"
    ? { verdict: "pass", maxSeverity: "none", summary: "nothing to report", findings: [] }
    : {
      verdict: "fail",
      maxSeverity: "major",
      summary: "the change does more than its objective",
      findings: [{ severity: "major", description: "in-scope is not satisfied by this change", evidence: "the sealed diff edits a hunk the objective does not ask for" }],
    });
}

test("the canary scores a judge that always passes and one that always rejects", async () => {
  const resultDir = mkdtempSync(join(tmpdir(), "canary-score-"));
  const runtime = { id: "replay-judge", harness: "replay", model: "replay-model" };
  /** @param {() => string} judge @param {number} now */
  const run = (judge, now) => runJudgeCanaryClass({
    runtime,
    budgetUsd: 100,
    repeat: 1,
    seed: 1,
    resultDir,
    judge,
    probeVersion: () => null,
    now: () => now,
  });
  try {
    const alwaysPass = await run(replayJudge("pass"), 0);
    const alwaysReject = await run(replayJudge("fail"), 1_000);
    const passReport = /** @type {any} */ (alwaysPass.report);
    const rejectReport = /** @type {any} */ (alwaysReject.report);
    assert.equal(passReport.overall.recall, 0, "a judge that always passes recalls no defect");
    assert.equal(passReport.overall.falseAlarmRate, 0, "and raises no false alarm");
    assert.equal(rejectReport.overall.recall, 1, "a judge that always rejects and cites the item recalls every defect");
    assert.equal(rejectReport.overall.falseAlarmRate, 1, "and raises a false alarm on every clean case");
    for (const kind of CANARY_KINDS) {
      assert.equal(passReport.byLabel[`defect:${kind}`].recall, 0, `${kind} recall is 0 for the always-pass judge`);
      assert.equal(rejectReport.byLabel[`defect:${kind}`].recall, 1, `${kind} recall is 1 for the always-reject judge`);
    }
    assert.equal(rejectReport.byLabel.clean.falseAlarmRate, 1);
    assert.equal(alwaysPass.resultPath, join(resultDir, "1970-01-01-replay-judge.json"));
    assert.equal(alwaysReject.resultPath, join(resultDir, "1970-01-01-replay-judge-2.json"), "a second run the same day gets its own file");
    assert.ok(existsSync(/** @type {string} */ (alwaysPass.resultPath)), "and the first run's result survives it");
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
});

test("errored and unparseable verdicts are counted per label outside both rates", async () => {
  let cleanSeen = 0;
  const { report } = await runJudgeCanaryClass({
    runtime: { id: "replay-judge", harness: "replay", model: "replay-model" },
    budgetUsd: 100,
    seed: 1,
    resultDir: null,
    probeVersion: () => null,
    judge: ({ artifact }) => {
      if (artifact.label === "clean") {
        cleanSeen += 1;
        if (cleanSeen % 2 === 0) throw new Error("judge timed out");
        return "not a verdict";
      }
      if (artifact.label === "defect:test-weakened") return "{\"verdict\": \"maybe\"}";
      return replayJudge("fail")();
    },
  });
  const scored = /** @type {any} */ (report);
  assert.equal(scored.byLabel.clean.errors, 10, "every clean invocation errored, half thrown and half unparseable");
  assert.equal(scored.byLabel.clean.verdicts, 0);
  assert.equal(scored.byLabel.clean.falseAlarmRate, null, "no verdict, no false-alarm rate: an error is not a pass");
  assert.equal(scored.byLabel["defect:test-weakened"].errors, 5);
  assert.equal(scored.byLabel["defect:test-weakened"].recall, null, "no verdict, no recall: an error is not a miss");
  for (const kind of CANARY_KINDS.filter((entry) => entry !== "test-weakened")) {
    assert.equal(scored.byLabel[`defect:${kind}`].errors, 0);
    assert.equal(scored.byLabel[`defect:${kind}`].recall, 1, `${kind} recall counts only the verdicts`);
  }
  assert.equal(scored.overall.errors, 15);
  assert.equal(scored.overall.recall, 1, "20 cited rejections over 20 defect verdicts, not over 25 invocations");
  assert.equal(scored.overall.falseAlarmRate, null);
});
