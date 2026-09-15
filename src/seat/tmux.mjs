/**
 * The tmux half of the operator seat: one session (`faberun-seat`) with
 * one window per open campaign.
 *
 * tmux is optional by design (ADR-0033): the run engine never binds to it, so
 * every function here returns an explicit result and an absent binary becomes
 * `{available: false}` instead of a throw. That is what keeps every campaign
 * command working on a host without tmux, where only reattaching is lost.
 */
import { execFileSync } from "node:child_process";
import { errorCode, exitStatus } from "../util.mjs";

/** The single seat session every campaign window lives in. */
export const SEAT_SESSION = "faberun-seat";

/** Window option recording which harness launched the window. */
const HARNESS_OPTION = "@faberun-harness";

/** `list-windows` format: name, index, harness option, pane command, tab-separated. */
const WINDOW_FORMAT = "#{window_name}\t#{window_index}\t#{@faberun-harness}\t#{pane_current_command}";

/** Measured 2026-09-12: every seat tmux call here returns in well under a second. */
const TMUX_TIMEOUT_MS = 10_000;

/**
 * @typedef {{available: boolean, ok: boolean, status: number|null, stdout: string, stderr: string, reason: string|null}} TmuxResult
 * @typedef {{window: string, index: number|null, harness: string|null, command: string|null}} SeatWindow
 */

/**
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
 * @returns {TmuxResult}
 */
function runTmux(args, options = {}) {
  try {
    const stdout = execFileSync("tmux", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TMUX_TIMEOUT_MS,
    });
    return { available: true, ok: true, status: 0, stdout: String(stdout), stderr: "", reason: null };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { available: false, ok: false, status: null, stdout: "", stderr: "", reason: "tmux_unavailable" };
    }
    const failure = spawnFailure(error);
    return {
      available: true,
      ok: false,
      status: exitStatus(error) ?? null,
      stdout: failure.stdout,
      stderr: failure.stderr,
      reason: "tmux_command_failed",
    };
  }
}

/** @param {unknown} error @returns {{stdout: string, stderr: string}} */
function spawnFailure(error) {
  const record = /** @type {{stdout?: string|Buffer, stderr?: string|Buffer}} */ (error);
  return { stdout: textOf(record.stdout), stderr: textOf(record.stderr) };
}

/** @param {unknown} value @returns {string} */
function textOf(value) {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/**
 * @param {string} session
 * @returns {{available: boolean, exists: boolean}}
 */
function sessionExists(session) {
  const result = runTmux(["has-session", "-t", session]);
  if (!result.available) return { available: false, exists: false };
  return { available: true, exists: result.ok };
}

/**
 * Create the seat window for one campaign, creating the session on the first
 * window. The harness argv is quoted into the single shell-command tmux takes;
 * the harness name is recorded as a window option so status can name it even
 * after the pane's foreground command changes.
 *
 * @param {{session: string, window: string, argv: readonly string[], harness: string, cwd: string}} options
 * @returns {{available: boolean, ok: boolean, created: boolean, session: string, window: string, command: string|null, reason: string|null, stderr: string}}
 */
export function createSeatWindow(options) {
  const existing = sessionExists(options.session);
  if (!existing.available) {
    return { available: false, ok: false, created: false, session: options.session, window: options.window, command: null, reason: "tmux_unavailable", stderr: "" };
  }
  const command = shellCommand(options.argv);
  const args = existing.exists
    ? ["new-window", "-t", options.session, "-n", options.window, "-c", options.cwd, command]
    : ["new-session", "-d", "-s", options.session, "-n", options.window, "-c", options.cwd, command];
  const result = runTmux(args);
  if (!result.ok) {
    return { available: result.available, ok: false, created: false, session: options.session, window: options.window, command, reason: result.reason, stderr: result.stderr };
  }
  runTmux(["set-option", "-w", "-t", `${options.session}:${options.window}`, HARNESS_OPTION, options.harness]);
  return { available: true, ok: true, created: true, session: options.session, window: options.window, command, reason: null, stderr: "" };
}

/** @param {readonly string[]} argv @returns {string} */
function shellCommand(argv) {
  return argv
    .map((argument) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument) ? argument : `'${argument.replace(/'/gu, "'\\''")}'`))
    .join(" ");
}

/**
 * Replace the process in an existing seat window with a new harness, keeping
 * the window, its name and its index. `respawn-window -k` is the kill and the
 * launch in one tmux verb; the caller materializes the brief before calling,
 * so a failed brief never tears down a working pane.
 *
 * @param {{session: string, window: string, argv: readonly string[], harness: string, cwd: string}} options
 * @returns {{available: boolean, ok: boolean, respawned: boolean, session: string, window: string, command: string|null, reason: string|null, stderr: string}}
 */
export function respawnSeatWindow(options) {
  const command = shellCommand(options.argv);
  const result = runTmux(["respawn-window", "-k", "-t", `${options.session}:${options.window}`, "-c", options.cwd, command]);
  if (!result.ok) {
    return { available: result.available, ok: false, respawned: false, session: options.session, window: options.window, command, reason: result.reason, stderr: result.stderr };
  }
  runTmux(["set-option", "-w", "-t", `${options.session}:${options.window}`, HARNESS_OPTION, options.harness]);
  return { available: true, ok: true, respawned: true, session: options.session, window: options.window, command, reason: null, stderr: "" };
}

/**
 * @param {string} session
 * @returns {{available: boolean, windows: SeatWindow[], reason: string|null, stderr: string}}
 */
export function listSeatWindows(session) {
  const result = runTmux(["list-windows", "-t", session, "-F", WINDOW_FORMAT]);
  if (!result.available) return { available: false, windows: [], reason: "tmux_unavailable", stderr: "" };
  if (!result.ok) {
    return { available: true, windows: [], reason: result.status === 1 ? "no_session" : "tmux_command_failed", stderr: result.stderr };
  }
  const windows = result.stdout.split("\n").map(parseWindowLine).filter((window) => window !== null);
  return { available: true, windows, reason: null, stderr: "" };
}

/**
 * @param {string} line
 * @returns {SeatWindow|null}
 */
function parseWindowLine(line) {
  if (!line.trim()) return null;
  const [name, index, harness, command] = line.split("\t");
  if (!name) return null;
  const parsed = Number.parseInt(index ?? "", 10);
  return {
    window: name,
    index: Number.isFinite(parsed) ? parsed : null,
    harness: harness ? harness : null,
    command: command ? command : null,
  };
}

/**
 * @returns {{available: boolean, version: string|null, reason: string|null}}
 */
export function tmuxAvailability() {
  const result = runTmux(["-V"]);
  return {
    available: result.available,
    version: result.ok && result.stdout.trim() ? result.stdout.trim() : null,
    reason: result.reason,
  };
}

/**
 * @param {string} session
 * @param {string} window
 * @returns {{available: boolean, ok: boolean, reason: string|null, stderr: string}}
 */
export function stopSeatWindow(session, window) {
  return stopTmux(["kill-window", "-t", `${session}:${window}`], "window");
}

/**
 * @param {string} session
 * @returns {{available: boolean, ok: boolean, reason: string|null, stderr: string}}
 */
export function stopSeatSession(session) {
  return stopTmux(["kill-session", "-t", session], "session");
}

/**
 * tmux exits 1 when the target is already gone. That is idempotent success for
 * a stop, not a failure: stopping the last window takes the session with it.
 *
 * @param {string[]} args
 * @param {"window"|"session"} label
 * @returns {{available: boolean, ok: boolean, reason: string|null, stderr: string}}
 */
function stopTmux(args, label) {
  const result = runTmux(args);
  if (result.available && !result.ok && result.status === 1) {
    return { available: true, ok: true, reason: `no_${label}`, stderr: result.stderr };
  }
  return { available: result.available, ok: result.ok, reason: result.reason, stderr: result.stderr };
}
