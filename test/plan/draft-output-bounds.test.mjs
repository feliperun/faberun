import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { TASK_KIND_CATALOGUE_FILE, buildPlanningContract, renderTaskKindCatalogue } from "../../src/plan/template.mjs";

const RUNTIMES = {
  "anthropic-sonnet": { harness: "claude", model: "claude-sonnet-5" },
  "openai-reviewer": { harness: "codex", model: "gpt-5.6" },
};

/**
 * measured 2026-09-30: the FX runner truncates a tool result at 8,192 output
 * tokens. A draft that read repo-facts.json's whole `paths`, `testFiles` or
 * `testFiles[].covers` in one call got a partial back and planned against it as
 * though it were the whole tree, so the draft instructions carry the bound and
 * this test holds that they still do.
 *
 * @returns {import("../../src/plan/template.mjs").PlanningContractInputs}
 */
function draftInputs() {
  return /** @type {any} */ ({
    campaignId: "demo-campaign",
    phase: "demo-phase",
    n: 1,
    runtimes: RUNTIMES,
    runtimeDefaults: { worker: "anthropic-sonnet", judge: "openai-reviewer" },
    specPath: "docs/spec.md",
    repoFactsPath: ".runs/repo-facts.json",
    cataloguePath: `.runs/${TASK_KIND_CATALOGUE_FILE}`,
    planPath: ".runs/plan.json",
    findingsPath: ".runs/findings.json",
    notesPath: "docs/notes.md",
  });
}

/** @param {string} cwd @param {string} relative @param {string} [content] */
function writeInputFile(cwd, relative, content = "placeholder\n") {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** @returns {string} a temp checkout holding every path a planning contract may declare in readFiles */
function checkout() {
  const cwd = mkdtempSync(join(tmpdir(), "plan-draft-bounds-"));
  writeInputFile(cwd, `.runs/${TASK_KIND_CATALOGUE_FILE}`, renderTaskKindCatalogue());
  for (const relative of ["docs/spec.md", ".runs/repo-facts.json", ".runs/plan.json", ".runs/findings.json", "docs/notes.md"]) {
    writeInputFile(cwd, relative);
  }
  return cwd;
}

/**
 * @param {import("../../src/plan/template.mjs").PlanningKind} kind
 * @param {string} cwd
 * @returns {string[]}
 */
function instructionsFor(kind, cwd) {
  return validateContract(buildPlanningContract(kind, draftInputs()), join(cwd, "contract.json")).nodes[0].taskPacket.instructions;
}

test("the generated draft packet bounds every repo-facts query below the measured FX response ceiling", () => {
  const draft = instructionsFor("draft", checkout());
  const rule = draft.find((instruction) => instruction.startsWith("Bound every repository-facts query"));
  assert.ok(rule, JSON.stringify(draft));
  assert.match(rule, /requirement/u);
  assert.match(rule, /below the measured 8,192-output-token FX response ceiling/u);
  assert.match(rule, /each individual tool result stays strictly below the ceiling/u);
  assert.match(rule, /Never dump all of paths, testFiles, or the testFiles\[\]\.covers coverage mapping in one result/u);
  assert.match(rule, /split a broad selection into requirement-scoped queries/u);
  assert.match(rule, /A tool result that truncated is not evidence/u);
});

test("the query bound stays off the revise and review instructions", () => {
  const cwd = checkout();
  for (const kind of /** @type {const} */ (["revise", "review", "spec-author", "spec-review"])) {
    const instructions = instructionsFor(kind, cwd);
    assert.ok(!instructions.some((instruction) => instruction.startsWith("Bound every repository-facts query")), `${kind} must not carry the draft's query bound`);
  }
});
