import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";
import { projectCampaignDecisions } from "../../src/campaign/projection.mjs";
import { buildBriefModel } from "../../src/campaign/campaign-brief.mjs";
import { contractDigest } from "../../src/contract/index.mjs";
import { contentDigest, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";

/** @typedef {import("../../src/campaign/campaign-brief.mjs").BriefModel} BriefModel */

const SPEC_PATH = "/repo/docs/campaigns/campaign-brief/spec/SPEC.md";
const PLAN_PATH = "/repo/.runs/campaigns/campaign-brief/plans/P1/plan.json";

/** @returns {BriefModel} */
function baseModel() {
  return {
    identity: {
      campaign: "campaign-brief",
      specBaseline: "d9eae18a917d328326a3a07bdd80d34c379901cc",
      specDigest: "a".repeat(64),
      specPath: SPEC_PATH,
      targetGitHead: "abc123",
      planPath: PLAN_PATH,
      planDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      journalCursor: 7,
      usageSampleCutoff: "2026-09-01T00:00:00.000Z",
    },
    opening: {
      intent: "An operator should be able to decide in a few minutes whether a frozen plan is worth executing.",
      expectedOutcome: "Markdown for one frozen plan",
      successCriteria: [{ measure: "Pre-execution approval artefact", target: "Markdown for one frozen plan", evidence: "R1" }],
      humanFacts: [
        "Human decision: Review the generated brief before executing the contract.",
        "Delegated decision: Pick module boundaries from this spec.",
        "Risk: A plausible summary disagrees — mitigation: pin the digests",
        "Planned eval: A missing spec produces a refusal.",
      ],
      calculatedFacts: ["Coverage: 1 covered, 0 uncovered, 0 outside this plan, 0 traceability missing of 1 spec requirements."],
      gaps: [],
    },
    coverage: {
      rows: [
        { requirementId: "R1", title: "One brief belongs to one frozen plan", declaredNodeIds: ["n1"], nodes: [{ id: "n1", proof: "dod1 command: npm run typecheck; node --test test/campaign" }], state: "covered", reasons: [] },
      ],
      unknownIds: [],
      unknownDeclared: [],
      unknownStamped: [],
      gaps: [],
      specPath: SPEC_PATH,
      planPath: PLAN_PATH,
      covered: 1,
      uncovered: 0,
      outside: 0,
      traceabilityMissing: 0,
      total: 1,
    },
    graph: {
      nodes: [{ id: "n1", runtimeId: "codex", model: "gpt-5", dependsOn: [], requirementIds: ["R1"] }],
      edges: [],
      independent: ["n1"],
      blocking: [],
      maxParallel: 1,
      maxConcurrent: { codex: 1 },
      effectiveConcurrency: 1,
      dispatchableTogether: ["n1"],
      dispatchNote: "fewer than two nodes are planned",
      gaps: [],
    },
    decisions: {
      human: ["Review the generated brief before executing the contract."],
      delegated: ["Pick module boundaries from this spec."],
      journal: [],
      risks: [{ risk: "A plausible summary disagrees", impact: "wrong approval", mitigation: "pin the digests" }],
      evals: ["A missing spec produces a refusal."],
      gaps: [],
    },
    estimate: {
      cost: { status: "range", min: 1, max: 2, samples: 6, reason: null, sourceRuns: ["run-a"], method: null, provenance: "priced usage.jsonl invocations" },
      duration: { status: "range", min: 10, max: 20, samples: 6, reason: null, sourceRuns: ["run-a"], method: null, provenance: "recorded actual node and verification elapsed times" },
      runtimes: ["codex"],
      models: ["gpt-5"],
      effectiveConcurrency: 1,
      nodeCount: 1,
      workerCount: 1,
      sampleCutoff: "2026-09-01T00:00:00.000Z",
      method: ["at least five comparable completed nodes per assigned role"],
      assumptions: ["Ranges are advisory, never spend or time ceilings."],
      gaps: [],
    },
    decisionState: "ready for human review",
  };
}

/** @param {string} markdown @returns {number} */
function openingWords(markdown) {
  const before = markdown.split("## Coverage matrix")[0] ?? "";
  const trimmed = before.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

test("renders the R2 opening, coverage matrix and links", () => {
  const model = baseModel();
  const markdown = renderCampaignBriefMarkdown(model);

  assert.match(markdown, /^# Campaign brief — campaign-brief/u);
  assert.match(markdown, /## Identity/u);
  assert.match(markdown, /Spec baseline: `d9eae18a/u);
  assert.match(markdown, /Target git head: `abc123`/u);
  assert.match(markdown, /## Decision/u);
  assert.match(markdown, /ready for human review/u);
  assert.match(markdown, /\[.*SPEC\.md\]\(\/repo\/docs\/campaigns\/campaign-brief\/spec\/SPEC\.md\)/u);
  assert.match(markdown, /\[.*plan\.json\]\(\/repo\/\.runs\/campaigns\/campaign-brief\/plans\/P1\/plan\.json\)/u);
  assert.match(markdown, /## Coverage matrix/u);
  assert.match(markdown, /\| `R1` \| `n1` \|/u);
  assert.match(markdown, /npm run typecheck/u);
  assert.ok(openingWords(markdown) <= 250);
});

test("marks human-authored and calculated facts separately", () => {
  const markdown = renderCampaignBriefMarkdown(baseModel());
  assert.match(markdown, /## Human-authored facts/u);
  assert.match(markdown, /Human decision: Review the generated brief/u);
  assert.match(markdown, /Risk: A plausible summary disagrees/u);
  assert.match(markdown, /## Calculated facts/u);
  assert.match(markdown, /Coverage: 1 covered/u);
});

test("names unknown requirement ids explicitly", () => {
  const model = baseModel();
  model.coverage.unknownIds = ["R99"];
  model.coverage.unknownDeclared = ["R99"];
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /Unknown requirement ids: `R99`/u);
});

test("renders gaps and insufficient data with the gap decision state", () => {
  const model = baseModel();
  model.decisionState = "gaps to resolve";
  model.coverage.gaps = ["R2: uncovered (declared but no frozen node is assigned)"];
  model.estimate.cost = { status: "insufficient data", min: null, max: null, samples: 4, reason: "fewer than 5 comparable completed nodes", sourceRuns: [], method: null, provenance: "priced usage.jsonl invocations" };
  model.estimate.gaps = ["cost estimate reports insufficient data: fewer than 5 comparable completed nodes"];
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /gaps to resolve/u);
  assert.match(markdown, /## Gaps/u);
  assert.match(markdown, /R2: uncovered/u);
  assert.match(markdown, /insufficient data — fewer than 5 comparable completed nodes/u);
});

test("is deterministic and bounds the opening at 250 words", () => {
  const model = baseModel();
  model.opening.humanFacts = Array.from({ length: 60 }, (_, index) => `Human decision ${index}: ${"word ".repeat(30)}`);
  const first = renderCampaignBriefMarkdown(model);
  const second = renderCampaignBriefMarkdown(model);
  assert.equal(second, first);
  assert.ok(openingWords(first) <= 250);
  assert.match(first, /An operator should be able to decide/u);
});

test("renders the R5 counts, concurrency, provenance, method and assumptions", () => {
  const markdown = renderCampaignBriefMarkdown(baseModel());
  assert.match(markdown, /## Estimate/u);
  assert.match(markdown, /- Nodes: 1/u);
  assert.match(markdown, /- Workers: 1/u);
  assert.match(markdown, /Effective worker concurrency: 1/u);
  assert.match(markdown, /Cost provenance: priced usage\.jsonl invocations/u);
  assert.match(markdown, /Duration provenance: recorded actual node and verification elapsed times/u);
  assert.match(markdown, /Advisory only: ranges are not spend or time ceilings\./u);
  assert.match(markdown, /Runtimes: `codex`/u);
  assert.match(markdown, /Models: `gpt-5`/u);
  assert.match(markdown, /Sample cutoff: 2026-09-01T00:00:00\.000Z/u);
});

// R4: the work graph and the judgment, from the graph and the two allowed
// decision sources only.

test("projectCampaignDecisions lists only the active journal decisions in order", () => {
  const projections = [
    {
      updatedAt: null,
      decisions: {
        // d1 was superseded and is already gone from the folded projection.
        d2: { type: "decision", eventId: "e2", at: "2026-09-02T00:00:00.000Z", sessionId: "s1", decisionId: "d2", text: "Second decision" },
        d1: { type: "decision", eventId: "e1", at: "2026-09-01T00:00:00.000Z", sessionId: "s1", decisionId: "d1", text: "First decision" },
      },
      questions: {},
      constraints: [],
      intents: [],
      outcomes: [],
      sessions: [],
      next: null,
      evicted: {},
    },
  ];
  // `projectCampaignDecisions` is typed to the folded Projection shape.
  const decisions = projectCampaignDecisions(/** @type {any} */ (projections[0]));
  assert.deepEqual(decisions.map((decision) => decision.id), ["d1", "d2"]);
  assert.equal(decisions[0].text, "First decision");
  assert.equal(decisions[1].sessionId, "s1");
  assert.deepEqual(projectCampaignDecisions(/** @type {any} */ ({ decisions: {} })), []);
});

test("renders the dependsOn graph, blocking prerequisites and capacity limits", () => {
  const model = baseModel();
  model.graph = {
    nodes: [
      { id: "a", runtimeId: "codex", model: "gpt-5", dependsOn: [], requirementIds: ["R1"] },
      { id: "b", runtimeId: "codex", model: "gpt-5", dependsOn: [], requirementIds: ["R1"] },
      { id: "c", runtimeId: "codex", model: "gpt-5", dependsOn: ["a", "b"], requirementIds: ["R1"] },
    ],
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
    independent: ["a", "b"],
    blocking: [{ node: "c", prerequisites: ["a", "b"] }],
    maxParallel: 1,
    maxConcurrent: { codex: 3 },
    effectiveConcurrency: 1,
    dispatchableTogether: ["a"],
    dispatchNote: "maxParallel is 1, so dependency-independent nodes are not simultaneously dispatchable",
    gaps: [],
  };
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /## Work graph/u);
  assert.match(markdown, /`a` → `c`/u);
  assert.match(markdown, /`b` → `c`/u);
  assert.match(markdown, /Dependency-independent nodes: `a`, `b`/u);
  assert.match(markdown, /Blocking prerequisites: `c` depends on `a`, `b`/u);
  assert.match(markdown, /maxParallel: 1/u);
  assert.match(markdown, /maxConcurrent: `codex` 3/u);
  // maxParallel 1: the graph says a and b are independent, but the brief must
  // not describe them as simultaneously dispatchable.
  assert.match(markdown, /Workers that can run at the same time: none — maxParallel is 1/u);
});

test("distinguishes dependency-independent nodes from workers capacity lets dispatch together", () => {
  const model = baseModel();
  /** @param {string} id @param {string[]} dependsOn */
  const node = (id, dependsOn) => ({ id, runtimeId: "codex", model: "gpt-5", dependsOn, requirementIds: ["R1"] });
  model.graph = {
    nodes: [node("a", []), node("b", []), node("c", [])],
    edges: [],
    independent: ["a", "b", "c"],
    blocking: [],
    maxParallel: 3,
    maxConcurrent: { codex: 1 },
    effectiveConcurrency: 1,
    dispatchableTogether: ["a"],
    dispatchNote: "each assigned runtime's maxConcurrent admits only one worker at a time",
    gaps: [],
  };
  const capped = renderCampaignBriefMarkdown(model);
  assert.match(capped, /Dependency-independent nodes: `a`, `b`, `c`/u);
  assert.match(capped, /maxParallel: 3/u);
  assert.match(capped, /maxConcurrent: `codex` 1/u);
  assert.match(capped, /Workers that can run at the same time: none — each assigned runtime's maxConcurrent/u);

  model.graph.dispatchableTogether = ["a", "b"];
  model.graph.maxConcurrent = { codex: 2 };
  model.graph.effectiveConcurrency = 2;
  const parallel = renderCampaignBriefMarkdown(model);
  assert.match(parallel, /Workers that can run at the same time: `a`, `b`/u);
});

test("renders journal decisions and spec risks/evals in their own sections", () => {
  const model = baseModel();
  model.decisions.journal = [{ id: "j1", text: "Recorded during the campaign", at: "2026-09-02T00:00:00.000Z", sessionId: "s1" }];
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /## Decisions/u);
  assert.match(markdown, /Human decision \(spec\): Review the generated brief/u);
  assert.match(markdown, /Delegated decision \(spec\): Pick module boundaries/u);
  assert.match(markdown, /Journal decision \[j1\]: Recorded during the campaign/u);
  assert.match(markdown, /## Risks and planned evals/u);
  assert.match(markdown, /Risk: A plausible summary disagrees/u);
  assert.match(markdown, /Planned eval: A missing spec produces a refusal\./u);
});

const R4_SPEC = `---
id: campaign-brief
baseline: abc
---

# R4 fixture

## Intent

Ship one deterministic brief.

## Requirements

### R1. Core

- **statement:** Build the core.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Brief exists | none | one markdown | R1 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Bad summary | wrong call | pin the digests |

## Human decisions

- A human decision from the spec.

## Delegable decisions

- A delegated decision from the spec.

## Planned evals

- An eval from the spec.
`;

/**
 * @param {{spec?: string, projection?: import("../../src/campaign/index.mjs").Projection}} [options]
 * @returns {BriefModel}
 */
function r4Model(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-r4-"));
  const spec = options.spec ?? R4_SPEC;
  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, spec, "utf8");
  /** @param {string} id @param {string[]} dependsOn */
  const node = (id, dependsOn) => ({
    id,
    type: "implement",
    phase: "P1",
    requirementIds: ["R1"],
    runtime: "codex",
    dependsOn,
    taskPacket: { verification: [] },
    definitionOfDone: [],
  });
  const contract = {
    schemaVersion: 1,
    contractVersion: "0.3.0",
    id: "r4",
    campaignId: "campaign-brief",
    goal: "R4 fixture",
    cwd: ".",
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5", vendor: "openai", maxConcurrent: 3 } },
    runtimeDefaults: { worker: "codex", judge: "codex" },
    nodes: [node("a", []), node("b", []), node("c", ["a", "b"])],
  };
  writeFileSync(join(dir, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  writeFrozenPlanRecord(dir, /** @type {any} */ ({
    formatVersion: 1,
    contractDigest: contractDigest(contract),
    spec: { path: specPath, digest: contentDigest(spec) },
    phases: [{ id: "P1", requirementIds: ["R1"], nodeIds: ["a", "b", "c"], deliverable: "The core." }],
    provenance: { targetGitHead: "abc" },
    status: "frozen",
    approved: true,
  }));
  return buildBriefModel({
    campaignId: "campaign-brief",
    planPath: join(dir, "plan.json"),
    usageSampleCutoff: "2026-09-01T00:00:00.000Z",
    estimate: {
      cost: { status: "range", min: 1, max: 2, samples: 6 },
      duration: { status: "range", min: 1, max: 2, samples: 6 },
    },
    projection: options.projection,
  });
}

test("active journal decisions join the spec decisions in a complete model", () => {
  const projection = /** @type {any} */ ({
    updatedAt: null,
    decisions: {
      j1: { type: "decision", eventId: "e1", at: "2026-09-02T00:00:00.000Z", sessionId: "s1", decisionId: "j1", text: "A journal decision." },
    },
    questions: {},
    constraints: [],
    intents: [],
    outcomes: [],
    sessions: [],
    next: null,
    evicted: {},
  });
  const model = r4Model({ projection });
  assert.deepEqual(model.decisions.human, ["A human decision from the spec."]);
  assert.deepEqual(model.decisions.delegated, ["A delegated decision from the spec."]);
  assert.deepEqual(model.decisions.journal.map((decision) => decision.id), ["j1"]);
  assert.equal(model.decisionState, "ready for human review");
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /Journal decision \[j1\]: A journal decision\./u);
  assert.match(markdown, /Workers that can run at the same time: none — maxParallel is 1/u);
});

test("a decision claimed as both human and delegable is a gap, not a fact", () => {
  const spec = R4_SPEC.replace("- A delegated decision from the spec.", "- A human decision from the spec.");
  const model = r4Model({ spec });
  assert.ok(model.decisions.gaps.some((gap) => gap.includes("both human and delegable")));
  assert.equal(model.decisionState, "gaps to resolve");
});

test("two active journal decisions with the same text are a conflicting-decision gap", () => {
  const projection = /** @type {any} */ ({
    updatedAt: null,
    decisions: {
      j1: { type: "decision", eventId: "e1", at: "2026-09-02T00:00:00.000Z", sessionId: "s1", decisionId: "j1", text: "Same text." },
      j2: { type: "decision", eventId: "e2", at: "2026-09-03T00:00:00.000Z", sessionId: "s2", decisionId: "j2", text: "same text." },
    },
    questions: {},
    constraints: [],
    intents: [],
    outcomes: [],
    sessions: [],
    next: null,
    evicted: {},
  });
  const model = r4Model({ projection });
  assert.ok(model.decisions.gaps.some((gap) => gap.includes("conflicting journal decisions")));
  assert.equal(model.decisionState, "gaps to resolve");
  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /gaps to resolve/u);
  assert.match(markdown, /conflicting journal decisions/u);
});
