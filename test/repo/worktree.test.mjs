import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidateRefName, createPreservedRef, preservedRefName, runRefName } from "../../src/repo/worktree.mjs";
import { initializeGit } from "../helpers.mjs";

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
