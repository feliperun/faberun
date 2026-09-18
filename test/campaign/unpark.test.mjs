import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unparkCampaign } from "../../src/campaign/unpark.mjs";
import { authoredContractDigest, closeCampaign, initializeCampaign, parkCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { appendJournal, readJournal } from "../../src/campaign/journal.mjs";
import { driveCampaignChain } from "../../src/campaign/chain.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { serializableContract, storedContractDigest } from "../../src/engine/run-identity.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";
import { packet } from "../helpers.mjs";

/** @typedef {import("../../src/contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {{repo: string, runsDir: string, campaignPath: string, campaignId: string, contractPath: string, contract: ValidatedContract, runDir: string, at: string}} ParkedFixture */
/** @typedef {{progress: (nodeId?: string, budgetBasis?: number) => void, setActive: (nodes: {nodeId: string, budgetBasis: number}[]) => void, stop: () => void}} NoopHeartbeat */

const CLI = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @returns {string} */
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "runner-unpark-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.email", "runner@example.test"]);
  git(repo, ["config", "user.name", "runner"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "-A", "--", ".", ":(exclude).runs"]);
  git(repo, ["-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "base"]);
  return repo;
}

/** @param {string} repo @param {string} path @param {string} content @param {string} message @returns {string} */
function commitFile(repo, path, content, message) {
  writeFileSync(join(repo, path), content);
  git(repo, ["add", "--", path]);
  git(repo, ["-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * @param {string} repo
 * @param {string} campaignId
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function chainContract(repo, campaignId, id, overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId,
    goal: `chain ${id}`,
    cwd: repo,
    maxParallel: 1,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna" },
      sol: { harness: "codex", model: "gpt-5.6-sol", vendor: "openai-sol" },
    },
    nodes: [{ id: "build", type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["base.txt"], writeFiles: ["out.txt"] }), gate: false }],
    ...overrides,
  };
}

/** @param {string} repo @param {string} campaignId @param {string} id @param {Record<string, unknown>} [overrides] @returns {string} */
function writeChainContract(repo, campaignId, id, overrides = {}) {
  const path = join(repo, `${id}.contract.json`);
  writeFileSync(path, `${JSON.stringify(chainContract(repo, campaignId, id, overrides), null, 2)}\n`);
  return path;
}

/**
 * @param {string} repo
 * @param {string} campaignId
 * @param {string[]} contractPaths
 * @param {string} [landBranch]
 * @returns {{path: string, campaign: import("../../src/campaign/index.mjs").Campaign}}
 */
function makeCampaign(repo, campaignId, contractPaths, landBranch = `campaign/${campaignId}`) {
  return initializeCampaign(runsRoot(repo), {
    campaignId,
    goal: `chain ${campaignId}`,
    contracts: contractPaths.map((path) => ({ path, digest: authoredContractDigest(path) })),
    landBranch,
  });
}

/** @param {string} runDir @param {{id: string, status: string, phase?: string, error?: {code: string, message: string}}} node */
function writeNode(runDir, node) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", `${node.id}.json`), JSON.stringify(node));
}

/**
 * A run directory with one node snapshot and a `run.json` whose digest matches
 * the contract, exactly the shape the chain reads.
 *
 * @param {{repo: string, runDir: string, contract: ValidatedContract, node: Record<string, unknown>}} args
 */
function writeRunDir({ repo, runDir, contract, node }) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(serializableContract(contract), null, 2)}\n`);
  writeFileSync(join(runDir, "nodes", `${String(node.id)}.json`), JSON.stringify(node));
  const metadata = {
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
      gitHead: git(repo, ["rev-parse", "HEAD"]),
      dirtyTreeFingerprint: null,
      packetHashes: Object.fromEntries(contract.nodes.map((candidate) => [candidate.id, candidate.packetHash])),
      harnessVersions: {},
    },
    contractDigest: storedContractDigest(runDir),
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * A campaign parked on `run_parked`, pointing at run `r1` whose node failed.
 *
 * @param {string} campaignId
 * @returns {ParkedFixture}
 */
function parkedRun(campaignId) {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, campaignId, "r1");
  const { path: campaignPath } = makeCampaign(repo, campaignId, [contractPath]);
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(repo, "r1");
  writeRunDir({ repo, runDir, contract, node: { id: "build", status: "failed", phase: "worker", error: { code: "boom", message: "boom" } } });
  const at = "2026-09-16T00:00:00.000Z";
  parkCampaign(campaignPath, { code: "run_parked", message: "contract r1 run parked", at, runId: "r1" });
  return { repo, runsDir: runsRoot(repo), campaignPath, campaignId, contractPath, contract, runDir, at };
}

/**
 * Finish the parked run the way the child controller would: integrate a real
 * commit on the run ref and mark the node done. The promoted branch then
 * fast-forwards when the chain resumes.
 *
 * @param {ParkedFixture} fixture
 */
function succeedAfterPark(fixture) {
  const baseSha = git(fixture.repo, ["rev-parse", "HEAD"]);
  const head = commitFile(fixture.repo, `out-${fixture.campaignId}.txt`, `${fixture.campaignId}\n`, `run ${fixture.campaignId}`);
  git(fixture.repo, ["update-ref", "refs/faberun/r1/run", head]);
  writeNode(fixture.runDir, { id: "build", status: "done" });
  assert.equal(
    JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).sourceIdentity.gitHead,
    baseSha,
    "the run was cut from the base so the promotion is a fast-forward",
  );
}

/** @returns {NoopHeartbeat} */
function noopHeartbeat() {
  return { progress() {}, setActive() {}, stop() {} };
}

test("unpark refuses a still-parked run, then clears the attention once it is done", () => {
  const fixture = parkedRun("unpark-refuse");
  assert.throws(
    () => unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir }),
    /run r1 is still parked; resume it first or pass --force/u,
  );

  succeedAfterPark(fixture);
  const result = unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir, at: fixture.at, eventId: "unpark-event-1" });
  assert.equal(result.cleared.code, "run_parked");
  assert.equal(result.campaign.attention, undefined);

  const raw = JSON.parse(readFileSync(join(fixture.campaignPath, "campaign.json"), "utf8"));
  assert.equal("attention" in raw, false, "campaign.json no longer carries attention");
  assert.equal(raw.updatedAt, fixture.at, "the clearing stamped updatedAt");

  const events = /** @type {{code?: string, runId?: string|null, eventId?: string}[]} */ (
    readJournal(fixture.campaignPath).filter((entry) => entry.type === "campaign.unparked")
  );
  assert.equal(events.length, 1, "exactly one campaign.unparked event");
  assert.equal(events[0].code, "run_parked");
  assert.equal(events[0].runId, "r1");
  assert.equal(events[0].eventId, "unpark-event-1");

  assert.throws(() => unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir }), /campaign is not parked/u);
});

test("unpark refuses a closed campaign", () => {
  const fixture = parkedRun("unpark-closed");
  appendJournal(fixture.campaignPath, { type: "retrospective", at: fixture.at, eventId: "retro-1", sessionId: "s1", text: "done" });
  closeCampaign(fixture.campaignPath, { at: fixture.at, eventId: "close-1" });
  assert.throws(() => unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir }), /campaign is closed/u);
});

test("--force clears a parked campaign while its run is still parked", () => {
  const fixture = parkedRun("unpark-force");
  const result = unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir, force: true, eventId: "force-event" });
  assert.equal(result.cleared.code, "run_parked");
  assert.equal(result.campaign.attention, undefined);
  const events = readJournal(fixture.campaignPath).filter((entry) => entry.type === "campaign.unparked");
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, "r1");
});

test("campaign unpark through the CLI prints the success line and exits 1 on refusal", () => {
  const fixture = parkedRun("unpark-cli");
  const refused = spawnSync(process.execPath, [CLI, "campaign", "unpark", "unpark-cli", "--cwd", fixture.repo], { encoding: "utf8" });
  assert.equal(refused.status, 1, `${refused.stdout ?? ""}${refused.stderr ?? ""}`);
  assert.match(String(refused.stderr).trim(), /run r1 is still parked/u);
  assert.equal(String(refused.stdout).trim(), "", "a refusal writes one line to stderr and nothing to stdout");

  succeedAfterPark(fixture);
  const ok = spawnSync(process.execPath, [CLI, "campaign", "unpark", "unpark-cli", "--cwd", fixture.repo], { encoding: "utf8" });
  assert.equal(ok.status, 0, `${ok.stdout ?? ""}${ok.stderr ?? ""}`);
  assert.equal(String(ok.stdout).trim(), "[campaign] unpark-cli unparked · run_parked cleared");

  const again = spawnSync(process.execPath, [CLI, "campaign", "unpark", "unpark-cli", "--cwd", fixture.repo], { encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.match(String(again.stderr).trim(), /campaign is not parked/u);
});

test("driveCampaignChain with maxTicks 1 no longer returns parked after an unpark", async () => {
  const fixture = parkedRun("unpark-chain");
  const before = await driveCampaignChain(fixture.campaignPath, {
    repo: fixture.repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 1,
    launch: () => { throw new Error("the parked chain must not launch"); },
  });
  assert.equal(before.state, "parked");

  succeedAfterPark(fixture);
  unparkCampaign(fixture.campaignPath, { runsDir: fixture.runsDir, at: fixture.at, eventId: "unpark-chain-event" });
  const after = await driveCampaignChain(fixture.campaignPath, {
    repo: fixture.repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 1,
    launch: () => { throw new Error("the succeeded run must not launch"); },
  });
  assert.notEqual(after.state, "parked");
  assert.equal(after.state, "stopped");
  assert.equal(readCampaign(fixture.campaignPath).attention, undefined);
});
