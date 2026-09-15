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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL } from "./prompts.mjs";
import { earliestTierReset } from "./retry.mjs";
import { lockStale, pidAlive, readLock } from "../run/lock.mjs";
import { listNodeSnapshots, readNodeSnapshot } from "../run/node-store.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { delay, errorCode, errorMessage } from "../util.mjs";

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
 * @typedef {{state: "done"|"unfinished"|"waiting"|"unknown", total: number, terminal: number, reason?: string, waitingUntil?: string}} RunProgress
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
 * How far the run has got, read from the node snapshots alone. `unknown` is
 * not `unfinished`: a run directory with no snapshots yet has not proved it
 * needs resuming, and resuming it would race the controller that is about to
 * write them.
 *
 * `waiting` is the one case where a blocked node is not counted terminal: a
 * `runtime_tier_exhausted` node whose earliest recorded reset is parseable and
 * still in the future has nothing to do until that instant. A tier-exhausted
 * node with no parseable reset keeps today's terminal classification (there is
 * nothing to wait for), and one whose reset is already past is ordinary
 * `unfinished` so the retry dispatches. Whenever a run carries any node that
 * is not waiting, `unfinished` outranks `waiting` and the waiting nodes never
 * hold the run back.
 *
 * @param {string} runDir
 * @param {number} [now] epoch milliseconds, injectable so a fake clock can drive the wait
 * @returns {RunProgress}
 */
export function runProgress(runDir, now = Date.now()) {
  const names = listNodeSnapshots(runDir);
  if (!names.length) return { state: "unknown", total: 0, terminal: 0, reason: "no node snapshots yet" };
  let terminal = 0;
  let unfinished = false;
  /** @type {number|null} */
  let earliestWaiting = null;
  for (const name of names) {
    let snapshot;
    try {
      snapshot = /** @type {import("../contract/index.mjs").NodeSnapshot} */ (readNodeSnapshot(runDir, name.replace(/\.json$/u, "")));
    } catch (error) {
      // A snapshot caught mid-write is not evidence either way; the next tick
      // reads a whole one.
      return { state: "unknown", total: names.length, terminal, reason: errorMessage(error) };
    }
    const status = snapshot?.status;
    if (status === "blocked" && snapshot.error?.code === "runtime_tier_exhausted") {
      const earliest = earliestTierReset(snapshot);
      if (earliest === null) {
        // No parseable reset: nothing to wait for, so the blocked node stays
        // terminal exactly as it always has.
        terminal += 1;
      } else if (now < earliest) {
        earliestWaiting = earliestWaiting === null ? earliest : Math.min(earliestWaiting, earliest);
      } else {
        // The instant has arrived; Phase 1b's retry is due now.
        unfinished = true;
      }
      continue;
    }
    if (typeof status === "string" && TERMINAL.has(status)) terminal += 1;
    else unfinished = true;
  }
  if (terminal === names.length) return { state: "done", total: names.length, terminal };
  if (unfinished) return { state: "unfinished", total: names.length, terminal };
  return { state: "waiting", total: names.length, terminal, waitingUntil: new Date(/** @type {number} */ (earliestWaiting)).toISOString() };
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
function groupAlive(pid) {
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
async function waitForGroupGone(pid, alive, graceMs, sleep, now) {
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
 * @param {string} runDir
 * @param {{kill?: (pid: number, signal: string) => void, alive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number, graceMs?: number, killGraceMs?: number}} [options]
 * @returns {Promise<boolean>} whether a group was found and terminated
 */
export async function terminateControllerGroup(runDir, options = {}) {
  const lock = readLock(runDir);
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return false;
  const record = /** @type {import("../run/lock.mjs").LockRecord} */ (lock);
  const pid = record.pid;
  const kill = options.kill ?? ((target, signal) => {
    try {
      // The controller is normally detached, so its pid is its process group
      // id; a non-detached holder has no such group, so fall back to the pid.
      if (process.platform !== "win32") {
        try {
          process.kill(-target, signal);
          return;
        } catch (groupError) {
          if (errorCode(groupError) !== "ESRCH") throw groupError;
        }
      }
      process.kill(target, signal);
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
    }
  });
  const alive = options.alive ?? ((target) => pidAlive(target) || groupAlive(target));
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_TERMINATE_KILL_GRACE_MS;
  if (!alive(pid)) return false;
  kill(pid, "SIGTERM");
  if (await waitForGroupGone(pid, alive, graceMs, sleep, now)) return true;
  kill(pid, "SIGKILL");
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
    // A `waiting` progress reports itself only while the reset instant is in
    // the future, so the ordinary `unfinished` branch below is exactly the
    // launch that fires once the clock reaches it.
    const progress = runProgress(runDir, now());
    if (progress.state === "done") {
      options.onTick?.({ progress, alive: false, launched: false });
      return { state: "done", ticks, launches };
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
