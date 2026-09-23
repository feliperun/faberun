import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractDigest } from "../../src/contract/index.mjs";
import { contentDigest, fileDigest, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
import { BriefInputError, buildBriefModel, decideBriefState } from "../../src/campaign/campaign-brief.mjs";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";

// The Campaign Brief core: verify the frozen plan, its contract and its spec
// before reading any fact, then derive a deterministic model the report layer
// renders. These tests refuse every missing or mismatched input and exercise
// the coverage states the matrix must name explicitly.

const DEFAULT_SPEC = `---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.5.0
status: draft
baseline: d9eae18a917d328326a3a07bdd80d34c379901cc
---

# Campaign Brief before execution

## Intent

An operator should be able to decide in a few minutes whether a frozen plan is worth executing. The plan remains available for detail.

## Requirements

### R1. One brief belongs to one frozen plan

- **statement:** Generation verifies the whole plan file against its sidecar.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R2. The first screen answers whether to proceed

- **statement:** The brief opens with intent, outcome and a decision state.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

### R3. Coverage is complete and traceable

- **statement:** A matrix lists every stable requirement id.
- **proof:** command: node --test test/campaign/campaign-brief.test.mjs

### R4. The work and judgment are legible

- **statement:** The brief shows the actual dependsOn graph.
- **proof:** command: node --test test/report/campaign-brief.test.mjs

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Pre-execution approval artefact | none | Markdown for one frozen plan | R1 |
| Requirement coverage visible | no matrix | every spec requirement shown | R3 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A plausible summary disagrees | wrong approval | pin the spec and contract digests |

## Human decisions

- Review the generated brief before executing the contract.

## Delegable decisions

- Pick module boundaries from this spec.

## Planned evals

- A missing spec produces a refusal.
`;

/** @returns {string} */
function defaultSpec() {
  return DEFAULT_SPEC;
}

/** @returns {Record<string, any>} */
function defaultContract(overrides = {}) {
  return {
    schemaVersion: 1,
    contractVersion: "0.3.0",
    id: "campaign-brief-plan-P1",
    campaignId: "campaign-brief",
    goal: "Core brief markdown",
    cwd: ".",
    maxParallel: 1,
    runtimes: {
      codex: { model: "gpt-5", vendor: "openai", maxConcurrent: 2 },
      claude: { model: "sonnet", vendor: "anthropic" },
    },
    runtimeDefaults: { worker: "codex", judge: "claude" },
    nodes: [
      {
        id: "n1",
        type: "implement",
        phase: "P1",
        requirementIds: ["R1", "R2"],
        runtime: "codex",
        dependsOn: [],
        taskPacket: { verification: [{ argv: ["node", "--test", "test/campaign/campaign-brief.test.mjs"] }] },
        definitionOfDone: [{ id: "dod1", proof: { kind: "command", ref: "npm run typecheck" } }],
      },
      {
        id: "n2",
        type: "implement",
        phase: "P1",
        requirementIds: ["R3"],
        runtime: "codex",
        dependsOn: ["n1"],
        taskPacket: { verification: [{ argv: ["node", "--test", "test/report/campaign-brief.test.mjs"] }] },
        definitionOfDone: [],
      },
    ],
    ...overrides,
  };
}

/** @returns {Record<string, any>[]} */
function defaultPhases() {
  // Freeze stamps every declaration's requirementIds onto each node it names,
  // so the matching frozen contract carries n1: [R1, R2] and n2: [R3].
  return [
    { id: "P1", requirementIds: ["R1", "R2"], nodeIds: ["n1"], deliverable: "The verified brief core." },
    { id: "P2", requirementIds: ["R3"], nodeIds: ["n2"], deliverable: "The coverage matrix." },
  ];
}

/** @returns {import("../../src/campaign/campaign-brief.mjs").BriefEstimateInput} */
function sufficientEstimate() {
  return {
    cost: { status: "range", min: 1.2, max: 3.4, samples: 6, sourceRuns: ["run-a", "run-b"], method: "median of comparable completed nodes" },
    duration: { status: "range", min: 12, max: 30, samples: 6, sourceRuns: ["run-a", "run-b"], method: "recorded node and verification elapsed times" },
    runtimes: ["codex"],
    models: ["gpt-5"],
    effectiveConcurrency: 1,
    method: ["at least five comparable completed nodes per assigned role"],
  };
}

/**
 * @param {{spec?: string, contract?: Record<string, any>, phases?: Record<string, any>[]|null, targetGitHead?: string|null}} [options]
 * @returns {{dir: string, specPath: string, contractPath: string, planPath: string}}
 */
function makeFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-"));
  const spec = options.spec ?? defaultSpec();
  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, spec, "utf8");
  const contract = options.contract ?? defaultContract();
  const contractPath = join(dir, "contract.json");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  const phases = options.phases === null ? undefined : options.phases ?? defaultPhases();
  const frozen = {
    formatVersion: 1,
    contractDigest: contractDigest(contract),
    spec: { path: specPath, digest: contentDigest(spec) },
    ...(phases === undefined ? {} : { phases }),
    provenance: {
      packageVersion: "0.15.0",
      schemaVersion: 1,
      contractVersion: "0.3.0",
      targetGitHead: options.targetGitHead === undefined ? "abc123" : options.targetGitHead,
      planner: { runtimeId: "codex", model: "gpt-5" },
      reviewer: { runtimeId: "claude", model: "sonnet" },
      sizing: {},
      findings: [],
    },
  };
  writeFrozenPlanRecord(dir, /** @type {any} */ ({ ...frozen, status: "frozen", approved: true }));
  return { dir, specPath, contractPath, planPath: join(dir, "plan.json") };
}

/**
 * @param {{dir: string, planPath: string}} fixture
 * @param {Partial<import("../../src/campaign/campaign-brief.mjs").BriefBuildOptions>} [extra]
 * @returns {import("../../src/campaign/campaign-brief.mjs").BriefModel}
 */
function build(fixture, extra = {}) {
  return buildBriefModel({
    campaignId: "campaign-brief",
    planPath: fixture.planPath,
    journalCursor: 7,
    usageSampleCutoff: "2026-09-01T00:00:00.000Z",
    estimate: sufficientEstimate(),
    ...extra,
  });
}

test("builds a verified deterministic model and decides ready", () => {
  const fixture = makeFixture();
  const model = build(fixture);

  assert.equal(model.identity.campaign, "campaign-brief");
  assert.equal(model.identity.specBaseline, "d9eae18a917d328326a3a07bdd80d34c379901cc");
  assert.equal(model.identity.targetGitHead, "abc123");
  assert.equal(model.identity.journalCursor, 7);
  assert.equal(model.identity.usageSampleCutoff, "2026-09-01T00:00:00.000Z");
  assert.equal(model.coverage.total, 4);
  assert.equal(model.coverage.covered, 3);
  assert.equal(model.coverage.outside, 1);
  assert.equal(model.coverage.uncovered, 0);
  assert.equal(model.coverage.traceabilityMissing, 0);

  const r1 = model.coverage.rows.find((row) => row.requirementId === "R1");
  assert.equal(r1?.state, "covered");
  assert.deepEqual(r1?.declaredNodeIds, ["n1"]);
  assert.equal(r1?.nodes[0]?.id, "n1");
  assert.match(r1?.nodes[0]?.proof ?? "", /npm run typecheck/u);
  const r4 = model.coverage.rows.find((row) => row.requirementId === "R4");
  assert.equal(r4?.state, "outside this plan");

  assert.equal(model.graph.edges.length, 1);
  assert.deepEqual(model.graph.independent, ["n1"]);
  assert.equal(model.graph.maxParallel, 1);
  assert.equal(decideBriefState(model), "ready for human review");
  assert.equal(model.decisionState, "ready for human review");

  const first = renderCampaignBriefMarkdown(model);
  const second = renderCampaignBriefMarkdown(build(fixture));
  assert.equal(second, first);
  assert.match(first, /ready for human review/u);
  assert.match(first, /## Coverage matrix/u);
  assert.match(first, /R4/u);
  assert.match(first, /outside this plan/u);
  assert.match(first, /Journal cursor: `7`/u);
  assert.match(first, /2026-09-01T00:00:00\.000Z/u);
});

test("refuses plan bytes that changed after the sidecar", () => {
  const fixture = makeFixture();
  writeFileSync(fixture.planPath, `${readFileSync(fixture.planPath, "utf8")} `, "utf8");
  assert.throws(() => build(fixture), (error) => {
    assert.ok(error instanceof BriefInputError);
    assert.equal(error.code, "plan_digest_mismatch");
    return true;
  });
});

test("refuses a missing sidecar, plan or spec", () => {
  const missingSidecar = makeFixture();
  rmSync(`${missingSidecar.planPath}.sha256`);
  assert.throws(() => build(missingSidecar), (error) => error instanceof BriefInputError && error.code === "missing_input");

  const missingSpec = makeFixture();
  rmSync(missingSpec.specPath);
  assert.throws(() => build(missingSpec), (error) => error instanceof BriefInputError && error.code === "missing_input");

  const missingPlan = makeFixture();
  rmSync(missingPlan.planPath);
  assert.throws(() => build(missingPlan), (error) => error instanceof BriefInputError && error.code === "missing_input");
});

test("refuses a plan without spec identity until it is refrozen", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-old-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, `${JSON.stringify({ formatVersion: 1, contractDigest: "a".repeat(64) }, null, 2)}\n`, "utf8");
  writeFileSync(`${planPath}.sha256`, `${fileDigest(planPath)}\n`, "utf8");
  assert.throws(
    () => buildBriefModel({ campaignId: "campaign-brief", planPath, specPath: join(dir, "SPEC.md") }),
    (error) => error instanceof BriefInputError && error.code === "missing_identity",
  );
});

test("refuses a contract or spec whose bytes no longer match the plan", () => {
  const contractFixture = makeFixture();
  const contract = JSON.parse(readFileSync(contractFixture.contractPath, "utf8"));
  contract.goal = "tampered after freeze";
  writeFileSync(contractFixture.contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  assert.throws(() => build(contractFixture), (error) => error instanceof BriefInputError && error.code === "contract_digest_mismatch");

  const specFixture = makeFixture();
  writeFileSync(specFixture.specPath, `${readFileSync(specFixture.specPath, "utf8")}\nmore text\n`, "utf8");
  assert.throws(() => build(specFixture), (error) => error instanceof BriefInputError && error.code === "spec_digest_mismatch");
});

test("names uncovered, traceability missing and unknown ids as gaps", () => {
  const contract = defaultContract({
    nodes: [
      { id: "n1", type: "implement", phase: "P1", requirementIds: ["R1"], runtime: "codex", dependsOn: [], taskPacket: { verification: [] }, definitionOfDone: [] },
      { id: "nX", type: "implement", phase: "P9", requirementIds: ["R99"], runtime: "codex", dependsOn: [], taskPacket: { verification: [] }, definitionOfDone: [] },
    ],
  });
  const phases = [
    // Legacy declaration: R1 is claimed but no frozen node is assigned.
    { id: "P0", requirementIds: ["R1"], deliverable: "Legacy claim." },
    // R2 names a node absent from the frozen contract.
    { id: "P1", requirementIds: ["R2"], nodeIds: ["n-missing"], deliverable: "Missing node." },
  ];
  const fixture = makeFixture({ contract, phases });
  const model = build(fixture, { estimate: undefined });

  const r1 = model.coverage.rows.find((row) => row.requirementId === "R1");
  const r2 = model.coverage.rows.find((row) => row.requirementId === "R2");
  const r3 = model.coverage.rows.find((row) => row.requirementId === "R3");
  assert.equal(r1?.state, "uncovered");
  assert.equal(r2?.state, "traceability missing");
  assert.equal(r3?.state, "outside this plan");
  assert.deepEqual(model.coverage.unknownIds, ["R99"]);
  assert.ok(model.coverage.gaps.some((gap) => gap.includes("R99")));
  assert.equal(decideBriefState(model), "gaps to resolve");
});

test("reports insufficient estimate and work-graph gaps", () => {
  const contract = defaultContract({
    nodes: [
      { id: "n1", type: "implement", phase: "P1", requirementIds: ["R1", "R2", "R3"], runtime: "codex", dependsOn: ["ghost"], taskPacket: { verification: [] }, definitionOfDone: [] },
    ],
  });
  const phases = [{ id: "P1", requirementIds: ["R1", "R2", "R3"], nodeIds: ["n1"], deliverable: "One node." }];
  const fixture = makeFixture({ contract, phases });
  const model = build(fixture, { estimate: undefined });

  assert.ok(model.graph.gaps.some((gap) => gap.includes("ghost")));
  assert.equal(model.estimate.cost.status, "insufficient data");
  assert.equal(model.estimate.duration.status, "insufficient data");
  assert.equal(decideBriefState(model), "gaps to resolve");

  const insufficientSamples = build(makeFixture(), {
    estimate: { cost: { status: "range", min: 1, max: 2, samples: 4 }, duration: { status: "range", min: 1, max: 2, samples: 4 } },
  });
  assert.equal(insufficientSamples.estimate.cost.status, "insufficient data");
  assert.match(insufficientSamples.estimate.cost.reason ?? "", /fewer than 5/u);

  const markdown = renderCampaignBriefMarkdown(model);
  assert.match(markdown, /insufficient data/u);
});
