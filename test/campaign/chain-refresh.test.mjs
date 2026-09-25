import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveCampaignChain } from "../../src/campaign/chain.mjs";
import { authoredContractDigest, initializeCampaign } from "../../src/campaign/index.mjs";
import { readJournal } from "../../src/campaign/journal.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { controllerSnapshotPath } from "../../src/engine/run-identity.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { packet } from "../helpers.mjs";

/** @param {string} repo @param {string[]} args */
function git(repo, args) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

/** @param {string} id @returns {{repo: string, campaignPath: string}} */
function campaignWithOneContract(id) {
  const repo = mkdtempSync(join(tmpdir(), `chain-refresh-${id}-`));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "base"]);
  const contractPath = join(repo, `${id}.contract.json`);
  writeFileSync(contractPath, `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, id, campaignId: id, goal: "refresh", cwd: repo,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: { luna: { harness: "codex", model: "gpt-5.6-luna" }, sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" } } },
    nodes: [{ id: "build", type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["base.txt"], writeFiles: ["out.txt"] }), gate: false }],
  }, null, 2)}\n`);
  const { path: campaignPath } = initializeCampaign(runsRoot(repo), {
    campaignId: id, goal: "refresh", contracts: [{ path: contractPath, digest: authoredContractDigest(contractPath) }], landBranch: `campaign/${id}`,
  });
  return { repo, campaignPath };
}

// Measured 2026-09-23 on evidence-you-can-recompute: contract A changed
// faberun's own src/, and the chain parked every later contract with
// controller_snapshot_changed and no command that could refresh it.
test("a changed controller snapshot is adopted only as a declared human boundary", async () => {
  const stale = { path: controllerSnapshotPath(), sha: "0".repeat(64) };
  /** @type {string[]} */
  const launched = [];
  const drive = (/** @type {string} */ repo, /** @type {string} */ campaignPath, /** @type {boolean} */ refreshController) => driveCampaignChain(campaignPath, {
    repo, coordination: false, heartbeat: { progress() {}, setActive() {}, stop() {} }, sleep: async () => {}, maxTicks: 3,
    controllerIdentity: stale, refreshController,
    launch: async (_path, context) => { launched.push(context.controllerIdentity.sha); throw new Error("stop after the launch decision"); },
  });

  const parked = campaignWithOneContract("refresh-refused");
  await drive(parked.repo, parked.campaignPath, false);
  const attention = readCampaign(parked.campaignPath).attention;
  assert.equal(attention?.code, "controller_snapshot_changed");
  assert.match(attention?.message ?? "", /faberun campaign supervise refresh-refused --refresh-controller/u, "the park names the command that refreshes it");
  assert.deepEqual(launched, [], "without the flag nothing launches");

  const refreshed = campaignWithOneContract("refresh-adopted");
  await drive(refreshed.repo, refreshed.campaignPath, true);
  assert.equal(launched.length, 1, "with the flag the launch goes ahead");
  assert.notEqual(launched[0], stale.sha, "on the current snapshot, not the recorded one");
  const touches = /** @type {any[]} */ (readJournal(refreshed.campaignPath)).filter((entry) => entry.type === "operator.command");
  assert.deepEqual(touches.map((entry) => entry.command), ["campaign supervise --refresh-controller"], "the refresh is recorded as an operator command");
});
