import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveCampaignChain } from "../../src/campaign/chain.mjs";
import { authoredContractDigest, initializeCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { packet } from "../helpers.mjs";

/** @param {string} repo @param {string[]} args */
function git(repo, args) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

// RM-053, measured on `rec-audit-remediation`: a controller launched from a
// shell whose scope was torn down left `detached bootstrap did not become
// ready for pid 31966 (launch_failed)` and a run directory with every node
// pending, and the same run finished under a durable `resume`. The park now
// says the run exists, what state its nodes are in, and the resume.
test("a failed detached bootstrap names the run and the resume that completes it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "launch-failed-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "base"]);
  const contractPath = join(repo, "stranded.contract.json");
  writeFileSync(contractPath, `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "stranded",
    campaignId: "stranded-campaign",
    goal: "strand a run",
    cwd: repo,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna" },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" } },
    },
    nodes: ["one", "two", "three"].map((id) => ({ id, type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["base.txt"], writeFiles: [`${id}.txt`] }), gate: false })),
  }, null, 2)}\n`);
  const { path: campaignPath } = initializeCampaign(runsRoot(repo), {
    campaignId: "stranded-campaign",
    goal: "strand a run",
    contracts: [{ path: contractPath, digest: authoredContractDigest(contractPath) }],
    landBranch: "campaign/stranded-campaign",
  });
  /** @type {string} */
  let strandedDir = "";
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: { progress() {}, setActive() {}, stop() {} },
    sleep: async () => {},
    maxTicks: 5,
    launch: async (_path, context) => {
      strandedDir = context.runDir;
      mkdirSync(join(context.runDir, "nodes"), { recursive: true });
      for (const [id, status] of [["one", "done"], ["two", "pending"], ["three", "pending"]]) {
        writeFileSync(join(context.runDir, "nodes", `${id}.json`), JSON.stringify({ id, status }));
      }
      throw new Error("detached bootstrap did not become ready for pid 31966");
    },
  });
  assert.equal(outcome.state, "parked");
  const attention = readCampaign(campaignPath).attention;
  assert.equal(attention?.code, "launch_failed", attention?.message);
  const message = attention?.message ?? "";
  assert.match(message, /detached bootstrap did not become ready for pid 31966/u, "the launcher's own reason stays first");
  assert.ok(message.includes(`run directory ${strandedDir} exists`), message);
  assert.match(message, /2 pending · 1 done|1 done · 2 pending/u, "the node count by state is named");
  assert.ok(message.includes(`faberun resume ${strandedDir}`), "the exact resume that completes the run is named");
  assert.equal(attention?.resume, `resume ${strandedDir}`);
});
