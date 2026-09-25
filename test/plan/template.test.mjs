import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import { droppedWriteFindings, unresolvedFindings } from "../../src/plan/pipeline.mjs";
import {
  RISK_TIERS,
  TASK_KINDS,
  TASK_KIND_CATALOGUE_FILE,
  renderTaskKindCatalogue,
  buildPlanningContract,
  validateFindings,
  validatePlanOutput,
} from "../../src/plan/template.mjs";

const RUNTIMES = {
  "anthropic-sonnet": { harness: "claude", model: "claude-sonnet-5" },
  "openai-reviewer": { harness: "codex", model: "gpt-5.6" },
};
const RUNTIME_DEFAULTS = { worker: "anthropic-sonnet", judge: "openai-reviewer" };

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
    cataloguePath: `.runs/${TASK_KIND_CATALOGUE_FILE}`,
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
  writeInputFile(cwd, `.runs/${TASK_KIND_CATALOGUE_FILE}`, renderTaskKindCatalogue());
  for (const relative of ["docs/spec.md", ".runs/repo-facts.json", ".runs/plan.json", ".runs/findings.json", "docs/notes.md"]) {
    writeInputFile(cwd, relative);
  }
  return cwd;
}

/** @returns {import("../../src/plan/template.mjs").PlanOutputNode} a minimal valid plan node */
function planNode() {
  return {
    id: "build",
    objective: "Implement it",
    taskKind: "implement",
    riskTier: "standard",
    dependsOn: [],
    readFiles: ["README.md"],
    writeFiles: ["README.md"],
    scopeAcknowledged: [],
    definitionOfDone: [],
    verification: [],
  };
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
  assert.equal(draftVendor, "anthropic");
  assert.equal(reviewVendor, "openai");
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
    assert.match(instructions, /definitionOfDone: \[\{id, text, proof\?: \{kind: "command"\|"path"\|"verification", ref\}, judgment\?: true, reason\?: string\}\]/);
    assert.match(instructions, /verification: \[\{argv: \[string\], cwd\?, timeoutSec\?, repeat\?, env\?, mutation\?: \{threshold\}\}\]/);
    // The id charset is requireId's (contract/assert.mjs) verbatim: an id that
    // is present but invalid fails validatePlanOutput just as late as an
    // absent one — after the run already succeeded.
    assert.match(instructions, /every id in it \(node, phase, node assignment, and definitionOfDone item\) must match \[A-Za-z0-9\._-\]\+ and never be exactly "\." or "\.\."/);
  }
});

test("draft and revise instructions carry the scope-closure rule writeFiles is held to", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  for (const kind of /** @type {const} */ (["draft", "revise"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const instructions = contract.nodes[0].taskPacket.instructions.join("\n");
    assert.match(instructions, /writeFiles lists what the change forces to change, not only what it intends to/);
    assert.match(instructions, /Scope closure refuses a task packet whose transitive imports reach an undeclared file/);
    assert.match(instructions, /readFiles only permits reading/);
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

test("a plan can acknowledge an importer it will not change, which is the only answer to a scope-closure finding it can give", () => {
  // The preflight raises a scope-closure failure as a finding and the
  // instructions tell the drafter to answer it with `writeFiles or
  // scopeAcknowledged`. Measured 2026-09-20: without this field the second
  // answer was inexpressible -- validatePlanOutput rejected it as an unknown
  // node field -- so the only plan a revise round could emit declared a
  // read-only importer writable, which is exactly what scope closure exists
  // to stop someone doing silently.
  const validated = validatePlanOutput({
    nodes: [{
      id: "build",
      objective: "Implement it",
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: ["README.md"],
      writeFiles: ["README.md"],
      scopeAcknowledged: ["test/cli/cli.test.mjs"],
      definitionOfDone: [],
      verification: [],
    }],
  });
  assert.deepEqual(validated.nodes[0].scopeAcknowledged, ["test/cli/cli.test.mjs"]);

  // Absent is the common case and stays legal: a node that drags nothing along
  // declares nothing, and reads back as an empty list rather than undefined.
  const bare = validatePlanOutput({
    nodes: [{
      id: "build", objective: "Implement it", taskKind: "implement", riskTier: "standard",
      dependsOn: [], readFiles: ["README.md"], writeFiles: ["README.md"], definitionOfDone: [], verification: [],
    }],
  });
  assert.deepEqual(bare.nodes[0].scopeAcknowledged, []);

  assert.throws(
    () => validatePlanOutput({
      nodes: [{
        id: "build", objective: "Implement it", taskKind: "implement", riskTier: "standard",
        dependsOn: [], readFiles: ["README.md"], writeFiles: ["README.md"],
        scopeAcknowledged: "test/cli/cli.test.mjs",
        definitionOfDone: [], verification: [],
      }],
    }),
    /plan\.nodes\[0\]\.scopeAcknowledged/u,
  );
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
  // Measured 2026-09-20: the draft prompt is 3.6 KiB and the revise prompt
  // 3.4 KiB with every shape spelled, against renderWorkerPrompt's 64 KiB
  // ceiling.
  for (const kind of /** @type {const} */ (["draft", "revise", "review", "spec-author", "spec-review"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const prompt = renderWorkerPrompt(contract.nodes[0].taskPacket, kind);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= 64 * 1024, `${kind} prompt fits the 64 KiB guard`);
  }
});

test("a plan phase with no associated requirement is reported as a finding, not refused", () => {
  const validated = validatePlanOutput({
    nodes: [planNode()],
    phases: [
      { id: "protocol", requirementIds: ["R1", "R2"], deliverable: "The packet schema closes over its imports." },
      { id: "chore", requirementIds: [], deliverable: "Dependencies are bumped." },
      { id: "mystery", deliverable: "No ids declared at all." },
    ],
  });
  assert.deepEqual(validated.phases, [
    { id: "protocol", requirementIds: ["R1", "R2"], deliverable: "The packet schema closes over its imports." },
    { id: "chore", requirementIds: [], deliverable: "Dependencies are bumped." },
    { id: "mystery", requirementIds: [], deliverable: "No ids declared at all." },
  ]);
  assert.deepEqual(validated.findings, [
    {
      id: "no-requirement-chore",
      severity: "minor",
      nodeId: "chore",
      text: "Phase chore is associated with no requirement: fill requirementIds with the R<n> ids from the spec that it satisfies, or fold it into a phase that does.",
    },
    {
      id: "no-requirement-mystery",
      severity: "minor",
      nodeId: "mystery",
      text: "Phase mystery is associated with no requirement: fill requirementIds with the R<n> ids from the spec that it satisfies, or fold it into a phase that does.",
    },
  ]);
});

test("a plan whose phases all name requirements carries no findings, and the phases-less shape stays legal", () => {
  const validated = validatePlanOutput({
    nodes: [planNode()],
    phases: [{ id: "protocol", requirementIds: ["R1"], deliverable: "One sentence." }],
  });
  assert.deepEqual(validated.phases, [{ id: "protocol", requirementIds: ["R1"], deliverable: "One sentence." }]);
  assert.equal(validated.findings, undefined);

  const bare = validatePlanOutput({ nodes: [planNode()] });
  assert.equal(bare.phases, undefined);
  assert.equal(bare.findings, undefined);
});

test("a malformed phase declaration is still a hard refusal", () => {
  assert.throws(() => validatePlanOutput({ nodes: [planNode()], phases: "protocol" }), /plan\.phases must be an array/);
  assert.throws(
    () => validatePlanOutput({ nodes: [planNode()], phases: [{ id: "p1", requirementIds: "R1", deliverable: "x" }] }),
    /plan\.phases\[0\]\.requirementIds/,
  );
  assert.throws(
    () => validatePlanOutput({ nodes: [planNode()], phases: [{ id: "p1", requirementIds: ["R1"] }] }),
    /plan\.phases\[0\]\.deliverable/,
  );
  assert.throws(
    () => validatePlanOutput({ nodes: [planNode()], phases: [{ requirementIds: ["R1"], deliverable: "x" }] }),
    /plan\.phases\[0\]\.id/,
  );
  assert.throws(
    () => validatePlanOutput({ nodes: [planNode()], phases: [{ id: "p1", requirementIds: ["R1"], deliverable: "x", runtime: "anthropic-sonnet" }] }),
    /unexpected field runtime/,
  );
});

test("a nodeIds declaration must cover every planned node exactly once", () => {
  /** @param {unknown} phases @returns {Record<string, unknown>} */
  const plan = (phases) => ({
    nodes: [planNode(), { ...planNode(), id: "docs", objective: "Write the docs" }],
    phases,
  });

  const validated = validatePlanOutput(plan([
    { id: "build-phase", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build it." },
    { id: "docs-phase", requirementIds: ["R2"], nodeIds: ["docs"], deliverable: "Document it." },
  ]));
  assert.deepEqual(validated.phases, [
    { id: "build-phase", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build it." },
    { id: "docs-phase", requirementIds: ["R2"], nodeIds: ["docs"], deliverable: "Document it." },
  ]);
  assert.equal(validated.findings, undefined);

  // A planned node no declaration names.
  assert.throws(
    () => validatePlanOutput(plan([{ id: "build-phase", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build it." }])),
    /leaves planned node\(s\) assigned to no phase: docs/,
  );
  // A node two declarations both name.
  assert.throws(
    () => validatePlanOutput(plan([
      { id: "one", requirementIds: ["R1"], nodeIds: ["build", "docs"], deliverable: "Both." },
      { id: "two", requirementIds: ["R2"], nodeIds: ["docs"], deliverable: "Again." },
    ])),
    /assigns node docs to both one and two/,
  );
  // A declaration naming a node the plan does not have.
  assert.throws(
    () => validatePlanOutput(plan([
      { id: "one", requirementIds: ["R1"], nodeIds: ["build", "ghost"], deliverable: "Both." },
      { id: "two", requirementIds: ["R2"], nodeIds: ["docs"], deliverable: "Docs." },
    ])),
    /assigns unknown node ghost/,
  );
  // The nodeIds shape refuses an empty assignment and an empty requirement
  // list, the two things the legacy shape reports as a visible gap instead.
  assert.throws(
    () => validatePlanOutput(plan([{ id: "one", requirementIds: ["R1"], nodeIds: [], deliverable: "Nothing." }])),
    /nodeIds must name at least one planned node/,
  );
  assert.throws(
    () => validatePlanOutput(plan([{ id: "one", requirementIds: [], nodeIds: ["build", "docs"], deliverable: "No requirement." }])),
    /requirementIds must name at least one requirement/,
  );
  // Mixing the legacy and nodeIds shapes, and a duplicate phase id, are both
  // refusals rather than a silent partial attribution.
  assert.throws(
    () => validatePlanOutput(plan([
      { id: "one", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build." },
      { id: "two", requirementIds: ["R2"], deliverable: "Legacy." },
    ])),
    /assign nodeIds on every declaration or on none/,
  );
  assert.throws(
    () => validatePlanOutput(plan([
      { id: "one", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build." },
      { id: "one", requirementIds: ["R2"], nodeIds: ["docs"], deliverable: "Docs." },
    ])),
    /duplicate phase id one/,
  );
});

test("draft and revise instructions spell the per-phase requirement declaration", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");
  for (const kind of /** @type {const} */ (["draft", "revise"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const instructions = contract.nodes[0].taskPacket.instructions.join("\n");
    assert.match(instructions, /phases\?: \[\{id, requirementIds: \[string\], nodeIds: \[string\], deliverable\}\]/);
    assert.match(instructions, /the requirement ids \(R<n> from the spec\) the phase satisfies, the planned node ids it assigns, and the deliverable it produces in one sentence/);
    assert.match(instructions, /Every planned node must appear in exactly one phase's nodeIds; a missing, duplicate, or unknown node assignment is refused/);
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

test("a plan node may declare expectedTurns, a positive integer, and the drafter is told how to size a node", () => {
  const node = { id: "build", objective: "Implement it", taskKind: "implement", riskTier: "standard", dependsOn: [], readFiles: ["README.md"], writeFiles: ["README.md"] };
  assert.equal(validatePlanOutput({ nodes: [{ ...node, expectedTurns: 40 }] }).nodes[0].expectedTurns, 40);
  assert.equal(validatePlanOutput({ nodes: [node] }).nodes[0].expectedTurns, undefined);
  assert.throws(() => validatePlanOutput({ nodes: [{ ...node, expectedTurns: 0 }] }), /expectedTurns/u);
  assert.throws(() => validatePlanOutput({ nodes: [{ ...node, expectedTurns: "many" }] }), /expectedTurns/u);
});

/** @param {string} id @param {string[]} writeFiles @returns {any} a plan node differing only where a test says so */
function nodeWriting(id, writeFiles) {
  return { ...planNode(), id, objective: `Do ${id}`, writeFiles };
}

test("a revision that drops a write the previous plan declared is a critical finding naming the node and the path", () => {
  const previous = { nodes: [nodeWriting("build", ["README.md", "src/extra.mjs", "src/gone.mjs"]), nodeWriting("docs", ["docs/spec.md"])] };
  const revised = { nodes: [nodeWriting("build", ["README.md"]), nodeWriting("docs", ["docs/spec.md"])] };

  const findings = droppedWriteFindings(previous, revised);
  assert.deepEqual(findings.map((finding) => finding.id), ["dropped-write-build-1", "dropped-write-build-2"]);
  assert.ok(findings.every((finding) => finding.severity === "critical" && finding.nodeId === "build"));
  assert.ok(findings.some((finding) => finding.text.includes("src/extra.mjs")));
  assert.ok(findings.some((finding) => finding.text.includes("src/gone.mjs")));
  assert.ok(findings.every((finding) => finding.text.includes("never to drop a write the node needs")));

  // A node that keeps its write set, or only gains writes, is never flagged.
  assert.deepEqual(droppedWriteFindings(previous, previous), []);
  assert.deepEqual(droppedWriteFindings({ nodes: [nodeWriting("build", ["README.md"])] }, { nodes: [nodeWriting("build", ["README.md", "src/new.mjs"])] }), []);
});

test("a revise that hands a write to a new sibling node has moved it, not dropped it", () => {
  // Measured 2026-09-21 on durable-state-integrity phase 1: the draft's only
  // node wrote both src/repo/worktree.mjs and src/engine/cancel.mjs, and the
  // revise layered them into two nodes along this repository's own boundary
  // -- repo/ owns git, engine/ owns the control loop. A per-node membership
  // test read the surviving node as having dropped worktree.mjs and emitted a
  // critical, which contested a sound plan. The path is still declared, still
  // reviewed, and the graph change is visible; that is a resolution.
  const previous = { nodes: [nodeWriting("build", ["src/repo/worktree.mjs", "src/engine/cancel.mjs"])] };
  const split = {
    nodes: [nodeWriting("worktree-verb", ["src/repo/worktree.mjs"]), nodeWriting("build", ["src/engine/cancel.mjs"])],
  };
  assert.deepEqual(droppedWriteFindings(previous, split), []);

  // A path that leaves the plan entirely is still critical, sibling or not.
  const shrunk = {
    nodes: [nodeWriting("worktree-verb", ["src/repo/worktree.mjs"]), nodeWriting("build", [])],
  };
  const findings = droppedWriteFindings(previous, shrunk);
  assert.deepEqual(findings.map((finding) => finding.id), ["dropped-write-build-1"]);
  assert.ok(findings[0].text.includes("src/engine/cancel.mjs"));
  assert.ok(findings[0].text.includes("no other node in the revised plan declares it"));
});

test("a node the revision renamed or removed is out of scope for the write-drop check", () => {
  // Nodes are matched by id alone: identity across a rename is a judgement
  // about the graph this check does not make, and a removed node's writes
  // were reviewed as a removal, not as a silent shrink.
  const previous = { nodes: [nodeWriting("build", ["README.md"])] };
  assert.deepEqual(droppedWriteFindings(previous, { nodes: [nodeWriting("build-2", ["README.md"])] }), []);
});

test("the write-drop check needs both plans: a draft that never validated or a revise refused leaves nothing to compare", () => {
  assert.deepEqual(droppedWriteFindings(null, { nodes: [nodeWriting("build", ["README.md"])] }), []);
  assert.deepEqual(droppedWriteFindings({ nodes: [nodeWriting("build", ["README.md"])] }, null), []);
});

/** @param {string} id @param {string} nodeId @returns {import("../../src/plan/template.mjs").PlanFindingOutput} */
function findingAgainst(id, nodeId) {
  return { id, severity: "critical", nodeId, text: `${id} objects to ${nodeId}` };
}

test("a finding survives a revise that left its node alone, and is resolved once the plan moves under it", () => {
  const previous = { nodes: [nodeWriting("build", ["README.md"]), nodeWriting("docs", ["docs/spec.md"])] };
  const findings = [findingAgainst("F1", "build"), findingAgainst("F2", "docs"), findingAgainst("F3", "plan")];

  // Nothing moved: both findings against a node of the plan are still open.
  // The third names no node — it is the pipeline's own shape finding, which
  // the next round's pre-flight re-derives — so it is not carried.
  const untouched = { nodes: [nodeWriting("build", ["README.md"]), nodeWriting("docs", ["docs/spec.md"])] };
  assert.deepEqual(unresolvedFindings(findings, previous, untouched).map((finding) => finding.id), ["F1", "F2"]);

  // build changed, docs is gone: one was acted on, the other is moot.
  const revised = { nodes: [nodeWriting("build", ["README.md", "src/new.mjs"])] };
  assert.deepEqual(unresolvedFindings(findings, previous, revised), []);

  // A node the revise introduced answers nothing raised against its id.
  assert.deepEqual(unresolvedFindings([findingAgainst("F4", "added")], previous, { nodes: [nodeWriting("added", ["src/added.mjs"])] }), []);
});

test("a refused revise output leaves every finding outstanding: there is no revised plan to measure against", () => {
  const previous = { nodes: [nodeWriting("build", ["README.md"])] };
  const findings = [findingAgainst("F1", "build")];
  assert.deepEqual(unresolvedFindings(findings, previous, null), findings);
});

test("a planning contract names no path inside faberun's own source", () => {
  // The finding this closes: `readFiles` resolve against the *target*
  // repository, so a planning contract that named `src/plan/template.mjs`
  // validated in this repository and in no other one -- `faberun plan` could
  // plan only faberun. The checkout below is deliberately an ordinary
  // repository with none of faberun's files in it.
  const cwd = checkout();
  assert.equal(existsSync(join(cwd, "src", "plan", "template.mjs")), false, "the checkout is not a faberun checkout");
  const contractPath = join(cwd, "contract.json");
  for (const kind of /** @type {const} */ (["draft", "revise"])) {
    const contract = validateContract(buildPlanningContract(kind, baseInputs()), contractPath);
    const readFiles = contract.nodes[0].taskPacket.readFiles;
    assert.ok(readFiles.includes(`.runs/${TASK_KIND_CATALOGUE_FILE}`), `${kind} reads the staged catalogue`);
    for (const path of readFiles) {
      assert.doesNotMatch(path, /^src\//u, `${kind} must not read ${path}: it is faberun's source, not the target repository's`);
    }
  }
  // The staged document carries the values the validator enforces, so a
  // worker that obeys it cannot be refused for a taskKind it was told to use.
  const catalogue = renderTaskKindCatalogue();
  for (const kind of TASK_KINDS) assert.match(catalogue, new RegExp(`^- ${kind}$`, "mu"));
  for (const tier of RISK_TIERS) assert.match(catalogue, new RegExp(`^- ${tier}$`, "mu"));
});

test("every planning stage's prompt asks for output and an empty artifacts list, never an artifact", () => {
  // Every planning stage is a discovery packet closed to its read files, so
  // it delivers through `output`: a prompt asking for an artifact made a
  // 38 KiB draft copy its plan into artifacts[0] and break the 16 KiB ceiling.
  for (const kind of /** @type {const} */ (["draft", "review", "revise", "spec-author", "spec-review"])) {
    const raw = /** @type {{nodes: {taskPacket: unknown}[]}} */ (buildPlanningContract(kind, baseInputs()));
    const prompt = renderWorkerPrompt(/** @type {any} */ (raw.nodes[0].taskPacket), kind);
    assert.match(prompt, /deliver your result in `output` and send `artifacts` as \[\]/, `${kind} prompt names output`);
    assert.ok(!prompt.includes("artifacts[0]"), `${kind} prompt never asks for an artifact`);
  }
});
