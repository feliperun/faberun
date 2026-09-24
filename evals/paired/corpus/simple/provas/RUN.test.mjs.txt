/**
 * Corpus proof, RUN: garbage collection reclaims a run's worktree tree
 * together with the run directory, and names it in the ledger.
 *
 * `.runs/worktrees/<runId>/` holds one full checkout per attempt — the largest
 * thing a finished run leaves behind. GC removes `<runsDir>/<runId>` and stops,
 * so the disk it was reclaiming stays occupied by orphaned worktrees, and
 * `gc.jsonl` reports only the run directory, as if nothing were left.
 *
 * Fails on the tree before the requirement: the run directory is removed, its
 * worktree tree survives, and the ledger does not mention it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeRuns, runGarbageCollection, selectGarbageCollectableRuns } from "../../../src/run/disk-gc.mjs";
import { attemptWorktreePath } from "../../../src/run/paths.mjs";

/**
 * One run directory as the store writes it, plus the attempt worktree its node
 * was cut in, created at the path `src/run/paths.mjs` owns.
 *
 * @param {string} runsDir
 * @param {string} id
 * @param {string} status the persisted status of the run's only node
 * @returns {{runDir: string, worktree: string}}
 */
function seedRun(runsDir, id, status) {
  const runDir = join(runsDir, id);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({ startedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  writeFileSync(join(runDir, "nodes", "build.json"), `${JSON.stringify({ id: "build", status })}\n`);
  const worktree = attemptWorktreePath(runDir, id, "build", 1);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "checkout.txt"), "a full checkout of the target repository\n");
  return { runDir, worktree };
}

/**
 * @param {string} runsDir
 * @returns {{finished: {runDir: string, worktree: string}, working: {runDir: string, worktree: string}}}
 */
function seedTwoRuns(runsDir) {
  const finished = seedRun(runsDir, "run-finished", "done");
  // A node still running makes the run ineligible: its worktree is live work.
  const working = seedRun(runsDir, "run-working", "running");
  return { finished, working };
}

test("a collected run's worktree tree is reclaimed with its run directory", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "faberun-corpus-run-gc-"));
  const { finished, working } = seedTwoRuns(runsDir);

  assert.deepEqual(
    selectGarbageCollectableRuns(describeRuns(runsDir), {}),
    [finished.runDir],
    "only the run whose every node is terminal is a candidate",
  );

  const { removed } = runGarbageCollection(runsDir, { isAboveThreshold: () => false });
  assert.ok(removed.includes(finished.runDir), "the finished run's directory was removed");
  assert.ok(!removed.includes(working.runDir), "the run holding a non-terminal node was never a candidate");

  assert.equal(existsSync(finished.runDir), false, "the run directory is gone");
  assert.equal(
    existsSync(finished.worktree),
    false,
    "the run's worktree tree is reclaimed with the run directory, not left orphaned",
  );
  assert.equal(existsSync(working.runDir), true, "a run holding a non-terminal node is untouched");
  assert.equal(existsSync(working.worktree), true, "and its worktree tree is untouched");
});

test("the reclaimed worktree tree is named in the gc ledger", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "faberun-corpus-run-gc-ledger-"));
  const { finished } = seedTwoRuns(runsDir);

  runGarbageCollection(runsDir, { isAboveThreshold: () => false });

  const ledger = readFileSync(join(runsDir, "gc.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  // The run directory is not an ancestor of the worktree tree, so a record for
  // the run alone cannot satisfy this: the record must name the worktree tree,
  // or a path inside it.
  assert.ok(
    ledger.some((record) => typeof record.path === "string"
      && (record.path === finished.worktree || finished.worktree.startsWith(`${record.path}/`))),
    `every removal is recorded, so the worktree tree it removed is named in gc.jsonl: ${JSON.stringify(ledger)}`,
  );
});
