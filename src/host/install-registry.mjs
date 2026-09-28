/**
 * The install registry under `$FABERUN_HOME`.
 *
 * Faberun writes outside a target repository in three shapes: a skill tree
 * registered in a harness's skills directory, an entry added inside a tool's
 * own settings file (the status line and the tool-policy hook), and the
 * version/project layout under `$FABERUN_HOME`. The first two must be
 * reversible one artifact at a time -- only the entries faberun added, never a
 * neighbour the operator keeps in the same directory or settings file -- so
 * this module records each write with its absolute path, the install-site root
 * that owns it, and, for a settings file, the exact JSON Pointer and value
 * added.
 *
 * `KNOWN_INSTALL_SITES` is the published manifest of where those writes land.
 * The registry only knows what was recorded after it shipped; an artifact an
 * older faberun installed, or one written before the registry file existed, is
 * found by walking the manifest's well-known sites and testing ownership.
 * `faberun uninstall` merges the recorded entries with this manifest, so it
 * can list and remove artifacts that predate the registry.
 *
 * `src/cli/init.mjs` needs no per-artifact entry. Read on 2026-09-27, it writes
 * only inside the target repository -- `.gitignore`, `.claude/skills`, and the
 * agent kit the installer lays down there -- while the project layout it can
 * trigger is written under the effective `$FABERUN_HOME`. Removal deletes
 * `$FABERUN_HOME` wholesale, so every out-of-repository write init can cause is
 * covered by that one delete; registering each project directory would add
 * entries removal ignores and could never be trusted to be complete.
 *
 * The registry is JSON at `$FABERUN_HOME/install-registry.json`, written with
 * the same temp-then-rename discipline as the rest of the home, so a reader
 * never observes a half-written record. A missing or malformed registry is
 * treated as empty rather than fatal: it is a ledger of things to remove, and
 * refusing to read it would block the command that removes them.
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { errorCode } from "../util.mjs";
import { faberunHome } from "./home.mjs";

/** The registry file name under `$FABERUN_HOME`. */
export const INSTALL_REGISTRY_FILE = "install-registry.json";

/** The registry schema this module reads and writes. */
export const INSTALL_REGISTRY_SCHEMA_VERSION = 1;

/**
 * @param {string} home
 * @returns {string} the absolute path of the registry file
 */
export function installRegistryPath(home) {
  return join(home, INSTALL_REGISTRY_FILE);
}

/**
 * One place faberun is known to write, expressed home-relatively so the
 * manifest is one frozen table and every absolute path is derived from it.
 *
 * @typedef {object} InstallSiteSpec
 * @property {string} harness the operator harness whose site this is
 * @property {readonly string[]} segments the path below `$HOME`
 * @property {string} [key] the settings key faberun owns at this file
 */

/**
 * The known install-site manifest: skill destination directories, the settings
 * files that carry the status-line entry, and the hook destinations. This is
 * the fallback for an artifact whose registry entry does not exist, so it names
 * only sites faberun writes and never a target repository's files.
 *
 * @type {Readonly<{skills: readonly InstallSiteSpec[], settings: readonly InstallSiteSpec[], hooks: readonly InstallSiteSpec[]}>}
 */
export const KNOWN_INSTALL_SITES = Object.freeze({
  skills: Object.freeze([
    Object.freeze({ harness: "claude", segments: Object.freeze([".claude", "skills"]) }),
    Object.freeze({ harness: "codex", segments: Object.freeze([".codex", "skills"]) }),
    Object.freeze({ harness: "zcode", segments: Object.freeze([".agents", "skills"]) }),
    Object.freeze({ harness: "agy", segments: Object.freeze([".gemini", "config", "skills"]) }),
    // The shared convention zcode points at. It is listed on its own because a
    // harness skills directory is often a symlink into it, and a machine may
    // carry it without the harness that introduced it.
    Object.freeze({ harness: "agents", segments: Object.freeze([".agents", "skills"]) }),
  ]),
  settings: Object.freeze([
    // Claude Code is the single statusLine surface; the entry lives in the
    // user-level settings file.
    Object.freeze({ harness: "claude", segments: Object.freeze([".claude", "settings.json"]), key: "statusLine" }),
  ]),
  hooks: Object.freeze([
    // A hook is registered as a key in the settings file...
    Object.freeze({ harness: "claude", segments: Object.freeze([".claude", "settings.json"]), key: "hooks" }),
    // ...and its command may point at a script faberun drops in a hooks dir.
    Object.freeze({ harness: "claude", segments: Object.freeze([".claude", "hooks"]) }),
  ]),
});

/**
 * The skills directory a harness reads, resolved against `home`, or null when
 * the harness has no skills convention (dsh). `skills.mjs` builds its discovery
 * table from this so the manifest is the one home for the paths.
 *
 * @param {string} harness
 * @param {string} home
 * @returns {string|null}
 */
export function skillSiteDir(harness, home) {
  const site = KNOWN_INSTALL_SITES.skills.find((entry) => entry.harness === harness);
  return site ? join(home, ...site.segments) : null;
}

/**
 * The manifest with every path resolved against `home`, grouped as it is
 * published. Settings and hook sites carry the settings `key` faberun owns when
 * one applies, so a caller can find the entry without guessing.
 *
 * @param {string} home
 * @returns {{skills: {harness: string, path: string}[], settings: {harness: string, path: string, key: string|null}[], hooks: {harness: string, path: string, key: string|null}[]}}
 */
export function knownInstallSites(home) {
  return {
    skills: KNOWN_INSTALL_SITES.skills.map((site) => ({ harness: site.harness, path: join(home, ...site.segments) })),
    settings: KNOWN_INSTALL_SITES.settings.map((site) => ({
      harness: site.harness,
      path: join(home, ...site.segments),
      key: site.key ?? null,
    })),
    hooks: KNOWN_INSTALL_SITES.hooks.map((site) => ({
      harness: site.harness,
      path: join(home, ...site.segments),
      key: site.key ?? null,
    })),
  };
}

/** Every kind of write the registry records. */
export const INSTALL_KINDS = Object.freeze(["skill", "statusline", "hook", "config"]);

/**
 * One entry faberun added inside a settings file: the JSON Pointer that names
 * it and the exact value written there. Both are kept so removal can delete the
 * entry only while it still holds what faberun put there, leaving a value the
 * operator later edited alone.
 *
 * @typedef {object} SettingsEntry
 * @property {string} pointer an RFC 6901 JSON Pointer into the settings JSON
 * @property {unknown} value the exact value faberun wrote at that pointer
 */

/**
 * One artifact faberun wrote outside a target repository.
 *
 * @typedef {object} InstallEntry
 * @property {"skill"|"statusline"|"hook"|"config"} kind
 * @property {string} path the absolute path written
 * @property {string} root the absolute install-site root that owns `path`
 * @property {string|null} harness the owning harness, when one applies
 * @property {SettingsEntry[]} entries settings entries added, empty otherwise
 * @property {string} registeredAt when the write was recorded, ISO-8601
 */

/**
 * @typedef {object} InstallRegistry
 * @property {number} schemaVersion
 * @property {InstallEntry[]} entries
 */

/**
 * The registry recorded under `$FABERUN_HOME`, or an empty one when the file is
 * absent, unreadable or malformed. The ledger is advisory: a bad read must not
 * stop the command that consumes it, and an empty registry is exactly what a
 * machine that has never installed anything has.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {InstallRegistry}
 */
export function readInstallRegistry(env = process.env) {
  const home = faberunHome(env);
  try {
    const parsed = readJson(installRegistryPath(home));
    return isInstallRegistry(parsed) ? parsed : emptyRegistry();
  } catch {
    // Absent, unreadable and unparsable all mean the same thing here: no
    // recorded entries to report.
    return emptyRegistry();
  }
}

/**
 * The recorded entries, in the order they were first installed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {InstallEntry[]}
 */
export function readInstallEntries(env = process.env) {
  return readInstallRegistry(env).entries;
}

/**
 * Record one install, replacing any earlier entry for the same kind and path so
 * a re-install refreshes its timestamp instead of accumulating duplicates.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{kind: InstallEntry["kind"], path: string, root: string, harness?: string|null, entries?: SettingsEntry[], registeredAt?: string}} entry
 * @returns {InstallEntry}
 */
export function recordInstall(env, entry) {
  const home = faberunHome(env);
  const registry = readInstallRegistry(env);
  const normalized = normalizeEntry(entry);
  const index = registry.entries.findIndex((existing) => existing.kind === normalized.kind && existing.path === normalized.path);
  if (index >= 0) registry.entries[index] = normalized;
  else registry.entries.push(normalized);
  writeJsonAtomic(installRegistryPath(home), registry);
  return normalized;
}

/**
 * Record a skill tree faberun linked or copied into a harness directory.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{path: string, root: string, harness?: string|null}} skill
 * @returns {InstallEntry}
 */
export function recordSkillInstall(env, skill) {
  return recordInstall(env, { kind: "skill", path: skill.path, root: skill.root, harness: skill.harness ?? null });
}

/**
 * Record a hook faberun registered, either as entries inside a settings file or
 * as a script it dropped at `path`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{path: string, root: string, harness?: string|null, entries?: SettingsEntry[]}} hook
 * @returns {InstallEntry}
 */
export function recordHookInstall(env, hook) {
  return recordInstall(env, { kind: "hook", path: hook.path, root: hook.root, harness: hook.harness ?? null, entries: hook.entries ?? [] });
}

/**
 * Record the user config faberun wrote at `$FABERUN_HOME/config.json`. It is
 * informational for removal -- `$FABERUN_HOME` is deleted wholesale -- but it
 * is still an artifact faberun wrote outside a target repository, and the
 * ledger should say so.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} path
 * @returns {InstallEntry}
 */
export function recordConfigInstall(env, path) {
  return recordInstall(env, { kind: "config", path, root: faberunHome(env) });
}

/**
 * The status-line integration faberun installed into a tool's settings file,
 * recorded with the exact pointer and value so removal can take back only that
 * entry.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{path: string, root: string, harness?: string|null, entries: SettingsEntry[]}} statusline
 * @returns {InstallEntry}
 */
export function recordStatuslineInstall(env, statusline) {
  return recordInstall(env, {
    kind: "statusline",
    path: statusline.path,
    root: statusline.root,
    harness: statusline.harness ?? null,
    entries: statusline.entries,
  });
}

/**
 * Add one entry inside a settings file and record exactly what was added:
 * `pointer` names the location, `value` is written there, and both are kept in
 * the registry. The settings file is created when missing, and the write is
 * atomic, so a concurrent reader sees either the old or the new document.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{kind: "statusline"|"hook", path: string, root: string, harness?: string|null, pointer: string, value: unknown}} install
 * @returns {InstallEntry}
 */
export function installSettingsEntry(env, install) {
  const settings = readSettings(install.path);
  setAtPointer(settings, parsePointer(install.pointer), install.value);
  writeJsonAtomic(install.path, settings);
  return recordInstall(env, {
    kind: install.kind,
    path: install.path,
    root: install.root,
    harness: install.harness ?? null,
    entries: [{ pointer: install.pointer, value: install.value }],
  });
}

/**
 * A copy of `settings` with exactly the recorded entries removed. An entry is
 * removed only while the value at its pointer still deep-equals what faberun
 * recorded, so an operator's later edit survives; every neighbouring key, and
 * every entry faberun did not record, is untouched.
 *
 * @param {unknown} settings
 * @param {readonly SettingsEntry[]} entries
 * @returns {unknown}
 */
export function removeRecordedSettingsEntries(settings, entries) {
  const copy = structuredClone(settings);
  for (const entry of entries) {
    try {
      removeAtPointer(copy, parsePointer(entry.pointer), entry.value);
    } catch {
      // A malformed recorded pointer is skipped, not fatal: the ledger must
      // never turn one bad entry into a refusal to clean the rest.
    }
  }
  return copy;
}

/** @returns {InstallRegistry} */
function emptyRegistry() {
  return { schemaVersion: INSTALL_REGISTRY_SCHEMA_VERSION, entries: [] };
}

/**
 * @param {unknown} value
 * @returns {value is InstallRegistry}
 */
function isInstallRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion !== INSTALL_REGISTRY_SCHEMA_VERSION) return false;
  return Array.isArray(record.entries) && record.entries.every(isInstallEntry);
}

/**
 * @param {unknown} value
 * @returns {value is InstallEntry}
 */
function isInstallEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.kind !== "string" || !INSTALL_KINDS.includes(record.kind)) return false;
  if (typeof record.path !== "string" || !record.path) return false;
  if (typeof record.root !== "string" || !record.root) return false;
  if (record.harness !== null && typeof record.harness !== "string") return false;
  if (!Array.isArray(record.entries)) return false;
  if (typeof record.registeredAt !== "string") return false;
  return record.entries.every(isSettingsEntry);
}

/**
 * @param {unknown} value
 * @returns {value is SettingsEntry}
 */
function isSettingsEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.pointer === "string" && record.pointer.startsWith("/");
}

/**
 * @param {{kind: InstallEntry["kind"], path: string, root: string, harness?: string|null, entries?: SettingsEntry[], registeredAt?: string}} entry
 * @returns {InstallEntry}
 */
function normalizeEntry(entry) {
  return {
    kind: entry.kind,
    path: entry.path,
    root: entry.root,
    harness: entry.harness ?? null,
    entries: dedupeSettingsEntries(entry.entries ?? []),
    registeredAt: entry.registeredAt ?? new Date().toISOString(),
  };
}

/**
 * Two records of the same pointer collapse to the last one written, so a
 * settings entry added twice does not make removal run twice.
 *
 * @param {SettingsEntry[]} entries
 * @returns {SettingsEntry[]}
 */
function dedupeSettingsEntries(entries) {
  /** @type {Map<string, SettingsEntry>} */
  const byPointer = new Map();
  for (const entry of entries) byPointer.set(entry.pointer, entry);
  return [...byPointer.values()];
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function readSettings(path) {
  try {
    const parsed = readJson(path);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    // A settings file that is unreadable or not JSON is replaced with a fresh
    // object only when the caller asked to add an entry; the read itself has
    // nothing to preserve. The caller owns that risk and the atomic write.
    return {};
  }
}

/**
 * An RFC 6901 JSON Pointer split into its decoded reference tokens.
 *
 * @param {string} pointer
 * @returns {string[]}
 */
function parsePointer(pointer) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`not a JSON Pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>|unknown[]}
 */
function isContainer(value) {
  return value !== null && typeof value === "object";
}

/**
 * @param {unknown} node
 * @param {string} token
 * @returns {string|number}
 */
function childKey(node, token) {
  return Array.isArray(node) ? Number(token) : token;
}

/** @param {string} token @returns {boolean} */
function isIndexToken(token) {
  return /^(?:0|[1-9]\d*)$/u.test(token);
}

/**
 * Write `value` at `tokens`, creating intermediate containers, and return the
 * (possibly new) root. A pointer into a missing object or array is created as
 * the next token requires; an existing non-container is replaced.
 *
 * @param {unknown} root
 * @param {string[]} tokens
 * @param {unknown} value
 * @returns {unknown}
 */
function setAtPointer(root, tokens, value) {
  if (tokens.length === 0) return value;
  if (!isContainer(root)) root = {};
  let node = /** @type {Record<string, unknown>|unknown[]} */ (root);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = childKey(node, tokens[index]);
    let child = /** @type {Record<string, unknown>|unknown[]|undefined} */ (/** @type {any} */ (node)[key]);
    if (!isContainer(child)) {
      child = isIndexToken(tokens[index + 1]) ? [] : {};
      /** @type {any} */ (node)[key] = child;
    }
    node = child;
  }
  /** @type {any} */ (node)[childKey(node, tokens.at(-1) ?? "")] = value;
  return root;
}

/**
 * Remove the value at `tokens` when it still deep-equals `expected`. A missing
 * path or a value that changed since it was recorded is left alone; arrays lose
 * the element at the index, objects lose the key.
 *
 * @param {unknown} root
 * @param {string[]} tokens
 * @param {unknown} expected
 * @returns {void}
 */
function removeAtPointer(root, tokens, expected) {
  if (tokens.length === 0 || !isContainer(root)) return;
  let node = /** @type {Record<string, unknown>|unknown[]} */ (root);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const child = /** @type {any} */ (node)[childKey(node, tokens[index])];
    if (!isContainer(child)) return;
    node = child;
  }
  const key = childKey(node, tokens.at(-1) ?? "");
  if (!(key in node)) return;
  if (!deepEqual(/** @type {any} */ (node)[key], expected)) return;
  if (Array.isArray(node)) node.splice(Number(key), 1);
  else delete /** @type {any} */ (node)[key];
}

/**
 * Structural equality for JSON values, so removal compares the recorded value
 * with the live one by shape rather than by reference.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftObject = /** @type {Record<string, unknown>} */ (left);
  const rightObject = /** @type {Record<string, unknown>} */ (right);
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(leftObject[key], rightObject[key]));
}
