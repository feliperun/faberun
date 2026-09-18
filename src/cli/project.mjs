/**
 * `faberun project`: re-associate a project whose repository moved, keeping
 * its id -- and everything that will hang off that id -- untouched.
 *
 * `src/host/projects.mjs` is out of this node's write scope, and its public
 * surface (`registerProject`, `findProjectByPath`, `readProject`) has no
 * operation that keeps an existing id while giving it a new path:
 * `registerProject` either finds the id already at a path or mints a fresh
 * one, and a fresh id is exactly what a move must not produce. This module
 * therefore reads and rewrites `projects/index.json` and
 * `projects/<id>/project.json` directly, with the same temp-then-rename
 * discipline the registry itself uses, rather than inventing a second
 * on-disk format for the same directory.
 */
import { join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { errorCode } from "../util.mjs";
import { findProjectByPath, projectsDir, readProject } from "../host/projects.mjs";
import { boundedGitSync } from "../repo/worktree.mjs";

/** @typedef {import("../host/projects.mjs").ProjectRecord} ProjectRecord */

/**
 * The path-to-id index, read straight off `index.json`. Inlined at each of
 * its two call sites rather than pulled out as a shared top-level helper: the
 * identical helper already lives, unexported, in `host/projects.mjs`, which
 * this module cannot import from without that file entering its write scope.
 *
 * @param {string} indexPath
 * @returns {Record<string, string>}
 */
function readIndexAt(indexPath) {
  try {
    return /** @type {Record<string, string>} */ (readJson(indexPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
}

/**
 * Every registered project, read straight off disk. Used only to search by
 * remote when the operator names no `--from`.
 *
 * @param {string} home
 * @returns {ProjectRecord[]}
 */
function listProjects(home) {
  const index = readIndexAt(join(projectsDir(home), "index.json"));
  const ids = new Set(Object.values(index));
  /** @type {ProjectRecord[]} */
  const projects = [];
  for (const id of ids) {
    const project = readProject(home, id);
    if (project) projects.push(project);
  }
  return projects;
}

/**
 * The remote URLs a git repository at `path` currently reports, or `[]` when
 * `path` is not a git repository, has no remote, or git is unavailable. An
 * operator who names `--from` never needs this at all.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function readRemotes(path) {
  const result = boundedGitSync(["-C", path, "remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return [];
  /** @type {Set<string>} */
  const urls = new Set();
  for (const line of /** @type {string} */ (result.stdout).split("\n")) {
    const match = /^\S+\s+(\S+)\s+\(/u.exec(line);
    if (match) urls.add(match[1]);
  }
  return [...urls];
}

/**
 * The registered project whose remotes overlap what `remotesOf(path)` reports
 * right now, or null when none does, or when `path` reports no remote at all.
 * More than one match is refused by the caller, not decided here.
 *
 * @param {string} home
 * @param {string} path
 * @param {(path: string) => string[]} remotesOf
 * @returns {ProjectRecord[]}
 */
function projectsMatchingRemotes(home, path, remotesOf) {
  const remotes = new Set(remotesOf(path));
  if (remotes.size === 0) return [];
  return listProjects(home).filter((project) => project.remotes.some((remote) => remotes.has(remote)));
}

/**
 * @param {string} home
 * @param {ProjectRecord} project
 * @param {string} newPath
 * @returns {ProjectRecord}
 */
function moveProject(home, project, newPath) {
  const indexPath = join(projectsDir(home), "index.json");
  const index = readIndexAt(indexPath);
  delete index[project.path];
  index[newPath] = project.id;
  writeJsonAtomic(indexPath, index);
  /** @type {ProjectRecord} */
  const record = { ...project, path: newPath, updatedAt: new Date().toISOString() };
  writeJsonAtomic(join(projectsDir(home), project.id, "project.json"), record);
  return record;
}

/**
 * Re-associate a project with the path its repository moved to.
 *
 * Idempotent by construction: when `newPath` is already the project's
 * registered path -- whether this is the first call or a repeat of one that
 * already landed -- the current record comes back untouched and nothing is
 * written. That is deliberate: an operator unsure whether a previous attempt
 * succeeded runs the same command again rather than inspecting the registry
 * first.
 *
 * With `options.from`, the project once registered at that path is moved.
 * Without it, the project is found by matching the git remotes `newPath`
 * reports now against the remotes every registered project last recorded;
 * no match, or more than one, is refused with a message naming what was
 * looked for, rather than guessed.
 *
 * @param {string} home
 * @param {string} newPath
 * @param {{from?: string, remotesOf?: (path: string) => string[]}} [options]
 * @returns {ProjectRecord}
 */
export function reassociateProject(home, newPath, options = {}) {
  const resolvedNew = resolve(newPath);
  const already = findProjectByPath(home, resolvedNew);
  if (already) return already;
  if (options.from) {
    const resolvedFrom = resolve(options.from);
    const found = findProjectByPath(home, resolvedFrom);
    if (!found) throw new Error(`no project is registered at ${resolvedFrom}`);
    return moveProject(home, found, resolvedNew);
  }
  const remotesOf = options.remotesOf ?? readRemotes;
  const matches = projectsMatchingRemotes(home, resolvedNew, remotesOf);
  if (matches.length === 0) throw new Error(`no registered project has the remotes reported at ${resolvedNew}`);
  if (matches.length > 1) throw new Error(`${matches.length} registered projects share a remote reported at ${resolvedNew}; pass --from to disambiguate`);
  return moveProject(home, matches[0], resolvedNew);
}
