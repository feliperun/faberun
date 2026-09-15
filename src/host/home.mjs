/**
 * The install layout under `$FABERUN_HOME` (default `~/.faberun`).
 *
 * One module owns every path the installer, the self-updater and the banner
 * must agree on: `versions/<v>/`, the `current` symlink, `config.json`,
 * `update-check.json` and `tmp/`. install.sh is owned by another node; if it
 * and the updater each spelled the layout out, they would drift until
 * `current` pointed at a directory one of them did not mean.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** @typedef {{checkedAt: string, current: string, latest: string}} UpdateCheck */

/**
 * The install root: `$FABERUN_HOME`, or `~/.faberun` when it is unset or empty.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function faberunHome(env = process.env) {
  const configured = env.FABERUN_HOME;
  if (typeof configured === "string" && configured) return configured;
  return join(homedir(), ".faberun");
}

/** @param {string} home @returns {string} */
export function versionsDir(home) {
  return join(home, "versions");
}

/** @param {string} home @returns {string} */
export function currentLink(home) {
  return join(home, "current");
}

/** @param {string} home @returns {string} */
export function configPath(home) {
  return join(home, "config.json");
}

/** @param {string} home @returns {string} */
export function updateCheckPath(home) {
  return join(home, "update-check.json");
}

/** @param {string} home @returns {string} */
export function tmpDir(home) {
  return join(home, "tmp");
}

/**
 * The version directory an entry path was launched from, or null when the path
 * does not name a location inside `versions/`.
 *
 * Containment is judged on the literal path first: a `bin/faberun.mjs` that is
 * itself a symlink still counts because its *location* is what identifies the
 * installed version. When the literal path does not match, the path is resolved
 * so an entry reached through the install's `current` link (or a `$FABERUN_BIN_DIR`
 * symlink to it) reports the version it ultimately points at.
 *
 * @param {string|undefined} entryPath
 * @param {string} home
 * @returns {string|null}
 */
export function installedVersionDir(entryPath, home) {
  if (typeof entryPath !== "string" || !entryPath) return null;
  const root = resolve(versionsDir(home));
  /** @type {string[]} */
  const candidates = [resolve(entryPath)];
  try {
    candidates.push(realpathSync(entryPath));
  } catch {
    // The path does not exist: only its literal location can identify a version.
  }
  for (const candidate of candidates) {
    const within = relative(root, candidate);
    if (!within || within.startsWith("..") || isAbsolute(within)) continue;
    const [name] = within.split(sep);
    if (name) return join(root, name);
  }
  return null;
}

/**
 * The cached update check, or null when it is missing or malformed. The banner
 * reads this and nothing else: it never reaches the network.
 *
 * @param {string} home
 * @returns {UpdateCheck|null}
 */
export function readUpdateCheck(home) {
  try {
    const parsed = JSON.parse(readFileSync(updateCheckPath(home), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.checkedAt !== "string" || typeof parsed.current !== "string" || typeof parsed.latest !== "string") return null;
    return { checkedAt: parsed.checkedAt, current: parsed.current, latest: parsed.latest };
  } catch {
    // No readable cache is simply no cached fact, not an error.
    return null;
  }
}

/**
 * Write the cache atomically: a sibling temporary file then a rename, so a
 * reader never observes a half-written record.
 *
 * @param {string} home
 * @param {UpdateCheck} record
 * @returns {void}
 */
export function writeUpdateCheck(home, record) {
  const path = updateCheckPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`);
  renameSync(temporary, path);
}

/**
 * Compare two `X.Y.Z` versions numerically on their three parts. Prerelease
 * suffixes are out of scope for this command: a version that does not match the
 * three-part grammar compares equal to nothing, so no hint is shown.
 *
 * @param {string} left
 * @param {string} right
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} text
 * @returns {number[]|null}
 */
function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
