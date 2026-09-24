// Proof for requirement REPORT: the campaign roll-up carries the declared read
// weight the run surfaces already measure.
//
// `status`, `report --json` and the closing report all expose a node's
// `declaredReadBytes`; the campaign roll-up (`renderCampaignProgress`, the JSON
// a campaign page reads) does not, so an operator comparing read regimes cannot
// see the measurement where the campaign is compared.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { authoredContractDigest, initializeCampaign, registerRun } from "../../../src/campaign/index.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../../src/contract/index.mjs";
import { renderCampaignProgress } from "../../../src/report/progress.mjs";
import { runsRoot } from "../../../src/run/paths.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

test("every rolled-up node reports its declared read weight and the campaign reports the total", () => {
  const { directory, runsDir } = makeCampaign("rollup-read-bytes", [
    {
      id: "phase-a",
      phaseId: "phase-a-first-write",
      hasRun: true,
      nodes: [
        { id: "measured", declaredReadBytes: 4096 },
        { id: "unmeasured" },
      ],
    },
    // A contract the manifest names but has never launched: its nodes have no
    // snapshot at all, so they carry no declared read weight either.
    { id: "phase-b", phaseId: "phase-b", hasRun: false, nodes: [{ id: "later" }] },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-read-bytes"));
    assert.equal(progress.phases[0].nodes[0].declaredReadBytes, 4096, "a launched node reports the weight its snapshot recorded");
    assert.equal(progress.phases[0].nodes[1].declaredReadBytes, null, "a snapshot with no declared weight reports null, never a fabricated zero");
    assert.equal(progress.phases[1].nodes[0].declaredReadBytes, null, "a node that has not started carries no declared read weight");
    assert.equal(progress.declaredReadBytes, 4096, "the campaign total sums only the nodes that carry a declared weight");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a campaign whose nodes carry no declared read weight reports zero, not null", () => {
  const { directory, runsDir } = makeCampaign("rollup-read-bytes-empty", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "one" }] },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-read-bytes-empty"));
    assert.equal(progress.phases[0].nodes[0].declaredReadBytes, null);
    assert.equal(progress.declaredReadBytes, 0, "no declared read weight at all is a total of zero");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A campaign with one contract per phase spec: each contract's own file written
 * to disk and listed in the campaign manifest, in the order given. A phase spec
 * with `hasRun: true` also gets a run directory with one snapshot per node; one
 * without it stays a manifest entry the campaign has never launched.
 *
 * @param {string} campaignId
 * @param {{id: string, phaseId: string, hasRun: boolean, nodes: {id: string, declaredReadBytes?: number}[]}[]} phaseSpecs
 * @returns {{directory: string, runsDir: string}}
 */
function makeCampaign(campaignId, phaseSpecs) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-read-weight-"));
  const runsDir = runsRoot(directory);
  const contracts = phaseSpecs.map((phaseSpec) => {
    const contractPath = join(directory, `${phaseSpec.id}.contract.json`);
    writeFileSync(contractPath, `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id: phaseSpec.id,
      campaignId,
      goal: `Goal for ${phaseSpec.id}`,
      cwd: ".",
      nodes: phaseSpec.nodes.map((node) => ({ id: node.id, phase: phaseSpec.phaseId, dependsOn: [] })),
    }, null, 2)}\n`);
    return { path: contractPath, digest: authoredContractDigest(contractPath) };
  });
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId, goal: "Prove the roll-up measures read weight", contracts });
  for (const phaseSpec of phaseSpecs) {
    if (!phaseSpec.hasRun) continue;
    const runDir = join(runsDir, phaseSpec.id);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      pid: process.pid,
      processStartToken: null,
      startedAt: NOW,
      sourceIdentity: { kind: "run" },
    }, null, 2)}\n`);
    for (const node of phaseSpec.nodes) {
      writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify({
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        id: node.id,
        type: "backend",
        status: "done",
        phase: "complete",
        attempt: 1,
        revisions: 0,
        startedAt: NOW,
        updatedAt: NOW,
        result: { status: "done", summary: `${node.id} done`, verification: [], artifacts: [], missingContext: [] },
        gate: null,
        error: null,
        ...(typeof node.declaredReadBytes === "number" ? { declaredReadBytes: node.declaredReadBytes } : {}),
      }, null, 2)}\n`);
    }
    registerRun(campaignPath, phaseSpec.id);
  }
  return { directory, runsDir };
}
