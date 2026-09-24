/**
 * The small shared pieces of the paired class: where its state lives, the
 * seeded shuffle that orders arms, JSON/JSONL reads, the environment a
 * provider or the CLI runs under, and the delivery rule the report counts by.
 * Everything else in `evals/paired/` is one arm or one stage; nothing here
 * knows what an arm is. Ported from `spike/arms/lib.mjs` so the permanent
 * instrument is the measured one, not a rewrite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVALS_ROOT } from "../paths.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/** The repository root, one level above `evals/`. */
export const PAIRED_REPO_ROOT = resolve(EVALS_ROOT, "..");
/** The faberun CLI a faberun arm runs against. */
export const FABERUN_CLI = resolve(PAIRED_REPO_ROOT, "src/cli.mjs");
/** The paired class's own state root, under the ignored runs directory so no worktree or log can land in `git status`. */
export const PAIRED_STATE = join(EVALS_ROOT, "paired", RUNS_DIR_NAME);
/** Provider streams and faberun stdout: evidence, kept under the ignored runs directory (a ten-requirement session log is megabytes). */
export const PAIRED_LOGS = join(PAIRED_STATE, "logs");
/** The checked-out trees the real arms work in. */
export const PAIRED_WORKTREES = join(PAIRED_STATE, "worktrees");
/** Arm A's faberun state lives in its own home so the measurement never touches the operator's projects. */
export const PAIRED_EXPERIMENT_HOME = join(PAIRED_STATE, "home");
/** The corpus declarations live beside the modules that load them. */
export const PAIRED_CORPUS_ROOT = join(EVALS_ROOT, "paired", "corpus");
/** The declared arms and their runtimes. */
export const PAIRED_ARMS_FILE = join(EVALS_ROOT, "paired", "arms.json");
/** Where a real operator run's result file lands. A test and a replay run pass their own temporary directory. */
export const PAIRED_RESULTS = join(EVALS_ROOT, "results", "paired");

/** @param {string} path @returns {any[]} */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not JSON: ${/** @type {Error} */ (error).message}`);
    }
  });
}

/** @param {string} path @param {unknown} value @returns {void} */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The environment a provider or the faberun CLI runs under: the caller's,
 * with an adapter overlay applied the way the product's gate applies it (a
 * null removes the variable), colours off so logs parse, and never the
 * notification transport -- a measurement must not buzz a phone.
 *
 * @param {Record<string, string|null>|undefined} overlay
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function providerEnv(overlay, extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  delete env.FABERUN_NOTIFY_BIN;
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}

/**
 * Deterministic shuffle (mulberry32): the arm order of one repetition is a
 * function of the repetition number and the recorded seed, so the ledger's
 * order is reproducible.
 *
 * @template T
 * @param {T[]} items
 * @param {number} seed
 * @returns {T[]}
 */
export function seededShuffle(items, seed) {
  let state = (seed >>> 0) || 1;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** @param {number[]} values @returns {number|null} */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
