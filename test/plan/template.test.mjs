import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import {
  RISK_TIERS,
  TASK_KINDS,
  TASK_KIND_CATALOGUE_PATH,
  buildPlanningContract,
  validateFindings,
  validatePlanOutput,
} from "../../src/plan/template.mjs";

const RUNTIMES = {
  "anthropic-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic-sonnet" },
  "anthropic-opus": { harness: "claude", model: "claude-opus-5", vendor: "anthropic-opus" },
};
const RUNTIME_DEFAULTS = { worker: "anthropic-sonnet", judge: "anthropic-opus" };

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {import("../../src/plan/template.mjs").PlanningContractInputs}
 */
function baseInputs(overrides = {}) {
  return /** @type {any} */ ({
    campaignId: "demo-campaign",
    phase: "demo-phase",
    n: 1,
    runtimes: RUNTIMES,
    runtimeDefaults: RUNTIME_DEFAULTS,
    specPath: "docs/spec.md",
    repoFactsPath: ".runs/repo-facts.json",
    planPath: ".runs/plan.json",
    findingsPath: ".runs/findings.json",
    notesPath: "docs/notes.md",
    ...overrides,
  });
}

/**
 * @param {string} cwd
 * @param {string} relative
 * @param {string} [content]
 */
function writeInputFile(cwd, relative, content = "placeholder\n") {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** @returns {string} a temp checkout holding every path a planning contract may declare in readFiles */
function checkout() {
  const cwd = mkdtempSync(join(tmpdir(), "plan-template-"));
  writeInputFile(cwd, TASK_KIND_CATALOGUE_PATH, "export const TASK_KINDS = [];\n");
  for (const relative of ["docs/spec.md", ".runs/repo-facts.json", ".runs/plan.json", ".runs/findings.json", "docs/notes.md"]) {
    writeInputFile(cwd, relative);
  }
  return cwd;
}

test("every built contract passes validateContract against a temp checkout that holds the named input files", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  for (const kind of /** @type {const} */ (["draft", "review", "revise", "spec-author", "spec-review"])) {
    const raw = buildPlanningContract(kind, baseInputs());
    assert.doesNotThrow(() => validateContract(raw, contractPath), `${kind} contract should validate`);
  }
});

test("review packet is isolated", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  const draftContract = validateContract(buildPlanningContract("draft", baseInputs()), contractPath);
  const reviewContract = validateContract(buildPlanningContract("review", baseInputs()), contractPath);

  const draftPacket = draftContract.nodes[0].taskPacket;
  const reviewPacket = reviewContract.nodes[0].taskPacket;
  const serializedReview = JSON.stringify(reviewPacket);

  for (const sentence of draftPacket.instructions) {
    assert.equal(serializedReview.includes(sentence), false, `review packet must not carry the draft sentence: ${sentence}`);
  }
  assert.equal(/\.runs\/[^"]*\/logs/u.test(serializedReview), false, "review packet must not carry a path under .runs/*/logs");
  assert.equal(reviewPacket.readFiles.length, 3);
});

test("planner vendors distinct", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  const draftContract = validateContract(buildPlanningContract("draft", baseInputs()), contractPath);
  const reviewContract = validateContract(buildPlanningContract("review", baseInputs()), contractPath);

  const draftRuntimeId = draftContract.nodes[0].runtime ?? draftContract.runtimeDefaults.worker;
  const reviewRuntimeId = reviewContract.nodes[0].runtime ?? reviewContract.runtimeDefaults.worker;
  const draftVendor = draftContract.runtimes[/** @type {string} */ (draftRuntimeId)].vendor;
  const reviewVendor = reviewContract.runtimes[/** @type {string} */ (reviewRuntimeId)].vendor;

  assert.notEqual(draftVendor, reviewVendor);
  assert.equal(draftVendor, "anthropic-sonnet");
  assert.equal(reviewVendor, "anthropic-opus");
});

test("review finding shape", () => {
  assert.throws(() => validateFindings([{ id: "F1", nodeId: "build", text: "missing proof" }]), /severity/);
  assert.throws(() => validateFindings([{ id: "F1", severity: "major", text: "missing proof" }]), /nodeId/);
  const findings = validateFindings([{ id: "F1", severity: "major", nodeId: "build", text: "missing proof" }]);
  assert.deepEqual(findings, [{ id: "F1", severity: "major", nodeId: "build", text: "missing proof" }]);
});

test("draft never names a runtime", () => {
  const validPlan = {
    nodes: [{
      id: "build",
      objective: "Implement it",
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: ["README.md"],
      writeFiles: ["README.md"],
    }],
  };
  assert.doesNotThrow(() => validatePlanOutput(validPlan));

  const planWithRuntime = {
    nodes: [{
      ...validPlan.nodes[0],
      runtime: "anthropic-sonnet",
    }],
  };
  assert.throws(() => validatePlanOutput(planWithRuntime), /unexpected field runtime/);

  assert.throws(
    () => validatePlanOutput({ nodes: [{ id: "build", objective: "Implement it", riskTier: "standard" }] }),
    /taskKind/,
  );
  assert.throws(
    () => validatePlanOutput({ nodes: [{ id: "build", objective: "Implement it", taskKind: "implement" }] }),
    /riskTier/,
  );
});

test("draft and revise instructions spell the nested definitionOfDone and verification shapes", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  for (const kind of /** @type {const} */ (["draft", "revise"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const instructions = contract.nodes[0].taskPacket.instructions.join("\n");
    assert.match(instructions, /definitionOfDone: \[\{id, text, proof\?: \{kind: "command"\|"path"\|"verification", ref\}, judgment\?: true\}\]/);
    assert.match(instructions, /verification: \[\{argv: \[string\], cwd\?, timeoutSec\?, repeat\?, env\?, mutation\?: \{threshold\}\}\]/);
    // The id charset is requireId's (contract/assert.mjs) verbatim: an id that
    // is present but invalid fails validatePlanOutput just as late as an
    // absent one — after the run already succeeded.
    assert.match(instructions, /every id in it \(node and definitionOfDone item\) must match \[A-Za-z0-9\._-\]\+ and never be exactly "\." or "\.\."/);
  }
});

test("a plan emitted exactly as the instructions spell it validates", () => {
  const validated = validatePlanOutput({
    nodes: [{
      id: "build",
      objective: "Implement it",
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: ["README.md"],
      writeFiles: ["README.md"],
      definitionOfDone: [
        { id: "works", text: "It works", proof: { kind: "verification", ref: 0 } },
        { id: "judged", text: "The diff reads cleanly", judgment: true },
      ],
      verification: [{ argv: ["node", "--test"], timeoutSec: 120, env: ["CI"] }],
    }],
    justification: "One node, one concern.",
  });
  assert.deepEqual(validated.nodes[0].definitionOfDone, [
    { id: "works", text: "It works", proof: { kind: "verification", ref: "0" } },
    { id: "judged", text: "The diff reads cleanly", judgment: true },
  ]);
  assert.deepEqual(validated.nodes[0].verification, [{ argv: ["node", "--test"], timeoutSec: 120, repeat: 1, env: ["CI"] }]);
});

test("the shapes a worker plausibly guesses are rejected, with the plan path named", () => {
  const node = {
    id: "build",
    objective: "Implement it",
    taskKind: "implement",
    riskTier: "standard",
    dependsOn: [],
    readFiles: ["README.md"],
    writeFiles: ["README.md"],
  };
  // Observed live 2026-09-20: a DoD item with no id.
  assert.throws(
    () => validatePlanOutput({ nodes: [{ ...node, definitionOfDone: [{ text: "It works", proof: { kind: "path", ref: "README.md" } }], verification: [] }] }),
    /plan\.nodes\[0\]\.definitionOfDone\[0\]/,
  );
  // ...and a verification entry keyed `command` where argv belongs.
  assert.throws(
    () => validatePlanOutput({ nodes: [{ ...node, definitionOfDone: [{ id: "works", text: "It works", judgment: true }], verification: [{ command: "node --test" }] }] }),
    /unexpected field command/,
  );
});

test("the spelled shapes keep every planning prompt inside renderWorkerPrompt's guard", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  // Measured 2026-09-20: the draft prompt is 2.8 KiB and the revise prompt
  // 2.8 KiB with both shapes spelled, against renderWorkerPrompt's 64 KiB
  // ceiling.
  for (const kind of /** @type {const} */ (["draft", "revise", "review", "spec-author", "spec-review"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const prompt = renderWorkerPrompt(contract.nodes[0].taskPacket, kind);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= 64 * 1024, `${kind} prompt fits the 64 KiB guard`);
  }
});

test("TASK_KINDS and RISK_TIERS carry the agreed catalogues", () => {
  assert.deepEqual([...TASK_KINDS], ["docs", "implement", "test", "refactor", "infra", "judge"]);
  assert.deepEqual([...RISK_TIERS], ["low", "standard", "high"]);
});

test("buildPlanningContract requires every input a kind names", () => {
  assert.throws(() => buildPlanningContract("draft", baseInputs({ repoFactsPath: undefined })), /repoFactsPath/);
  assert.throws(() => buildPlanningContract("review", baseInputs({ planPath: undefined })), /planPath/);
  assert.throws(() => buildPlanningContract("revise", baseInputs({ findingsPath: undefined })), /findingsPath/);
  assert.throws(() => buildPlanningContract("spec-author", baseInputs({ notesPath: undefined })), /notesPath/);
  assert.throws(() => buildPlanningContract("spec-review", baseInputs({ specPath: undefined })), /specPath/);
});
