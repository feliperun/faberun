/**
 * The campaign chain: the loop that launches each contract in a campaign's
 * ordered manifest, advances only on a run that actually succeeded, and parks
 * the campaign on anything else.
 *
 * It is not a resident daemon. A frozen process cannot detect its own freeze:
 * an unref'd timer inside it stops too. So the coordinator is an **idempotent
 * re-invocation**. `acquireCoordinator` takes `coordinator.lock` in the
 * campaign directory and reads the campaign heartbeat Phase 1 already defined;
 * a second invocation of the same command finds a fresh heartbeat and exits
 * having written nothing, finds a stale one and terminates that process group
 * and takes over, or finds no coordinator and becomes one. The re-invoker is
 * the host scheduler (launchd or cron) or the operator session's own Monitor.
 *
 * Advancement is `runOutcome`, never node counts: `succeeded` advances,
 * `waiting` is a self-resuming tier exhaustion and is neither advanced nor
 * parked, and `parked`/`canceled` park the campaign with attention. An
 * in-flight run (`state: unfinished`/`unknown`) is awaited, not relaunched.
 *
 * Validation of contract N+1 happens here, at launch, against the `landBranch`
 * N's promotion just advanced. Validating the manifest up front would reject
 * every contract that reads a file its predecessor creates, because there is
 * no deferral between contracts. The manifest entry's authored-bytes digest is
 * checked first so tampering between authoring and launch is caught before the
 * branch-aware validation runs.
 *
 * The chain takes no run lock and writes no node state. Its own artifacts are
 * `coordinator.lock`, the campaign `heartbeat.json`, and the campaign attention
 * record. Every run lock and node snapshot belongs to a child controller.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { assertContractManifestIntact, parkCampaign, promoteRunInCampaign } from "./index.mjs";
import { readCampaign } from "./record.mjs";
import { contractDigest, validateContract } from "../contract/index.mjs";
import { defaultControllerIdentity, verifyControllerIdentity } from "../engine/run-identity.mjs";
import { HEARTBEAT_INTERVAL_MS, createHeartbeat, groupAlive, heartbeatBreach, readHeartbeat, runProgress, waitForGroupGone } from "../engine/supervise.mjs";
import { pidAlive, processStartToken } from "../run/lock.mjs";
import { delay, errorCode, errorMessage } from "../util.mjs";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("../contract/index.mjs").ControllerIdentity} ControllerIdentity */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../engine/supervise.mjs").RunProgress} RunProgress */
/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").CampaignContract} CampaignContract */
/** @typedef {import("./index.mjs").CampaignAttention} CampaignAttention */

/** The campaign-level coordinator lock file name. */
export const COORDINATOR_LOCK_FILE = "coordinator.lock";

/** How long the chain waits between two reads of a child run's outcome. */
export const DEFAULT_CHAIN_POLL_MS = 1_000;

/** How long the coordinator's process group gets to honour `SIGTERM` before `SIGKILL`. */
export const DEFAULT_COORDINATOR_TERMINATE_GRACE_MS = 5_000;

/** How long the group gets after `SIGKILL` before the takeover stops waiting. */
export const DEFAULT_COORDINATOR_KILL_GRACE_MS = 5_000;

/**
 * @param {string} campaignPath
 * @returns {string}
 */
export function coordinatorLockPath(campaignPath) {
  return join(campaignPath, COORDINATOR_LOCK_FILE);
}

/**
 * @param {string} campaignPath
 * @returns {Record<string, unknown>|{invalid: true}|null}
 */
export function readCoordinatorLock(campaignPath) {
  try {
    const parsed = JSON.parse(readFileSync(coordinatorLockPath(campaignPath), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { invalid: true };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) return { invalid: true };
    throw error;
  }
}

/**
 * A coordinator lock is stale only once its holder is proven dead, exactly the
 * rule the run controller lock uses. A live pid with a mismatched start token
 * is a recycled pid, not the holder.
 *
 * @param {Record<string, unknown>|{invalid: true}|null} lock
 * @param {(pid: number) => boolean} [alive]
 * @param {(pid: number|null) => string|null} [startToken]
 * @returns {boolean}
 */
export function coordinatorLockStale(lock, alive = pidAlive, startToken = processStartToken) {
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return true;
  const record = /** @type {Record<string, unknown>} */ (lock);
  const pid = /** @type {number} */ (record.pid);
  if (!alive(pid)) return true;
  const recorded = /** @type {string|null|undefined} */ (record.processStartToken);
  return Boolean(recorded) && startToken(pid) !== recorded;
}

/** @param {string} campaignPath @param {Record<string, unknown>} record */
export function writeCoordinatorLock(campaignPath, record) {
  writeJsonAtomic(coordinatorLockPath(campaignPath), record);
}

/**
 * Remove the lock only when it is still the caller's own record, so a takeover
 * that already replaced it is never undone by the previous holder's exit.
 *
 * @param {string} campaignPath
 * @param {Record<string, unknown>|null} record
 */
export function releaseCoordinatorLock(campaignPath, record) {
  const current = readCoordinatorLock(campaignPath);
  if (!current || /** @type {{invalid?: true}} */ (current).invalid) return;
  const actual = /** @type {Record<string, unknown>} */ (current);
  if (record && actual.pid === record.pid && actual.startedAt === record.startedAt) {
    try {
      rmSync(coordinatorLockPath(campaignPath), { force: true });
    } catch {
      // A lock already removed by a takeover is exactly the state we wanted.
    }
  }
}

/** @param {number} pid @param {string} signal */
function groupKill(pid, signal) {
  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
      }
    }
    process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/**
 * Terminate the coordinator's process group, bounded: `SIGTERM`, then `SIGKILL`
 * after the named grace. The takeover writes its own lock only once the group
 * is gone, so two coordinators never overlap.
 *
 * @param {string} campaignPath
 * @param {{lock?: Record<string, unknown>|null, kill?: (pid: number, signal: string) => void, alive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number, graceMs?: number, killGraceMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function terminateCoordinatorGroup(campaignPath, options = {}) {
  const lock = options.lock ?? readCoordinatorLock(campaignPath);
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return false;
  const record = /** @type {Record<string, unknown>} */ (lock);
  const pid = /** @type {number} */ (record.pid);
  const kill = options.kill ?? groupKill;
  const alive = options.alive ?? ((target) => pidAlive(target) || groupAlive(target));
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_COORDINATOR_TERMINATE_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_COORDINATOR_KILL_GRACE_MS;
  if (!alive(pid)) return false;
  kill(pid, "SIGTERM");
  if (await waitForGroupGone(pid, alive, graceMs, sleep, now)) return true;
  kill(pid, "SIGKILL");
  await waitForGroupGone(pid, alive, killGraceMs, sleep, now);
  return true;
}

/**
 * The three re-invocation outcomes. A fresh heartbeat behind a live lock is
 * observed and the caller must write nothing; a stale heartbeat behind a live
 * lock is terminated and taken over; no live coordinator is simply become.
 *
 * @param {string} campaignPath
 * @param {{now?: () => number, heartbeatIntervalMs?: number, alive?: (pid: number) => boolean, startTokenOf?: (pid: number|null) => string|null, kill?: (pid: number, signal: string) => void, sleep?: (ms: number) => Promise<void>, graceMs?: number, killGraceMs?: number, pid?: number, processStartToken?: string|null}} [options]
 * @returns {Promise<{role: "observed"|"took-over"|"became", lock: Record<string, unknown>}>}
 */
export async function acquireCoordinator(campaignPath, options = {}) {
  const now = options.now ?? Date.now;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const alive = options.alive ?? pidAlive;
  const startToken = options.startTokenOf ?? processStartToken;
  const lock = readCoordinatorLock(campaignPath);
  const liveLock = lock && !coordinatorLockStale(lock, alive, startToken) ? /** @type {Record<string, unknown>} */ (lock) : null;
  const heartbeat = readHeartbeat(campaignPath);
  // A missing heartbeat behind a live lock is a coordinator that has just
  // started, not a frozen one: `createHeartbeat` writes immediately, and Phase
  // 1's `controllerAlive` reads absence the same way. Only a present heartbeat
  // that breaches its threshold is stale enough to take over.
  const fresh = heartbeat === null || heartbeatBreach(heartbeat, now(), heartbeatIntervalMs) === null;
  if (liveLock && fresh) return { role: "observed", lock: liveLock };
  if (liveLock) {
    await terminateCoordinatorGroup(campaignPath, { ...options, lock: liveLock });
    releaseCoordinatorLock(campaignPath, liveLock);
  }
  const pid = options.pid ?? process.pid;
  const record = {
    schemaVersion: 1,
    pid,
    processStartToken: options.processStartToken !== undefined ? options.processStartToken : startToken(pid),
    startedAt: new Date(now()).toISOString(),
    hostname: hostname(),
  };
  writeCoordinatorLock(campaignPath, record);
  return { role: liveLock ? "took-over" : "became", lock: record };
}

/**
 * The ref a contract's run is cut from: the campaign's landing branch once it
 * exists, nothing (the checkout's HEAD) for the first run that creates it.
 *
 * @param {string} repo
 * @param {string} landBranch
 * @returns {string|undefined}
 */
function landBranchRef(repo, landBranch) {
  return gitHead(repo, landBranch) ? landBranch : undefined;
}

/**
 * @param {string} repo
 * @param {string} ref
 * @returns {string|null}
 */
function gitHead(repo, ref) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Validate a manifest entry at launch against the ref its run is cut from. The
 * authored bytes are checked first (tamper), then the contract is fully
 * validated in a throwaway checkout of `baseRef`, where a predecessor's files
 * exist, with the runtime workspace pointed back at the operator's tree.
 *
 * @param {CampaignContract} entry
 * @param {{repo?: string, baseRef?: string}} [context]
 * @returns {ValidatedContract}
 */
export function validateManifestEntryAtLaunch(entry, context = {}) {
  assertContractManifestIntact(entry);
  const raw = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(entry.path, "utf8")));
  return validateContractAgainstRef(raw, entry.path, context);
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} contractPath
 * @param {{repo?: string, baseRef?: string}} [context]
 * @returns {ValidatedContract}
 */
export function validateContractAgainstRef(raw, contractPath, context = {}) {
  const { repo, baseRef } = context;
  if (!baseRef || !repo) return validateContract(raw, contractPath);
  const originalCwd = resolve(dirname(contractPath), typeof raw.cwd === "string" ? raw.cwd : ".");
  const worktree = mkdtempSync(join(tmpdir(), "runner-chain-ref-"));
  try {
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, baseRef], { stdio: ["ignore", "pipe", "pipe"] });
    const relativedCwd = relative(repo, originalCwd);
    const mappedCwd = relativedCwd && !relativedCwd.startsWith("..") ? join(worktree, relativedCwd) : worktree;
    const relativeContract = relative(repo, contractPath);
    const tempContractPath = relativeContract && !relativeContract.startsWith("..")
      ? join(worktree, relativeContract)
      : join(worktree, "contract.json");
    mkdirSync(dirname(tempContractPath), { recursive: true });
    writeFileSync(tempContractPath, JSON.stringify({ ...raw, cwd: mappedCwd }));
    const contract = validateContract(/** @type {Record<string, unknown>} */ ({ ...raw, cwd: mappedCwd }), tempContractPath);
    contract.cwd = originalCwd;
    return contract;
  } finally {
    try {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // The ref-based validation is done; a cleanup failure must not mask it.
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}

/**
 * Reduce a run's progress to the one decision the chain makes. An in-flight run
 * is `unfinished` even though `reduceRunOutcome` already names its running nodes
 * `parked`: only a settled, unsuccessful run parks the campaign.
 *
 * @param {RunProgress} progress
 * @returns {"succeeded"|"waiting"|"parked"|"canceled"|"unfinished"}
 */
export function classifyRunProgress(progress) {
  if (progress.runOutcome === "canceled") return "canceled";
  if (progress.runOutcome === "succeeded") return "succeeded";
  if (progress.state === "waiting") return "waiting";
  if (progress.state === "done") return "parked";
  return "unfinished";
}

/**
 * @param {string} contractPath
 * @returns {{id: string, cwd: string, runDir: string}}
 */
function runIdentityFor(contractPath) {
  const raw = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(contractPath, "utf8")));
  const cwd = resolve(dirname(contractPath), typeof raw.cwd === "string" ? raw.cwd : ".");
  const id = String(raw.id);
  return { id, cwd, runDir: join(cwd, ".runs", id) };
}

/**
 * @param {string} campaignPath
 * @returns {string}
 */
function defaultRepo(campaignPath) {
  return resolve(dirname(dirname(campaignPath)), "..");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drive a campaign's manifest to completion, watching the current run and
 * launching the next one only after the previous one succeeded and promoted.
 *
 * @param {string} campaignPath
 * @param {{
 *   repo?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   emit?: (line: string) => void,
 *   pollMs?: number,
 *   heartbeatIntervalMs?: number,
 *   allowMain?: boolean,
 *   maxTicks?: number,
 *   coordination?: boolean,
 *   controllerIdentity?: ControllerIdentity,
 *   launch?: (contractPath: string, context: {baseRef: string|undefined, controllerIdentity: ControllerIdentity, runDir: string, contract: ValidatedContract}) => Promise<void>|void,
 *   validate?: (entry: CampaignContract, context: {repo: string|undefined, baseRef: string|undefined, contractPath: string}) => ValidatedContract,
 *   progress?: (runDir: string) => RunProgress,
 *   heartbeat?: {progress: (nodeId?: string, budgetBasis?: number) => void, setActive: (nodes: {nodeId: string, budgetBasis: number}[]) => void, stop: () => void},
 *   acquire?: (campaignPath: string, options: Record<string, unknown>) => Promise<{role: "observed"|"took-over"|"became", lock: Record<string, unknown>}>,
 *   kill?: (pid: number, signal: string) => void,
 *   alive?: (pid: number) => boolean,
 *   graceMs?: number,
 *   killGraceMs?: number,
 *   pid?: number,
 *   processStartToken?: string|null,
 * }} [options]
 * @returns {Promise<{state: "done"|"parked"|"closed"|"already-running"|"stopped", ticks: number, launches: number, reason?: string, attention?: CampaignAttention|null}>}
 */
export async function driveCampaignChain(campaignPath, options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const emit = options.emit ?? ((line) => process.stdout.write(`${line}\n`));
  const repo = options.repo ?? defaultRepo(campaignPath);
  const pollMs = options.pollMs ?? DEFAULT_CHAIN_POLL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const allowMain = options.allowMain === true;
  const progressOf = options.progress ?? ((runDir) => runProgress(runDir, now()));
  const validate = options.validate ?? ((entry, context) => validateManifestEntryAtLaunch(entry, context));
  const launch = options.launch ?? (() => { throw new Error("driveCampaignChain requires a launch seam"); });

  /** @type {{role: "observed"|"took-over"|"became", lock: Record<string, unknown>}|null} */
  let acquired = null;
  if (options.coordination !== false) {
    acquired = options.acquire
      ? await options.acquire(campaignPath, /** @type {Record<string, unknown>} */ (options))
      : await acquireCoordinator(campaignPath, /** @type {Record<string, unknown>} */ (options));
    if (acquired.role === "observed") {
      emit(`[campaign] already supervised by pid ${acquired.lock.pid}; leaving it alone`);
      return { state: "already-running", ticks: 0, launches: 0 };
    }
  }
  const heartbeat = options.heartbeat ?? createHeartbeat({ runDir: campaignPath, intervalMs: heartbeatIntervalMs, now });
  try {
    let ticks = 0;
    let launches = 0;
    let index = 0;
    /** @type {ControllerIdentity} */
    let controllerIdentity = options.controllerIdentity ?? defaultControllerIdentity();
    // Validation is cached per manifest index: the landing branch does not move
    // until this contract succeeds, so re-validating against a fresh checkout
    // every poll would burn a worktree per second for no new information.
    let validatedIndex = -1;
    /** @type {ValidatedContract|null} */
    let validatedContract = null;

    /** @param {Omit<CampaignAttention, "at">} attention */
    const park = (attention) => {
      const parked = parkCampaign(campaignPath, /** @type {CampaignAttention} */ ({ ...attention, at: new Date(now()).toISOString() }));
      emit(`[campaign] ${parked.id} parked · ${attention.message}`);
      return { state: /** @type {const} */ ("parked"), ticks, launches, attention: parked.attention ?? null };
    };

    for (;;) {
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
        return { state: "stopped", ticks, launches, reason: "tick budget exhausted" };
      }
      ticks += 1;
      const campaign = readCampaign(campaignPath);
      if (campaign.status !== "active") return { state: "closed", ticks, launches, attention: campaign.attention ?? null };
      if (campaign.attention) return { state: "parked", ticks, launches, attention: campaign.attention };
      if (index >= campaign.contracts.length) return { state: "done", ticks, launches };

      const entry = campaign.contracts[index];
      const baseRef = landBranchRef(repo, campaign.landBranch);
      /** @type {string} */
      let id = entry.path;
      /** @type {string} */
      let runDir = "";
      /** @type {ValidatedContract} */
      let contract;
      try {
        const identity = runIdentityFor(entry.path);
        id = identity.id;
        runDir = identity.runDir;
        if (validatedIndex === index && validatedContract !== null) {
          contract = validatedContract;
        } else {
          contract = validate(entry, { repo, baseRef, contractPath: entry.path });
          validatedIndex = index;
          validatedContract = contract;
        }
      } catch (error) {
        const tampered = errorCode(error) === "contract_authored_bytes_changed";
        return park({
          code: tampered ? "contract_authored_bytes_changed" : "contract_validation_failed",
          message: errorMessage(error),
          contractPath: entry.path,
          contractId: id,
          runId: id,
        });
      }

      if (existsSync(join(runDir, "run.json"))) {
        const metadata = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
        const recorded = typeof metadata.contractDigest === "string" ? metadata.contractDigest : null;
        const current = contractDigest(contract);
        if (recorded !== current) {
          return park({
            code: "contract_digest_mismatch",
            message: `contract ${id} does not match the digest recorded for its run; packet hashes alone cannot prove the DAG, gate, runtime, timeout, definition of done, or finalVerification are unchanged`,
            contractPath: entry.path,
            contractId: id,
            runId: id,
          });
        }
        if (isRecord(metadata.controllerIdentity)) {
          controllerIdentity = /** @type {ControllerIdentity} */ (metadata.controllerIdentity);
        }
        const progress = progressOf(runDir);
        const classification = classifyRunProgress(progress);
        if (classification === "succeeded") {
          try {
            promoteRunInCampaign({
              campaignPath,
              repo,
              runId: id,
              baseSha: isRecord(metadata.sourceIdentity) && typeof metadata.sourceIdentity.gitHead === "string" ? metadata.sourceIdentity.gitHead : null,
              finalVerificationPassed: true,
              allowMain,
              contractPath: entry.path,
            });
          } catch (error) {
            return park({
              code: errorCode(error) ?? "promotion_failed",
              message: errorMessage(error),
              contractPath: entry.path,
              contractId: id,
              runId: id,
            });
          }
          heartbeat.progress();
          index += 1;
          continue;
        }
        if (classification === "parked" || classification === "canceled") {
          const failed = progress.outcomeNodes?.[0];
          return park({
            code: classification === "canceled" ? "run_canceled" : "run_parked",
            message: `contract ${id} run ${classification}: node ${failed?.id ?? "unknown"} ${failed?.status ?? classification}${failed?.errorCode ? ` [${failed.errorCode}]` : ""}`,
            contractPath: entry.path,
            contractId: id,
            runId: id,
            node: failed?.id ?? null,
            status: failed?.status ?? classification,
            resume: `resume ${runDir}`,
          });
        }
        // waiting / unfinished / unknown: the run resumes itself, so await it.
        // `lastProgressAt` is deliberately not refreshed: a wait is not work,
        // and a self-resuming tier exhaustion must not look like progress.
        await sleep(pollMs);
        continue;
      }

      try {
        verifyControllerIdentity(controllerIdentity);
      } catch (error) {
        return park({
          code: errorCode(error) ?? "controller_snapshot_changed",
          message: errorMessage(error),
          contractPath: entry.path,
          contractId: id,
          runId: id,
        });
      }
      try {
        await launch(entry.path, { baseRef, controllerIdentity, runDir, contract });
      } catch (error) {
        return park({
          code: errorCode(error) ?? "launch_failed",
          message: errorMessage(error),
          contractPath: entry.path,
          contractId: id,
          runId: id,
        });
      }
      heartbeat.progress();
      launches += 1;
      await sleep(pollMs);
    }
  } finally {
    heartbeat.stop();
    if (acquired) releaseCoordinatorLock(campaignPath, acquired.lock);
  }
}
