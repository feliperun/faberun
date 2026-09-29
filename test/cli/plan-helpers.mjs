/**
 * The fixtures the plan tests build a campaign phase with: a scratch repo at a
 * throwaway $FABERUN_HOME, the recorded runtimes and reviewers a phase declares,
 * and the two plan macros (a scope-gap plan and a two-node plan) the pipeline is
 * asked to freeze.
 *
 * They live beside the tests rather than inside them because the test file is
 * capped: `plan.test.mjs` carried these inline until the fixtures stopped leaving
 * room for the assertions, the same way `test/contract/helpers.mjs` came out of
 * `contract.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { runProgress } from "../../src/engine/supervise.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { envelope, writeRecording } from "../harnesses/replay-helpers.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));


/** @param {string} cwd @param {string} relative @param {string} content */
export function writeFixtureFile(cwd, relative, content) {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** @param {string} cwd */
export function initializeGit(cwd) {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", ".", ":!.runs"]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=plan-test@example.test", "-c", "user.name=plan-test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
}

/**
 * Commit a file a fixture writes into the tree after `setup` has committed it.
 * The pipeline refuses a dirty tree up front — the launch it ends with would
 * refuse the same tree fifteen minutes later, so an input the plan reads is
 * committed the way the campaign contracts it sits beside are (AP10).
 *
 * @param {string} cwd
 * @param {string} relative
 */
export function commitFixture(cwd, relative) {
  execFileSync("git", ["-C", cwd, "add", "--", relative]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=plan-test@example.test", "-c", "user.name=plan-test", "-c", "commit.gpgSign=false", "commit", "-qm", `fixture ${relative}`]);
}

/**
 * A plan whose write set drags along a file it does not declare: the test
 * named after the entry point runs src/cli.mjs, which imports
 * src/plan/thing.mjs, so scope closure refuses the packet — the exact shape
 * that killed the live pipeline between the routing and freeze stage lines
 * on 2026-09-20. `closed` declares the dragged-along test, the fix a revise
 * round is expected to make once the in-round contract check reports it.
 *
 * @param {{closed?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function scopeGapPlan({ closed = false } = {}) {
  return {
    nodes: [
      {
        id: "thing",
        objective: "Implement the thing",
        taskKind: "implement",
        riskTier: "standard",
        dependsOn: [],
        readFiles: ["src/cli.mjs"],
        writeFiles: closed ? ["src/plan/thing.mjs", "test/cli/cli.test.mjs"] : ["src/plan/thing.mjs"],
        definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/plan/thing.mjs" } }],
        verification: [],
      },
      {
        id: "docs",
        objective: "Document the feature",
        taskKind: "docs",
        riskTier: "low",
        dependsOn: [],
        readFiles: ["docs/spec.md"],
        writeFiles: ["docs/spec.md"],
        definitionOfDone: [{ id: "documented", text: "Documented", proof: { kind: "path", ref: "docs/spec.md" } }],
        verification: [],
      },
    ],
  };
}

/** @param {string} plansDir @returns {Array<Record<string, unknown>>} the pipeline.jsonl stage lines */
export function readPipelineStages(plansDir) {
  return readFileSync(join(plansDir, "pipeline.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * A minimal, schema-valid draft/revise plan: two independent nodes, each with
 * its own mechanical Definition of Done proof and disjoint writeFiles, so
 * sizing's merge rules leave both in place (a single-node plan is refused).
 *
 * @param {{highRisk?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function twoNodePlan({ highRisk = false } = {}) {
  return {
    nodes: [
      {
        id: "build",
        objective: "Implement the feature",
        taskKind: "implement",
        riskTier: highRisk ? "high" : "standard",
        dependsOn: [],
        readFiles: ["src/index.mjs"],
        writeFiles: ["src/index.mjs"],
        definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
        verification: [],
      },
      {
        id: "docs",
        objective: "Document the feature",
        taskKind: "docs",
        riskTier: "low",
        dependsOn: [],
        readFiles: ["docs/spec.md"],
        writeFiles: ["docs/spec.md"],
        definitionOfDone: [{ id: "documented", text: "Documented", proof: { kind: "path", ref: "docs/spec.md" } }],
        verification: [],
      },
    ],
  };
}

/**
 * A patch that turns `previous` into `next`: every node of `next`, plus the ids
 * of the nodes `previous` carries that `next` does not.
 *
 * @param {Record<string, any>} previous
 * @param {Record<string, any>} next
 * @returns {Record<string, unknown>}
 */
function patchOver(previous, next) {
  const nodes = next.nodes ?? [];
  const nextIds = new Set(nodes.map((/** @type {any} */ node) => node.id));
  /** @type {Record<string, unknown>} */
  const patch = {
    nodes,
    removedNodeIds: (previous.nodes ?? []).map((/** @type {any} */ node) => node.id).filter((/** @type {string} */ id) => !nextIds.has(id)),
  };
  for (const field of ["phases", "sharedVerification", "finalVerification", "justification"]) {
    if (next[field] !== undefined) patch[field] = next[field];
  }
  return patch;
}

/**
 * The `output` object each recorded worker invocation carries. One recording
 * serves two stages — the same worker runtime drafts the plan and revises it —
 * and the replay runtime hands out its lines in order without seeing what the
 * invocation asked for, so a line has to answer whichever of the two shapes it
 * lands on: a draft is always `output.plan`, and RM-110 gives a revise two
 * shapes, a patch over the plan the pipeline holds when that plan validated
 * and the whole plan again when the draft it repairs never did, chosen by the
 * pipeline and never by the model. So every line carries both: `plan` is what
 * the line's plan says, `patch` is that same plan written as the change from
 * the line before it, and each key is read only by the stage that asked for it.
 *
 * @param {unknown[]} plans
 * @returns {Array<Record<string, unknown>>}
 */
function workerOutputs(plans) {
  /** @type {Record<string, any>} */
  let previous = /** @type {Record<string, any>} */ (plans[0]);
  return plans.map((plan) => {
    const next = /** @type {Record<string, any>} */ (plan);
    const output = { plan, patch: patchOver(previous, next) };
    previous = next;
    return output;
  });
}

/**
 * A temp checkout with everything a planning contract's readFiles may name,
 * two replay runtimes (distinct vendors, one per role) and an active
 * campaign. `reviewMode` picks the review recording: "clean" never finds a
 * critical, "critical" always does. `plans` lists the plan each worker
 * invocation produces, in order (the draft, then one revise output per later
 * invocation), each recorded as both the plan and the patch a revise would
 * answer with (see `workerOutputs`); the default repeats the same valid
 * two-node plan. `reviews`
 * does the same for the reviewer, one findings array per round, for a test
 * about what one round remembers of another. `files` adds repository files
 * beyond the fixed set, path to text.
 *
 * @param {string} campaignId
 * @param {{reviewMode?: "clean"|"critical", highRisk?: boolean, plans?: unknown[], reviews?: unknown[][], files?: Record<string, string>}} [options]
 * @returns {{cwd: string, campaignId: string, runtimes: Record<string, Record<string, unknown>>, runtimeDefaults: {worker: string, judge: string}, reviewers: string[]}}
 */
export function setup(campaignId, { reviewMode = "clean", highRisk = false, plans, reviews, files = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-"));
  writeFixtureFile(cwd, "src/index.mjs", "export default 1;\n");
  for (const [path, text] of Object.entries(files)) writeFixtureFile(cwd, path, text);
  writeFixtureFile(cwd, "docs/spec.md", "# Feature 42\n\nA legacy spec with no front matter, accepted outright.\n");
  // The scope-closure pair a planned write set is checked against: the entry
  // point imports the module a scope-gap plan writes, and the test named
  // after the entry runs it — the dragged-along obligation detector 1 names,
  // in the shape that cost the live run on 2026-09-20.
  writeFixtureFile(cwd, "src/cli.mjs", "import { thing } from \"./plan/thing.mjs\";\nexport default thing;\n");
  writeFixtureFile(cwd, "test/cli/cli.test.mjs", "new URL(\"../../src/cli.mjs\", import.meta.url);\n");
  initializeGit(cwd);

  const runsDir = runsRoot(cwd);
  initializeCampaign(runsDir, { campaignId, goal: "Ship feature 42" });

  // Each replay line serves exactly one invocation, consumed strictly in
  // order and persisted in a `.cursor` sidecar next to the recording — so a
  // runtime reused across draft and revise, or across two pipeline calls in
  // one test, needs one line per invocation it will actually serve.
  const invocationBudget = 10;
  const workerPlans = plans ?? Array(invocationBudget).fill(twoNodePlan({ highRisk }));
  const reviewFindings = reviewMode === "critical"
    ? [{ id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" }]
    : [];
  const reviewRounds = reviews ?? Array(invocationBudget).fill(reviewFindings);
  const recordingDir = mkdtempSync(join(tmpdir(), "plan-pipeline-rec-"));
  const draftRecording = writeRecording(recordingDir, workerOutputs(workerPlans).map((output) => ({ envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "drafted", verification: [], artifacts: [], missingContext: [],
    output,
  }) }) })), "draft.jsonl");
  const reviewRecording = writeRecording(recordingDir, reviewRounds.map((findings) => ({ envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "reviewed", verification: [], artifacts: [], missingContext: [],
    output: { findings },
  }) }) })), "review.jsonl");

  const runtimes = {
    "planner-worker": { harness: "replay", model: "replay-worker-model", vendor: "vendor-worker", config: { "replay.recording": draftRecording } },
    "planner-judge": { harness: "replay", model: "replay-judge-model", vendor: "vendor-judge", config: { "replay.recording": reviewRecording } },
  };
  const runtimeDefaults = { worker: "planner-worker", judge: "planner-judge" };
  // R19: the planner's own reviewer list is separate from runtimeDefaults.judge;
  // this fixture points it at the same replay runtime so every existing test
  // below keeps exercising the review stage exactly as before.
  const reviewers = ["planner-judge"];
  return { cwd, campaignId, runtimes, runtimeDefaults, reviewers };
}

/** @param {string} contractPath @returns {Promise<void>} */
export async function launch(contractPath) {
  await runContract(contractPath);
}

/** @param {string} runDir */
export function wait(runDir) {
  return runProgress(runDir);
}
