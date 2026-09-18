import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { cancelRun } from "../../src/engine/cancel.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { gitHead, runRefName } from "../../src/repo/worktree.mjs";

import { fixture, orphan, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

test("a cancelled run's contract relaunches with no manual cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-relaunch-"));
  const path = writeContract(directory, fixture({ id: "cancel-relaunch-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  assert.equal(await cancelRun(runDir), true);
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).status, "canceled");

  const relaunched = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(relaunched.ok, true, "the contract relaunches with no manual cleanup between the cancel and this call");
  assert.equal(nodeState(relaunched).status, "done");
  assert.equal(relaunched.runDir, runDir, "the relaunch reclaims the same id's directory");

  const archives = readdirSync(dirname(runDir)).filter((name) => name.startsWith(`${basename(runDir)}.canceled-`));
  assert.equal(archives.length, 1, "the cancelled run's own directory is moved aside, not deleted");
  const archived = JSON.parse(readFileSync(join(dirname(runDir), archives[0], "nodes", "build.json"), "utf8"));
  assert.equal(archived.status, "canceled", "the archived directory still holds the cancelled run's evidence");
});

test("a run that ended without being cancelled still refuses a same-id relaunch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-no-cancel-relaunch-"));
  const path = writeContract(directory, fixture({ id: "no-cancel-relaunch-run", pollIntervalMs: 10 }));
  await withFakeCodex(directory, "pass", () => runContract(path));
  await assert.rejects(
    () => withFakeCodex(directory, "pass", () => runContract(path)),
    /run already exists/u,
  );
});

test("cancelling a run twice is not an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-twice-"));
  const path = writeContract(directory, fixture({ id: "cancel-twice-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  assert.equal(await cancelRun(runDir), true);
  await assert.doesNotReject(() => cancelRun(runDir), "an operator unsure whether the first cancel landed must be able to repeat it");
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).status, "canceled");
});

test("cancel releases the run ref and the node's attempt branch, keeping the run directory as evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-release-"));
  const path = writeContract(directory, fixture({ id: "cancel-release-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const branch = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).worktree.branch;
  assert.ok(gitHead(directory, branch), "the attempt branch exists before cancel");
  assert.ok(gitHead(directory, runRefName("cancel-release-run")), "the run ref exists before cancel");
  orphan(runDir, "build");

  await cancelRun(runDir);

  assert.equal(gitHead(directory, runRefName("cancel-release-run")), null, "the run ref is released");
  assert.equal(gitHead(directory, branch), null, "the node's attempt branch is released");
  assert.equal(existsSync(runDir), true, "the run directory itself stays as evidence");
});
