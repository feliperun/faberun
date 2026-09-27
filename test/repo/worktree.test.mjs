import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidateRefName, createPreservedRef, preservedRefName, releaseRunWorktrees, runRefName, sealAttempt } from "../../src/repo/worktree.mjs";
import { initializeGit } from "../helpers.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/**
 * The ref verb `cancel` needs: one integrated commit per node, preserved under
 * the run's own `refs/faberun/<run-id>/` namespace so releasing the run ref
 * and the attempt branches never orphans the work the run integrated. The gc
 * case at the bottom is the point of the whole verb.
 */

/** @param {string} repo @param {string[]} args @returns {string} */
function gitOut(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * A throwaway repository with one committed file, the integrated work. Built
 * through the shared fixture helper, whose import also points FABERUN_HOME at
 * a throwaway home, so this suite never writes into the operator's own
 * ~/.faberun as a side effect.
 *
 * @returns {string}
 */
function fixtureRepo() {
  const directory = mkdtempSync(join(tmpdir(), "runner-worktree-preserve-"));
  writeFileSync(join(directory, "integrated.txt"), "integrated work\n");
  initializeGit(directory);
  return directory;
}

test("createPreservedRef puts refs/faberun/<run-id>/preserved/<node-id> at the integrated commit", () => {
  const repo = fixtureRepo();
  const sha = gitOut(repo, ["rev-parse", "HEAD"]);
  const ref = createPreservedRef(repo, "preserve-1", "integrate", sha);
  assert.equal(ref, "refs/faberun/preserve-1/preserved/integrate");
  assert.equal(ref, preservedRefName("preserve-1", "integrate"));
  assert.equal(gitOut(repo, ["rev-parse", ref]), sha);
  // Inside the run's namespace, yet neither of the two names the launch path
  // refuses on when it already exists.
  assert.notEqual(ref, runRefName("preserve-1"));
  assert.notEqual(ref, candidateRefName("preserve-1"));
  assert.deepEqual(gitOut(repo, ["for-each-ref", "--format=%(refname)", "refs/faberun/preserve-1/"]).split("\n"), [ref]);
});

test("creating the same preserved ref twice at the same sha neither fails nor moves it", () => {
  const repo = fixtureRepo();
  const sha = gitOut(repo, ["rev-parse", "HEAD"]);
  const ref = createPreservedRef(repo, "preserve-2", "integrate", sha);
  assert.doesNotThrow(() => createPreservedRef(repo, "preserve-2", "integrate", sha));
  assert.equal(gitOut(repo, ["rev-parse", ref]), sha, "the second creation left the target where it was");
});

test("the preserved ref keeps the integrated commit readable through git gc --prune=now", () => {
  const repo = fixtureRepo();
  const sha = gitOut(repo, ["rev-parse", "HEAD"]);
  const ref = createPreservedRef(repo, "preserve-3", "integrate", sha);
  // Every other name that reaches the commit goes: the branch it was committed
  // on. Only the preserved ref is left holding it.
  execFileSync("git", ["-C", repo, "update-ref", "-d", `refs/heads/${gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"])}`], { stdio: "ignore" });
  assert.deepEqual(gitOut(repo, ["for-each-ref", "--format=%(refname)"]).split("\n"), [ref]);
  // Reflogs would root the commit on their own and let this pass for the
  // wrong reason; expire them so the ref is provably the only root left.
  execFileSync("git", ["-C", repo, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "gc", "--prune=now"], { stdio: "ignore" });
  assert.equal(gitOut(repo, ["cat-file", "-t", sha]), "commit", "the integrated commit survived the gc");
  assert.equal(gitOut(repo, ["rev-parse", ref]), sha);
});

// Measured 2026-09-23: the campaign branch of evidence-you-can-recompute
// carried seal commits titled `faberun <run> <node> attempt 1`, and the PR's
// commit-message check (commitlint, conventional) refuses every one, so each
// campaign PR had to be rebuilt as a squash. A seal answers to the factory,
// but it lands in branches that answer to this convention.
test("a seal commit message follows the conventional commit shape", () => {
  const repo = mkdtempSync(join(tmpdir(), "seal-message-"));
  writeFileSync(join(repo, "README.md"), "base\n");
  initializeGit(repo);
  writeFileSync(join(repo, "sealed.txt"), "work\n");
  const runId = "a-run-whose-id-is-long-enough-to-matter-2026-09-23";
  sealAttempt({ repo, path: repo, baseSha: null, runId, nodeId: "build", attempt: 2 });
  const message = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" }).trim();
  const [header, ...rest] = message.split("\n");
  assert.match(header, /^chore\(faberun\): seal build attempt 2$/u);
  assert.ok(header.length <= 100, "commitlint's header-max-length");
  assert.match(rest.join("\n"), new RegExp(`run ${runId}`, "u"), "the run id stays in the body");
});

// Measured 2026-09-24: attempts that were never accepted kept their worktree
// and branch forever; one machine held 41 registered and 42 orphaned ones.
test("a finished run's worktrees are released, and each one's HEAD and delta are kept under an archive ref", () => {
  const repo = mkdtempSync(join(tmpdir(), "release-run-worktrees-"));
  writeFileSync(join(repo, "README.md"), "base\n");
  initializeGit(repo);
  const runId = "released-run";
  const runDir = join(repo, RUNS_DIR_NAME, runId);
  const dirty = join(repo, RUNS_DIR_NAME, "worktrees", runId, "build.1");
  const clean = join(repo, RUNS_DIR_NAME, "worktrees", runId, "build.2");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `faberun/${runId}/build/1`, dirty]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `faberun/${runId}/build/2`, clean]);
  writeFileSync(join(dirty, "README.md"), "work nobody sealed\n");

  const released = releaseRunWorktrees(repo, runDir, runId);

  assert.equal(released.removed, 2);
  assert.deepEqual(released.archived.sort(), [`refs/faberun-archive/${runId}/build.1`, `refs/faberun-archive/${runId}/build.2`]);
  assert.equal(existsSync(join(repo, RUNS_DIR_NAME, "worktrees", runId)), false, "the run's worktree directory is gone");
  const list = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.equal(list.includes(runId), false, "git no longer lists them");
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", `faberun/${runId}/*`], { encoding: "utf8" }).trim();
  assert.equal(branches, "", "their branches are deleted");
  const kept = execFileSync("git", ["-C", repo, "show", `refs/faberun-archive/${runId}/build.1:README.md`], { encoding: "utf8" });
  assert.equal(kept, "work nobody sealed\n", "the uncommitted delta survives in the archive ref");
  assert.deepEqual(releaseRunWorktrees(repo, runDir, runId), { removed: 0, archived: [] }, "a second release is a no-op");
});
