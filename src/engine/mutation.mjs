/**
 * Mutation verification: prove a suite asserts by breaking the code on purpose.
 *
 * A test that asserts nothing still exits zero, so re-running a command cannot
 * tell it apart from a real one. This runner rewrites one comparison or logical
 * operator in the files the node declared, re-runs the same argv, and restores
 * the file. A mutant the suite fails on is killed; one it survives is a test
 * that did not assert. The operator set is deliberately six swaps that rarely
 * break syntax and the sample is a deterministic eight, because a gate that
 * fails at random, or on a mutant that does not compile, is worse than no gate.
 *
 * The kill fraction is declared by tier, not hand-picked per entry: the entry
 * declares a risk tier and `MUTATION_TIERS` (`contract/verification.mjs`)
 * fixes what each tier demands, so two nodes at the same tier sit the same
 * bar. The whole entry — baseline plus sample — is held inside
 * `MUTATION_TIME_BUDGET_MS`, and mutants the budget cannot afford stay in the
 * denominator, so a suite too slow to sample inside the budget fails rather
 * than passing on a narrowed set.
 *
 * It is a separate module from `run-command.mjs` so that the "doing" of a
 * verification run and the "which file to break" policy do not grow together;
 * the runner receives the argv executor as a callback rather than importing it,
 * which is also what keeps the import graph acyclic.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MUTATION_TIERS } from "../contract/verification.mjs";

/** At most this many mutants run for one verification entry. */
export const MUTATION_BUDGET = 8;

/**
 * Wall-clock budget for one mutation entry — baseline plus every mutant run —
 * in milliseconds. Each mutant re-runs the same argv, so each one costs what
 * the baseline cost, and the runner refuses to start a mutant the remaining
 * budget cannot afford.
 *
 * measured 2026-09-21 on this repository: the scenarios in
 * test/engine/mutation.test.mjs cost 0.08–0.37s per run, so a node-sized entry
 * (baseline plus eight mutants over a targeted suite) costs ~1–4s and samples
 * in full. The budget admits any suite up to ~3.3s per run and denies slower
 * ones every mutant — measured counter-example: `node --test test/contract`
 * costs ~20s per run, and a mutation entry is scoped to the node's own
 * verification command, not to a whole suite directory.
 */
export const MUTATION_TIME_BUDGET_MS = 30_000;

/**
 * The six operators, and only these: comparison and logical swaps. Each swap
 * keeps the expression well formed, so a surviving mutant is signal about the
 * suite rather than about the parser.
 *
 * @type {Readonly<Record<string, string>>}
 */
const MUTATION_SUBSTITUTIONS = Object.freeze({
  "===": "!==",
  "!==": "===",
  "<=": "<",
  ">=": ">",
  "&&": "||",
  "||": "&&",
});

/** `!==` first so the `===`/`!==` alternatives cannot shadow each other. */
const MUTATION_PATTERN = /!==|===|<=|>=|&&|\|\|/gu;

/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationCommand} VerificationCommand */

/**
 * One operator occurrence that can be swapped.
 *
 * @typedef {{path: string, absolute: string, offset: number, from: string, to: string}} MutationCandidate
 */

/**
 * @typedef {{writeFiles?: string[], run: (attempt: number) => Promise<VerificationAttemptResult>}} MutationRunOptions
 */

/**
 * @typedef {{passed: boolean, killed: number, total: number, threshold: number, attempts: VerificationAttemptResult[]}} MutationResult
 */

/**
 * Every swap in the declared files, ordered by (path, offset) so the sample is
 * a function of the tree and not of the filesystem or the clock.
 *
 * @param {string} baseCwd
 * @param {string[]} writeFiles
 * @returns {MutationCandidate[]}
 */
function mutationCandidates(baseCwd, writeFiles) {
  /** @type {MutationCandidate[]} */
  const candidates = [];
  for (const path of [...new Set(writeFiles)].sort()) {
    const absolute = resolve(baseCwd, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const text = readFileSync(absolute, "utf8");
    for (const match of text.matchAll(MUTATION_PATTERN)) {
      candidates.push({ path, absolute, offset: match.index, from: match[0], to: MUTATION_SUBSTITUTIONS[match[0]] });
    }
  }
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : left.offset - right.offset));
  return candidates;
}

/**
 * Pick at most `budget` candidates spread evenly across the ordered list. The
 * first and last are always kept, so a large file cannot lose a whole region
 * from the sample silently.
 *
 * @param {MutationCandidate[]} candidates
 * @param {number} budget
 * @returns {MutationCandidate[]}
 */
function evenlySpaced(candidates, budget) {
  if (candidates.length <= budget) return [...candidates];
  const last = candidates.length - 1;
  /** @type {MutationCandidate[]} */
  const selected = [];
  for (let index = 0; index < budget; index += 1) selected.push(candidates[Math.round((index * last) / (budget - 1))]);
  return selected;
}

/**
 * Run the entry once untouched and then once per sampled mutant. The original
 * content is held in memory and written back in `finally`, so a mutant that
 * times out, throws or kills the process still leaves the tree as it was.
 *
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {MutationRunOptions} options
 * @returns {Promise<MutationResult>}
 */
export async function runMutation(command, baseCwd, options) {
  const mutation = command.mutation;
  if (!mutation) throw new TypeError("mutation runner requires a command.mutation risk tier");
  const threshold = MUTATION_TIERS[mutation.tier];
  const sample = evenlySpaced(mutationCandidates(baseCwd, options.writeFiles ?? []), MUTATION_BUDGET);
  /** @type {VerificationAttemptResult[]} */
  const attempts = [];
  const baseline = await options.run(1);
  attempts.push(baseline);
  if (!baseline.passed) return { passed: false, killed: 0, total: sample.length, threshold, attempts };
  // Every mutant re-runs the same argv, so the baseline's own measured duration
  // is what one more attempt costs, and the budget is spent in those units. An
  // executor that reports no duration (the unit-test seam) is charged zero and
  // is never denied a mutant.
  const attemptMs = Number.isFinite(baseline.durationMs) ? /** @type {number} */ (baseline.durationMs) : 0;
  /** @type {Map<string, string>} */
  const originals = new Map();
  let killed = 0;
  let spentMs = attemptMs;
  let attempt = 1;
  for (const candidate of sample) {
    // Mutants the budget cannot afford are not silently dropped from the
    // denominator: `total` stays the full sample, so truncation can only lower
    // the kill fraction. A suite too slow to sample inside the budget fails a
    // gate it is too slow to sit for — the narrowing the budget exists to
    // prevent.
    if (attemptMs > 0 && spentMs + attemptMs > MUTATION_TIME_BUDGET_MS) break;
    let original = originals.get(candidate.absolute);
    if (original === undefined) {
      original = readFileSync(candidate.absolute, "utf8");
      originals.set(candidate.absolute, original);
    }
    const mutated = `${original.slice(0, candidate.offset)}${candidate.to}${original.slice(candidate.offset + candidate.from.length)}`;
    /** @type {VerificationAttemptResult} */
    let result;
    attempt += 1;
    try {
      writeFileSync(candidate.absolute, mutated);
      result = await options.run(attempt);
    } finally {
      writeFileSync(candidate.absolute, original);
    }
    attempts.push(result);
    spentMs += Number.isFinite(result.durationMs) ? /** @type {number} */ (result.durationMs) : 0;
    if (!result.passed) killed += 1;
  }
  const total = sample.length;
  // No operators to break is a vacuous pass: there is no mutant the suite could
  // have failed to kill. The caller declared the entry, so an empty target is a
  // measurement of nothing, not a suite that proved nothing.
  return { passed: total === 0 || killed / total >= threshold, killed, total, threshold, attempts };
}
