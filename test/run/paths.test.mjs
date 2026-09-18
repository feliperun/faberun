/**
 * This is the one file in `test/` allowed to spell the runs directory literal
 * directly (the exact token RUNS_DIR_NAME holds): it is the resolver's own
 * test, pinning what `src/run/paths.mjs` produces. A test that pins a
 * function's output cannot call that function to build its own expectation --
 * that would only assert the function equals itself. Every other test
 * composes a fixture path through this module's resolver instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  RUNS_DIR_NAME,
  attemptWorktreePath,
  campaignTree,
  campaignsRoot,
  candidateWorktreePath,
  runDirectory,
  runsRoot,
} from "../../src/run/paths.mjs";

test("RUNS_DIR_NAME is the literal pathspec users need", () => {
  assert.equal(RUNS_DIR_NAME, ".runs");
});

test("runsRoot is <cwd>/.runs", () => {
  assert.equal(runsRoot("/repo"), join("/repo", ".runs"));
});

test("runDirectory is <cwd>/.runs/<runId>", () => {
  assert.equal(runDirectory("/repo", "run-1"), join("/repo", ".runs", "run-1"));
});

test("campaignsRoot is <cwd>/.runs/campaigns", () => {
  assert.equal(campaignsRoot("/repo"), join("/repo", ".runs", "campaigns"));
});

test("campaignTree is <cwd>/.runs/campaigns/<campaignId>", () => {
  assert.equal(campaignTree("/repo", "campaign-1"), join("/repo", ".runs", "campaigns", "campaign-1"));
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

test("a relative cwd resolves the same way it does today", () => {
  assert.equal(runsRoot("."), join(".", ".runs"));
  assert.equal(runDirectory(".", "run-1"), join(".", ".runs", "run-1"));
  assert.equal(campaignsRoot("."), join(".", ".runs", "campaigns"));
  assert.equal(campaignTree(".", "campaign-1"), join(".", ".runs", "campaigns", "campaign-1"));
  assert.equal(
    attemptWorktreePath(join(".", ".runs", "run-1"), "run-1", "node-a", 0),
    join(".", ".runs", "worktrees", "run-1", "node-a.0"),
  );
});
