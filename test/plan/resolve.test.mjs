import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { readJournal } from "../../src/campaign/journal.mjs";
import { JOURNAL_TEXT_BYTES } from "../../src/campaign/layout.mjs";
import { collectRepoFacts } from "../../src/plan/repo-facts.mjs";
import { contentDigest } from "../../src/plan/freeze.mjs";
import { contestPlan } from "../../src/plan/contest.mjs";
import { parseAnswerFlags, resolvePlanningPipeline } from "../../src/plan/resolve.mjs";
import { campaignTree, runsRoot } from "../../src/run/paths.mjs";
import { initializeGit } from "../helpers.mjs";

/**
 * `resolve.mjs` never launches a stage or reaches a provider: it reads a
 * contested `plan.json` back off disk and continues straight into
 * sizing/routing/freeze, so every test here builds that record by hand (or
 * through `contestPlan`, itself provider-free) instead of running the
 * pipeline's draft/review/revise rounds.
 */

/**
 * @returns {Record<string, unknown>}
 */
function twoNodePlan() {
  return {
    nodes: [
      {
        id: "build",
        objective: "Implement the feature",
        taskKind: "implement",
        riskTier: "standard",
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
 * A throwaway git checkout, an active campaign and the runtime catalogue a
 * frozen contract validates against -- everything a resume needs except the
 * contested `plan.json` itself, which each test writes with its own findings.
 *
 * @param {string} campaignId
 * @returns {{cwd: string, campaignId: string, phase: string, plansDir: string, runtimes: Record<string, Record<string, unknown>>, runtimeDefaults: {worker: string, judge: string}, repoFacts: import("../../src/plan/repo-facts.mjs").RepoFacts, specDigest: string}}
 */
function setup(campaignId) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-resolve-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/index.mjs"), "export default 1;\n");
  mkdirSync(join(cwd, "docs"), { recursive: true });
  const specText = "# Feature 42\n\nA legacy spec with no front matter, accepted outright.\n";
  writeFileSync(join(cwd, "docs/spec.md"), specText);
  initializeGit(cwd);

  const runsDir = runsRoot(cwd);
  initializeCampaign(runsDir, { campaignId, goal: "Ship feature 42" });

  const runtimes = {
    "planner-worker": { harness: "replay", model: "replay-worker-model", vendor: "vendor-worker" },
    "planner-judge": { harness: "replay", model: "replay-judge-model", vendor: "vendor-judge" },
  };
  const runtimeDefaults = { worker: "planner-worker", judge: "planner-judge" };
  const phase = "build";
  const plansDir = join(campaignTree(cwd, campaignId), "plans", phase);
  mkdirSync(plansDir, { recursive: true });
  const repoFacts = collectRepoFacts(cwd, { requirements: [] });
  return { cwd, campaignId, phase, plansDir, runtimes, runtimeDefaults, repoFacts, specDigest: contentDigest(specText) };
}

/**
 * Write a contested `plan.json` through the real `contestPlan` writer (the
 * same path a pipeline run's own contest takes), so this fixture and the
 * production write path can never drift apart.
 *
 * @param {ReturnType<typeof setup>} fixture
 * @param {Array<Record<string, unknown>>} findings
 * @returns {Promise<void>}
 */
async function writeContested(fixture, findings) {
  const { cwd, campaignId, phase, plansDir, runtimes, runtimeDefaults, repoFacts, specDigest } = fixture;
  await contestPlan({
    campaignId, phase, cwd, plansDir, sessionId: "planner",
    findings: /** @type {any} */ (findings), round: 2, plan: /** @type {any} */ (twoNodePlan()), logStage: () => {},
    resume: {
      campaignId, phase, specPath: "docs/spec.md", specDigest, reviewRounds: 2,
      runtimeDefaults, reviewers: [], runtimes, verification: {}, packageMode: "implementation",
      targetedFix: false, approveBelow: "standard", repoFacts,
    },
  });
}

test("a contested plan resumes from the operator's answers", async () => {
  const fixture = setup("resolve-demo");
  const findings = [
    { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" },
    { id: "F2", severity: "critical", nodeId: "docs", text: "the docs example is stale" },
    { id: "F3", severity: "minor", nodeId: "build", text: "nice to have: a changelog entry" },
  ];
  await writeContested(fixture, findings);

  const answers = parseAnswerFlags(["F1=accept", "F2=reject:already refreshed last sprint"]);
  const result = await resolvePlanningPipeline({ plansDir: fixture.plansDir, cwd: fixture.cwd, answers });

  assert.equal(result.status, "frozen", "every critical finding was answered, so the plan resumes to a freeze");
  assert.ok(existsSync(result.contractPath), "contract.json is written");
  assert.ok(existsSync(result.planPath), "plan.json is written");
  const plan = JSON.parse(readFileSync(result.planPath, "utf8"));
  assert.equal(plan.status, "frozen");
  assert.equal(plan.approved, true);
  // Never redrafted: the frozen contract is exactly the two nodes the
  // contested plan already carried.
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(contract.nodes.map((/** @type {any} */ node) => node.id).sort(), ["build", "docs"]);

  const journal = readJournal(campaignTree(fixture.cwd, fixture.campaignId));
  const decisions = journal.filter((entry) => entry.type === "decision");
  assert.deepEqual(decisions.map((entry) => entry.decisionId).sort(), ["plan-build-F1", "plan-build-F2"]);
  const accepted = decisions.find((entry) => entry.decisionId === "plan-build-F1");
  const rejected = decisions.find((entry) => entry.decisionId === "plan-build-F2");
  assert.match(String(accepted?.text), /^Accepted finding F1/);
  assert.match(String(rejected?.text), /^Rejected finding F2.*already refreshed last sprint/);
  // Every decision fits the journal's own cap -- the failure mode this
  // node's other half (RM-105) exists to avoid.
  for (const entry of decisions) assert.ok(Buffer.byteLength(String(entry.text), "utf8") <= JOURNAL_TEXT_BYTES);
});

test("resolving with a critical finding left unanswered refuses", async () => {
  const fixture = setup("resolve-missing-demo");
  const findings = [
    { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" },
    { id: "F2", severity: "critical", nodeId: "docs", text: "the docs example is stale" },
  ];
  await writeContested(fixture, findings);

  const answers = parseAnswerFlags(["F1=accept"]);
  await assert.rejects(
    resolvePlanningPipeline({ plansDir: fixture.plansDir, cwd: fixture.cwd, answers }),
    /every critical finding needs an --answer.*F2/,
  );
});

test("resolving with an --answer naming an unknown finding refuses", async () => {
  const fixture = setup("resolve-unknown-demo");
  const findings = [{ id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" }];
  await writeContested(fixture, findings);

  const answers = parseAnswerFlags(["F1=accept", "F9=accept"]);
  await assert.rejects(
    resolvePlanningPipeline({ plansDir: fixture.plansDir, cwd: fixture.cwd, answers }),
    /not open critical findings.*F9/,
  );
});

test("parseAnswerFlags requires a reason for reject and rejects a malformed flag", () => {
  assert.deepEqual(parseAnswerFlags(["F1=accept"]).get("F1"), { decision: "accept" });
  assert.deepEqual(parseAnswerFlags(["F1=reject:not applicable here"]).get("F1"), { decision: "reject", reason: "not applicable here" });
  assert.throws(() => parseAnswerFlags(["F1=reject"]), /requires a reason/);
  assert.throws(() => parseAnswerFlags(["F1"]), /must be <finding-id>=accept/);
  assert.throws(() => parseAnswerFlags(["=accept"]), /finding id must not be empty/);
});
