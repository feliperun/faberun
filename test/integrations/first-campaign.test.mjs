/**
 * R8: a stranger's first campaign completes offline.
 *
 * The whole path from a repository with no faberun conventions: `faberun init
 * --yes`, `faberun spec scaffold`, `faberun plan` over replay runtimes (so no
 * provider is ever reached), a frozen contract, one campaign node to `done`,
 * and a closed campaign with a complete ledger. The fixture is a Python
 * package (`pyproject.toml`, no `package.json`), which is exactly the target
 * whose repository facts used to arrive at the planner with no verification
 * candidate at all.
 *
 * The plan the replay worker "writes" is the offline test's own authoring: it
 * points the node's verification at the portable `git diff --check` that every
 * CI runner already carries, rather than at the `pytest` candidate repo facts
 * detected but that this test must not require Python to run. The test still
 * proves the candidate was detected, by reading the repo-facts file the
 * planner staged for its draft.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { runPlanningPipeline } from "../../src/plan/pipeline.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { runProgress } from "../../src/engine/supervise.mjs";
import { collectRepoFacts } from "../../src/plan/repo-facts.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { closeCampaign, initializeCampaign } from "../../src/campaign/index.mjs";
import { campaignTree, runsRoot } from "../../src/run/paths.mjs";
import { envelope, writeRecording } from "../harnesses/replay-helpers.mjs";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/offline-stranger", import.meta.url));

const CAMPAIGN_ID = "offline-stranger-first-campaign";
const PHASE = "first-campaign";
const NODE_ID = "keep-importable";

/** The fixture entry point the campaign node writes, read back so the worker replay is byte-for-byte what a real first change would be. */
const MAIN_PY = readFileSync(join(FIXTURE, "app", "main.py"), "utf8");

/**
 * A fresh temp repository carrying the Python fixture, committed so
 * `git ls-files` — and therefore repo facts — sees it as the tracked tree.
 * realpath-resolved because the project registry keys on the path.
 *
 * @returns {string}
 */
function fixtureRepo() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "offline-stranger-")));
  writeFileSync(join(cwd, "pyproject.toml"), readFileSync(join(FIXTURE, "pyproject.toml")));
  mkdirSync(join(cwd, "app"));
  writeFileSync(join(cwd, "app", "main.py"), MAIN_PY);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=stranger@example.test", "-c", "user.name=stranger", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  return cwd;
}

/**
 * The stranger's own commit before planning. `faberun init` edited `.gitignore`
 * and installed the skill, and the spec is a new file, so the tree is dirty in
 * exactly the way a launch refuses (GETTING-STARTED step 4: "commit them before
 * running"). The launch seam below is stubbed, so the planning pipeline's own
 * pre-flight is the only thing that can see it.
 *
 * @param {string} cwd @param {string} message
 * @returns {void}
 */
function commitAll(cwd, message) {
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=stranger@example.test", "-c", "user.name=stranger", "-c", "commit.gpgSign=false", "commit", "-qm", message]);
}

/**
 * Run one `faberun` verb through the shipped executable, the way a stranger
 * following the guide would.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function faberun(args, cwd) {
  // Force color off: the assertions below read literal status tokens, and an
  // ambient FORCE_COLOR would split them with escape codes.
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  return {
    status: /** @type {number|null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

/**
 * The structured spec a stranger writes after scaffolding: one requirement
 * whose proof is the portable `git diff --check`, and the Non-goals section
 * strict traceability requires. No baseline/target front matter, so nothing
 * has to resolve against this throwaway repository's commit graph.
 *
 * @returns {string}
 */
function specText() {
  return `---
id: ${CAMPAIGN_ID}
title: "A stranger's first campaign keeps the package importable"
version: 1.0.0
status: draft
date: 2026-09-27
owner: offline-stranger
---

# A stranger's first campaign keeps the package importable

## Intent

Prove the whole path works offline from a repository with no faberun conventions.

## Requirements

### R1. The repository diff has no whitespace errors

- **statement:** every change a campaign node makes leaves \`git diff --check\` green.
- **proof:** \`command: git diff --check\`

## Non-goals

- Publishing the package.
`;
}

/**
 * The plan the replay draft worker authors. One node (a targeted fix, so
 * sizing accepts a single node), and its verification is the portable
 * `git diff --check` — never the `pytest` command repo facts detected, which
 * would make the offline test depend on Python being installed.
 *
 * @returns {Record<string, unknown>}
 */
function draftedPlan() {
  return {
    nodes: [{
      id: NODE_ID,
      objective: "Keep app/main.py importable and the repository diff clean",
      taskKind: "implement",
      riskTier: "low",
      dependsOn: [],
      readFiles: ["app/main.py", "pyproject.toml"],
      writeFiles: ["app/main.py"],
      scopeAcknowledged: [],
      definitionOfDone: [{
        id: "clean-diff",
        text: "The repository diff has no whitespace errors",
        proof: { kind: "verification", ref: "git diff --check" },
      }],
      verification: [{ argv: ["git", "diff", "--check"] }],
      expectedTurns: 1,
    }],
    phases: [{
      id: PHASE,
      requirementIds: ["R1"],
      nodeIds: [NODE_ID],
      deliverable: "A one-node campaign that leaves the repository diff clean",
    }],
  };
}

/**
 * A worker-result envelope carrying `body` as the discovery output the
 * planning pipeline reads back.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function discoveryEnvelope(body) {
  return { envelope: envelope({ result: JSON.stringify({ status: "done", summary: "replay", verification: [], artifacts: [], missingContext: [], ...body }) }) };
}

test("a first campaign by a stranger completes offline", { timeout: 120_000 }, async () => {
  const cwd = fixtureRepo();

  // Step 1: `faberun init --yes`, the only setup a stranger runs.
  const init = faberun(["init", "--yes"], cwd);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(join(cwd, ".claude", "skills", "faberun", "SKILL.md")), "init installs the skill");

  // Step 2: `faberun spec scaffold`, then the stranger replaces the template
  // with the structured spec. Scaffolding proves the verb; the real document
  // is what `faberun plan` reads.
  const specRelative = join("docs", "campaigns", PHASE, "SPEC.md");
  const specPath = join(cwd, specRelative);
  mkdirSync(dirname(specPath), { recursive: true });
  const scaffold = faberun(["spec", "scaffold", specPath, "--id", CAMPAIGN_ID], cwd);
  assert.equal(scaffold.status, 0, scaffold.stderr);
  assert.ok(existsSync(specPath), "spec scaffold writes the document");
  writeFileSync(specPath, specText());
  commitAll(cwd, "chore: prepare the repository for faberun");

  // Repo facts detect the Python manifest, and no Node candidate is measured
  // because there is no package.json and no test/ directory.
  const facts = collectRepoFacts(cwd);
  assert.deepEqual(facts.verificationCandidates, [], "a repository without package.json measures no Node candidate");
  assert.deepEqual(facts.detectedVerificationCandidates, [
    { argv: ["pytest"], manifest: "pyproject.toml", measuredMs: null, eligible: true },
  ]);

  // `faberun campaign init`: the campaign the plan and its runs register with.
  const runsDir = runsRoot(cwd);
  const campaignPath = campaignTree(cwd, CAMPAIGN_ID);
  initializeCampaign(runsDir, { campaignId: CAMPAIGN_ID, goal: "Prove a stranger's first campaign completes offline" });
  assert.ok(existsSync(campaignPath));

  // Replay recordings: one runtime serves both the planning stage and the
  // campaign node, so the worker recording holds the draft plan first and the
  // node's result after it. The judge recording holds the empty review and a
  // passing verdict.
  const recordingDir = mkdtempSync(join(tmpdir(), "offline-stranger-rec-"));
  const workerRecording = writeRecording(recordingDir, [
    discoveryEnvelope({ output: { plan: draftedPlan() } }),
    { envelope: envelope({ result: JSON.stringify({ status: "done", summary: "kept the package importable", verification: [], artifacts: [], missingContext: [] }) }), files: [{ path: "app/main.py", content: MAIN_PY }] },
  ], "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, [
    discoveryEnvelope({ output: { findings: [] } }),
    { envelope: envelope({ result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] }) }) },
  ], "judge.jsonl");
  const runtimes = {
    "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
    "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
  };
  const runtimeDefaults = { worker: "replay-worker", judge: "replay-judge" };

  // Step 3: `faberun plan`, driven in-process so the replay runtimes are the
  // provider and nothing reaches the network.
  const planned = await runPlanningPipeline({
    specPath,
    campaignId: CAMPAIGN_ID,
    phase: PHASE,
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers: ["replay-judge"],
    targetedFix: true,
    // The seam's contract is `void | Promise<void>`; awaiting the engine here
    // keeps the ordering the pipeline relies on without leaking RunOutcome.
    launch: async (contractPath) => { await runContract(contractPath); },
    wait: (runDir) => runProgress(runDir),
  });
  assert.equal(planned.status, "frozen", "a clean plan freezes");
  assert.ok(existsSync(planned.contractPath));

  // The draft's own facts, staged for the worker, name the Python candidate —
  // the planner really did see it, even though the contract it froze uses the
  // portable command instead.
  const stagedFacts = JSON.parse(readFileSync(join(cwd, ".faberun-plan", CAMPAIGN_ID, PHASE, "repo-facts.json"), "utf8"));
  assert.ok(
    stagedFacts.detectedVerificationCandidates.some((/** @type {{manifest: string, argv: string[]}} */ candidate) => candidate.manifest === "pyproject.toml" && candidate.argv[0] === "pytest"),
    "the planner's repo facts carry the detected Python candidate",
  );

  const contract = JSON.parse(readFileSync(planned.contractPath, "utf8"));
  const node = contract.nodes.find((/** @type {{id: string}} */ candidate) => candidate.id === NODE_ID);
  assert.ok(node, "the frozen contract carries the planned node");
  assert.deepEqual(
    node.taskPacket.verification.map((/** @type {{argv: string[]}} */ command) => command.argv),
    [["git", "diff", "--check"]],
    "the frozen contract's verification is the portable git diff --check, not the detected pytest candidate",
  );
  assert.equal(JSON.stringify(contract).includes("pytest"), false, "the Python candidate never reaches the contract");

  // Step 4: one campaign node runs to `done` over replay.
  const outcome = await runContract(planned.contractPath);
  assert.equal(outcome.ok, true, "the single-node campaign succeeds");
  const state = outcome.states.get(NODE_ID);
  assert.ok(state);
  assert.equal(state.status, "done");
  const diffCheck = /** @type {{argv: string[], passed: boolean}|undefined} */ (
    state.verification?.commands?.find((/** @type {{argv: string[]}} */ command) => command.argv.join(" ") === "git diff --check")
  );
  assert.ok(diffCheck, "the campaign node ran git diff --check");
  assert.equal(diffCheck.passed, true);

  // Step 5: close the campaign with its ledger complete: a recorded
  // retrospective, then the close preserves journal, record and run sources.
  appendJournal(campaignPath, {
    type: "retrospective",
    eventId: "offline-stranger-retrospective",
    at: new Date().toISOString(),
    sessionId: "replay",
    text: "Retrospective: the stranger's first campaign closed offline with a complete ledger.",
  });
  const closed = closeCampaign(campaignPath);
  assert.equal(closed.campaign.status, "closed");
  const ledgerDir = join(cwd, "docs", "campaigns", CAMPAIGN_ID, "ledger");
  assert.ok(existsSync(join(ledgerDir, "journal.jsonl")), "the ledger preserves the journal");
  assert.ok(existsSync(join(ledgerDir, "campaign.json")), "the ledger preserves the closed record");
  assert.ok(existsSync(join(ledgerDir, "sources.json")), "the ledger lists its sources");
  assert.ok(
    closed.ledgerFiles.some((path) => path.endsWith(`${contract.id}.events.jsonl`)),
    "the ledger preserves the campaign run's event stream",
  );
});
