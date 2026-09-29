import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import { TASK_KIND_CATALOGUE_FILE, buildPlanningContract } from "../../src/plan/template.mjs";

// R5 of the phase-2 reissue, reissued. A planning packet's readFiles resolve
// against the target repository being planned, so a review contract that named
// the Faberun source and test files behind the freeze and proof rules
// validated in this repository and nowhere else. The rules are carried in the
// review packet's own instructions instead, and this file proves both halves:
// the contract validates against a target checkout that holds only the three
// inputs, and its instructions state the rules themselves.

const RUNTIMES = {
  "anthropic-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
  "openai-reviewer": { harness: "codex", model: "gpt-5.6", vendor: "openai" },
};
const RUNTIME_DEFAULTS = { worker: "anthropic-sonnet", judge: "openai-reviewer" };
const REVIEW_READ_FILES = ["docs/spec.md", ".runs/repo-facts.json", ".runs/plan.json"];

/** @returns {string} a target checkout holding only the review's three inputs */
function bareTargetCheckout() {
  const cwd = mkdtempSync(join(tmpdir(), "review-portable-"));
  for (const relative of REVIEW_READ_FILES) {
    const path = join(cwd, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "placeholder\n");
  }
  return cwd;
}

/** @returns {any} the planning inputs every contract below is built from */
function inputs() {
  return {
    campaignId: "portable-campaign",
    phase: "portable-phase",
    n: 1,
    runtimes: RUNTIMES,
    runtimeDefaults: RUNTIME_DEFAULTS,
    reviewerId: "openai-reviewer",
    specPath: "docs/spec.md",
    repoFactsPath: ".runs/repo-facts.json",
    planPath: ".runs/plan.json",
    cataloguePath: `.runs/${TASK_KIND_CATALOGUE_FILE}`,
    findingsPath: ".runs/findings.json",
    notesPath: "docs/notes.md",
  };
}

/** @param {string} cwd @returns {string} */
function reviewInstructions(cwd) {
  const contract = validateContract(buildPlanningContract("review", inputs()), join(cwd, "contract.json"));
  return contract.nodes[0].taskPacket.instructions.join("\n");
}

test("a review contract validates against a target checkout holding only its three inputs and no faberun tree", () => {
  const cwd = bareTargetCheckout();
  // Not a faberun checkout: neither the module tree the packet used to name
  // nor a test tree exists here, so a declared Faberun path could only refuse
  // the contract.
  assert.equal(existsSync(join(cwd, "src")), false, "the target checkout has no src/");
  assert.equal(existsSync(join(cwd, "test")), false, "the target checkout has no test/");

  const contract = validateContract(buildPlanningContract("review", inputs()), join(cwd, "contract.json"));
  assert.deepEqual(contract.nodes[0].taskPacket.readFiles, REVIEW_READ_FILES);
});

test("the review instructions state the rules, including the ones the packet used to point at by path", () => {
  const instructions = reviewInstructions(bareTargetCheckout());
  const rules = [
    // The paths in this packet resolve against the target, and a path is not a
    // rule.
    [/the rules this packet states/u, "the target-path statement"],
    // The rules a draft authors to, now stated to the reviewer as well.
    [/writeFiles lists what the change forces to change, not only what it intends to/u, "scope closure"],
    [/Scope closure refuses a task packet whose transitive imports reach an undeclared file/u, "scope closure's refusal"],
    [/names the test file it selects from/u, "the name-filtered test-file rule"],
    [/testFiles lists, per test file, the repo-relative modules it is named after/u, "the covering-test rule"],
    [/output\.plan\.sharedVerification/u, "the contract-level verification suites"],
    [/verificationCandidates includes each measured argv with its measuredMs/u, "the measured-candidate rule"],
    [/Size nodes to 4 to 6 write files where the work allows/u, "the sizing rule"],
    // The two rules only a reviewer applies, and the freeze-time refusals no
    // earlier stage can see.
    [/compare each command proof with the requirement statement it proves/u, "the proof-vs-requirement reading"],
    [/absent from it is not evidence that the file is absent/u, "the path cut"],
    [/timeoutSec is at least 1\.5 times what repo-facts\.json measured/u, "the measured-timeout rule"],
    [/a node's verification holds at most 32 commands/u, "the verification limit"],
  ];
  for (const [pattern, rule] of rules) assert.match(instructions, /** @type {RegExp} */ (pattern), `the review instructions state ${rule}`);
});

test("no planning packet's readFiles name a faberun source or test path", () => {
  // Generated only: a draft and a revise also read the staged catalogue and, for
  // a revise, the findings and the plan, so the target checkout that validates
  // them is test/plan/template.test.mjs's. What this asserts is the packet's
  // own shape, before any path is resolved.
  for (const kind of /** @type {const} */ (["draft", "revise", "review"])) {
    const packet = /** @type {any} */ (buildPlanningContract(kind, inputs())).nodes[0].taskPacket;
    for (const path of packet.readFiles) {
      assert.doesNotMatch(path, /^(?:src|test)\//u, `${kind} must not read ${path}: every readFile resolves against the target repository`);
    }
  }
});

test("the review prompt stays inside renderWorkerPrompt's 64 KiB guard with the rules inline", () => {
  const cwd = bareTargetCheckout();
  const contract = validateContract(buildPlanningContract("review", inputs()), join(cwd, "contract.json"));
  const prompt = renderWorkerPrompt(contract.nodes[0].taskPacket, "review");
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 64 * 1024, "the review prompt fits the 64 KiB guard");
});
