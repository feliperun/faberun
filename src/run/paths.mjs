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
 */
import { dirname, join } from "node:path";
import { campaignDir, campaignsDir } from "../campaign/layout.mjs";

/** The runs directory name, relative to the tree it lives under. */
export const RUNS_DIR_NAME = ".runs";

/**
 * The runs directory for a working tree.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function runsRoot(cwd) {
  return join(cwd, RUNS_DIR_NAME);
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
 * The campaigns directory beneath a runs root: `<cwd>/.runs/campaigns`.
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
 * A single campaign's own directory: `<cwd>/.runs/campaigns/<campaignId>`.
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
function worktreeRoot(runDir, runId) {
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
