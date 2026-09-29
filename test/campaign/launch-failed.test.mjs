import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveCampaignChain } from "../../src/campaign/chain.mjs";
import { authoredContractDigest, initializeCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { unparkCampaign } from "../../src/campaign/unpark.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { serializableContract, storedContractDigest } from "../../src/engine/run-identity.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { packet } from "../helpers.mjs";

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @param {string} repo @param {string} file @param {string} content @param {string} message @returns {string} */
function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** @returns {{progress: (nodeId?: string, budgetBasis?: number) => void, setActive: (nodes: {nodeId: string, budgetBasis: number}[]) => void, stop: () => void}} */
function noopHeartbeat() {
  return { progress() {}, setActive() {}, stop() {} };
}

/** @param {string} repo @param {string} campaignId @param {string} id @returns {string} */
function writeContractFor(repo, campaignId, id) {
  const path = join(repo, `${id}.contract.json`);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId,
    goal: `strand ${id}`,
    cwd: repo,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna" },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" } },
    },
    nodes: [{ id: "build", type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["base.txt"], writeFiles: [`out-${id}.txt`] }), gate: false }],
  }, null, 2)}\n`);
  return path;
}

/**
 * The run directory a controller leaves when it dies between taking the run and
 * dispatching its first node: the stored contract, the `run.json` this resume
 * reads, one pending node, and the run ref creation wrote. Anything less is not
 * a run the chain can find.
 *
 * @param {string} repo @param {string} runDir @param {import("../../src/contract/index.mjs").ValidatedContract} contract
 */
function writeStrandedRun(repo, runDir, contract) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(serializableContract(contract), null, 2)}\n`);
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "pending" }));
  const gitHead = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", `refs/faberun/${contract.id}/run`, gitHead]);
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: new Date().toISOString(),
    sourceIdentity: {
      kind: "run",
      contractId: contract.id,
      campaignId: contract.campaignId,
      cwd: repo,
      gitHead,
      dirtyTreeFingerprint: null,
      packetHashes: Object.fromEntries(contract.nodes.map((node) => [node.id, node.packetHash])),
      harnessVersions: {},
    },
    contractDigest: storedContractDigest(runDir),
  }, null, 2)}\n`);
}

/** @param {string} repo @param {string} runDir */
function settleStrandedRun(repo, runDir) {
  const contract = /** @type {{id: string, nodes: {id: string}[]}} */ (JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")));
  const head = commitFile(repo, `out-${contract.id}.txt`, `${contract.id}\n`, `run ${contract.id}`);
  git(repo, ["update-ref", `refs/faberun/${contract.id}/run`, head]);
  for (const node of contract.nodes) writeFileSync(join(runDir, "nodes", `${node.id}.json`), JSON.stringify({ id: node.id, status: "done" }));
}

/** @returns {string} a fresh repository with one commit */
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "launch-failed-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "base"]);
  return repo;
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

// RM-053's other half, and R2's: the stranded run did not stay stranded. The
// operator clears the park, the next invocation finds the run directory the
// dead controller left, and resumes that same run instead of launching the
// contract again -- a second `run` would refuse an existing run directory, and
// a second controller would dispatch the same node twice.
test("a stranded run is resumed by the next invocation rather than launched again", async () => {
  const repo = initRepo();
  const path0 = writeContractFor(repo, "stranded-resume", "first");
  const path1 = writeContractFor(repo, "stranded-resume", "second");
  const { path: campaignPath } = initializeCampaign(runsRoot(repo), {
    campaignId: "stranded-resume",
    goal: "strand a run and pick it back up",
    contracts: [path0, path1].map((path) => ({ path, digest: authoredContractDigest(path) })),
    landBranch: "campaign/stranded-resume",
  });

  /** @type {string} */
  let strandedDir = "";
  const failed = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 5,
    launch: async (_contractPath, context) => {
      strandedDir = context.runDir;
      writeStrandedRun(repo, context.runDir, context.contract);
      throw new Error("detached bootstrap did not become ready for pid 31966");
    },
  });
  assert.equal(failed.state, "parked");
  assert.equal(readCampaign(campaignPath).attention?.code, "launch_failed");
  unparkCampaign(campaignPath, { runsDir: runsRoot(repo) });
  assert.equal(readCampaign(campaignPath).attention, undefined, "the operator lifted the park");

  /** @type {string[]} */
  const resumed = [];
  /** @type {string[]} */
  const launched = [];
  const second = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 20,
    resume: async (target) => {
      resumed.push(target);
      settleStrandedRun(repo, target);
    },
    launch: async (_contractPath, context) => {
      launched.push(context.contract.id);
      writeStrandedRun(repo, context.runDir, context.contract);
      settleStrandedRun(repo, context.runDir);
    },
  });

  assert.deepEqual(resumed, [strandedDir], "the run the failed bootstrap left is the one resumed");
  assert.deepEqual(launched, ["second"], "the contract that failed is not launched again; only the remainder runs");
  assert.equal(second.state, "done");
});

