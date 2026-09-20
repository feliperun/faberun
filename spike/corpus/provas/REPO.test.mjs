/**
 * Corpus proof, REPO: the excludes file a repository's own Git configuration
 * names is an ignore source of the workspace snapshot.
 *
 * `captureWorkspaceSnapshot` fingerprints the rules that decide what the
 * snapshot can see, so a worker that edits one mid-node cannot move a file out
 * of view. The repository config and `.git/info/exclude` are fingerprinted; the
 * file `core.excludesFile` points at is not. Git honours that file when it
 * enumerates the workspace with `--exclude-standard`, so one edit to it hides a
 * write from the comparison in the same breath, and the node passes.
 *
 * Fails on the tree before the requirement: the edit is invisible and
 * `compareWorkspaceSnapshot` returns a clean comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureWorkspaceSnapshot, compareWorkspaceSnapshot } from "../../../src/repo/workspace.mjs";

/**
 * A committed repository whose own Git configuration names an excludes file
 * outside the worktree, the file initialized empty.
 *
 * @returns {{repo: string, excludes: string}}
 */
function repositoryWithExcludesFile() {
  const base = mkdtempSync(join(tmpdir(), "faberun-corpus-repo-excludes-"));
  const repo = join(base, "repo");
  const excludes = join(base, "repo-excludes");
  mkdirSync(repo);
  writeFileSync(excludes, "");
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  git("config", "core.excludesFile", excludes);
  writeFileSync(join(repo, "README.md"), "read\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "seed");
  return { repo, excludes };
}

test("editing the excludes file a repository's configuration names fails the snapshot closed", () => {
  const { repo, excludes } = repositoryWithExcludesFile();
  const before = captureWorkspaceSnapshot(repo);

  // One edit to an ignore source the snapshot does not fingerprint, then the
  // write that edit hides. `git ls-files --others --exclude-standard` stops
  // reporting hidden.txt, so the comparison sees no diff at all.
  writeFileSync(excludes, "hidden.txt\n");
  writeFileSync(join(repo, "hidden.txt"), "written by the worker\n");

  assert.throws(
    () => compareWorkspaceSnapshot(before, repo, { files: [], roots: [] }),
    /ignore sources changed/u,
    "the file core.excludesFile names is an ignore source: changing it must fail closed, never pass with the hidden write missing from the diff",
  );
});

test("editing the configured excludes file fails closed even when it hides nothing", () => {
  const { repo, excludes } = repositoryWithExcludesFile();
  const before = captureWorkspaceSnapshot(repo);

  // The rule is about the rules, not about a hidden path: a source change fails
  // the comparison on its own, whatever the new pattern would have matched.
  writeFileSync(excludes, "matches-nothing-at-all.txt\n");

  assert.throws(
    () => compareWorkspaceSnapshot(before, repo, { files: [], roots: [] }),
    /ignore sources changed/u,
    "an ignore source change fails the comparison by itself",
  );
});
