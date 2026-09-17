/**
 * Owns sampling the seat's allowance -- a coarse, harness-reported rate-limit
 * signal -- from one minimal live invocation, and the delta between two
 * samples. Separate from every other file in `seat/` because this is the one
 * that spends a real call, however small; `seat/harnesses.mjs` only launches
 * and detects, `seat/index.mjs` only composes tmux with that registry.
 *
 * Measured 2026-09-17 against `claude -p 'Reply with exactly OK and use no
 * tools.' --output-format stream-json --verbose`, at a cost of
 * `total_cost_usd: 0.27848` for that one probe (see `protocol.mjs`'s
 * `extractClaudeAllowance` header for the raw measured line and the scale
 * evidence): the stream carries one `rate_limit_event` line, not a field on
 * the terminal `result` event, and no other operator harness (codex, zcode,
 * dsh, agy) has been measured. `defaultInvoke` below only ever spawns a
 * process for `claude`; every other harness name returns null without
 * spending a call, which is also what happens once a claude call runs but the
 * adapter finds no signal on it (`normalize(...).allowance` with every member
 * null). Every sampling call site pays this cost again: `campaign init`
 * (once) and `plan freeze` (once per phase) each spend one probe when the
 * sampled harness is claude.
 */
import { spawn } from "node:child_process";
import { getHarness } from "../harnesses/index.mjs";

/** @typedef {{remaining: number|null, limit: number|null, resetsAt: string|null}} Allowance */
/** @typedef {{stdout: string, exitCode: number|null, signal: string|null}} InvokeResult */

const ALLOWANCE_PROBE_PROMPT = "Reply with exactly OK and use no tools.";
const ALLOWANCE_PROBE_TIMEOUT_MS = 30_000;

/**
 * One minimal `claude -p` call, its stdout handed back raw for the adapter's
 * own `normalize` to parse. Every other harness resolves to null without
 * spawning anything: the signal has only ever been measured on claude's
 * stream, and probing a harness that is known to expose nothing would spend a
 * call for no reading.
 *
 * @param {string} harness
 * @returns {Promise<InvokeResult|null>}
 */
function defaultInvoke(harness) {
  if (harness !== "claude") return Promise.resolve(null);
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(process.env.FABERUN_CLAUDE_BIN ?? "claude", ["-p", ALLOWANCE_PROBE_PROMPT, "--output-format", "stream-json", "--verbose"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ESRCH: the child is already gone.
      }
    }, ALLOWANCE_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(null);
    });
    child.once("close", (exitCode, signalName) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ stdout, exitCode, signal: signalName });
    });
  });
}

/**
 * The current seat allowance, from one minimal invocation, or null when the
 * harness is unset, the invocation fails, or the harness's adapter reports no
 * signal. Never throws: an allowance sample is advisory, and a probe failure
 * must not fail the campaign operation sampling it.
 *
 * @param {{harness: string|null, invoke?: (harness: string) => Promise<InvokeResult|null>|InvokeResult|null}} options
 * @returns {Promise<Allowance|null>}
 */
export async function sampleAllowance({ harness, invoke = defaultInvoke }) {
  if (!harness) return null;
  /** @type {InvokeResult|null} */
  let raw;
  try {
    raw = await invoke(harness);
  } catch {
    return null;
  }
  if (!raw || typeof raw.stdout !== "string") return null;
  try {
    const envelope = /** @type {{allowance?: Allowance|null}} */ (getHarness(harness).normalize(raw.stdout, raw.exitCode ?? null, raw.signal ?? null));
    // The adapter always returns the shape (never omits it), with every
    // member null when its stream carried no signal: that all-null shape and
    // "no signal" are the same fact, so both collapse to null here.
    return envelope.allowance && envelope.allowance.remaining !== null ? envelope.allowance : null;
  } catch {
    return null;
  }
}

/**
 * The change in remaining allowance between two samples, or null when either
 * sample is absent or itself carries no remaining figure.
 *
 * @param {Allowance|null} start
 * @param {Allowance|null} freeze
 * @returns {number|null}
 */
export function allowanceDelta(start, freeze) {
  if (!start || !freeze || start.remaining === null || freeze.remaining === null) return null;
  return freeze.remaining - start.remaining;
}
