import { normalizeClaudeResult, parseVersion } from "../protocol.mjs";
import { hookSettings } from "../../host/tool-policy-hook.mjs";

/**
 * The environment names the Claude adapter reads to authenticate and configure
 * the CLI: the provider credential the CLI resolves for API-key sign-in and the
 * binary override `executable()` honours. Values never travel here.
 *
 * @type {readonly string[]}
 */
export const declaredEnvironment = Object.freeze([
  "ANTHROPIC_API_KEY",
  "FABERUN_CLAUDE_BIN",
]);

/** Built-in tools a closed-packet worker needs; every other tool is preamble. */
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

/**
 * Bound the harness preamble of a Claude-compatible CLI: no skills, no MCP
 * servers, no settings files (an explicit `--settings` still applies, so hook
 * enforcement survives) and only the declared built-in tools. Measured on
 * 2026-09-01 against this CLI: 65,170 uncached input tokens per trivial call
 * with the ambient configuration, about 4,300 per turn with these flags.
 * `--bare` would cut further but disables hooks, so it is never used.
 *
 * @param {import("../index.mjs").HarnessRuntime} runtime
 * @returns {string[]}
 */
function claudePreambleArgs(runtime) {
  return [
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    (runtime.tools ?? DEFAULT_CLAUDE_TOOLS).join(","),
  ];
}

/**
 * The envelope this adapter returns: the shared provider envelope plus the
 * top-level reset instant a session limit names. The field has to live here
 * rather than in `error` so that `exhaustedUntilOf` keeps parsing the sentence
 * against the caller's clock.
 *
 * @typedef {import("../index.mjs").ProviderEnvelope & {resetAt?: string}} ClaudeEnvelope
 */

/**
 * The reset sentence a Claude quota stop writes into its error message, e.g.
 * "You've hit your session limit · resets 6:40pm (America/Sao_Paulo)". The
 * wall-clock form names a time and a zone but no date; an absolute form names
 * the instant directly ("Your limit will reset at 2026-09-08 20:30:00").
 */
const SESSION_RESET_SENTENCE = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/iu;
const ABSOLUTE_RESET_SENTENCE = /reset(?:s| at| on)?\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)/iu;

/**
 * The instant a Claude quota stop names, or null when its message names none.
 *
 * The generic availability classifier (`harnesses/index.mjs`'s
 * `exhaustedUntilOf`) parses the same sentence for the durable refusal store,
 * but the node's own wait decision (`engine/backoff.mjs`'s
 * `quotaResetSchedule`) reads only a structured `resetAt`. This adapter is the
 * protocol boundary and cannot import `harnesses/index.mjs` -- that module
 * imports this one at load -- so the sentence is parsed here. A zone the
 * runtime does not know names no instant, and the failover edge is taken as
 * before.
 *
 * @param {string} message
 * @param {number} [now] the instant a wall-clock sentence is read against
 * @returns {string|null}
 */
function sessionResetAt(message, now = Date.now()) {
  const absolute = ABSOLUTE_RESET_SENTENCE.exec(message);
  if (absolute) {
    const value = absolute[1];
    const zoned = value.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value.replace(" ", "T")}Z`;
    const parsed = Date.parse(zoned);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const match = SESSION_RESET_SENTENCE.exec(message);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  /** @type {Intl.DateTimeFormatPart[]} */
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: match[4], hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(now));
  } catch {
    // An unknown zone name is not a reset time; the caller falls back to failover.
    return null;
  }
  const at = (/** @type {Intl.DateTimeFormatPartTypes} */ type) => Number(parts.find((part) => part.type === type)?.value);
  const offset = Date.UTC(at("year"), at("month") - 1, at("day"), at("hour") % 24, at("minute"), at("second")) - Math.floor(now / 1000) * 1000;
  let target = Date.UTC(at("year"), at("month") - 1, at("day"), hour, minute) - offset;
  if (target <= now) target += 86_400_000;
  return new Date(target).toISOString();
}

/**
 * Thread a session-limit reset into the envelope so the node can wait for it.
 * The instant rides the envelope's top-level `resetAt`, the field the node's
 * wait decision (`engine/backoff.mjs`'s `quotaResetSchedule`) reads. It is not
 * written into `error.resetAt`/`exhaustedUntil` on purpose: `exhaustedUntilOf`
 * must keep parsing the sentence against the clock its caller passes, so a test
 * or a replayed envelope can re-read the same message at a chosen instant.
 *
 * @param {ClaudeEnvelope} envelope
 * @returns {ClaudeEnvelope}
 */
function withSessionReset(envelope) {
  if (envelope.status !== "exhausted" || envelope.resetAt) return envelope;
  const resetAt = sessionResetAt(String(envelope.error?.message ?? ""));
  return resetAt ? { ...envelope, resetAt } : envelope;
}

/**
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const claudeHarness = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: true,
    continuation: true,
    tokenBudget: false,
    costBudget: true,
    usage: true,
    cost: true,
    // The Claude-compatible hook surface enforces the tool policy mechanically.
    toolPolicy: true,
    // `--output-format stream-json --verbose` writes one JSON line per event
    // as the turn runs, not one dump at exit.
    streamsOutput: true,
    // Measured 2026-09-16: `bypassPermissions` runs an unsandboxed Bash that
    // signals child processes and reads the process table; headless
    // `acceptEdits` cannot run commands at all, so the flag describes the
    // executing mode.
    signalsProcesses: true,
  },

  // Headless acceptEdits denies Bash; bypassPermissions executes commands;
  // plan neither edits nor runs anything, the mode a judge or a preflight ask
  // needs (measured 2026-09-27: an Opus judge left on the acceptEdits default
  // edited the review it was grading and was blocked judge_protocol).
  permissionExecution: { field: "permissionMode", executingModes: ["bypassPermissions"], defaultMode: "acceptEdits", readOnlyModes: ["plan"] },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.FABERUN_CLAUDE_BIN ?? runtime.executable ?? "claude";
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @param {string} prompt @param {import("../index.mjs").CommandOptions} options @returns {import("../index.mjs").HarnessCommand} */
  command(runtime, prompt, options) {
    const continuationId = options.continuationId ?? null;
    const args = [
      "-p",
      ...(continuationId ? ["--resume", continuationId] : []),
      "--model",
      runtime.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      runtime.permissionMode ?? "acceptEdits",
      ...claudePreambleArgs(runtime),
    ];
    if (options.toolPolicy) args.push("--settings", JSON.stringify(hookSettings(options.toolPolicy)));
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    // The attempt's request ceiling, enforced by the CLI itself; the
    // controller's monitor enforces the same number for every streaming
    // harness, so this only makes the stop cleaner (a result event instead of
    // a kill) for the one harness that can take it as a flag.
    if (typeof options.maxTurns === "number") args.push("--max-turns", String(options.maxTurns));
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt };
  },

  /** @param {string} stdout @param {number|null} exitCode @param {string|null} signal @param {import("../index.mjs").NormalizeOptions} [options] @returns {import("../index.mjs").ProviderEnvelope} */
  normalize(stdout, exitCode, signal, options = {}) {
    return withSessionReset(normalizeClaudeResult(stdout, exitCode, signal, options));
  },
};

export const harness = claudeHarness;
export default claudeHarness;
