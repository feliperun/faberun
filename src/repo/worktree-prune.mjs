/**
 * Releasing the attempt worktrees of runs whose work has already landed.
 * `campaign close` releases a campaign's worktrees, but a long campaign
 * integrates run after run long before it closes. Measured 2026-09-25 on
 * `planner-and-routing`: 19 registered worktrees from five finished runs, all
 * already merged into the campaign branch. Separate from `worktree.mjs`
 * because deciding which runs are finished and integrated reads run state
 * (`run/disk-gc.mjs`) and every branch of the repository, while `worktree.mjs`
 * only acts on one run it is handed.
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { SETTLED } from "../engine/prompts.mjs";
import { describeRuns } from "../run/disk-gc.mjs";
import { worktreeRoot } from "../run/paths.mjs";
import { git, gitHead, releaseRunWorktrees, runRefName } from "./worktree.mjs";

/** @typedef {{runId: string, removed: number, archived: string[]}} PrunedRun */

/**
 * Is the run's integrated head already on a branch of the operator's? An
 * attempt branch (`refs/heads/faberun/…`) holds the run's own commits and
 * does not count; a run with no run ref has nothing integrated to check.
 *
 * @param {string} repo
 * @param {string} runId
 * @returns {boolean}
 */
function runRefLanded(repo, runId) {
  const ref = runRefName(runId);
  if (!gitHead(repo, ref)) return false;
  return git(repo, ["for-each-ref", "--contains", ref, "--format=%(refname)", "refs/heads"])
    .split("\n")
    .some((name) => name && !name.startsWith("refs/heads/faberun/"));
}

/**
 * @param {string} runDir
 * @returns {boolean}
 */
function allNodesSettled(runDir) {
  const names = readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json"));
  return names.length > 0 && names.every((name) => SETTLED.has(JSON.parse(readFileSync(join(runDir, "nodes", name), "utf8")).status));
}

/**
 * Release the attempt worktrees of every run that no controller holds, whose
 * nodes are all terminal, and whose run ref a local branch already contains.
 * `releaseRunWorktrees` keeps each attempt's HEAD and uncommitted delta under
 * `refs/faberun-archive/`, so a released attempt can still be recovered.
 * `parked` also takes a run with a blocked or exhausted node: only on the
 * operator's word, because a resume that re-judges an attempt reads its
 * worktree, and only the operator knows the run was superseded.
 *
 * @param {string} repo
 * @param {string} runsDir
 * @param {{parked?: boolean}} [options]
 * @returns {PrunedRun[]}
 */
export function pruneIntegratedRunWorktrees(repo, runsDir, options = {}) {
  /** @type {PrunedRun[]} */
  const pruned = [];
  for (const run of describeRuns(runsDir)) {
    if (run.hasActiveController) continue;
    if (!run.allNodesTerminal && !(options.parked === true && allNodesSettled(run.path))) continue;
    const runId = basename(run.path);
    if (!existsSync(worktreeRoot(join(runsDir, runId), runId))) continue;
    if (!runRefLanded(repo, runId)) continue;
    pruned.push({ runId, ...releaseRunWorktrees(repo, join(runsDir, runId), runId) });
  }
  return pruned;
}
