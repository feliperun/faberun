/**
 * Where a run, a campaign and a worktree tree live on disk, and the name of
 * the runs directory itself.
 *
 * Every one of these shapes used to be spelled out inline, independently, at
 * each call site that needed it, all sharing the literal `".runs"`. A later
 * move or rename of that directory had to find and change every one of them
 * separately; this module is the one place such a change is made instead. It
 * composes `campaign/layout.mjs`, which already owns the campaign directory
 * shape given a runs root, rather than re-deriving it.
 *
 * Since R2 the runs root answers from the operator's home, not the
 * repository: `runsRoot(cwd)` is `<home>/projects/<id>/runs` for the project
 * `cwd` belongs to, so run state survives a repository move and never lands
 * inside the target tree. A repository that still holds its own `.runs` from
 * before the move keeps being answered there until the migration command has
 * run, because answering the home side of a not-yet-migrated repository would
 * split its state across two layouts.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { campaignDir, campaignsDir } from "../campaign/layout.mjs";
import { faberunHome } from "../host/home.mjs";
import { findProjectByPath, projectsDir, readProject, registerProject } from "../host/projects.mjs";

/** The runs directory name, relative to the tree it lives under. */
export const RUNS_DIR_NAME = ".runs";

/** The runs directory name inside a project's directory under the home. */
const PROJECT_RUNS_DIR_NAME = "runs";

/**
 * The runs directory for a working tree: the project's runs directory under
 * `faberunHome()`, or — for a repository that still holds its own `.runs`
 * and has nothing under the home yet — that directory, with a warning.
 *
 * Resolving registers a never-seen path on demand. The alternative is a
 * separate init step before the first run of any repository, which no
 * existing workflow performs; a resolve is how every consumer announces the
 * repository it is working on, so it is also where the registration belongs.
 * The registry write happens once per path: a known project resolves through
 * two small read-only reads (the index, the record).
 *
 * When both layouts exist the home side wins. That is the mid-migration
 * case: the migration command copies the repository's state into the home
 * and removes the original afterwards, so a present home directory is the
 * authoritative copy and the leftover `.runs` is the stale pre-copy one.
 * Letting the repository side win would make a completed migration whose
 * cleanup failed silently answer from state the migration already superseded.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function runsRoot(cwd) {
  const home = faberunHome();
  const project = findProjectByPath(home, cwd);
  const homeRuns = project ? projectRunsDir(home, project.id) : null;
  if (homeRuns && existsSync(homeRuns)) return homeRuns;
  const legacy = join(cwd, RUNS_DIR_NAME);
  if (existsSync(legacy)) {
    warnLegacyRuns(legacy);
    return legacy;
  }
  const registered = project ?? registerProject(home, cwd);
  return projectRunsDir(home, registered.id);
}

/** @param {string} home @param {string} id @returns {string} */
function projectRunsDir(home, id) {
  return join(projectsDir(home), id, PROJECT_RUNS_DIR_NAME);
}

let warnedLegacyRuns = false;

/**
 * One warning per process, not per resolve: the resolver sits under a hot
 * path, and repeating the same stderr line at every call would bury whatever
 * the command is actually printing.
 *
 * @param {string} legacyPath
 * @returns {void}
 */
function warnLegacyRuns(legacyPath) {
  if (warnedLegacyRuns) return;
  warnedLegacyRuns = true;
  process.stderr.write(`[warn] runs · ${legacyPath} still holds this repository's runs; move them under the home with \`faberun migrate\`\n`);
}

/**
 * The project id a runs directory under the home layout carries, or null for
 * any other shape — a legacy `<repo>/.runs` answers null because
 * `RUNS_DIR_NAME` is dotted and `PROJECT_RUNS_DIR_NAME` is not.
 *
 * `<home>/projects/<id>/runs` is composed entirely by this module, so the id
 * sits at a fixed position: between the `projects` segment and the runs
 * directory itself. Readers that must name the repository a runs directory
 * belongs to (the AGENTS.md signal block, campaign ledger preservation) parse
 * it here instead of deriving a sibling path by directory arithmetic, which
 * only held while runs lived inside the repository.
 *
 * @param {string} runsDir
 * @returns {string|null}
 */
export function projectIdForRunsDir(runsDir) {
  const parts = resolve(runsDir).split(sep);
  const id = parts.at(-2);
  if (parts.at(-3) !== "projects" || parts.at(-1) !== PROJECT_RUNS_DIR_NAME || !id) return null;
  return id;
}

/**
 * The repository path a runs directory belongs to, read live from the
 * project registry, or null when the runs directory is not under the home
 * layout or its project has no record. Live, never cached: a project
 * reassociated to a new path must answer its current repository.
 *
 * @param {string} runsDir
 * @returns {string|null}
 */
export function repositoryForRunsDir(runsDir) {
  const id = projectIdForRunsDir(runsDir);
  if (!id) return null;
  return readProject(faberunHome(), id)?.path ?? null;
}

/**
 * A single run's own directory.
 *
 * @param {string} cwd
 * @param {string} runId
 * @returns {string}
 */
export function runDirectory(cwd, runId) {
  return join(runsRoot(cwd), runId);
}

/**
 * The live-preflight verdict store, at the top of the home. Whether a
 * provider answers is a fact about this machine and this operator -- the same
 * binary, model and credential whatever repository or contract asks -- so the
 * record outlives any one run and is shared by every project. This module
 * owns every path under the home and is the only place that names this one.
 *
 * @returns {string}
 */
export function availabilityPath() {
  return join(faberunHome(), "availability.json");
}

/** @returns {string} the machine-wide record of each account's provider-reported usage windows */
export function usageWindowsPath() {
  return join(faberunHome(), "usage-windows.json");
}

/**
 * The campaigns directory beneath a runs root: `<runs>/campaigns`.
 * Composes `campaign/layout.mjs`'s `campaignsDir`, which owns the shape given
 * a runs root.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function campaignsRoot(cwd) {
  return campaignsDir(runsRoot(cwd));
}

/**
 * A single campaign's own directory: `<runs>/campaigns/<campaignId>`.
 * Composes `campaign/layout.mjs`'s `campaignDir`, which owns the shape given
 * a runs root.
 *
 * @param {string} cwd
 * @param {string} campaignId
 * @returns {string}
 */
export function campaignTree(cwd, campaignId) {
  return campaignDir(runsRoot(cwd), campaignId);
}

/** @param {string} runDir @param {string} runId @returns {string} */
export function worktreeRoot(runDir, runId) {
  return join(dirname(runDir), "worktrees", runId);
}

/**
 * The isolated worktree for one attempt at one node.
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} attempt
 * @returns {string}
 */
export function attemptWorktreePath(runDir, runId, nodeId, attempt) {
  return join(worktreeRoot(runDir, runId), `${nodeId}.${attempt}`);
}

/**
 * The detached worktree an integration candidate is verified in.
 *
 * @param {string} runDir
 * @param {string} runId
 * @returns {string}
 */
export function candidateWorktreePath(runDir, runId) {
  return join(worktreeRoot(runDir, runId), ".candidate");
}
