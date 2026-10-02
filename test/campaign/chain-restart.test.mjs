import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveCampaignChain, MAX_RUN_RECOVERY_ATTEMPTS } from "../../src/campaign/chain.mjs";
import { authoredContractDigest, initializeCampaign, promoteRunInCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { serializableContract, storedContractDigest } from "../../src/engine/run-identity.mjs";
import { writeHeartbeat } from "../../src/engine/supervise.mjs";
import { acquire as acquireRunLock } from "../../src/run/lock.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";
import { packet } from "../helpers.mjs";
/** @typedef {import("../../src/contract/index.mjs").ValidatedContract} ValidatedContract */

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @returns {string} a fresh repository with one commit */
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "runner-chain-restart-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.test"]);
  git(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", "base"]);
  return repo;
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

/**
 * @param {string} repo
 * @param {string} campaignId
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
function chainContract(repo, campaignId, id) {
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
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" } },
    },
    nodes: [{ id: "build", type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["base.txt"], writeFiles: [`out-${id}.txt`] }), gate: false }],
  };
}

/** @param {string} repo @param {string} campaignId @param {string} id @returns {string} */
function writeChainContract(repo, campaignId, id) {
  const path = join(repo, `${id}.contract.json`);
  writeFileSync(path, `${JSON.stringify(chainContract(repo, campaignId, id), null, 2)}\n`);
  return path;
}

/** @param {string} path @returns {ValidatedContract} */
function validatedAt(path) {
  return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
}

/**
 * @param {string} repo
 * @param {string} campaignId
 * @param {string[]} contractPaths
 * @returns {{path: string, campaign: import("../../src/campaign/index.mjs").Campaign}}
 */
function makeCampaign(repo, campaignId, contractPaths) {
  return initializeCampaign(runsRoot(repo), {
    campaignId,
    goal: `chain ${campaignId}`,
    contracts: contractPaths.map((path) => ({ path, digest: authoredContractDigest(path) })),
    landBranch: `campaign/${campaignId}`,
  });
}

/**
 * A run directory shaped the way a controller leaves one: the serialized
 * contract it stores, one node snapshot, and a `run.json` whose
 * `contractDigest` is computed over the stored `contract.json` bytes. The
 * chain refuses a run directory whose three records disagree, so a fixture that
 * does not go through this shape tests nothing.
 *
 * @param {{repo: string, runDir: string, contract: ValidatedContract, node: Record<string, unknown>, gitHead?: string|null}} args
 */
function writeRunDir({ repo, runDir, contract, node, gitHead = null }) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(serializableContract(contract), null, 2)}\n`);
  writeFileSync(join(runDir, "nodes", `${String(node.id)}.json`), JSON.stringify(node));
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
      gitHead: gitHead ?? git(repo, ["rev-parse", "HEAD"]),
      dirtyTreeFingerprint: null,
      packetHashes: Object.fromEntries(contract.nodes.map((candidate) => [candidate.id, candidate.packetHash])),
      harnessVersions: {},
    },
    contractDigest: storedContractDigest(runDir),
  }, null, 2)}\n`);
}

/**
 * The controller's own work on a run that was already bootstrapped: one commit
 * integrated onto the run's ref, and the node that was in flight settled done.
 * A resumed run keeps the `run.json` its dead controller wrote, so this is
 * deliberately narrower than `writeRunDir`.
 *
 * @param {string} repo @param {string} runDir @param {ValidatedContract} contract @returns {string}
 */
function finishRun(repo, runDir, contract) {
  const head = commitFile(repo, `out-${contract.id}.txt`, `${contract.id}\n`, `run ${contract.id}`);
  git(repo, ["update-ref", `refs/faberun/${contract.id}/run`, head]);
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done" }));
  return head;
}

// A coordinator restart re-runs promotion for a node whose run had already
// landed. By the time the restart replays it, a later run may have already
// advanced the land branch further, so promoteRun's already_promoted result
// reports that later head, not the replayed run's own head. Recording that
// verbatim would add a spurious promotion for the replayed run.

test("a coordinator restart replaying an already-promoted run does not re-record after the land branch has since advanced", () => {
  const repo = initRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const runOneHead = commitFile(repo, "one.txt", "one\n", "run one");
  const runTwoHead = commitFile(repo, "two.txt", "two\n", "run two");

  const runsDir = runsRoot(mkdtempSync(join(tmpdir(), "runner-chain-restart-campaign-")));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "restart", goal: "Coordinator restart replay" });

  const first = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead: runOneHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(first.status, "promoted");
  const second = promoteRunInCampaign({ campaignPath, repo, runId: "run-2", runHead: runTwoHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(second.status, "promoted");

  const replay = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead: runOneHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(replay.status, "already_promoted");
  assert.equal(replay.sha, runTwoHead, "already_promoted reports the branch's current head, not run-1's own head");

  const promotions = readCampaign(campaignPath).promotions;
  assert.equal(promotions.length, 2, "one promotion per run that actually moved the branch; the replay adds nothing");
});

// R2, measured in the 2026-09-29 review: the campaign launched a detached
// `run`, the controller died after its bootstrap, and the chain waited on the
// unfinished run forever -- `runProgress` said `unfinished`,
// `controllerAlive` said false, and nothing ever asked for a resume.

test("R2: an unfinished run with no live controller is resumed in place, and the campaign advances", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "resume-chain", "r1");
  const path1 = writeChainContract(repo, "resume-chain", "r2");
  const { path: campaignPath } = makeCampaign(repo, "resume-chain", [path0, path1]);
  const contract0 = validatedAt(path0);
  const runDir = runDirectory(repo, "r1");
  // A run's ref exists from creation, cut from the base; the dead controller
  // left the single node in flight.
  git(repo, ["update-ref", "refs/faberun/r1/run", git(repo, ["rev-parse", "HEAD"])]);
  writeRunDir({ repo, runDir, contract: contract0, node: { id: "build", status: "running", phase: "worker" } });
  writeFileSync(join(runDir, "left-behind.txt"), "dead controller\n");

  /** @type {string[]} */
  const resumed = [];
  /** @type {string[]} */
  const launched = [];
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    resume: async (target) => {
      resumed.push(target);
      finishRun(repo, target, contract0);
    },
    launch: async (_contractPath, context) => {
      launched.push(context.contract.id);
      const baseSha = context.baseRef ? git(repo, ["rev-parse", context.baseRef]) : undefined;
      writeRunDir({ repo, runDir: context.runDir, contract: context.contract, node: { id: "build", status: "done" }, gitHead: baseSha ?? null });
      finishRun(repo, context.runDir, context.contract);
    },
  });

  assert.deepEqual(resumed, [runDir], "the run the controller abandoned is the one resumed");
  assert.deepEqual(launched, ["r2"], "only the next contract is launched; the orphaned run is never re-launched");
  assert.equal(outcome.state, "done");
  assert.equal(readFileSync(join(runDir, "left-behind.txt"), "utf8"), "dead controller\n", "the run directory was resumed in place, not recreated");
  assert.deepEqual(readCampaign(campaignPath).promotions.map((promotion) => promotion.runId), ["r1", "r2"]);
});

test("R2: a run whose controller is alive is awaited, never resumed", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "live-controller", "l1");
  const { path: campaignPath } = makeCampaign(repo, "live-controller", [path0]);
  const runDir = runDirectory(repo, "l1");
  writeRunDir({ repo, runDir, contract: validatedAt(path0), node: { id: "build", status: "running", phase: "worker" } });
  const lock = acquireRunLock(runDir);
  let resumed = 0;
  try {
    const outcome = await driveCampaignChain(campaignPath, {
      repo,
      coordination: false,
      heartbeat: noopHeartbeat(),
      sleep: async () => {},
      maxTicks: 3,
      resume: () => { resumed += 1; },
      launch: () => { throw new Error("a run with a live controller is never relaunched"); },
    });
    assert.equal(outcome.state, "stopped");
    assert.equal(resumed, 0, "the live controller owns the run; the chain only waits");
    assert.equal(existsSync(join(runDir, "controller.lock")), true, "the controller's own lock is left exactly where it was");
  } finally {
    lock.release();
  }
});

test("R2: a resume that never takes is bounded, and the campaign keeps the attention", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "exhausted", "e1");
  const { path: campaignPath } = makeCampaign(repo, "exhausted", [path0]);
  const runDir = runDirectory(repo, "e1");
  git(repo, ["update-ref", "refs/faberun/e1/run", git(repo, ["rev-parse", "HEAD"])]);
  writeRunDir({ repo, runDir, contract: validatedAt(path0), node: { id: "build", status: "running", phase: "worker" } });

  let resumes = 0;
  const first = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    resume: async () => { resumes += 1; throw new Error("integration ref is unavailable for e1"); },
    launch: () => { throw new Error("nothing is launched while a run is unfinished"); },
  });
  assert.equal(resumes, MAX_RUN_RECOVERY_ATTEMPTS, "the chain stops resuming at its bound");
  assert.equal(first.state, "parked");
  const attention = readCampaign(campaignPath).attention;
  assert.equal(attention?.code, "run_recovery_exhausted");
  assert.match(String(attention?.message), /integration ref is unavailable for e1/u, "the last refusal is what the operator reads");
  assert.ok(String(attention?.message).includes(runDir), "the attention names the run directory");
  assert.equal(attention?.resume, `resume ${runDir}`);

  // The attention is the durable half: a re-invocation resumes nothing and
  // reports the same park instead of spending three more resumes.
  let secondResumes = 0;
  const second = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    resume: () => { secondResumes += 1; },
    launch: () => { throw new Error("nothing is launched while the campaign is parked"); },
  });
  assert.equal(second.state, "parked");
  assert.equal(secondResumes, 0, "the campaign's attention survives the invocation that wrote it");
  assert.equal(second.attention?.code, "run_recovery_exhausted");
});

test("R2: progress between resumes restarts the recovery budget", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "progressing", "p1");
  const { path: campaignPath } = makeCampaign(repo, "progressing", [path0]);
  const contract0 = validatedAt(path0);
  const runDir = runDirectory(repo, "p1");
  git(repo, ["update-ref", "refs/faberun/p1/run", git(repo, ["rev-parse", "HEAD"])]);
  writeRunDir({ repo, runDir, contract: contract0, node: { id: "build", status: "running", phase: "worker" } });

  let calls = 0;
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    resume: async (target) => {
      calls += 1;
      if (calls === 1) throw new Error("first resume refused");
      if (calls === 2) {
        // A controller that came up, made progress and died again: the run's own
        // heartbeat is the only record of that, and it is what resets the bound.
        writeHeartbeat(target, { at: new Date().toISOString(), lastProgressAt: "2026-09-29T00:00:01.000Z", iteration: 1, activeNodes: [] });
        return;
      }
      if (calls === 3) throw new Error("second resume refused");
      finishRun(repo, target, contract0);
    },
    launch: () => { throw new Error("the campaign has one contract"); },
  });

  assert.equal(calls, MAX_RUN_RECOVERY_ATTEMPTS + 1, "a run that showed progress gets a fresh budget instead of a park");
  assert.equal(outcome.state, "done");
});

test("R2: a pause requested between the classification and the resume is not overridden", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "paused", "x1");
  const { path: campaignPath } = makeCampaign(repo, "paused", [path0]);
  const runDir = runDirectory(repo, "x1");
  writeRunDir({ repo, runDir, contract: validatedAt(path0), node: { id: "build", status: "running", phase: "worker" } });
  // The pause the operator asked for is the run's cancel request, written after
  // this tick's classification was computed -- the race the resume re-checks.
  writeFileSync(join(runDir, "cancel.request.json"), JSON.stringify({ at: new Date().toISOString() }));

  let resumed = 0;
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 10,
    progress: () => ({ state: "unfinished", total: 1, terminal: 0, runOutcome: "parked", outcomeNodes: [{ id: "build", status: "running" }] }),
    resume: () => { resumed += 1; },
    launch: () => { throw new Error("nothing is launched while a run is unfinished"); },
  });
  assert.equal(outcome.state, "parked");
  assert.equal(outcome.attention?.code, "run_canceled");
  assert.equal(resumed, 0, "a requested pause is never resumed by the chain");
  assert.equal(existsSync(join(runDir, "cancel.request.json")), true, "the pause request is left for the operator to lift");
});
