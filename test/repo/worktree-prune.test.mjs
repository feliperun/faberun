import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneIntegratedRunWorktrees } from "../../src/repo/worktree-prune.mjs";
import { runRefName } from "../../src/repo/worktree.mjs";
import { initializeGit } from "../helpers.mjs";

/** @param {string} repo @param {string[]} args @returns {string} */
function gitOut(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * One finished-or-not run under `runsDir` with one attempt worktree, its run
 * ref at `runRef` (or at the attempt's own commit when `runRef` is null).
 *
 * @param {string} repo
 * @param {string} runsDir
 * @param {string} runId
 * @param {{status: string, runRef: string|null}} options
 * @returns {string} the attempt worktree path
 */
function seedRun(repo, runsDir, runId, { status, runRef }) {
  const runDir = join(runsDir, runId);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ startedAt: new Date().toISOString() }));
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status }));
  const attempt = join(runsDir, "worktrees", runId, "build.1");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `faberun/${runId}/build/1`, attempt]);
  if (runRef === null) {
    writeFileSync(join(attempt, "work.txt"), `${runId}\n`);
    execFileSync("git", ["-C", attempt, "add", "work.txt"]);
    execFileSync("git", ["-C", attempt, "commit", "-q", "-m", "chore(faberun): seal build attempt 1"]);
  }
  gitOut(repo, ["update-ref", runRefName(runId), runRef ?? gitOut(attempt, ["rev-parse", "HEAD"])]);
  return attempt;
}

test("prune releases the worktrees of a finished run a branch already holds, and a parked one only when asked", () => {
  const repo = mkdtempSync(join(tmpdir(), "worktree-prune-"));
  writeFileSync(join(repo, "README.md"), "base\n");
  initializeGit(repo);
  const runsDir = mkdtempSync(join(tmpdir(), "worktree-prune-runs-"));
  const head = gitOut(repo, ["rev-parse", "HEAD"]);

  const landed = seedRun(repo, runsDir, "landed", { status: "done", runRef: head });
  writeFileSync(join(landed, "README.md"), "delta nobody sealed\n");
  const unlanded = seedRun(repo, runsDir, "unlanded", { status: "done", runRef: null });
  const moving = seedRun(repo, runsDir, "moving", { status: "running", runRef: head });
  const parked = seedRun(repo, runsDir, "parked", { status: "exhausted", runRef: head });

  const pruned = pruneIntegratedRunWorktrees(repo, runsDir);

  assert.deepEqual(pruned.map((run) => [run.runId, run.removed]), [["landed", 1]]);
  assert.equal(existsSync(landed), false, "the landed run's attempt worktree is gone");
  assert.equal(gitOut(repo, ["show", "refs/faberun-archive/landed/build.1:README.md"]), "delta nobody sealed", "its uncommitted delta is archived first");
  assert.equal(existsSync(unlanded), true, "work only an attempt branch holds is not integrated");
  assert.equal(existsSync(moving), true, "a run with a node that can still move is left alone");
  assert.equal(existsSync(parked), true, "a parked run may still be resumed, so a plain prune keeps it");
  assert.deepEqual(pruneIntegratedRunWorktrees(repo, runsDir), [], "a second prune finds nothing");
  assert.deepEqual(pruneIntegratedRunWorktrees(repo, runsDir, { parked: true }).map((run) => run.runId), ["parked"], "--parked takes the landed parked run");
  assert.equal(existsSync(parked), false);
  assert.equal(existsSync(moving), true, "--parked still never touches a run that can move");
});
