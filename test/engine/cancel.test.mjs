import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { cancelRun } from "../../src/engine/cancel.mjs";
import { createRunRef } from "../../src/repo/worktree.mjs";
import { runDirectory } from "../../src/run/paths.mjs";
import { serializableContract } from "../../src/engine/run-identity.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { writeJsonAtomic } from "../../src/run/store.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { gitHead, preservedRefName, runRefName } from "../../src/repo/worktree.mjs";

import { fixture, orphan, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

test("scheduler cancellation records killed invocation reason before settling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-usage-reason-"));
  const path = writeContract(directory, fixture({ id: "cancel-usage-reason-run", pollIntervalMs: 10 }));
  const runDir = runDirectory(directory, "cancel-usage-reason-run");
  const running = withFakeCodex(directory, "wait-for-release", () => runContract(path));
  try {
    await waitForValue(() => existsSync(join(runsRoot(directory), "provider-started")) ? true : null);
    writeFileSync(join(runDir, "cancel.request.json"), JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid }));
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(nodeState(result).status, "canceled");
    const records = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].unknownReason, "invocation-killed", "the scheduler records the cancel kill before settling the node");
  } finally {
    if (existsSync(join(runDir, "cancel.request.json"))) writeFileSync(join(runDir, "cancel.request.json"), "{}");
  }
});

test("a cancelled run's contract relaunches with no manual cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-relaunch-"));
  const path = writeContract(directory, fixture({ id: "cancel-relaunch-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const canceled = await cancelRun(runDir);
  assert.deepEqual(canceled.preservedRefs, [preservedRefName("cancel-relaunch-run", "build")], "the integrated head survives cancel behind its preserved ref");
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
  const first = await cancelRun(runDir);
  assert.deepEqual(first.preservedRefs, [preservedRefName("cancel-twice-run", "build")]);
  const repeated = await cancelRun(runDir);
  assert.deepEqual(repeated.preservedRefs, first.preservedRefs, "the second cancel neither moves nor duplicates the preserved ref");
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

test("cancel preserves every integrated head before releasing the run's git names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-preserve-"));
  const path = writeContract(directory, fixture({ id: "cancel-preserve-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.ok(state.integratedHead, "the fixture node integrated before cancel");
  const branch = state.worktree.branch;

  const result = await cancelRun(runDir);

  const preserved = preservedRefName("cancel-preserve-run", "build");
  assert.equal(gitHead(directory, preserved), state.integratedHead, "the preserved ref names the node's integrated commit");
  assert.deepEqual(result.preservedRefs, [preserved], "the result names the preserved ref without opening a node snapshot");
  assert.deepEqual(result.released, [`refs/heads/${branch}`, state.worktree.path, runRefName("cancel-preserve-run")], "the result names every artifact released");
  assert.equal(gitHead(directory, branch), null, "the attempt branch is still released");
  assert.equal(gitHead(directory, runRefName("cancel-preserve-run")), null, "the run ref is still released");

  const repeated = await cancelRun(runDir);
  assert.deepEqual(repeated.preservedRefs, [preserved], "a second cancel neither moves nor duplicates the preserved ref");
  assert.equal(gitHead(directory, preserved), state.integratedHead, "the preserved ref survives a second cancel untouched");
});

test("a node whose integrated head is null gets no preserved ref", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-null-head-"));
  const path = writeContract(directory, fixture({ id: "cancel-null-head-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build", { integratedHead: null });
  const result = await cancelRun(runDir);
  assert.deepEqual(result.preservedRefs, [], "an integrated head of null is nothing to preserve");
  assert.equal(gitHead(directory, preservedRefName("cancel-null-head-run", "build")), null);
});

test("a launch that died before persisting any node is cancellable, and one verb releases both names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-bare-"));
  const path = writeContract(directory, fixture({ id: "cancel-bare-run", pollIntervalMs: 10 }));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const runDir = runDirectory(contract.cwd, contract.id);
  // Exactly what a launch leaves behind when it dies after claiming the run
  // ref and before any node snapshot exists -- the same two writes the
  // scheduler makes, in the same order, and nothing after them.
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeJsonAtomic(join(runDir, "contract.json"), serializableContract(contract));
  createRunRef(contract.cwd, contract.id, gitHead(contract.cwd, "HEAD"));

  await assert.rejects(
    () => withFakeCodex(directory, "pass", () => runContract(path)),
    /run already exists/u,
    "the occupied directory refuses the relaunch, as it should",
  );

  const canceled = await cancelRun(runDir);
  assert.deepEqual(canceled.preservedRefs, [], "nothing was integrated, so nothing is preserved");
  assert.ok(canceled.released.includes(runRefName("cancel-bare-run")), "cancel releases the ref the dead launch claimed");
  assert.equal(gitHead(contract.cwd, runRefName("cancel-bare-run")), null, "the run ref is gone from the repository");

  const relaunched = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(relaunched.ok, true, "one cancel released the directory and the ref; no manual cleanup of either");
  assert.equal(nodeState(relaunched).status, "done");
});
