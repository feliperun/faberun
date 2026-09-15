import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { controllerSnapshotIdentity, verifyControllerIdentity } from "../../src/engine/run-identity.mjs";
import { assertLaunchBaseClean } from "../../src/repo/source-identity.mjs";
import { runRefName } from "../../src/repo/worktree.mjs";
import { fakeCodex, fixture, writeContract } from "../helpers.mjs";

/**
 * `run --base-ref <ref>`: the run is cut from that ref's sha, so every attempt
 * worktree is cut from it too and the operator's checkout is never touched. A
 * dirty tree blocks the launch only when the cwd HEAD *is* the base.
 *
 * These cases go through the real CLI (`src/cli.mjs run`), because the flag is
 * the surface being added and a direct `runContract` call would bypass the
 * plumbing that reads it.
 */

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/** @param {string} directory @param {string} message @returns {void} */
function commitAll(directory, message) {
  execFileSync("git", ["-C", directory, "add", "-A", "--", ".", ":(exclude).runs"], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", message], { stdio: "ignore" });
}

/** @param {string} repo @param {string[]} args @returns {string} */
function gitOut(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("run --base-ref cuts the run ref and attempt worktrees from the base and leaves the operator tree untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-base-ref-"));
  const contractPath = writeContract(directory, fixture({ id: "base-ref-run" }));
  // A is the base the run is cut from; B is where the operator's checkout has
  // since moved. A run cut from B would see version.txt = "head".
  writeFileSync(join(directory, "version.txt"), "base\n");
  commitAll(directory, "base");
  const baseSha = gitOut(directory, ["rev-parse", "HEAD"]);
  writeFileSync(join(directory, "version.txt"), "head\n");
  commitAll(directory, "head");
  const headBefore = gitOut(directory, ["rev-parse", "HEAD"]);
  const statusBefore = gitOut(directory, ["status", "--porcelain=v1"]);
  const readmeBefore = readFileSync(join(directory, "README.md"), "utf8");

  const result = spawnSync(process.execPath, [CLI, "run", contractPath, "--base-ref", baseSha], {
    cwd: directory,
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  // The operator's tree is untouched, asserted on the tree rather than the sha.
  assert.equal(gitOut(directory, ["rev-parse", "HEAD"]), headBefore, "the checkout did not move");
  assert.equal(gitOut(directory, ["status", "--porcelain=v1"]), statusBefore, "the working tree did not gain or lose a path");
  assert.equal(readFileSync(join(directory, "README.md"), "utf8"), readmeBefore, "tracked file bytes are unchanged");

  const runDir = join(directory, ".runs", "base-ref-run");
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(run.sourceIdentity.gitHead, baseSha, "the run records the base sha, not the cwd HEAD");
  const node = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(node.worktree.baseSha, baseSha, "the attempt worktree was cut from the base");
  // The integrated ref's tree is the base tree, not HEAD's: direct proof the
  // run was cut from the base rather than the checkout.
  assert.equal(gitOut(directory, ["show", `${runRefName("base-ref-run")}:version.txt`]), "base");
});

test("a dirty tree refuses the launch only when the cwd HEAD is the base", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-base-dirty-"));
  execFileSync("git", ["-C", directory, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "test"]);
  writeFileSync(join(directory, "a.txt"), "one\n");
  commitAll(directory, "base");
  const baseSha = gitOut(directory, ["rev-parse", "HEAD"]);
  writeFileSync(join(directory, "a.txt"), "dirty\n");
  assert.throws(
    () => assertLaunchBaseClean(directory, undefined),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "dirty_work_tree");
      assert.match(error.message, /uncommitted path/u);
      return true;
    },
  );
  assert.throws(() => assertLaunchBaseClean(directory, "HEAD"), /uncommitted path/u);
  // Move the checkout past the base, dirty it again, and a base ref that is
  // not the cwd HEAD no longer cares about the dirt.
  commitAll(directory, "head");
  writeFileSync(join(directory, "a.txt"), "dirty again\n");
  assert.doesNotThrow(() => assertLaunchBaseClean(directory, baseSha));
});

test("run.json records the controller snapshot, and a snapshot whose executable no longer matches its sha refuses", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-controller-id-"));
  const contractPath = writeContract(directory, fixture({ id: "controller-id-run" }));
  const result = spawnSync(process.execPath, [CLI, "run", contractPath], {
    cwd: directory,
    env: { ...process.env, INTENT_FACTORY_CODEX_BIN: fakeCodex(directory, "pass") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(readFileSync(join(directory, ".runs", "controller-id-run", "run.json"), "utf8"));
  assert.ok(run.controllerIdentity, "run.json records the controller snapshot");
  assert.equal(typeof run.controllerIdentity.path, "string");
  assert.match(run.controllerIdentity.sha, /^[a-f0-9]{64}$/u);

  // The check the next chain node runs before launching N+1: same path, edited
  // executable bytes, refused by the recorded sha.
  const executable = join(mkdtempSync(join(tmpdir(), "runner-controller-snapshot-")), "controller.mjs");
  writeFileSync(executable, "console.log('v1')\n");
  const identity = controllerSnapshotIdentity(executable);
  assert.deepEqual(verifyControllerIdentity(identity), identity, "an unchanged snapshot verifies");
  writeFileSync(executable, "console.log('v2')\n");
  assert.throws(
    () => verifyControllerIdentity(identity),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "controller_snapshot_changed");
      assert.match(error.message, /does not match its recorded sha/u);
      return true;
    },
  );
});
