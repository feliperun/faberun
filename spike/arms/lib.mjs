/**
 * The small shared pieces of the orchestration-arms driver: append-only JSONL,
 * the env merge a null overlay needs, a seeded shuffle, and the one place the
 * driver's paths are spelled. Everything else in spike/arms/ is one arm or one
 * stage; nothing here knows what an arm is.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = process.cwd();
export const FABERUN_CLI = resolve(ROOT, "src/cli.mjs");
export const RESULTS = resolve(ROOT, "spike/arms/resultados");
export const LEDGER = resolve(RESULTS, "runs.jsonl");
export const REPORTS = resolve(RESULTS, "reports");
/** Provider streams and faberun stdout: evidence, kept under the ignored runs directory (a ten-requirement session log is megabytes); the ledger records each path. */
export const LOGS = resolve(ROOT, "spike/.runs/arms-logs");
export const WORKTREES = resolve(ROOT, "spike/.runs/worktrees/arms");
/** Arm A's faberun state lives in its own home so the experiment never touches the user's projects. */
export const EXPERIMENT_HOME = resolve(ROOT, "spike/.runs/home");

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

/** @param {string} path @param {unknown} record */
export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** @param {string} path @param {unknown} value */
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
 * function of the repetition number, so the ledger's order is reproducible.
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

/**
 * Whether a ledger line is a measurement: it ran without a driver error and,
 * for arm A, faberun actually made at least one provider invocation -- a run
 * the CLI refused before starting is a pipeline failure, not an arm result.
 *
 * @param {any} run
 * @returns {boolean}
 */
export function isMeasuredRun(run) {
  if (!run || run.error) return false;
  if (run.arm === "A" && (run.invocations ?? 0) === 0) return false;
  return true;
}
