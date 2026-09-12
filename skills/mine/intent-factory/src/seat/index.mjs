/**
 * The seat facade the CLI calls: `startSeat`, `attachSeat`, `seatStatus`,
 * `stopSeat`.
 *
 * It composes the tmux session layer with the operator harness registry and
 * executes no tmux itself; every tmux fact comes back from `tmux.mjs` as an
 * explicit result. The seat is where a human talks to a harness, never the
 * engine that drives a run: nothing here writes `.runs/`, so killing a pane
 * cannot touch a run.
 */
import { resolve } from "node:path";
import { OPERATOR_HARNESSES, canRenderAmbient, detectOperatorHarness, detectOperatorHarnessByCommand } from "./harnesses.mjs";
import { SEAT_SESSION, createSeatWindow, listSeatWindows, stopSeatSession, stopSeatWindow, tmuxAvailability } from "./tmux.mjs";

/** `seat status --json` payload version. */
const SEAT_STATUS_SCHEMA_VERSION = 1;

/** @typedef {import("./tmux.mjs").SeatWindow} SeatWindow */
/** @typedef {{campaign: string, harness: string|null, canRenderAmbient: boolean, command: string|null, index: number|null}} SeatStatusEntry */
/** @typedef {{ok: boolean, available: boolean, reason: string|null, session: string, campaign: string, harness: string|null, window: string|null, command: string|null, attachCommand: string|null, stderr: string, message: string|null}} SeatStartResult */

/**
 * @param {{campaign: string, harness?: string, cwd?: string}} options
 * @returns {SeatStartResult}
 */
export function startSeat(options) {
  const campaign = options.campaign;
  if (!campaign) return startFailure("campaign_required", "", null, "a campaign id is required");
  const harness = options.harness ?? detectOperatorHarness();
  if (!harness || !Object.prototype.hasOwnProperty.call(OPERATOR_HARNESSES, harness)) {
    const known = Object.keys(OPERATOR_HARNESSES).join(", ");
    return startFailure("unknown_harness", campaign, harness ?? null, `unknown harness ${harness ?? "(none detected)"}; choose one of ${known}`);
  }
  const created = createSeatWindow({
    session: SEAT_SESSION,
    window: campaign,
    argv: OPERATOR_HARNESSES[harness].argv,
    harness,
    cwd: resolve(options.cwd ?? "."),
  });
  if (!created.ok) {
    const message = created.available
      ? `tmux could not create the seat window: ${created.reason ?? "tmux_command_failed"}`
      : "tmux is not available; cannot start the seat";
    return { ...startFailure(created.reason ?? "tmux_command_failed", campaign, harness, message), available: created.available, stderr: created.stderr };
  }
  return {
    ok: true,
    available: true,
    reason: null,
    session: SEAT_SESSION,
    campaign,
    harness,
    window: campaign,
    command: created.command,
    attachCommand: attachCommandLine(SEAT_SESSION, campaign, null),
    stderr: "",
    message: null,
  };
}

/**
 * @param {{campaign?: string, ssh?: string}} [options]
 * @returns {{ok: boolean, available: boolean, reason: string|null, command: string|null, target: string, message: string|null}}
 */
export function attachSeat(options = {}) {
  const target = options.campaign ? `${SEAT_SESSION}:${options.campaign}` : SEAT_SESSION;
  // An SSH attach runs tmux on the far side, so the local binary is irrelevant.
  if (options.ssh) {
    return { ok: true, available: true, reason: null, command: attachCommandLine(SEAT_SESSION, options.campaign ?? null, options.ssh), target, message: null };
  }
  const availability = tmuxAvailability();
  if (!availability.available) {
    return { ok: false, available: false, reason: "tmux_unavailable", command: null, target, message: "tmux is not available; cannot reattach to the seat" };
  }
  return { ok: true, available: true, reason: null, command: attachCommandLine(SEAT_SESSION, options.campaign ?? null, null), target, message: null };
}

/**
 * @returns {{schemaVersion: number, session: string, tmux: boolean, seats: SeatStatusEntry[], reason: string|null}}
 */
export function seatStatus() {
  const listed = listSeatWindows(SEAT_SESSION);
  if (!listed.available) {
    return { schemaVersion: SEAT_STATUS_SCHEMA_VERSION, session: SEAT_SESSION, tmux: false, seats: [], reason: "tmux_unavailable" };
  }
  return { schemaVersion: SEAT_STATUS_SCHEMA_VERSION, session: SEAT_SESSION, tmux: true, seats: listed.windows.map(seatEntry), reason: listed.reason };
}

/**
 * @param {{campaign?: string}} [options]
 * @returns {{ok: boolean, available: boolean, reason: string|null, stopped: "window"|"session", stderr: string}}
 */
export function stopSeat(options = {}) {
  const result = options.campaign ? stopSeatWindow(SEAT_SESSION, options.campaign) : stopSeatSession(SEAT_SESSION);
  return { ok: result.ok, available: result.available, reason: result.reason, stopped: options.campaign ? "window" : "session", stderr: result.stderr };
}

/**
 * The line to paste. `attach` must not run `tmux attach` itself: attaching
 * from a child process nests sessions. The SSH form quotes the whole remote
 * command so it survives the local shell.
 *
 * @param {string} session
 * @param {string|null} campaign
 * @param {string|null} ssh
 * @returns {string}
 */
function attachCommandLine(session, campaign, ssh) {
  const attach = `tmux attach -t ${campaign ? `${session}:${campaign}` : session}`;
  return ssh ? `ssh -t ${ssh} ${JSON.stringify(attach)}` : attach;
}

/**
 * @param {SeatWindow} window
 * @returns {SeatStatusEntry}
 */
function seatEntry(window) {
  const harness = window.harness ?? detectOperatorHarnessByCommand(window.command);
  return {
    campaign: window.window,
    harness,
    canRenderAmbient: harness ? canRenderAmbient(harness) : false,
    command: window.command,
    index: window.index,
  };
}

/**
 * @param {string} reason
 * @param {string} campaign
 * @param {string|null} harness
 * @param {string} message
 * @returns {SeatStartResult}
 */
function startFailure(reason, campaign, harness, message) {
  return {
    ok: false,
    available: reason !== "tmux_unavailable",
    reason,
    session: SEAT_SESSION,
    campaign,
    harness,
    window: null,
    command: null,
    attachCommand: null,
    stderr: "",
    message,
  };
}
