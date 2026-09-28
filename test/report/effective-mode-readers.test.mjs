import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { renderBrief } from "../../src/campaign/brief.mjs";
import { buildBriefModel } from "../../src/campaign/campaign-brief.mjs";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";
import { projectMetrics } from "../../src/campaign/metrics.mjs";
import { contractDigest } from "../../src/contract/index.mjs";
import { contentDigest, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// R36's reader half: the launch records the effective judge-independence mode
// on the run snapshot (`routing.assignments.judgeIndependence`,
// `src/contract/snapshot.mjs`). The brief, the campaign-brief assembly, the
// report and the metrics read that recorded value back instead of re-deriving
// it from the contract, which never sees a machine-config opt-in.

const SAME_VENDOR = "same-vendor";

const SPEC = `---
id: effective-mode-readers
baseline: abc123
---

# Effective mode readers

## Intent

The brief, the report and the metrics read the mode the launch recorded.

## Requirements

### R1. The recorded mode is read back

- **statement:** Every reader reads the recorded effective mode.
- **proof:** command: node --test test/report/effective-mode-readers.test.mjs

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Recorded mode | re-derived | read from the snapshot | R1 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A reader re-derives the mode | a config opt-in is lost | read the recorded value |

## Human decisions

- Read the recorded mode.

## Delegable decisions

- Pick the surface that renders it.

## Planned evals

- A contract that declares no mode reports the recorded one.
`;

test("the brief, the report and the metrics read the recorded effective mode", () => {
  // 1. The operator brief reads each linked run's persisted node snapshots and
  //    surfaces the mode the launch stamped there.
  {
    const directory = mkdtempSync(join(tmpdir(), "effective-mode-brief-"));
    const runsDir = runsRoot(directory);
    const created = initializeCampaign(runsDir, { campaignId: "effective-mode-brief", goal: "Read the recorded mode" });
    const runId = "recorded-run";
    registerRun(created.path, runId);
    const runDir = join(runsDir, runId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeFileSync(join(runDir, "status.json"), `${JSON.stringify({
      summary: "1 nodes · 1 done",
      controller: { state: "active" },
      nodes: [{ id: "build", status: "done" }],
      usage: {},
    })}\n`);
    writeFileSync(join(runDir, "nodes", "build.json"), `${JSON.stringify({
      id: "build",
      status: "done",
      routing: { assignments: { worker: "sonnet", judge: "opus", judgeIndependence: SAME_VENDOR } },
    })}\n`);
    assert.match(renderBrief(created.path, runsDir), /judge independence same-vendor/u);
  }

  // 2. The campaign-brief assembly takes the recorded mode as the fact: the
  //    contract below declares no `judgeIndependence`, yet the recorded mode
  //    reaches both the identity and the work graph.
  const { planPath } = recordedModeFixture();
  const model = buildBriefModel({ campaignId: "effective-mode-readers", planPath, effectiveJudgeIndependence: SAME_VENDOR });
  assert.equal(model.identity.judgeIndependence, SAME_VENDOR);
  assert.equal(model.graph.nodes[0]?.sameProviderReview, true, "the recorded mode marks the same-provider pairing");

  const withoutRecordedMode = buildBriefModel({ campaignId: "effective-mode-readers", planPath });
  assert.equal(withoutRecordedMode.identity.judgeIndependence, null, "the contract declares no mode to re-derive");

  // 3. The report renders the mode the model read, never a second derivation.
  assert.match(renderCampaignBriefMarkdown(model), /Judge independence: `same-vendor`/u);
  assert.match(renderCampaignBriefMarkdown(withoutRecordedMode), /Judge independence: `cross-vendor`/u);

  // 4. The metrics projector reads the mode from the reduced node snapshots and
  //    keeps it out of the section-6 indicator set.
  /** @type {{effectiveJudgeIndependence: string|null}} */
  const recorded = /** @type {any} */ (projectMetrics({
    nodes: [{ runId: "run-a", id: "build", status: "done", judgeIndependence: SAME_VENDOR }],
  }));
  assert.equal(recorded.effectiveJudgeIndependence, SAME_VENDOR);
  const unrecorded = /** @type {any} */ (projectMetrics({ nodes: [{ runId: "run-a", id: "build", status: "done" }] }));
  assert.equal(unrecorded.effectiveJudgeIndependence, null);
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(projectMetrics()).sort(), "the mode is source metadata, not a new indicator");
});

/**
 * A frozen plan whose contract declares no `judgeIndependence` -- only the
 * machine config could opt it in, and only the run snapshot records the
 * effective mode -- with one gated node whose worker and judge share a vendor.
 *
 * @returns {{planPath: string}}
 */
function recordedModeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "effective-mode-plan-"));
  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, SPEC, "utf8");
  const contract = {
    schemaVersion: 1,
    contractVersion: "0.3.0",
    id: "effective-mode-readers-P1",
    campaignId: "effective-mode-readers",
    goal: "Read the recorded mode",
    cwd: ".",
    maxParallel: 1,
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
    runtimeDefaults: { worker: "worker", judge: "judge" },
    nodes: [
      {
        id: "build",
        type: "implement",
        phase: "P1",
        requirementIds: ["R1"],
        runtime: "worker",
        gate: { enabled: true },
        dependsOn: [],
        taskPacket: { verification: [] },
        definitionOfDone: [],
      },
    ],
  };
  writeFileSync(join(dir, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  writeFrozenPlanRecord(dir, /** @type {any} */ ({
    formatVersion: 1,
    contractDigest: contractDigest(contract),
    spec: { path: specPath, digest: contentDigest(SPEC) },
    phases: [{ id: "P1", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "The brief reads the recorded mode." }],
    provenance: { targetGitHead: "abc123" },
    status: "frozen",
    approved: true,
  }));
  return { planPath: join(dir, "plan.json") };
}
