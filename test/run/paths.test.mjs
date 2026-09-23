/**
 * This is the one file in `test/` allowed to spell the runs directory literal
 * directly (the exact token RUNS_DIR_NAME holds): it is the resolver's own
 * test, pinning what `src/run/paths.mjs` produces. A test that pins a
 * function's output cannot call that function to build its own expectation --
 * that would only assert the function equals itself. Every other test
 * composes a fixture path through this module's resolver instead.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectByPath, registerProject } from "../../src/host/projects.mjs";
import { reassociateProject } from "../../src/cli/project.mjs";
import {
  RUNS_DIR_NAME,
  attemptWorktreePath,
  campaignTree,
  campaignsRoot,
  candidateWorktreePath,
  projectIdForRunsDir,
  repositoryForRunsDir,
  runDirectory,
  runsRoot,
} from "../../src/run/paths.mjs";

/** A fresh, empty `$FABERUN_HOME` for one test: the resolver reads it per call. */
function home() {
  const directory = mkdtempSync(join(tmpdir(), "faberun-paths-home-"));
  process.env.FABERUN_HOME = directory;
  return directory;
}

/**
 * @returns {string} a fresh, empty directory standing in for a repository,
 *   realpath-resolved: the registry keys on it, since $TMPDIR itself is a
 *   symlink on macOS (`/var` -> `/private/var`).
 */
function repo() {
  return realpathSync(mkdtempSync(join(tmpdir(), "faberun-paths-repo-")));
}

/** @param {() => void} body @returns {string} everything written to stderr during `body` */
function captureStderr(body) {
  /** @type {string[]} */
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    body();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("RUNS_DIR_NAME is the literal pathspec users need", () => {
  assert.equal(RUNS_DIR_NAME, ".runs");
});

test("a never-seen path resolves under the home and registers its project", () => {
  const root = home();
  const directory = repo();
  const runs = runsRoot(directory);
  const project = findProjectByPath(root, directory);
  assert.ok(project, "resolving registered the project");
  assert.equal(runs, join(root, "projects", project.id, "runs"));
});

test("a registered project resolves under its own project directory", () => {
  const root = home();
  const directory = repo();
  const project = registerProject(root, directory);
  const runs = runsRoot(directory);
  assert.equal(runs, join(root, "projects", project.id, "runs"));
  assert.equal(runDirectory(directory, "run-1"), join(runs, "run-1"));
  assert.equal(campaignsRoot(directory), join(runs, "campaigns"));
  assert.equal(campaignTree(directory, "campaign-1"), join(runs, "campaigns", "campaign-1"));
});

test("two clones at two paths resolve to two different places", () => {
  const root = home();
  const first = runsRoot(repo());
  const second = runsRoot(repo());
  assert.notEqual(first, second);
  assert.equal(first.startsWith(join(root, "projects")), true);
  assert.equal(second.startsWith(join(root, "projects")), true);
});

test("a repository holding the old layout still resolves to it, warned once", () => {
  const root = home();
  const directory = repo();
  mkdirSync(join(directory, RUNS_DIR_NAME));
  const stderr = captureStderr(() => {
    assert.equal(runsRoot(directory), join(directory, RUNS_DIR_NAME));
    assert.equal(runsRoot(directory), join(directory, RUNS_DIR_NAME));
  });
  assert.equal(stderr.split("faberun migrate").length - 1, 1, "the warning names the migration command, once per process");
  assert.equal(findProjectByPath(root, directory), null, "answering the old layout is a read, not a registration");
});

test("when both layouts exist the home side wins", () => {
  const root = home();
  const directory = repo();
  mkdirSync(join(directory, RUNS_DIR_NAME));
  const project = registerProject(root, directory);
  mkdirSync(join(root, "projects", project.id, "runs"), { recursive: true });
  const stderr = captureStderr(() => {
    assert.equal(runsRoot(directory), join(root, "projects", project.id, "runs"));
  });
  assert.equal(stderr, "", "the migrated copy is authoritative, so no legacy warning");
});

test("projectIdForRunsDir parses the project id and rejects the legacy shape", () => {
  const root = home();
  const directory = repo();
  const runs = runsRoot(directory);
  const project = findProjectByPath(root, directory);
  assert.ok(project);
  assert.equal(projectIdForRunsDir(runs), project.id);
  assert.equal(projectIdForRunsDir(join(directory, RUNS_DIR_NAME)), null);
});

test("repositoryForRunsDir answers the registered repository, live after a move", () => {
  const root = home();
  const directory = repo();
  const runs = runsRoot(directory);
  assert.equal(repositoryForRunsDir(runs), directory);
  const moved = join(root, "moved-clone");
  reassociateProject(root, moved, { from: directory });
  assert.equal(repositoryForRunsDir(runs), moved, "the lookup reads the registry, not a cached path");
});

test("attemptWorktreePath is <dirname(runDir)>/worktrees/<runId>/<nodeId>.<attempt>", () => {
  assert.equal(
    attemptWorktreePath("/repo/.runs/run-1", "run-1", "node-a", 2),
    join("/repo/.runs", "worktrees", "run-1", "node-a.2"),
  );
});

test("candidateWorktreePath is <dirname(runDir)>/worktrees/<runId>/.candidate", () => {
  assert.equal(
    candidateWorktreePath("/repo/.runs/run-1", "run-1"),
    join("/repo/.runs", "worktrees", "run-1", ".candidate"),
  );
});

test("a relative cwd resolves to the same place its absolute form does", () => {
  home();
  assert.equal(resolve(runsRoot(".")), runsRoot(process.cwd()));
});
