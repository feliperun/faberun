/**
 * `seat` argv: start, attach, status, stop, switch.
 *
 * Per-operation options only, so a flag declared for one operation is rejected
 * for the others. The facade in `src/seat/index.mjs` owns the behavior; this
 * file owns the wire, the same split `campaign.mjs` uses.
 */
import { parseArgs as parseFlags } from "node:util";
import { attachSeat, seatStatus, startSeat, stopSeat, switchSeat } from "../seat/index.mjs";

/** @typedef {{cwd?: string, harness?: string, ssh?: string, json?: boolean}} SeatValues */

/** Flags are scoped to the operations that declare them; all other flags are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  start: { cwd: { type: "string" }, harness: { type: "string" } },
  attach: { cwd: { type: "string" }, ssh: { type: "string" } },
  status: { cwd: { type: "string" }, json: { type: "boolean" } },
  stop: { cwd: { type: "string" } },
  switch: { cwd: { type: "string" }, harness: { type: "string" } },
};

/**
 * @param {string[]} args
 * @returns {void}
 */
export function seatCli(args) {
  const operation = args[0];
  if (!operation || !(operation in OPERATION_OPTIONS)) return usage();
  let parsed;
  try {
    parsed = parseFlags({ args: args.slice(1), options: OPERATION_OPTIONS[operation], allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return usage();
  }
  const [campaign, ...extra] = parsed.positionals;
  const values = /** @type {SeatValues} */ (parsed.values);
  if (extra.length) return usage();
  if (operation === "status") {
    if (campaign !== undefined) return usage();
    return reportStatus(values);
  }
  if (operation === "start") {
    if (!campaign) return usage();
    return reportStart(campaign, values);
  }
  if (operation === "attach") return reportAttach(campaign, values);
  if (operation === "stop") return reportStop(campaign);
  if (operation === "switch") {
    if (!values.harness) return usage();
    return reportSwitch(campaign, values);
  }
  return usage();
}

/**
 * @param {string} campaign
 * @param {SeatValues} values
 */
function reportStart(campaign, values) {
  const result = startSeat({ campaign, harness: values.harness, cwd: values.cwd });
  if (!result.ok) {
    process.stderr.write(`[seat] ${result.message ?? result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[seat] ${campaign} started with ${result.harness} · ${result.session}:${campaign}\n`);
  process.stdout.write(`${result.attachCommand}\n`);
}

/**
 * @param {string|undefined} campaign
 * @param {SeatValues} values
 */
function reportAttach(campaign, values) {
  const result = attachSeat({ campaign, ssh: values.ssh });
  if (!result.ok) {
    process.stderr.write(`[seat] ${result.message ?? "cannot reattach to the seat"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.command}\n`);
}

/**
 * @param {SeatValues} values
 */
function reportStatus(values) {
  const status = seatStatus();
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (!status.tmux) {
    process.stdout.write("[seat] tmux is not available; no seat can be listed\n");
    return;
  }
  if (!status.seats.length) {
    process.stdout.write(`[seat] ${status.session} has no windows\n`);
    return;
  }
  for (const seat of status.seats) {
    process.stdout.write(`[seat] ${seat.campaign} · harness ${seat.harness ?? "unknown"} · ambient ${seat.canRenderAmbient ? "yes" : "no"}\n`);
  }
}

/**
 * @param {string|undefined} campaign
 */
function reportStop(campaign) {
  const result = stopSeat({ campaign });
  if (!result.ok) {
    process.stderr.write(`[seat] ${result.reason ?? "stop failed"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(campaign ? `[seat] ${campaign} stopped\n` : "[seat] seat session stopped\n");
}

/**
 * @param {string|undefined} campaign
 * @param {SeatValues} values
 */
function reportSwitch(campaign, values) {
  const result = switchSeat({ campaign, harness: values.harness, cwd: values.cwd });
  if (!result.ok) {
    process.stderr.write(`[seat] ${result.message ?? result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[seat] ${result.campaign} switched to ${result.harness} · ${result.session}:${result.window}\n`);
  process.stdout.write(`${result.attachCommand}\n`);
}

function usage() {
  process.stderr.write("usage: faberun seat <start|attach|status|stop|switch> [<campaign-id>] [--cwd <dir>] ...\n");
  process.exitCode = 2;
}
