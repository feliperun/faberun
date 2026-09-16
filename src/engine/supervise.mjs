/**
 * The watchdog that keeps a run finishing when nobody is watching it, and the
 * heartbeat record it reads.
 *
 * `resume` takes over a run once. That is enough when a human is at the
 * keyboard and enough for one crash; it is not enough for the case this
 * factory exists for, which is a campaign running for hours from a host
 * scheduler while the operator is asleep. A controller that dies at 02:00
 * leaves the run parked until someone types `resume` — and every node still
 * pending is wall clock that buys nothing.
 *
 * So this loop owns nothing. It never takes the controller lock, never writes
 * run state, and never touches a worktree: it watches, and when the run is
 * unfinished with no live controller, it launches one exactly the way an
 * operator would. Keeping it outside the lock is the whole point — a
 * supervisor that became the controller would die with it, and a supervisor
 * that wrote state would be a second writer racing the one that exists.
 *
 * The heartbeat is the two-question split the watchdog needs. `at` is written
 * by an unref'd timer and answers "is the loop process alive"; the loop body
 * never writes it, because the loop awaits verification on its own critical
 * path and a single field would stop during a legitimate 600s verification
 * and kill a healthy controller. `lastProgressAt` is written by the loop on a
 * node state transition or provider output and answers "is work advancing";
 * a child that never closes keeps the process alive while work stops, so the
 * timer stays fresh and progress goes stale. `activeNodes` is per node, each
 * carrying its own last-progress instant and its own derived budget, because a
 * healthy sibling refreshing a single global timestamp would keep a run-level
 * maximum unbreached forever and a frozen node would never be caught.
 *
 * The `launch` and `sleep` seams are injected so a test can drive the loop
 * deterministically without spawning a process or waiting out an interval.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTLED, SUCCESS } from "./prompts.mjs";
import { invocationOwned } from "./process-identity.mjs";
import { earliestTierReset } from "./retry.mjs";
import { lockStale, pidAlive, readLock } from "../run/lock.mjs";
import { listNodeSnapshots, readNodeSnapshot } from "../run/node-store.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { delay, errorCode, errorMessage } from "../util.mjs";
import { loadPersistedContract } from "../contract/index.mjs";
import { emitScheduledAttention } from "./notify-queue.mjs";

/** What `--interval` defaults to, in seconds: often enough that a dead controller costs a minute of wall clock, rare enough to be free. */
export const DEFAULT_SUPERVISE_INTERVAL_SEC = 30;

/** Bound on consecutive failed launches before the supervisor gives up and says why. A run that refuses to resume will refuse forever, and a loop that keeps trying hides that from the operator. */
export const MAX_CONSECUTIVE_LAUNCH_FAILURES = 3;

/**
 * How many times the supervisor will relaunch a run whose `lastProgressAt`
 * never moves before it parks the run instead of killing a third controller.
 * Two is deliberate: one relaunch can be a transient provider death, two is a
 * controller that dies without making progress, and a third kill would only
 * repeat the second.
 */
export const MAX_CONSECUTIVE_RELAUNCHES = 2;

/** The controller heartbeat's file name inside the run directory. */
export const HEARTBEAT_FILE = "heartbeat.json";

/**
 * The interval the controller's unref'd `at` timer beats at, and therefore the
 * half of the `2 x interval` staleness threshold. Fifteen seconds is often
 * enough that a frozen controller is noticed within half a minute and rare
 * enough that the write is free next to a poll loop.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Extra time a `phase: "recovering"` controller is allowed past the orphan
 * invocation's own deadline before the supervisor treats it as dead. The
 * adoption busy-wait is already bounded by that deadline; the grace only
 * covers the write and the read around it.
 */
export const RECOVERING_GRACE_MS = 30_000;

/** How long a breached controller group gets to honour `SIGTERM` before the supervisor escalates. */
export const DEFAULT_TERMINATE_GRACE_MS = 5_000;

/** How long the group gets after `SIGKILL` before the supervisor stops waiting; the lock is taken only once it is gone. */
export const DEFAULT_TERMINATE_KILL_GRACE_MS = 5_000;

/**
 * @typedef {{state: "done"|"unfinished"|"waiting"|"unknown", total: number, terminal: number, reason?: string, waitingUntil?: string, runOutcome?: "succeeded"|"parked"|"waiting"|"canceled", outcomeNodes?: OutcomeNode[]}} RunProgress
 * @typedef {{id: string, status?: string, errorCode?: string|null, message?: string, waitingUntil?: string}} OutcomeNode
 * @typedef {{nodeId: string, lastProgressAt: string, budgetBasis: number}} HeartbeatNode
 * @typedef {{at: string, lastProgressAt: string, iteration: number, activeNodes: HeartbeatNode[], phase?: string, until?: string}} HeartbeatRecord
 * @typedef {{kind: "at"|"node"|"recovering", nodeId?: string, ageMs?: number, budgetBasis?: number, until?: string}} HeartbeatBreach
 */

/** @param {string} runDir @returns {string} */
export function heartbeatPath(runDir) {
  return join(runDir, HEARTBEAT_FILE);
}

/**
 * Read the heartbeat, treating a missing or torn file as no evidence. The
 * supervisor must not mistake a write in progress for a dead controller: the
 * next tick reads a whole file.
 *
 * @param {string} runDir
 * @returns {HeartbeatRecord|null}
 */
export function readHeartbeat(runDir) {
  let text;
  try {
    text = readFileSync(heartbeatPath(runDir), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? /** @type {HeartbeatRecord} */ (parsed) : null;
  } catch {
    // A heartbeat caught mid-write is not evidence either way; the next tick reads a whole one.
    return null;
  }
}

/**
 * @param {string} runDir
 * @param {HeartbeatRecord} record
 */
export function writeHeartbeat(runDir, record) {
  writeJsonAtomic(heartbeatPath(runDir), record);
}

/**
 * The controller-side heartbeat writer. `at` is owned by the injected timer and
 * is never written by the caller's loop; `lastProgressAt` and `activeNodes` are
 * owned by the loop. Construction preserves an existing `lastProgressAt`
 * instead of resetting it to now, so a relaunched controller that immediately
 * freezes leaves the value flat and the supervisor's no-progress guard can see
 * it. The timer is unref'd so it can never hold the controller process open.
 *
 * @param {{runDir: string, intervalMs?: number, now?: () => number, setIntervalFn?: (fn: () => void, ms: number) => unknown, clearIntervalFn?: (timer: unknown) => void}} options
 * @returns {{write: () => void, progress: (nodeId?: string, budgetBasis?: number) => void, setActive: (nodes: {nodeId: string, budgetBasis: number}[]) => void, snapshot: () => HeartbeatRecord, stop: () => void}}
 */
export function createHeartbeat(options) {
  const { runDir } = options;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(/** @type {NodeJS.Timeout} */ (timer)));
  const previous = readHeartbeat(runDir);
  const startedAt = new Date(now()).toISOString();
  let lastProgressAt = typeof previous?.lastProgressAt === "string" ? previous.lastProgressAt : startedAt;
  let iteration = 0;
  /** @type {Map<string, {lastProgressAt: string, budgetBasis: number}>} */
  const activeNodes = new Map();

  /** @returns {HeartbeatRecord} */
  const snapshot = () => ({
    at: new Date(now()).toISOString(),
    lastProgressAt,
    iteration,
    activeNodes: [...activeNodes.entries()].map(([nodeId, value]) => ({ nodeId, lastProgressAt: value.lastProgressAt, budgetBasis: value.budgetBasis })),
  });
  let stopped = false;
  const write = () => {
    if (!stopped) writeHeartbeat(runDir, snapshot());
  };
  const timer = setIntervalFn(write, intervalMs);
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
  write();
  return {
    write,
    progress(nodeId, budgetBasis) {
      iteration += 1;
      lastProgressAt = new Date(now()).toISOString();
      if (typeof nodeId === "string") {
        const existing = activeNodes.get(nodeId);
        activeNodes.set(nodeId, { lastProgressAt, budgetBasis: budgetBasis ?? existing?.budgetBasis ?? 0 });
      }
      write();
    },
    setActive(nodes) {
      const keep = new Set(nodes.map((node) => node.nodeId));
      for (const nodeId of [...activeNodes.keys()]) if (!keep.has(nodeId)) activeNodes.delete(nodeId);
      const at = new Date(now()).toISOString();
      for (const node of nodes) {
        const existing = activeNodes.get(node.nodeId);
        if (!existing || existing.budgetBasis !== node.budgetBasis) {
          activeNodes.set(node.nodeId, { lastProgressAt: existing?.lastProgressAt ?? at, budgetBasis: node.budgetBasis });
        }
      }
      write();
    },
    snapshot,
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

/**
 * The recovery phase a `resume` enters while it busy-waits for an orphan. The
 * poll refreshes `at` so a frozen resume is still caught by the timer
 * threshold, but it must never touch `lastProgressAt`: an orphan that is alive
 * but never advancing would otherwise look like perpetual progress. The bound
 * is the orphan invocation's own deadline, which the supervisor widens by the
 * named recovering grace.
 *
 * @param {string} runDir
 * @param {string} until the orphan invocation's own deadlineAt
 * @param {string} [at] the poll's instant, injectable for a fake clock
 */
export function markRecovering(runDir, until, at = new Date().toISOString()) {
  const previous = readHeartbeat(runDir);
  writeHeartbeat(runDir, {
    at,
    lastProgressAt: typeof previous?.lastProgressAt === "string" ? previous.lastProgressAt : at,
    iteration: typeof previous?.iteration === "number" ? previous.iteration : 0,
    activeNodes: Array.isArray(previous?.activeNodes) ? previous.activeNodes : [],
    phase: "recovering",
    until,
  });
}

/**
 * Which heartbeat threshold, if any, this record breaches. `at` staleness is
 * the frozen-process signal and applies during recovery too; otherwise a
 * `recovering` record is judged only against `until + grace`, never against
 * `lastProgressAt`; and any active node whose own last-progress instant is
 * older than its own budget is a breach even while the global timestamp is
 * fresh.
 *
 * @param {HeartbeatRecord|null|undefined} heartbeat
 * @param {number} now epoch milliseconds
 * @param {number} [intervalMs]
 * @returns {HeartbeatBreach|null}
 */
export function heartbeatBreach(heartbeat, now, intervalMs = HEARTBEAT_INTERVAL_MS) {
  if (!heartbeat) return null;
  const at = Date.parse(typeof heartbeat.at === "string" ? heartbeat.at : "");
  if (Number.isFinite(at) && now - at > 2 * intervalMs) return { kind: "at", ageMs: now - at };
  if (heartbeat.phase === "recovering") {
    const until = Date.parse(typeof heartbeat.until === "string" ? heartbeat.until : "");
    if (Number.isFinite(until) && now > until + RECOVERING_GRACE_MS) return { kind: "recovering", until: heartbeat.until };
    return null;
  }
  for (const node of Array.isArray(heartbeat.activeNodes) ? heartbeat.activeNodes : []) {
    const last = Date.parse(typeof node.lastProgressAt === "string" ? node.lastProgressAt : "");
    const budget = Number(node.budgetBasis);
    if (Number.isFinite(last) && Number.isFinite(budget) && now - last > budget) {
      return { kind: "node", nodeId: node.nodeId, ageMs: now - last, budgetBasis: budget };
    }
  }
  return null;
}

/**
 * The run's declared contract, loaded as a persisted replay: the node set the
 * reduction must answer against, never whatever snapshots happen to exist. A
 * missing or unreadable contract is no evidence, so `null` falls back to the
 * snapshots alone.
 *
 * @param {string} runDir
 * @returns {import("../contract/index.mjs").ValidatedContract|null}
 */
export function readRunContract(runDir) {
  try {
    let digest;
    try {
      const metadata = readJson(join(runDir, "run.json"));
      digest = typeof metadata.contractDigest === "string" ? metadata.contractDigest : undefined;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return null;
    }
    return loadPersistedContract(join(runDir, "contract.json"), digest);
  } catch (error) {
    return null;
  }
}

/**
 * Reduce the declared node set to a run outcome. Pure over the declared ids and
 * a snapshot map, so the empty-input invariant is a unit claim and the sparse
 * case cannot be faked by whatever snapshots exist.
 *
 * `succeeded` needs a readable snapshot for every declared node, each in
 * `{done, no-op}`. `canceled` comes from the durable run-level marker, never
 * from a node status. `waiting` is the single case where a parked-shaped node
 * is not parked: a `blocked`/`runtime_tier_exhausted` node whose recorded reset
 * is still in the future. Everything else is `parked`, naming each non-success
 * node; a missing or unreadable snapshot is named, never dropped.
 *
 * @param {string[]} declaredIds
 * @param {Map<string, import("../contract/index.mjs").NodeSnapshot|{unreadable: string}>} snapshots
 * @param {{canceled?: boolean, now?: number}} [options]
 * @returns {{outcome: "succeeded"|"parked"|"waiting"|"canceled", nodes: OutcomeNode[], waitingUntil?: string}}
 */
export function reduceRunOutcome(declaredIds, snapshots, options = {}) {
  if (options.canceled) return { outcome: "canceled", nodes: [] };
  const now = options.now ?? Date.now();
  /** @type {OutcomeNode[]} */
  const nonSuccess = [];
  /** @type {number|null} */
  let earliestWaiting = null;
  let allWaiting = true;
  for (const id of declaredIds) {
    const snapshot = snapshots.get(id);
    if (!snapshot) {
      nonSuccess.push({ id, status: "missing" });
      allWaiting = false;
      continue;
    }
    if ("unreadable" in snapshot) {
      nonSuccess.push({ id, status: "unreadable", message: snapshot.unreadable });
      allWaiting = false;
      continue;
    }
    const status = snapshot.status;
    if (SUCCESS.has(status)) continue;
    if (status === "blocked" && snapshot.error?.code === "runtime_tier_exhausted") {
      const earliest = earliestTierReset(snapshot);
      if (earliest !== null) {
        // A tier-exhausted node is waiting, never parked: the provider named a
        // reset, and the retry dispatches at that instant (or is due now).
        const waiting = now < earliest;
        if (waiting) earliestWaiting = earliestWaiting === null ? earliest : Math.min(earliestWaiting, earliest);
        nonSuccess.push({
          id,
          status,
          errorCode: snapshot.error.code,
          ...(waiting ? { waitingUntil: new Date(earliest).toISOString() } : {}),
        });
        continue;
      }
    }
    nonSuccess.push({ id, status, errorCode: snapshot.error?.code ?? null });
    allWaiting = false;
  }
  if (nonSuccess.length === 0) {
    // The empty declared set never reaches `succeeded`: "every node succeeded"
    // is vacuous there and validation owns rejecting the empty contract.
    return { outcome: declaredIds.length === 0 ? "parked" : "succeeded", nodes: [] };
  }
  if (allWaiting) {
    return {
      outcome: "waiting",
      nodes: nonSuccess,
      ...(earliestWaiting !== null ? { waitingUntil: new Date(earliestWaiting).toISOString() } : {}),
    };
  }
  return { outcome: "parked", nodes: nonSuccess };
}

/**
 * How far the run has got, read from the node snapshots and the declared node
 * set. `unknown` is not `unfinished`: a run directory with no snapshots yet has
 * not proved it needs resuming, and resuming it would race the controller that
 * is about to write them. A torn snapshot is `unknown` for the same reason.
 *
 * `waiting` is the one case where a blocked node is not counted settled: a
 * `runtime_tier_exhausted` node whose earliest recorded reset is parseable and
 * still in the future has nothing to do until that instant. A tier-exhausted
 * node with no parseable reset keeps today's settled classification (there is
 * nothing to wait for), and one whose reset is already past is ordinary
 * `unfinished` so the retry dispatches. Whenever a run carries any node that is
 * not waiting, `unfinished` outranks `waiting` and the waiting nodes never hold
 * the run back.
 *
 * `state` says whether anything can still move; `runOutcome` says what the
 * settled result is. A parked node is settled but not successful, so the
 * watchdog must keep watching it rather than report the run done.
 *
 * @param {string} runDir
 * @param {number} [now] epoch milliseconds, injectable so a fake clock can drive the wait
 * @returns {RunProgress}
 */
export function runProgress(runDir, now = Date.now()) {
  const names = listNodeSnapshots(runDir);
  if (!names.length) return { state: "unknown", total: 0, terminal: 0, reason: "no node snapshots yet" };
  /** @type {Map<string, import("../contract/index.mjs").NodeSnapshot|{unreadable: string}>} */
  const snapshots = new Map();
  let unreadable = false;
  for (const name of names) {
    const id = name.replace(/\.json$/u, "");
    try {
      const snapshot = /** @type {import("../contract/index.mjs").NodeSnapshot} */ (readNodeSnapshot(runDir, id));
      snapshots.set(snapshot?.id ?? id, snapshot);
    } catch (error) {
      // A snapshot caught mid-write is not evidence either way; the next tick
      // reads a whole one, and the reduction names it rather than dropping it.
      snapshots.set(id, { unreadable: errorMessage(error) });
      unreadable = true;
    }
  }
  const contract = readRunContract(runDir);
  const declared = contract ? contract.nodes.map((node) => node.id) : [...snapshots.keys()];
  let terminal = 0;
  let unfinished = false;
  /** @type {number|null} */
  let earliestWaiting = null;
  for (const id of declared) {
    const snapshot = snapshots.get(id);
    if (!snapshot || "unreadable" in snapshot) {
      unfinished = true;
      continue;
    }
    const status = snapshot.status;
    if (status === "blocked" && snapshot.error?.code === "runtime_tier_exhausted") {
      const earliest = earliestTierReset(snapshot);
      if (earliest === null) {
        // No parseable reset: nothing to wait for, so the blocked node stays
        // settled exactly as it always has.
        terminal += 1;
      } else if (now < earliest) {
        earliestWaiting = earliestWaiting === null ? earliest : Math.min(earliestWaiting, earliest);
      } else {
        // The instant has arrived; Phase 1b's retry is due now.
        unfinished = true;
      }
      continue;
    }
    if (typeof status === "string" && SETTLED.has(status)) terminal += 1;
    else unfinished = true;
  }
  const canceled = existsSync(join(runDir, "cancel.request.json"));
  const reduction = reduceRunOutcome(declared, snapshots, { canceled, now });
  /** @type {"done"|"unfinished"|"waiting"|"unknown"} */
  let state;
  if (unreadable) state = "unknown";
  else if (terminal === declared.length) state = "done";
  else if (unfinished) state = "unfinished";
  else state = "waiting";
  return {
    state,
    total: declared.length,
    terminal,
    ...(state === "unknown" ? { reason: "a node snapshot could not be read" } : {}),
    ...(state === "waiting" && earliestWaiting !== null ? { waitingUntil: new Date(earliestWaiting).toISOString() } : {}),
    runOutcome: reduction.outcome,
    outcomeNodes: reduction.nodes,
  };
}

/**
 * Whether a controller is alive on this run right now. A lock whose holder
 * cannot be proven dead is a live controller, the same rule `acquire` uses:
 * launching against one would be refused anyway, and refusing here keeps the
 * supervisor from spawning a process per tick. A live lock is no longer
 * sufficient on its own: a heartbeat that breaches either threshold is a
 * controller the supervisor may kill, because a frozen process holds its lock
 * open forever.
 *
 * @param {string} runDir
 * @param {{now?: number, heartbeatIntervalMs?: number}} [options]
 * @returns {boolean}
 */
export function controllerAlive(runDir, options = {}) {
  const lock = readLock(runDir);
  if (lock === null || lockStale(lock)) return false;
  const breach = heartbeatBreach(readHeartbeat(runDir), options.now ?? Date.now(), options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  return breach === null;
}

/**
 * Whether a pid's process group is still visible. The controller is spawned
 * detached, so its pid is its process group id and the group is what must be
 * gone before the lock is taken.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function groupAlive(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * @param {number} pid @param {(pid: number) => boolean} alive @param {number} graceMs @param {(ms: number) => Promise<void>} sleep @param {() => number} now
 * @returns {Promise<boolean>}
 */
export async function waitForGroupGone(pid, alive, graceMs, sleep, now) {
  const deadline = now() + graceMs;
  while (alive(pid) && now() < deadline) await sleep(Math.max(1, Math.min(250, deadline - now())));
  return !alive(pid);
}

/**
 * Terminate the controller's process group, bounded: `SIGTERM`, then `SIGKILL`
 * after the named grace, waiting for the group to disappear after each. The
 * caller relaunches only once this resolves, so the lock is taken only after
 * the previous holder is gone. The kill and liveness probes are injectable so
 * a test can prove the ordering without signalling a real process.
 *
 * A lock is a claim until it is proven, exactly as the engine proves one: the
 * signal goes out only after `invocationOwned` confirms the pid still answers
 * a signal-0 probe and still carries the token the holder recorded. A recycled
 * pid is never signalled, and a lock that recorded no token is unverifiable --
 * the function returns false and the caller's takeover path handles whatever is
 * left, as it would a dead controller. EPERM is not ownership and not a failure
 * to surface: like ESRCH it means gone-or-not-ours and never escapes.
 *
 * @param {string} runDir
 * @param {{kill?: (pid: number, signal: string) => void, alive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number, graceMs?: number, killGraceMs?: number}} [options]
 * @returns {Promise<boolean>} whether a verified group was found and terminated
 */
export async function terminateControllerGroup(runDir, options = {}) {
  const lock = readLock(runDir);
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return false;
  const record = /** @type {import("../run/lock.mjs").LockRecord} */ (lock);
  const pid = record.pid;
  if (!invocationOwned({ pid, processGroupId: pid, processStartToken: record.processStartToken })) return false;
  const kill = options.kill ?? ((target, signal) => {
    try {
      // The controller is normally detached, so its pid is its process group
      // id; a non-detached holder has no such group, so fall back to the pid.
      // A group that is gone or not ours falls through to the pid probe.
      if (process.platform !== "win32") {
        try {
          process.kill(-target, signal);
          return;
        } catch (groupError) {
          if (errorCode(groupError) !== "ESRCH" && errorCode(groupError) !== "EPERM") throw groupError;
        }
      }
      process.kill(target, signal);
    } catch (error) {
      if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") throw error;
    }
  });
  const alive = options.alive ?? ((target) => pidAlive(target) || groupAlive(target));
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_TERMINATE_KILL_GRACE_MS;
  if (!alive(pid)) return false;
  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") return false;
    throw error;
  }
  if (await waitForGroupGone(pid, alive, graceMs, sleep, now)) return true;
  try {
    kill(pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") return false;
    throw error;
  }
  await waitForGroupGone(pid, alive, killGraceMs, sleep, now);
  return true;
}

/**
 * @param {string} runDir
 * @returns {Record<string, unknown>}
 */
function readRunMetadata(runDir) {
  try {
    return readJson(join(runDir, "run.json"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
}

/**
 * @param {string} runDir @param {Record<string, unknown>} metadata
 */
function writeRunMetadata(runDir, metadata) {
  writeJsonAtomic(join(runDir, "run.json"), metadata);
}

/**
 * Decide whether the next breach is a relaunch or the park that replaces a
 * third kill. The comparison is against the `lastProgressAt` recorded at the
 * previous relaunch: a value that moved means the relaunched controller did
 * make progress and the counter resets; a value that did not means this is
 * another no-progress dispatch and the counter grows. The counter lives in
 * `run.json` so a restarted supervisor reads the same number.
 *
 * @param {string} runDir
 * @param {HeartbeatRecord|null} heartbeat
 * @returns {{parked: boolean, message: string, count: number, lastProgressAt: string|null, metadata: Record<string, unknown>}}
 */
function nextRelaunch(runDir, heartbeat) {
  const metadata = readRunMetadata(runDir);
  const progressAt = typeof heartbeat?.lastProgressAt === "string" ? heartbeat.lastProgressAt : null;
  const recorded = typeof metadata.lastRelaunchProgressAt === "string" ? metadata.lastRelaunchProgressAt : null;
  const advanced = progressAt !== null && recorded !== null && Date.parse(progressAt) > Date.parse(recorded);
  const count = advanced ? 0 : (Number.isInteger(metadata.relaunchCount) ? Number(metadata.relaunchCount) : 0);
  if (count >= MAX_CONSECUTIVE_RELAUNCHES) {
    return {
      parked: true,
      message: `controller relaunched ${count} times without lastProgressAt advancing`,
      count,
      lastProgressAt: progressAt,
      metadata,
    };
  }
  return { parked: false, message: "", count: count + 1, lastProgressAt: progressAt, metadata };
}

/**
 * @param {string} runDir @param {{count: number, lastProgressAt: string|null, metadata: Record<string, unknown>}} decision
 */
function persistRelaunch(runDir, decision) {
  writeRunMetadata(runDir, {
    ...decision.metadata,
    relaunchCount: decision.count,
    lastRelaunchProgressAt: decision.lastProgressAt,
  });
}

/**
 * Record the durable park and its attention code. This is the run's
 * `attention` record, written where a supervisor restart will still read it.
 *
 * @param {string} runDir @param {string} code @param {string} message @param {string} at
 */
function parkRun(runDir, code, message, at) {
  const metadata = readRunMetadata(runDir);
  writeRunMetadata(runDir, { ...metadata, attention: { code, message, at } });
}

/**
 * Report a parked run without returning: anchor its durable attention record
 * the first time it is seen parked, then re-emit the schedule slot the clock
 * has reached. The anchor lives in run.json, so a supervisor restart reads the
 * same interval; the slot lives in the notify receipt log, so a restart does
 * not re-announce a slot already sent. A resume that changes node state clears
 * the anchor, which is what starts a fresh interval.
 *
 * @param {string} runDir @param {RunProgress} progress @param {number} now
 */
async function reportParkedAttention(runDir, progress, now) {
  const metadata = readRunMetadata(runDir);
  const first = progress.outcomeNodes?.[0];
  const existing = metadata.attention && typeof metadata.attention === "object" ? /** @type {{code: string, message: string, at: string}} */ (metadata.attention) : null;
  const attention = existing ?? {
    code: first?.errorCode ?? first?.status ?? "parked",
    message: `run parked: ${(progress.outcomeNodes ?? []).map((node) => `${node.id}:${node.status ?? "unknown"}`).join(", ") || "no nodes named"}`,
    at: new Date(now).toISOString(),
  };
  if (!existing) writeRunMetadata(runDir, { ...metadata, attention });
  await emitScheduledAttention(runDir, { anchor: attention.at, code: attention.code, now });
}

/**
 * Watch one run and relaunch its controller until every node is terminal.
 *
 * @param {string} runDir
 * @param {{intervalSec?: number, heartbeatIntervalMs?: number, launch: (runDir: string) => Promise<void>|void, sleep?: (ms: number) => Promise<void>, now?: () => number, onTick?: (tick: {progress: RunProgress, alive: boolean, launched: boolean}) => void, maxTicks?: number, terminate?: (runDir: string, breach: HeartbeatBreach) => Promise<void>|void, kill?: (pid: number, signal: string) => void, alive?: (pid: number) => boolean, graceMs?: number, killGraceMs?: number}} options
 * @returns {Promise<{state: "done"|"stopped", ticks: number, launches: number, reason?: string}>}
 */
export async function superviseRun(runDir, options) {
  const intervalMs = Math.max(1, Math.round((options.intervalSec ?? DEFAULT_SUPERVISE_INTERVAL_SEC) * 1000));
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const terminate = options.terminate ?? ((target, breach) => terminateControllerGroup(target, {
    sleep,
    now,
    graceMs: options.graceMs,
    killGraceMs: options.killGraceMs,
    kill: options.kill,
    alive: options.alive,
  }));
  let ticks = 0;
  let launches = 0;
  let consecutiveFailures = 0;
  for (;;) {
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
      return { state: "stopped", ticks, launches, reason: "tick budget exhausted" };
    }
    ticks += 1;
    // A succeeded or canceled run is finished. A parked run is not: every node
    // has stopped but the outcome needs attention, so it is announced and the
    // loop keeps watching instead of returning as a finished one.
    const progress = runProgress(runDir, now());
    if (progress.runOutcome === "succeeded" || progress.runOutcome === "canceled") {
      options.onTick?.({ progress, alive: false, launched: false });
      return { state: "done", ticks, launches };
    }
    if (progress.state === "done" && progress.runOutcome === "parked") {
      await reportParkedAttention(runDir, progress, now());
      options.onTick?.({ progress, alive: false, launched: false });
      await sleep(intervalMs);
      continue;
    }
    const lock = readLock(runDir);
    const lockAlive = lock !== null && !lockStale(lock);
    const heartbeat = readHeartbeat(runDir);
    // A breach on a live lock is a dead controller the lock cannot see: it is
    // killed before the relaunch; a dead lock needs no kill.
    const breach = lockAlive ? heartbeatBreach(heartbeat, now(), heartbeatIntervalMs) : null;
    const alive = lockAlive && breach === null;
    let launched = false;
    // A breach is a frozen controller and is relaunched even while the run is
    // `waiting` on a tier reset: the holder is not merely idle, it is dead and
    // would never dispatch the retry at the reset instant. A dead lock with no
    // breach still holds a waiting run until the instant arrives.
    if ((progress.state === "unfinished" || breach !== null) && !alive) {
      const decision = nextRelaunch(runDir, heartbeat);
      if (decision.parked) {
        parkRun(runDir, "controller_unresponsive", decision.message, new Date(now()).toISOString());
        options.onTick?.({ progress, alive, launched: false });
        return { state: "stopped", ticks, launches, reason: "controller_unresponsive" };
      }
      try {
        if (breach && lockAlive) await terminate(runDir, breach);
        await options.launch(runDir);
        // Persist only a successful relaunch: a launch that threw is counted
        // by the failure guard below, not by the no-progress guard.
        persistRelaunch(runDir, decision);
        launched = true;
        launches += 1;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_LAUNCH_FAILURES) {
          options.onTick?.({ progress, alive, launched: false });
          return { state: "stopped", ticks, launches, reason: `resume failed ${consecutiveFailures} times: ${errorMessage(error)}` };
        }
      }
    }
    options.onTick?.({ progress, alive, launched });
    await sleep(intervalMs);
  }
}
