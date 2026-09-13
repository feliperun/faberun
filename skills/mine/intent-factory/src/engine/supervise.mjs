/**
 * The watchdog that keeps a run finishing when nobody is watching it.
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
 * The `launch` and `sleep` seams are injected so a test can drive the loop
 * deterministically without spawning a process or waiting out an interval.
 */
import { TERMINAL } from "./prompts.mjs";
import { lockStale, readLock } from "../run/lock.mjs";
import { listNodeSnapshots, readNodeSnapshot } from "../run/node-store.mjs";
import { delay, errorMessage } from "../util.mjs";

/** What `--interval` defaults to, in seconds: often enough that a dead controller costs a minute of wall clock, rare enough to be free. */
export const DEFAULT_SUPERVISE_INTERVAL_SEC = 30;

/** Bound on consecutive failed launches before the supervisor gives up and says why. A run that refuses to resume will refuse forever, and a loop that keeps trying hides that from the operator. */
export const MAX_CONSECUTIVE_LAUNCH_FAILURES = 3;

/**
 * @typedef {{state: "done"|"unfinished"|"unknown", total: number, terminal: number, reason?: string}} RunProgress
 */

/**
 * How far the run has got, read from the node snapshots alone. `unknown` is
 * not `unfinished`: a run directory with no snapshots yet has not proved it
 * needs resuming, and resuming it would race the controller that is about to
 * write them.
 *
 * @param {string} runDir
 * @returns {RunProgress}
 */
export function runProgress(runDir) {
  const names = listNodeSnapshots(runDir);
  if (!names.length) return { state: "unknown", total: 0, terminal: 0, reason: "no node snapshots yet" };
  let terminal = 0;
  for (const name of names) {
    let snapshot;
    try {
      snapshot = /** @type {{status?: unknown}} */ (readNodeSnapshot(runDir, name.replace(/\.json$/u, "")));
    } catch (error) {
      // A snapshot caught mid-write is not evidence either way; the next tick
      // reads a whole one.
      return { state: "unknown", total: names.length, terminal, reason: errorMessage(error) };
    }
    if (typeof snapshot?.status === "string" && TERMINAL.has(snapshot.status)) terminal += 1;
  }
  return { state: terminal === names.length ? "done" : "unfinished", total: names.length, terminal };
}

/**
 * Whether a controller is alive on this run right now. A lock whose holder
 * cannot be proven dead is a live controller, the same rule `acquire` uses:
 * launching against one would be refused anyway, and refusing here keeps the
 * supervisor from spawning a process per tick.
 *
 * @param {string} runDir
 * @returns {boolean}
 */
export function controllerAlive(runDir) {
  const lock = readLock(runDir);
  return lock !== null && !lockStale(lock);
}

/**
 * Watch one run and relaunch its controller until every node is terminal.
 *
 * @param {string} runDir
 * @param {{intervalSec?: number, launch: (runDir: string) => Promise<void>|void, sleep?: (ms: number) => Promise<void>, onTick?: (tick: {progress: RunProgress, alive: boolean, launched: boolean}) => void, maxTicks?: number}} options
 * @returns {Promise<{state: "done"|"stopped", ticks: number, launches: number, reason?: string}>}
 */
export async function superviseRun(runDir, options) {
  const intervalMs = Math.max(1, Math.round((options.intervalSec ?? DEFAULT_SUPERVISE_INTERVAL_SEC) * 1000));
  const sleep = options.sleep ?? delay;
  let ticks = 0;
  let launches = 0;
  let consecutiveFailures = 0;
  for (;;) {
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
      return { state: "stopped", ticks, launches, reason: "tick budget exhausted" };
    }
    ticks += 1;
    const progress = runProgress(runDir);
    if (progress.state === "done") {
      options.onTick?.({ progress, alive: false, launched: false });
      return { state: "done", ticks, launches };
    }
    const alive = controllerAlive(runDir);
    let launched = false;
    if (progress.state === "unfinished" && !alive) {
      try {
        await options.launch(runDir);
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
