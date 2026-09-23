import test from "node:test";
import assert from "node:assert/strict";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";

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
      gaps: [],
    },
    decisions: {
      human: ["Review the generated brief before executing the contract."],
      delegated: ["Pick module boundaries from this spec."],
      risks: [{ risk: "A plausible summary disagrees", impact: "wrong approval", mitigation: "pin the digests" }],
      evals: ["A missing spec produces a refusal."],
      gaps: [],
    },
    estimate: {
      cost: { status: "range", min: 1, max: 2, samples: 6, reason: null, sourceRuns: ["run-a"], method: null },
      duration: { status: "range", min: 10, max: 20, samples: 6, reason: null, sourceRuns: ["run-a"], method: null },
      runtimes: ["codex"],
      models: ["gpt-5"],
      effectiveConcurrency: 1,
      sampleCutoff: "2026-09-01T00:00:00.000Z",
      method: ["at least five comparable completed nodes per assigned role"],
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
  model.estimate.cost = { status: "insufficient data", min: null, max: null, samples: 4, reason: "fewer than 5 comparable completed nodes", sourceRuns: [], method: null };
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
