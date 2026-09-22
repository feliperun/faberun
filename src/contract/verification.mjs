import { Buffer } from "node:buffer";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fail, isContained, tailText } from "../util.mjs";

export const VERIFICATION_LIMITS = Object.freeze({
  stdoutBytes: 16 * 1024,
  stderrBytes: 16 * 1024,
  maxCommands: 32,
  maxRepeat: 8,
  // A verification command may declare up to half an hour. It was 600s, which
  // is below this repository's own suite: measured 2026-09-22, `npm test`
  // takes 434-473s at the default parallelism on the author's machine and 650s
  // on a Windows CI runner, and `node --test --test-concurrency=1 test/engine/`
  // -- the way a packet's verification actually runs it -- takes 1035-1058s.
  // So the one command that proves the engine could not be declared at all,
  // and a packet author's way out was `--test-name-pattern`, which exits 0
  // when it matches nothing (see AGENTS.md). A cap that pushes authors toward
  // a proof that certifies nothing is worse than a longer runaway. The node's
  // own wall clock (`contract.timeoutSec`, 2400s by default) still bounds the
  // attempt above this.
  maxTimeoutSec: 1_800,
  stateStdoutBytes: 2 * 1024,
  stateCommands: 16,
  stateAttempts: 4,
  stateAttemptRecords: 16,
  stateArgvBytes: 8 * 1024,
  stateEnvBytes: 4 * 1024,
  maxArgvBytes: 32 * 1024,
  maxEnvBytes: 8 * 1024,
  snapshotEntries: 4096,
  snapshotPathBytes: 1024,
});

/**
 * The declared risk tiers and the fraction of sampled mutants a suite must kill
 * for a `mutation` verification entry to pass. The tier is what the entry
 * declares; the fraction is not re-picked per entry, so two nodes at the same
 * tier sit the same bar. The wall-clock budget that bounds how many mutants run
 * at all is a measurement, not policy, and lives with the runner that enforces
 * it (`MUTATION_TIME_BUDGET_MS`, `src/engine/mutation.mjs`).
 */
export const MUTATION_TIERS = Object.freeze({
  high: 1,
  medium: 0.75,
  low: 0.5,
});

/** @typedef {keyof typeof MUTATION_TIERS} MutationTier */

/** @typedef {"active"|"closed"|"failed"|"crashed"|"canceled"} VerificationAttemptStatus */

/**
 * One declared deterministic check: an argv command run by the controller.
 *
 * `requirementId` names the spec requirement this command is the proof of. It
 * changes nothing about how the command runs; it is what makes a duplicated
 * proof visible. Measured 2026-09-22: one broken command lived in a spec's R3,
 * in its R4 and in seven nodes' verification, and the repair reached one of
 * them — nothing could tell that the other copies had stopped agreeing,
 * because nothing recorded that they were copies of one claim.
 *
 * @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[], mutation?: {tier: MutationTier}, requirementId?: string}} VerificationCommand
 */

/**
 * A single attempt of a verification command.
 *
 * @typedef {{attempt: number, invocationId: string, commandIndex: number, pid: number|null, processStartToken: string|null, processGroupId: number|null, startedAt: string, deadlineAt: string, status: VerificationAttemptStatus, completedAt?: string|null, result?: VerificationAttemptResult|null}} VerificationAttempt
 */

/**
 * Bounded evidence captured for one attempt.
 *
 * @typedef {{passed: boolean, stdout: string, stderr: string, error: string|null, exitCode: number|null, signal: string|null, timedOut: boolean, durationMs: number|null, signalDeath?: boolean}} VerificationAttemptResult
 */

/**
 * A command with its repeated attempts.
 *
 * @typedef {VerificationCommand & {passed: boolean, attempts: VerificationAttemptResult[]}} VerificationCommandResult
 */

/**
 * Aggregated verification result.
 *
 * @typedef {{passed: boolean, commands: VerificationCommandResult[]}} VerificationResult
 */

/**
 * Callbacks and options for {@link runVerification}.
 *
 * @typedef {{signal?: AbortSignal, logDir?: string, writeFiles?: string[], onAttemptStart?: (attempt: VerificationAttempt) => void, onAttemptSpawn?: (attempt: VerificationAttempt) => void, onAttemptComplete?: (attempt: VerificationAttempt) => void}} VerificationOptions
 */

/**
 * @param {unknown} cwd
 * @param {string} label
 */
function validateRelativeCwd(cwd, label) {
  if (typeof cwd !== "string" || isAbsolute(cwd) || /^[A-Za-z]:[\\/]/u.test(cwd) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(cwd)) {
    throw fail("verification_cwd_invalid", `${label}.cwd must be a relative path without ..`);
  }
}

/**
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @returns {string}
 */
export function resolveVerificationCwd(baseCwd, commandCwd = ".") {
  validateRelativeCwd(commandCwd, "verification command");
  const baseReal = realpathSync(baseCwd);
  const candidate = resolve(baseReal, commandCwd);
  const targetReal = realpathSync(candidate);
  if (!isContained(baseReal, targetReal)) {
    throw fail("verification_cwd_escape", `verification cwd escapes workspace: ${commandCwd}`);
  }
  if (!statSync(targetReal).isDirectory()) throw fail("verification_cwd_invalid", `verification cwd is not a directory: ${commandCwd}`);
  return targetReal;
}

/**
 * @param {unknown} commands
 * @param {string} label
 * @returns {VerificationCommand[]}
 */
export function validateVerificationCommands(commands, label = "verification") {
  if (!Array.isArray(commands) || commands.length > VERIFICATION_LIMITS.maxCommands) {
    throw new TypeError(`${label} must be an array of at most ${VERIFICATION_LIMITS.maxCommands} command objects`);
  }
  return commands.map((command, index) => validateVerificationCommand(command, `${label}[${index}]`));
}

/**
 * @param {unknown} command
 * @param {string} label
 * @returns {VerificationCommand}
 */
function validateVerificationCommand(command, label = "verification command") {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError(`${label} must be an argv command object`);
  const record = /** @type {Record<string, unknown>} */ (command);
  const allowed = new Set(["argv", "cwd", "timeoutSec", "repeat", "env", "mutation", "requirementId"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.length > 64 || record.argv.some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > 8 * 1024)) {
    throw new TypeError(`${label}.argv must be a non-empty array of strings`);
  }
  const argvBytes = record.argv.reduce((sum, item) => sum + Buffer.byteLength(/** @type {string} */ (item), "utf8"), 0);
  if (argvBytes > VERIFICATION_LIMITS.maxArgvBytes) throw new TypeError(`${label}.argv exceeds aggregate byte limit`);
  if (record.cwd !== undefined) validateRelativeCwd(record.cwd, label);
  const timeoutSec = record.timeoutSec === undefined ? 120 : record.timeoutSec;
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > VERIFICATION_LIMITS.maxTimeoutSec) throw new TypeError(`${label}.timeoutSec must be between 0 and ${VERIFICATION_LIMITS.maxTimeoutSec}`);
  // Default single attempt: the worker already ran these commands inside its
  // session and the controller run is the independent confirmation; repeating
  // by default doubled suite cost for no extra signal.
  const repeat = record.repeat === undefined ? 1 : record.repeat;
  if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0 || repeat > VERIFICATION_LIMITS.maxRepeat) throw new TypeError(`${label}.repeat must be between 1 and ${VERIFICATION_LIMITS.maxRepeat}`);
  const env = record.env ?? [];
  if (!Array.isArray(env) || env.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new TypeError(`${label}.env must be an array of environment-variable names`);
  const envBytes = env.reduce((sum, name) => sum + Buffer.byteLength(/** @type {string} */ (name), "utf8"), 0);
  if (envBytes > VERIFICATION_LIMITS.maxEnvBytes) throw new TypeError(`${label}.env exceeds aggregate byte limit`);
  // Mutation testing is opt-in per entry: it re-runs the same argv against
  // deliberately broken copies of the node's written files. The entry declares
  // its risk tier; `MUTATION_TIERS` fixes the kill fraction each tier demands,
  // so the bar is a property of the tier, not of the author's caution.
  /** @type {{tier: MutationTier}|undefined} */
  let mutation;
  if (record.mutation !== undefined) {
    const rawMutation = record.mutation;
    if (!rawMutation || typeof rawMutation !== "object" || Array.isArray(rawMutation)) throw new TypeError(`${label}.mutation must be an object with a declared risk tier`);
    const mutationRecord = /** @type {Record<string, unknown>} */ (rawMutation);
    for (const key of Object.keys(mutationRecord)) if (key !== "tier") throw new TypeError(`${label}.mutation has unexpected field ${key}`);
    if (typeof mutationRecord.tier !== "string" || !Object.hasOwn(MUTATION_TIERS, mutationRecord.tier)) {
      throw new TypeError(`${label}.mutation.tier must be one of ${Object.keys(MUTATION_TIERS).join(", ")}`);
    }
    mutation = { tier: /** @type {MutationTier} */ (mutationRecord.tier) };
  }
  // Bounded exactly like the node-level `requirementIds` it must match against
  // (at most 128 bytes), so the two sides of the claim cannot accept different
  // ids.
  if (record.requirementId !== undefined
    && (typeof record.requirementId !== "string" || !record.requirementId.trim() || Buffer.byteLength(record.requirementId, "utf8") > 128)) {
    throw new TypeError(`${label}.requirementId must be a requirement id of at most 128 bytes`);
  }
  /** @type {VerificationCommand} */
  const normalized = { argv: [.../** @type {string[]} */ (record.argv)], timeoutSec, repeat, env: [.../** @type {string[]} */ (env)] };
  if (record.cwd !== undefined) normalized.cwd = /** @type {string} */ (record.cwd);
  if (mutation !== undefined) normalized.mutation = mutation;
  if (record.requirementId !== undefined) normalized.requirementId = /** @type {string} */ (record.requirementId);
  return normalized;
}

/**
 * Bound a verification result for persisted node state.
 *
 * @param {VerificationResult|undefined} result
 * @returns {VerificationResult}
 */
export function compactVerification(result) {
  /** @type {VerificationCommandResult[]} */
  const commands = [];
  let argvBytes = 0;
  let envBytes = 0;
  for (const command of result?.commands ?? []) {
    if (commands.length >= VERIFICATION_LIMITS.stateCommands) break;
    const nextArgvBytes = argvBytes + command.argv.reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    const nextEnvBytes = envBytes + (command.env ?? []).reduce((sum, item) => sum + Buffer.byteLength(String(item), "utf8"), 0);
    if (nextArgvBytes > VERIFICATION_LIMITS.stateArgvBytes || nextEnvBytes > VERIFICATION_LIMITS.stateEnvBytes) break;
    argvBytes = nextArgvBytes;
    envBytes = nextEnvBytes;
    commands.push({
      argv: command.argv,
      cwd: command.cwd,
      timeoutSec: command.timeoutSec,
      repeat: command.repeat,
      env: command.env,
      passed: Boolean(command.passed),
      attempts: (command.attempts ?? []).slice(0, VERIFICATION_LIMITS.stateAttempts).map((attempt) => ({
        ...attempt,
        stdout: tailText(attempt.stdout, VERIFICATION_LIMITS.stateStdoutBytes),
        stderr: tailText(attempt.stderr, VERIFICATION_LIMITS.stateStdoutBytes),
      })),
    });
  }
  return { passed: Boolean(result?.passed), commands };
}


/**
 * One proof, one source. A command that declares `requirementId` says it is
 * the proof of that requirement; this reports the two ways such a claim can
 * be false.
 *
 * A claim the node does not carry is a mislabel: the node's own
 * `requirementIds` are what the phase assigned it, and a command proving
 * something outside them is either the wrong id or the wrong node.
 *
 * Copies that stopped agreeing are the measured one. 2026-09-22: a broken
 * command lived in a spec's R3, its R4, and seven nodes' verification, and
 * the repair reached one copy. Nothing could see that the others had drifted,
 * because nothing recorded that they were copies of a single claim. Argv is
 * compared against argv, never a joined string against a shell command: a
 * joined argv loses argument boundaries, which is the same reason a
 * `verification` proof references an index instead of comparing text.
 *
 * @param {Array<{id: string, requirementIds?: string[], commands: VerificationCommand[]}>} owners
 * @returns {string[]}
 */
export function requirementProofWarnings(owners) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, Array<{owner: string, position: number, argv: string[]}>>} */
  const claims = new Map();
  for (const owner of owners) {
    owner.commands.forEach((command, position) => {
      const requirementId = command.requirementId;
      if (requirementId === undefined) return;
      if (owner.requirementIds !== undefined && !owner.requirementIds.includes(requirementId)) {
        warnings.push(`${owner.id}: verification[${position}] declares requirementId "${requirementId}", which this node does not carry in requirementIds`);
      }
      const claimed = claims.get(requirementId) ?? [];
      claimed.push({ owner: owner.id, position, argv: command.argv });
      claims.set(requirementId, claimed);
    });
  }
  for (const [requirementId, claimed] of claims) {
    const distinct = new Map(claimed.map((claim) => [JSON.stringify(claim.argv), claim]));
    if (distinct.size < 2) continue;
    const listed = [...distinct.values()].map((claim) => `${claim.owner}: verification[${claim.position}] runs ${JSON.stringify(claim.argv)}`).join("; ");
    warnings.push(`requirementId "${requirementId}" is proven by commands that no longer agree: ${listed}`);
  }
  return warnings;
}
