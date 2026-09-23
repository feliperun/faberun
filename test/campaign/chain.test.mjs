import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  driveCampaignChain,
  readCoordinatorLock,
  validateManifestEntryAtLaunch,
  writeCoordinatorLock,
} from "../../src/campaign/chain.mjs";
import { authoredContractDigest, initializeCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, contractDigest, validateContract } from "../../src/contract/index.mjs";
import { controllerSnapshotIdentity, serializableContract, storedContractDigest } from "../../src/engine/run-identity.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { writeHeartbeat } from "../../src/engine/supervise.mjs";
import { processStartToken } from "../../src/run/lock.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";
import { packet, closeResult, waitForValue, withFakeCodex } from "../helpers.mjs";
/** @typedef {import("../../src/contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../../src/contract/index.mjs").ControllerIdentity} ControllerIdentity */
/** @typedef {{baseRef: string|undefined, controllerIdentity: ControllerIdentity, runDir: string, contract: ValidatedContract}} ChainLaunchContext */
/** @typedef {{id: string, baseRef?: string, runDir: string}} LaunchRecord */
/** @typedef {{repo: string, runDir: string, contract: ValidatedContract, node: Record<string, unknown>, gitHead?: string|null, controllerIdentity?: ControllerIdentity, digest?: string}} RunDirArgs */

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/** @param {string} campaignPath @returns {number|undefined} */
function lockPid(campaignPath) {
  const lock = readCoordinatorLock(campaignPath);
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return undefined;
  return /** @type {number|undefined} */ (/** @type {Record<string, unknown>} */ (lock).pid);
}

/**
 * Drive the operator surface an operator actually types: `supervise campaign
 * <id>`, routed by src/cli.mjs through the `supervise` operation in
 * src/cli/campaign.mjs. Spawned async so a test can observe the coordinator
 * lock while the invocation is still alive.
 *
 * @param {string} campaignId
 * @param {string} repo
 * @returns {import("node:child_process").ChildProcess}
 */
function coordinatorCliCase(campaignId, repo) {
  return spawn(process.execPath, [CLI, "supervise", "campaign", campaignId, "--cwd", repo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Wait until the invocation's own pid is the coordinator lock's holder. The
 * lock is released again when the invocation exits, so this is only
 * answerable while the `supervise` process is alive.
 *
 * @param {string} campaignPath
 * @param {number} pid
 * @returns {Promise<number>}
 */
async function waitForCoordinatorLock(campaignPath, pid) {
  return /** @type {number} */ (await waitForValue(() => (lockPid(campaignPath) === pid ? pid : null)));
}

/**
 * Every file under `dir`, keyed by its path relative to `dir`, as bytes. Two
 * snapshots compare equal only when nothing was added, removed or rewritten.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function snapshotTree(dir) {
  /** @type {Record<string, string>} */
  const snapshot = {};
  /** @param {string} current @param {string} prefix */
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, relative);
      else snapshot[relative] = readFileSync(absolute, "utf8");
    }
  };
  walk(dir, "");
  return snapshot;
}

/** @returns {{progress: (nodeId?: string, budgetBasis?: number) => void, setActive: (nodes: {nodeId: string, budgetBasis: number}[]) => void, stop: () => void}} */
function noopHeartbeat() {
  return { progress() {}, setActive() {}, stop() {} };
}

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @param {string} [branch] @returns {string} */
function initRepo(branch = "main") {
  const repo = mkdtempSync(join(tmpdir(), "runner-chain-repo-"));
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
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

/**
 * A run directory shaped the way the controller leaves one: the serialized
 * contract the controller stores, the node snapshots, and a run.json whose
 * `contractDigest` is computed the controller's way -- over the stored
 * contract.json bytes, not over the in-memory validated contract. The
 * `digest` override exists for the tamper case alone.
 *
 * @param {RunDirArgs} args
 */
function writeRunDir({ repo, runDir, contract, node, gitHead = null, controllerIdentity, digest }) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(serializableContract(contract), null, 2)}\n`);
  writeFileSync(join(runDir, "nodes", `${String(node.id)}.json`), JSON.stringify(node));
  /** @type {Record<string, unknown>} */
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
      gitHead: gitHead ?? git(repo, ["rev-parse", "HEAD"]),
      dirtyTreeFingerprint: null,
      packetHashes: Object.fromEntries(contract.nodes.map((candidate) => [candidate.id, candidate.packetHash])),
      harnessVersions: {},
    },
    contractDigest: digest ?? storedContractDigest(runDir),
  };
  if (controllerIdentity) metadata.controllerIdentity = controllerIdentity;
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * The child controller's legitimate work, simulated: integrate a commit onto the
 * run ref and leave a succeeded run behind for the chain to observe.
 *
 * @param {string} repo
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {string|undefined} baseRef
 * @param {{controllerIdentity?: ControllerIdentity}} [options]
 * @returns {{baseSha: string, head: string}}
 */
function succeedRun(repo, runDir, contract, baseRef, options = {}) {
  const baseSha = baseRef ? git(repo, ["rev-parse", baseRef]) : git(repo, ["rev-parse", "HEAD"]);
  const head = commitFile(repo, `out-${contract.id}.txt`, `${contract.id}\n`, `run ${contract.id}`);
  git(repo, ["update-ref", `refs/faberun/${contract.id}/run`, head]);
  writeRunDir({ repo, runDir, contract, node: { id: "build", status: "done" }, gitHead: baseSha, ...(options.controllerIdentity ? { controllerIdentity: options.controllerIdentity } : {}) });
  return { baseSha, head };
}

/** @param {string} repo @param {LaunchRecord[]} log @returns {(contractPath: string, context: ChainLaunchContext) => Promise<void>} */
function succeedingLauncher(repo, log) {
  return async (_contractPath, context) => {
    log.push({ id: context.contract.id, baseRef: context.baseRef, runDir: context.runDir });
    succeedRun(repo, context.runDir, context.contract, context.baseRef);
  };
}

// ---------------------------------------------------------------------------
// Phase 3 done-when cases this node owns.
// ---------------------------------------------------------------------------

test("done-when 1 and 2: three contracts launch in order, landBranch moves after each, and N+1 is cut from N's commit", async () => {
  const repo = initRepo();
  const paths = ["c1", "c2", "c3"].map((id) => writeChainContract(repo, "chain1", id));
  const { path: campaignPath } = makeCampaign(repo, "chain1", paths);
  /** @type {LaunchRecord[]} */
  const log = [];
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    launch: succeedingLauncher(repo, log),
  });
  assert.equal(outcome.state, "done");
  assert.deepEqual(log.map((entry) => entry.id), ["c1", "c2", "c3"], "the manifest order is the launch order");
  assert.equal(log[0].baseRef, undefined, "the first run is cut from the checkout HEAD");
  assert.equal(log[1].baseRef, "campaign/chain1");
  assert.equal(log[2].baseRef, "campaign/chain1");

  const campaign = readCampaign(campaignPath);
  assert.equal(campaign.promotions.length, 3, "each success left one promotion record");
  assert.deepEqual(campaign.promotions.map((record) => record.runId), ["c1", "c2", "c3"]);
  assert.equal(git(repo, ["rev-parse", "campaign/chain1"]), git(repo, ["rev-parse", "refs/faberun/c3/run"]), "the branch moved after each contract");

  // done-when 2: lineage. c2 recorded the sha c1 integrated.
  const c2 = JSON.parse(readFileSync(join(runDirectory(repo, "c2"), "run.json"), "utf8"));
  assert.equal(c2.sourceIdentity.gitHead, git(repo, ["rev-parse", "refs/faberun/c1/run"]));
  const c3 = JSON.parse(readFileSync(join(runDirectory(repo, "c3"), "run.json"), "utf8"));
  assert.equal(c3.sourceIdentity.gitHead, git(repo, ["rev-parse", "refs/faberun/c2/run"]));
});

test("done-when 3: a parked second run stops the chain before the third and names contract, node and status", async () => {
  const repo = initRepo();
  const paths = ["p1", "p2", "p3"].map((id) => writeChainContract(repo, "chain2", id));
  const { path: campaignPath } = makeCampaign(repo, "chain2", paths);
  /** @type {string[]} */
  const log = [];
  const launch = async (/** @type {string} */ _contractPath, /** @type {ChainLaunchContext} */ context) => {
    log.push(context.contract.id);
    if (context.contract.id === "p1") {
      succeedRun(repo, context.runDir, context.contract, context.baseRef);
      return;
    }
    if (context.contract.id === "p2") {
      writeRunDir({
        repo,
        runDir: context.runDir,
        contract: context.contract,
        node: { id: "build", status: "failed", phase: "worker", error: { code: "boom", message: "boom" } },
      });
      return;
    }
    throw new Error("the third contract must not launch");
  };
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    launch,
  });
  assert.equal(outcome.state, "parked");
  assert.deepEqual(log, ["p1", "p2"]);
  assert.equal(outcome.attention?.code, "run_parked");
  assert.equal(outcome.attention?.contractId, "p2");
  assert.equal(outcome.attention?.node, "build");
  assert.equal(outcome.attention?.status, "failed");
  assert.match(String(outcome.attention?.message), /contract p2/u);
  assert.equal(readCampaign(campaignPath).attention?.node, "build", "the campaign record carries the durable park");
});

test("done-when 10a: with no coordinator, supervise campaign through the CLI becomes one", async () => {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, "cli-become", "b1");
  const { path: campaignPath } = makeCampaign(repo, "cli-become", [contractPath]);
  // An in-flight run keeps the newly-become coordinator alive long enough to
  // observe the lock it wrote, without launching anything.
  const validated = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  writeRunDir({ repo, runDir: runDirectory(repo, "b1"), contract: validated, node: { id: "build", status: "running", phase: "worker" } });
  assert.equal(readCoordinatorLock(campaignPath), null, "no coordinator exists before the invocation");

  const child = coordinatorCliCase("cli-become", repo);
  const childPid = child.pid;
  assert.ok(childPid !== undefined, "the invocation has a pid");
  const done = closeResult(child);
  try {
    assert.equal(await waitForCoordinatorLock(campaignPath, childPid), childPid, "the invocation wrote its own coordinator lock");
  } finally {
    child.kill("SIGTERM");
    await done;
  }
});

test("done-when 10b: a fresh heartbeat is observed through the CLI, exits 0 and writes nothing", async () => {
  const repo = initRepo();
  const { path: campaignPath } = makeCampaign(repo, "watch", []);
  // A detached probe holds the lock, so a CLI that considered it stale could
  // never signal the test runner's own group.
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  holder.unref();
  const holderPid = holder.pid;
  if (holderPid === undefined) throw new Error("coordinator holder probe did not start");
  try {
    const now = Date.now();
    writeCoordinatorLock(campaignPath, { schemaVersion: 1, pid: holderPid, processStartToken: processStartToken(holderPid), startedAt: new Date(now).toISOString(), hostname: "test" });
    writeHeartbeat(campaignPath, { at: new Date(now).toISOString(), lastProgressAt: new Date(now).toISOString(), iteration: 1, activeNodes: [] });
    const before = snapshotTree(campaignPath);
    const result = await closeResult(coordinatorCliCase("watch", repo));
    assert.equal(result.code, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    assert.match(String(result.stdout), /already-running/u, "the invocation reported the coordinator it observed");
    assert.deepEqual(snapshotTree(campaignPath), before, "the observer wrote nothing to the campaign directory");
  } finally {
    try { process.kill(-holderPid, "SIGKILL"); } catch { /* the probe is already gone */ }
  }
});

test("done-when 10c: a stale heartbeat is taken over through the CLI, terminating the group and acquiring the lock", async () => {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, "cli-takeover", "t1");
  const { path: campaignPath } = makeCampaign(repo, "cli-takeover", [contractPath]);
  // An in-flight run keeps the new coordinator alive long enough to observe
  // that it acquired the lock, without launching anything.
  const validated = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  writeRunDir({ repo, runDir: runDirectory(repo, "t1"), contract: validated, node: { id: "build", status: "running", phase: "worker" } });

  // The previous coordinator is a real live process group that records the
  // SIGTERM that takes it down.
  const marker = join(mkdtempSync(join(tmpdir(), "runner-coordinator-marker-")), "sigterm.txt");
  const holderScript = join(mkdtempSync(join(tmpdir(), "runner-coordinator-holder-")), "holder.mjs");
  writeFileSync(holderScript, `import { appendFileSync } from "node:fs";\nprocess.on("SIGTERM", () => { appendFileSync(${JSON.stringify(marker)}, "SIGTERM\\n"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`);
  const holder = spawn(process.execPath, [holderScript], { detached: true, stdio: "ignore" });
  const holderPid = holder.pid;
  assert.ok(holderPid !== undefined, "the previous coordinator has a pid");
  const holderDone = closeResult(holder);
  const staleAt = Date.now() - 10 * 60_000;
  writeCoordinatorLock(campaignPath, { schemaVersion: 1, pid: holderPid, processStartToken: null, startedAt: new Date(staleAt).toISOString(), hostname: "test" });
  writeHeartbeat(campaignPath, { at: new Date(staleAt).toISOString(), lastProgressAt: new Date(staleAt).toISOString(), iteration: 1, activeNodes: [] });

  try {
    const child = coordinatorCliCase("cli-takeover", repo);
    const childPid = child.pid;
    assert.ok(childPid !== undefined, "the invocation has a pid");
    const done = closeResult(child);
    try {
      assert.equal(await waitForCoordinatorLock(campaignPath, childPid), childPid, "the invocation acquired the previous holder's lock");
      const ended = await holderDone;
      if (process.platform === "win32") assert.notEqual(ended.code ?? ended.signal, null, "the previous group was terminated"); else assert.equal(readFileSync(marker, "utf8"), "SIGTERM\n", "exactly one SIGTERM terminated the previous group"); // guard-exempt: host-layout `taskkill /F` runs no handler, so only a POSIX holder records its own SIGTERM
    } finally {
      child.kill("SIGTERM");
      await done;
    }
  } finally {
    if (holder.exitCode === null) holder.kill("SIGTERM");
  }
});

test("done-when 11: a waiting first run neither advances nor fails, then advances once the clock passes the reset", async () => {
  const repo = initRepo();
  const path0 = writeChainContract(repo, "chain3", "w1");
  const path1 = writeChainContract(repo, "chain3", "w2");
  const { path: campaignPath } = makeCampaign(repo, "chain3", [path0, path1]);
  const validated = validateContract(JSON.parse(readFileSync(path0, "utf8")), path0);
  const runDir = runDirectory(repo, "w1");
  // A run ref exists from run creation, cut from the base; the waiting run has
  // not advanced it yet.
  git(repo, ["update-ref", "refs/faberun/w1/run", git(repo, ["rev-parse", "HEAD"])]);
  const start = Date.parse("2026-09-14T00:00:00Z");
  const reset = "2026-09-14T00:10:00.000Z";
  writeRunDir({
    repo,
    runDir,
    contract: validated,
    node: {
      id: "build",
      status: "blocked",
      phase: "worker",
      error: { code: "runtime_tier_exhausted", message: "no runtime left" },
      routing: { tierExhaustion: { role: "worker", candidates: [{ runtimeId: "luna", exhaustedUntil: reset }] } },
    },
  });
  let clock = start;
  let resumed = false;
  /** @type {LaunchRecord[]} */
  const log = [];
  const sleep = async (/** @type {number} */ ms) => {
    clock += ms;
    if (!resumed && clock >= Date.parse(reset)) {
      resumed = true;
      writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done" }));
    }
  };
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    now: () => clock,
    sleep,
    pollMs: 60_000,
    maxTicks: 40,
    launch: succeedingLauncher(repo, log),
  });
  assert.equal(outcome.state, "done");
  assert.equal(resumed, true, "the run resumed itself at the recorded reset");
  assert.deepEqual(log.map((entry) => entry.id), ["w2"], "the chain advanced only after the run succeeded");
});

test("done-when 11b: a readFiles entry only the predecessor creates refuses before promotion and validates after it", async () => {
  const repo = initRepo();
  const path1 = writeChainContract(repo, "chain4", "r1");
  const path2 = writeChainContract(repo, "chain4", "r2", {
    nodes: [{ id: "build", type: "backend", phase: "phase", taskPacket: packet({ readFiles: ["out-r1.txt"], writeFiles: ["out-r2.txt"] }), gate: false }],
  });
  const base = git(repo, ["rev-parse", "HEAD"]);
  assert.throws(
    () => validateManifestEntryAtLaunch({ path: path2, digest: authoredContractDigest(path2) }, { repo, baseRef: base }),
    /does not exist/u,
    "before the predecessor lands, the deferred read is refused",
  );
  const { path: campaignPath } = makeCampaign(repo, "chain4", [path1, path2]);
  /** @type {LaunchRecord[]} */
  const log = [];
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    launch: succeedingLauncher(repo, log),
  });
  assert.equal(outcome.state, "done");
  assert.deepEqual(log.map((entry) => entry.id), ["r1", "r2"], "after r1 promoted, r2 validated against the branch and launched");
  assert.equal(log[1].baseRef, "campaign/chain4");
});

test("done-when 11c: a manifest entry whose authored bytes changed stops with a tamper report", async () => {
  const repo = initRepo();
  const path1 = writeChainContract(repo, "chain5", "t1");
  const { path: campaignPath } = makeCampaign(repo, "chain5", [path1]);
  const raw = JSON.parse(readFileSync(path1, "utf8"));
  raw.goal = "tampered after authoring";
  writeFileSync(path1, `${JSON.stringify(raw, null, 2)}\n`);
  /** @type {LaunchRecord[]} */
  const log = [];
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 5,
    launch: succeedingLauncher(repo, log),
  });
  assert.equal(outcome.state, "parked");
  assert.equal(outcome.attention?.code, "contract_authored_bytes_changed");
  assert.deepEqual(log, []);
});

test("done-when 12: a changed contractDigest stops, including when every packet is unchanged", async () => {
  const repo = initRepo();
  const path1 = writeChainContract(repo, "chain6", "d1");
  const raw = JSON.parse(readFileSync(path1, "utf8"));
  const original = validateContract(JSON.parse(readFileSync(path1, "utf8")), path1);
  const originalDigest = contractDigest(original);
  // Gate, DAG, timeout and finalVerification changes all leave the task packet
  // bytes untouched, so only the digest can refuse them.
  const variants = [
    { ...raw, nodes: raw.nodes.map((/** @type {Record<string, any>} */ node) => ({ ...node, gate: { enabled: true, review: "advisory", failOn: ["critical"] } })) },
    { ...raw, nodes: [...raw.nodes, { id: "second", type: "backend", phase: "phase", dependsOn: ["build"], taskPacket: packet({ readFiles: ["base.txt"], writeFiles: ["other.txt"] }), gate: false }] },
    { ...raw, timeoutSec: 99, finalVerification: [{ argv: ["true"] }] },
  ];
  for (const variant of variants) {
    assert.notEqual(contractDigest(variant), originalDigest, "a non-packet change moved the digest");
  }
  assert.deepEqual(variants[0].nodes.map((/** @type {Record<string, any>} */ node) => node.taskPacket), raw.nodes.map((/** @type {Record<string, any>} */ node) => node.taskPacket), "the gate variant's packets are byte-identical");

  const { path: campaignPath } = makeCampaign(repo, "chain6", [path1]);
  writeRunDir({ repo, runDir: runDirectory(repo, "d1"), contract: original, node: { id: "build", status: "done" }, digest: contractDigest(variants[0]) });
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 5,
    launch: () => { throw new Error("the mismatched run must not relaunch"); },
  });
  assert.equal(outcome.state, "parked");
  assert.equal(outcome.attention?.code, "contract_digest_mismatch");
});

/**
 * Create a real run through the child controller path -- the same `runContract`
 * the CLI entry uses -- so the chain observes a run.json and contract.json the
 * controller actually wrote rather than a hand-shaped pair.
 *
 * @param {string} repo
 * @param {string} contractPath
 * @returns {Promise<string>}
 */
function controllerRun(repo, contractPath) {
  return withFakeCodex(repo, "pass", async () => (await runContract(contractPath)).runDir);
}

test("chain-digest 1: a controller-created run is classified, not parked as a digest mismatch", async () => {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, "chain-real", "real1");
  const { path: campaignPath } = makeCampaign(repo, "chain-real", [contractPath]);
  const runDir = await controllerRun(repo, contractPath);

  // The controller records the digest of the stored contract.json; hashing the
  // freshly validated in-memory contract disagrees, which is what the chain
  // used to compare and park on.
  const recorded = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).contractDigest;
  assert.equal(recorded, storedContractDigest(runDir), "run.json records the stored contract's digest");
  const validated = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  assert.notEqual(contractDigest(validated), recorded, "the old in-memory comparison would have mismatched");

  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 2,
    launch: () => { throw new Error("the existing run must not relaunch"); },
  });
  assert.notEqual(outcome.attention?.code, "contract_digest_mismatch");
  assert.equal(outcome.state, "done", "the chain classified the real run and promoted it");
  assert.equal(readCampaign(campaignPath).promotions.length, 1, "the real run was promoted exactly once");
});

test("chain-digest 2: editing the stored contract parks with contract_digest_mismatch", async () => {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, "chain-stored-edit", "edit1");
  const { path: campaignPath } = makeCampaign(repo, "chain-stored-edit", [contractPath]);
  const runDir = await controllerRun(repo, contractPath);
  const recorded = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).contractDigest;
  const storedPath = join(runDir, "contract.json");
  const stored = JSON.parse(readFileSync(storedPath, "utf8"));
  stored.goal = "edited after creation";
  writeFileSync(storedPath, `${JSON.stringify(stored, null, 2)}\n`);
  const editedDigest = storedContractDigest(runDir);

  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 3,
    launch: () => { throw new Error("the edited run must not relaunch"); },
  });
  assert.equal(outcome.state, "parked");
  assert.equal(outcome.attention?.code, "contract_digest_mismatch");
  assert.match(String(outcome.attention?.message), new RegExp(String(editedDigest), "u"), "the message names the stored digest");
  assert.match(String(outcome.attention?.message), new RegExp(recorded, "u"), "the message names the recorded digest");
});

test("chain-digest 3: a stored contract for a different contract id is refused", async () => {
  const repo = initRepo();
  const contractPath = writeChainContract(repo, "chain-foreign", "foreign1");
  const { path: campaignPath } = makeCampaign(repo, "chain-foreign", [contractPath]);
  const runDir = await controllerRun(repo, contractPath);
  const storedPath = join(runDir, "contract.json");
  const stored = JSON.parse(readFileSync(storedPath, "utf8"));
  stored.id = "some-other-contract";
  if (stored.sourceIdentity && typeof stored.sourceIdentity === "object") stored.sourceIdentity.id = "some-other-contract";
  writeFileSync(storedPath, `${JSON.stringify(stored, null, 2)}\n`);
  // Keep run.json's digest consistent with the edited stored contract, so only
  // the contract id can refuse it.
  const runJsonPath = join(runDir, "run.json");
  const metadata = JSON.parse(readFileSync(runJsonPath, "utf8"));
  metadata.contractDigest = contractDigest(stored);
  writeFileSync(runJsonPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 3,
    launch: () => { throw new Error("the foreign run must not relaunch"); },
  });
  assert.equal(outcome.state, "parked");
  assert.equal(outcome.attention?.code, "contract_digest_mismatch");
  assert.match(String(outcome.attention?.message), /some-other-contract/u, "the message names the foreign contract id");
});

test("done-when 13: re-issue launches only the remainder and awaits a non-terminal run", async () => {
  const repo = initRepo();
  const path1 = writeChainContract(repo, "chain7", "a1");
  const path2 = writeChainContract(repo, "chain7", "a2");
  const { path: campaignPath } = makeCampaign(repo, "chain7", [path1, path2]);
  /** @type {LaunchRecord[]} */
  const firstLog = [];
  const first = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    launch: succeedingLauncher(repo, firstLog),
  });
  assert.equal(first.state, "done");
  assert.deepEqual(firstLog.map((entry) => entry.id), ["a1", "a2"]);

  /** @type {LaunchRecord[]} */
  const secondLog = [];
  const second = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 10,
    launch: succeedingLauncher(repo, secondLog),
  });
  assert.equal(second.state, "done");
  assert.deepEqual(secondLog, [], "an already-succeeded run is skipped by digest");

  const repo2 = initRepo();
  const path3 = writeChainContract(repo2, "chain8", "n1");
  const { path: campaignPath2 } = makeCampaign(repo2, "chain8", [path3]);
  const validated = validateContract(JSON.parse(readFileSync(path3, "utf8")), path3);
  writeRunDir({ repo: repo2, runDir: runDirectory(repo2, "n1"), contract: validated, node: { id: "build", status: "running", phase: "worker" } });
  let relaunched = 0;
  const awaited = await driveCampaignChain(campaignPath2, {
    repo: repo2,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 3,
    launch: () => { relaunched += 1; },
  });
  assert.equal(awaited.state, "stopped");
  assert.equal(relaunched, 0, "a non-terminal run is awaited rather than relaunched");
});

test("done-when 14: the chain takes no run lock and writes no node state", async () => {
  const repo = initRepo();
  const path1 = writeChainContract(repo, "chain9", "l1");
  const { path: campaignPath } = makeCampaign(repo, "chain9", [path1]);
  const validated = validateContract(JSON.parse(readFileSync(path1, "utf8")), path1);
  const runDir = runDirectory(repo, "l1");
  succeedRun(repo, runDir, validated, undefined);
  const nodeBefore = readFileSync(join(runDir, "nodes", "build.json"), "utf8");
  const outcome = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 10,
    launch: () => { throw new Error("the succeeded run must not relaunch"); },
  });
  assert.equal(outcome.state, "done");
  assert.equal(existsSync(join(runDir, "controller.lock")), false, "the chain itself took no run lock");
  assert.equal(readFileSync(join(runDir, "nodes", "build.json"), "utf8"), nodeBefore, "the chain wrote no node state");

  // The child controller's own writes are legitimate, so the check observes
  // them through the launch seam rather than through a global spy.
  const repo2 = initRepo();
  const path2 = writeChainContract(repo2, "chain10", "l2");
  const { path: campaignPath2 } = makeCampaign(repo2, "chain10", [path2]);
  let lockAtLaunch = null;
  const outcome2 = await driveCampaignChain(campaignPath2, {
    repo: repo2,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 20,
    launch: async (/** @type {string} */ _contractPath, /** @type {ChainLaunchContext} */ context) => {
      lockAtLaunch = existsSync(join(context.runDir, "controller.lock"));
      succeedRun(repo2, context.runDir, context.contract, context.baseRef);
    },
  });
  assert.equal(outcome2.state, "done");
  assert.equal(lockAtLaunch, false, "the chain did not take the run lock before the child controller did");
});

test("instruction 7: N+1 launches from N's controller snapshot, and a changed snapshot refuses", async () => {
  const executable = join(mkdtempSync(join(tmpdir(), "runner-chain-snapshot-")), "controller.mjs");
  writeFileSync(executable, "console.log('v1')\n");
  const identity = controllerSnapshotIdentity(executable);

  const repo = initRepo();
  const paths = ["i1", "i2"].map((id) => writeChainContract(repo, "chain11", id));
  const { path: campaignPath } = makeCampaign(repo, "chain11", paths);
  /** @type {{id: string, identity: ControllerIdentity}[]} */
  const log = [];
  const first = await driveCampaignChain(campaignPath, {
    repo,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    controllerIdentity: identity,
    launch: async (_contractPath, context) => {
      log.push({ id: context.contract.id, identity: context.controllerIdentity });
      succeedRun(repo, context.runDir, context.contract, context.baseRef, { controllerIdentity: context.controllerIdentity });
    },
  });
  assert.equal(first.state, "done");
  assert.equal(log[1].identity.path, identity.path, "N+1 used N's recorded snapshot path");
  assert.equal(log[1].identity.sha, identity.sha, "N+1 used N's recorded snapshot sha");

  // The same run, but the executable is rewritten before the next launch.
  const changedExecutable = join(mkdtempSync(join(tmpdir(), "runner-chain-snapshot-changed-")), "controller.mjs");
  writeFileSync(changedExecutable, "console.log('v1')\n");
  const recorded = controllerSnapshotIdentity(changedExecutable);
  const repo2 = initRepo();
  const changedPaths = ["j1", "j2"].map((id) => writeChainContract(repo2, "chain12", id));
  const { path: campaignPath2 } = makeCampaign(repo2, "chain12", changedPaths);
  /** @type {string[]} */
  const changedLog = [];
  const blocked = await driveCampaignChain(campaignPath2, {
    repo: repo2,
    coordination: false,
    heartbeat: noopHeartbeat(),
    sleep: async () => {},
    maxTicks: 40,
    controllerIdentity: recorded,
    launch: async (_contractPath, context) => {
      changedLog.push(context.contract.id);
      succeedRun(repo2, context.runDir, context.contract, context.baseRef, { controllerIdentity: recorded });
      if (context.contract.id === "j1") writeFileSync(changedExecutable, "console.log('v2')\n");
    },
  });
  assert.equal(blocked.state, "parked");
  assert.equal(blocked.attention?.code, "controller_snapshot_changed");
  assert.deepEqual(changedLog, ["j1"], "N+1 was refused before it launched");
});

test("done-when 15: the real CLI surface drives the chain, including the main authorization flag", () => {
  const repo = initRepo();
  const c1 = writeChainContract(repo, "cli1", "k1");
  makeCampaign(repo, "cli1", [c1]);
  const validated = validateContract(JSON.parse(readFileSync(c1, "utf8")), c1);
  succeedRun(repo, runDirectory(repo, "k1"), validated, undefined);

  const result = spawnSync(process.execPath, [CLI, "supervise", "campaign", "cli1", "--cwd", repo], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.match(String(result.stdout), /cli1 done/u);
  assert.equal(git(repo, ["rev-parse", "campaign/cli1"]), git(repo, ["rev-parse", "refs/faberun/k1/run"]));
  const alias = spawnSync(process.execPath, [CLI, "campaign", "supervise", "cli1", "--cwd", repo], { encoding: "utf8" });
  assert.equal(alias.status, 0, `${alias.stdout ?? ""}${alias.stderr ?? ""}`);

  // main without the explicit operator flag refuses; with it, the refusal moves
  // past authorization to the live-checkout guard. Separate campaigns, because
  // the first refusal parks its campaign.
  const mainRepo = initRepo("main");
  const deniedContract = writeChainContract(mainRepo, "mainA", "m1");
  makeCampaign(mainRepo, "mainA", [deniedContract], "main");
  const deniedValidated = validateContract(JSON.parse(readFileSync(deniedContract, "utf8")), deniedContract);
  succeedRun(mainRepo, runDirectory(mainRepo, "m1"), deniedValidated, undefined);
  const noFlag = spawnSync(process.execPath, [CLI, "supervise", "campaign", "mainA", "--cwd", mainRepo], { encoding: "utf8" });
  assert.notEqual(noFlag.status, 0);
  assert.match(`${noFlag.stdout ?? ""}${noFlag.stderr ?? ""}`, /--allow-main/u);

  const authorizedContract = writeChainContract(mainRepo, "mainB", "m2");
  makeCampaign(mainRepo, "mainB", [authorizedContract], "main");
  const authorizedValidated = validateContract(JSON.parse(readFileSync(authorizedContract, "utf8")), authorizedContract);
  succeedRun(mainRepo, runDirectory(mainRepo, "m2"), authorizedValidated, undefined);
  const withFlag = spawnSync(process.execPath, [CLI, "supervise", "campaign", "mainB", "--cwd", mainRepo, "--allow-main"], { encoding: "utf8" });
  assert.notEqual(withFlag.status, 0);
  assert.match(`${withFlag.stdout ?? ""}${withFlag.stderr ?? ""}`, /checked out/u);
});
