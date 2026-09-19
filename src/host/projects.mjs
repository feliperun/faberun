/**
 * The project registry under `$FABERUN_HOME/projects/`.
 *
 * A project is keyed by the repository path, not by anything derived from it:
 * `projects/index.json` maps a path to an opaque id, and `projects/<id>/project.json`
 * is the record. The split matters because a project must be able to move —
 * a later command re-associates a project whose path changed — and everything
 * that will hang off a project id (campaigns, in a later phase) must survive
 * that move untouched. Keying storage by path instead would mean a rename or
 * a clone-to-a-new-directory orphans every one of them; keying storage by id
 * and the *lookup* by path means a move rewrites one index entry while the
 * project directory, and everything under it, stays put.
 *
 * The id is `randomUUID()`: opaque, and unrelated to the path it was minted
 * for, which is the one property this registry actually needs from it.
 *
 * Both files are written with the same temp-then-rename discipline as
 * `run/store.mjs`'s `writeJsonAtomic`, so a second faberun process reading
 * either file — the operator routinely runs more than one at a time — never
 * observes a half-written record. This does not arbitrate two processes
 * writing at once: a race between two *new* registrations landing in the same
 * tick can drop one index entry, and that is accepted here because the loser
 * simply registers again the next time its path is looked up.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { errorCode } from "../util.mjs";
import { projectsDir } from "./home.mjs";

export { projectsDir };

/** @typedef {{schemaVersion: 1, id: string, path: string, remotes: string[], createdAt: string, updatedAt: string}} ProjectRecord */

/**
 * `path`, realpath-resolved so two different spellings of the same real
 * directory key the same project — `$TMPDIR` itself is a symlink on macOS
 * (`/var` -> `/private/var`), which is what actually surfaced this,
 * measured 2026-09-19. Falls back to a plain `resolve` for a path that does
 * not exist: `cwd` from a live process always exists, but a path this
 * registry is asked about — a stale config entry, an operator's typo — need
 * not, and nothing could already be registered under either spelling of a
 * path that was never real to begin with, so there is nothing to reconcile.
 *
 * Exported because `cli/project.mjs` writes this same index directly (it has
 * no registry operation that keeps an id while changing its path) and must
 * key its write identically, or a write it makes becomes one this module's
 * own lookups can never find again.
 *
 * @param {string} path
 * @returns {string}
 */
export function resolveIdentity(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return resolve(path);
    throw error;
  }
}

/** @param {string} home @returns {string} */
function projectIndexPath(home) {
  return join(projectsDir(home), "index.json");
}

/** @param {string} home @param {string} id @returns {string} */
function projectRecordPath(home, id) {
  return join(projectsDir(home), id, "project.json");
}

/** @param {string} home @returns {Record<string, string>} the path-to-id map, or `{}` when the registry has never been written */
function readIndex(home) {
  try {
    return /** @type {Record<string, string>} */ (readJson(projectIndexPath(home)));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
}

/**
 * The project registered at `id`, or null when no such project exists.
 *
 * @param {string} home
 * @param {string} id
 * @returns {ProjectRecord|null}
 */
export function readProject(home, id) {
  try {
    return /** @type {ProjectRecord} */ (readJson(projectRecordPath(home, id)));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * The project registered at `path`, or null when that path has never been
 * registered. `path` is realpath-resolved first, the same normalization
 * `registerProject` applies, so a caller need not agree in advance on
 * relative-vs-absolute spelling, and two different spellings of the same
 * real directory — a symlinked `$TMPDIR` on macOS is the case that actually
 * surfaced this, measured 2026-09-19 — still answer the same project rather
 * than silently minting two.
 *
 * @param {string} home
 * @param {string} path
 * @returns {ProjectRecord|null}
 */
export function findProjectByPath(home, path) {
  const id = readIndex(home)[resolveIdentity(path)];
  return id ? readProject(home, id) : null;
}

/**
 * Register `path` as a project, or update the existing one at that path.
 *
 * A path seen for the first time mints a new id and an index entry that
 * outlives any single call. A path already in the index keeps its id — this
 * is the "registers once, not twice" half of R4 — and only its record is
 * refreshed: the remotes are replaced with what the caller passed just now.
 * A changed remote list is not a new identity, since the project is keyed by
 * path; it is simply the current fact about a path that can gain, lose or
 * rename a remote over its lifetime, so each registration overwrites the
 * list rather than accumulating history the caller no longer observes.
 *
 * @param {string} home
 * @param {string} path
 * @param {string[]} [remotes]
 * @returns {ProjectRecord}
 */
export function registerProject(home, path, remotes = []) {
  const resolved = resolveIdentity(path);
  const index = readIndex(home);
  let id = index[resolved];
  if (!id) {
    id = randomUUID();
    writeJsonAtomic(projectIndexPath(home), { ...index, [resolved]: id });
  }
  const existing = readProject(home, id);
  const now = new Date().toISOString();
  /** @type {ProjectRecord} */
  const record = {
    schemaVersion: 1,
    id,
    path: resolved,
    remotes: [...remotes],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeJsonAtomic(projectRecordPath(home, id), record);
  return record;
}
