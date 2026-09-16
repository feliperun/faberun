import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { setLaunchBaseRef } from "../../src/engine/run-identity.mjs";
import { fixture, withFakeCodex, writeContract } from "../helpers.mjs";

/**
 * `run --base-ref` records the ref a run was cut from on its source identity
 * ([[resume-base-ref-recorded]]). A resume must compare against that recorded
 * ref, not against whatever the operator's checkout HEAD happens to be —
 * otherwise a chain-launched run refuses to resume from any checkout but the
 * one that happened to be current at launch.
 */

/** @param {string} directory @param {string} message @returns {void} */
function commitAll(directory, message) {
  execFileSync("git", ["-C", directory, "add", "-A", "--", ".", ":(exclude).runs"], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", message], { stdio: "ignore" });
}

/** @param {string} repo @param {string[]} args @returns {string} */
function gitOut(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

test("a run launched with --base-ref resumes against that ref from a checkout on an unrelated commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-base-ref-"));
  const path = writeContract(directory, fixture({ id: "resume-base-ref-run", pollIntervalMs: 10 }));
  const baseSha = gitOut(directory, ["rev-parse", "HEAD"]);

  setLaunchBaseRef(baseSha);
  let runDir;
  try {
    runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  } finally {
    setLaunchBaseRef(undefined);
  }
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(run.sourceIdentity.gitHead, baseSha);
  assert.equal(run.sourceIdentity.baseRef, baseSha);

  // Move the checkout to a commit that shares no history with the base: a
  // resume that measured the checkout's own HEAD would refuse this as drift.
  execFileSync("git", ["-C", directory, "checkout", "--orphan", "unrelated"], { stdio: "ignore" });
  writeFileSync(join(directory, "unrelated.txt"), "unrelated\n");
  commitAll(directory, "unrelated");
  const ancestry = spawnSync("git", ["-C", directory, "merge-base", "--is-ancestor", baseSha, "HEAD"]);
  assert.notEqual(ancestry.status, 0, "the checkout HEAD does not descend from the base");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
});
