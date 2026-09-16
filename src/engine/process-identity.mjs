/**
 * Whether a recorded invocation still names the process the controller started.
 *
 * This is its own module because the two callers hold different evidence:
 * `process.mjs` owns a live `ChildProcess` and can prove a pid has not been
 * reaped, while recovery and cancel hold only a persisted record and must rely
 * on the start token. Keeping the proof here lets both ask the same question
 * without either importing the other's spawn, signal, or journal machinery.
 */
import { errorCode } from "../util.mjs";
import { processStartToken } from "../run/lock.mjs";

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {{pid: number|null, processGroupId?: number|null, processStartToken?: string|null}} InvocationProbe */

/**
 * Whether a controller may signal a pid's process group at all. It may not when
 * the pid is the calling process -- whose group is the controller's own -- or
 * its parent, whose group is the runner (or host scheduler) that spawned the
 * controller: either signal takes down the caller instead of the invocation.
 * The refusal is recorded and returned, never thrown.
 *
 * The line goes to the injected sink when a caller supplied one, otherwise to
 * stderr; this function owns no run directory and no event-log schema, so
 * stderr is the one recorder it always has. Recording is diagnostic, so a
 * failure to record must never turn the refusal into a throw.
 *
 * @param {number} pid
 * @param {((event: Record<string, unknown>) => void)|undefined} [append] injected event sink
 * @returns {boolean} true when the pid is this process or its parent and the signal was refused
 */
export function refuseSelfSignal(pid, append) {
  const relation = pid === process.pid ? "self" : pid === process.ppid ? "parent" : null;
  if (relation === null) return false;
  const event = {
    type: "controller_self_signal_refused",
    at: new Date().toISOString(),
    pid,
    processPid: process.pid,
    relation,
  };
  try {
    if (append) append(event);
    else process.stderr.write(`[warn] controller_self_signal_refused ${JSON.stringify(event)}\n`);
  } catch {
    // The refusal is diagnostic: a failed recorder must never become a throw.
  }
  return true;
}

/**
 * A process group answers a signal-0 probe. EPERM means the group exists but is
 * not this user's, which is no more "ours" than a missing group.
 *
 * @param {number|null} processGroupId
 * @returns {boolean}
 */
export function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * A recorded token is evidence only when it still names the live pid. An absent
 * token proves nothing on its own; callers that need proof use
 * {@link invocationOwned} instead.
 *
 * @param {InvocationProbe} invocation
 * @returns {boolean}
 */
export function processStartTokenMatches(invocation) {
  if (!invocation.processStartToken) return true;
  const current = processStartToken(invocation.pid);
  return current === invocation.processStartToken;
}

/**
 * The controller's proof of ownership. The leader pid must answer a signal-0
 * probe, and either a live child handle proves the pid cannot have been reaped,
 * or a recorded start token still names that pid now. EPERM is not alive-and-ours
 * -- a pid this user cannot signal is not the child this controller spawned --
 * and a null token with no handle is unverifiable, so it is never owned.
 *
 * @param {InvocationProbe} invocation
 * @param {{child?: ChildProcess|null}} [options]
 * @returns {boolean}
 */
export function invocationOwned(invocation, options = {}) {
  if (!invocation?.pid || !Number.isInteger(invocation.pid)) return false;
  // A controller does not spawn itself or its parent: a recorded pid that names
  // either can never be an invocation this controller owns, whatever token or
  // child handle accompanies it, and signalling it would hit the caller.
  if (invocation.pid === process.pid || invocation.pid === process.ppid) return false;
  try {
    process.kill(invocation.pid, 0);
  } catch {
    // ESRCH: the pid is gone. EPERM: it is alive but not ours; either way this
    // controller cannot prove it started that process.
    return false;
  }
  const child = options.child;
  if (child && child.exitCode === null && child.signalCode === null) return true;
  const token = invocation.processStartToken;
  if (!token) return false;
  return processStartToken(invocation.pid) === token;
}
