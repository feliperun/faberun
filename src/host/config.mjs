/**
 * The user config at `$FABERUN_HOME/config.json`: which harnesses `setup`
 * enabled, which runtime is the default worker and judge, the machine's own
 * ordered `judges` list (R18) -- read only when a contract declares none --
 * and its ordered `reviewers` list (R19), `faberun plan`'s own machine
 * default, read only when `--reviewers` names none.
 *
 * It is separate from `host/home.mjs`, which owns the path, because reading a
 * config is a validation problem and writing it is an atomic-write problem;
 * neither belongs in the path table. `engine/runtime-discovery.mjs` types its
 * `options.config` against this module and `cli/setup.mjs` writes it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, faberunHome } from "./home.mjs";

/** @typedef {{schemaVersion: 1, harnesses: string[], worker?: string, judge?: string, judges?: string[], reviewers?: string[], updatedAt: string}} UserConfig */

/** Paths already reported malformed, so a process that reads twice warns once. */
const warned = new Set();

/**
 * The user config, or null when the file is absent or malformed. A malformed
 * file is written off as a single `[warn]` line on stderr and then ignored:
 * the run falls back to the discovery law rather than refusing to start.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UserConfig|null}
 */
export function readUserConfig(env = process.env) {
  const path = configPath(faberunHome(env));
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // An unreadable file is indistinguishable from an absent one here; there
    // is nothing to act on either way.
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return warnMalformed(path);
  }
  return isUserConfig(parsed) ? parsed : warnMalformed(path);
}

/**
 * Write the config atomically: a sibling temporary file then a rename, so a
 * concurrent reader never observes a half-written record. The home directory
 * is created on the way.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {UserConfig} config
 * @returns {void}
 */
export function writeUserConfig(env, config) {
  const path = configPath(faberunHome(env));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`);
  renameSync(temporary, path);
}

/**
 * @param {string} path
 * @returns {null}
 */
function warnMalformed(path) {
  if (!warned.has(path)) {
    warned.add(path);
    process.stderr.write(`[warn] config · ${path} is not valid; ignoring it\n`);
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is UserConfig}
 */
function isUserConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion !== 1) return false;
  if (!Array.isArray(record.harnesses) || !record.harnesses.every((harness) => typeof harness === "string")) return false;
  if (record.worker !== undefined && typeof record.worker !== "string") return false;
  if (record.judge !== undefined && typeof record.judge !== "string") return false;
  if (record.judges !== undefined && (!Array.isArray(record.judges) || !record.judges.every((id) => typeof id === "string"))) return false;
  if (record.reviewers !== undefined && (!Array.isArray(record.reviewers) || !record.reviewers.every((id) => typeof id === "string"))) return false;
  return typeof record.updatedAt === "string";
}
