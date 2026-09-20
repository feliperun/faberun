import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
import { createAttemptWorktree, runRefName } from "../../src/repo/worktree.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/**
 * The runner's own scratch tree is machine-owned state, not evidence of what
 * a worker changed: neither the relevant-paths walk nor the ignore-source walk
 * a workspace snapshot builds from may see into it, regardless of what git
 * itself would report about it.
 */

test(`captureWorkspaceSnapshot excludes ${RUNS_DIR_NAME} from both the entries and the ignore sources it captures`, () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-snapshot-"));
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "tracked.txt"), "hello\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "seed");

  // The runs tree carries content and its own `.gitignore`, so both walks
  // have something to wrongly pick up if the exclusion ever lapses.
  mkdirSync(join(root, RUNS_DIR_NAME, "results"), { recursive: true });
  writeFileSync(join(root, RUNS_DIR_NAME, "results", "build.json"), "{}\n");
  writeFileSync(join(root, RUNS_DIR_NAME, ".gitignore"), "ignored\n");

  const snapshot = captureWorkspaceSnapshot(root);

  assert.ok(snapshot.entries.some((entry) => entry.path === "tracked.txt"), "the tracked file is still snapshotted");
  assert.ok(
    !snapshot.entries.some((entry) => entry.path === RUNS_DIR_NAME || entry.path.startsWith(`${RUNS_DIR_NAME}/`)),
    "nothing under the runs directory appears among the relevant entries",
  );

  assert.ok(snapshot.ignoreSources.some((entry) => entry.path === ".gitignore"), "the root ignore file is still an ignore source");
  assert.ok(
    !snapshot.ignoreSources.some((entry) => entry.path === RUNS_DIR_NAME || entry.path.startsWith(`${RUNS_DIR_NAME}/`)),
    "the ignore-source walk never descends into the runs directory",
  );
});

test("a declared read git does not track is carried into the attempt worktree; a tracked file keeps its checkout version", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-declared-reads-"));
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  writeFileSync(join(root, ".gitignore"), "staged/\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "seed");
  git("update-ref", runRefName("declared-reads-run"), "HEAD");

  // What the plan pipeline's relay looks like: a gitignored scratch file
  // staged under the repository and named in readFiles — plus a tracked read
  // whose working copy has gone dirty since the seed commit, and a file that
  // exists only outside the repository.
  mkdirSync(join(root, "staged", "campaign"), { recursive: true });
  writeFileSync(join(root, "staged", "campaign", "repo-facts.json"), "{\"facts\":true}\n");
  writeFileSync(join(root, "untracked.txt"), "untracked\n");
  writeFileSync(join(root, "tracked.txt"), "dirty working copy\n");
  const outside = mkdtempSync(join(tmpdir(), "worktree-declared-reads-out-"));
  writeFileSync(join(outside, "escape.txt"), "outside\n");

  // attemptWorktreePath places the worktree beside the run directory
  // (dirname(runDir)/worktrees/…), so the run directory needs this test's own
  // parent: one directly under the shared tmpdir would aim every run of this
  // test at the same worktree path, and the first run's leftover would fail
  // every later one on the identity check.
  const runDir = join(mkdtempSync(join(tmpdir(), "worktree-declared-reads-runs-")), "declared-reads-run");

  const worktree = createAttemptWorktree({
    repo: root,
    runDir,
    runId: "declared-reads-run",
    nodeId: "plan",
    attempt: 1,
    declaredReads: [
      "tracked.txt",
      "staged/campaign/repo-facts.json",
      "untracked.txt",
      "missing.txt",
      `../${basename(outside)}/escape.txt`,
    ],
  });

  assert.equal(
    readFileSync(join(worktree.path, "staged", "campaign", "repo-facts.json"), "utf8"),
    "{\"facts\":true}\n",
    "the gitignored declared read reaches the worker's worktree",
  );
  assert.equal(readFileSync(join(worktree.path, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(
    readFileSync(join(worktree.path, "tracked.txt"), "utf8"),
    "committed\n",
    "a tracked read comes from the checkout, never the dirty working copy",
  );
  assert.equal(existsSync(join(worktree.path, "missing.txt")), false, "an absent declared read is skipped, not fabricated");
  assert.equal(existsSync(join(worktree.path, basename(outside))), false, "a path resolving outside the repository is never copied");
});
