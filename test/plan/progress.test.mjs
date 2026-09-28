import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedPlanProgress, clearPlanProgress, planProgressPath, readPlanProgress, writePlanProgress } from "../../src/plan/progress.mjs";
import { campaignTree } from "../../src/run/paths.mjs";
import { writeJsonAtomic } from "../../src/run/store.mjs";

// No process can hold this pid, so the record names one that is certainly gone
// without the test spawning anything or racing a pid the system may reuse.
const GONE_PID = 2_147_483_646;

test("a plan's liveness record describes the process it is written by, and outlives it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-progress-"));
  assert.equal(planProgressPath(cwd, "live-demo", "build"), join(campaignTree(cwd, "live-demo"), "plans", "build", "progress.json"));
  assert.equal(readPlanProgress(cwd, "live-demo", "build"), null, "a phase no plan has run for carries no record");
  assert.equal(abandonedPlanProgress(cwd, "live-demo", "build"), null);

  writePlanProgress(cwd, "live-demo", "build", { campaignId: "live-demo", phase: "build", stage: "repo-facts:start" });
  const written = readPlanProgress(cwd, "live-demo", "build");
  assert.equal(written?.stage, "repo-facts:start");
  assert.equal(written?.pid, process.pid);
  assert.equal(abandonedPlanProgress(cwd, "live-demo", "build"), null, "the process that wrote it is this one, and it is alive");

  // A pid the operating system handed to somebody else is not this plan: the
  // start token is what separates the two, and a mismatched one reads as gone
  // even while a process with that number answers.
  writeJsonAtomic(planProgressPath(cwd, "live-demo", "build"), {
    pid: process.pid, processStartToken: "a token no process on this machine has", at: "2026-09-28T12:00:00.000Z", stage: "draft",
  });
  assert.equal(abandonedPlanProgress(cwd, "live-demo", "build")?.stage, "draft");

  writeJsonAtomic(planProgressPath(cwd, "live-demo", "build"), {
    pid: GONE_PID, processStartToken: null, at: "2026-09-28T12:00:00.000Z", stage: "repo-facts:measured",
  });
  const abandoned = abandonedPlanProgress(cwd, "live-demo", "build");
  assert.equal(abandoned?.pid, GONE_PID);
  assert.equal(abandoned?.stage, "repo-facts:measured");

  clearPlanProgress(cwd, "live-demo", "build");
  assert.equal(readPlanProgress(cwd, "live-demo", "build"), null);
  assert.equal(abandonedPlanProgress(cwd, "live-demo", "build"), null, "a pipeline that returned leaves nothing to report");
});

test("a record a dying process left half-written is not read as a stage", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-progress-partial-"));
  writeJsonAtomic(planProgressPath(cwd, "cut-demo", "build"), { stage: "freeze", pid: GONE_PID, processStartToken: null });
  assert.equal(readPlanProgress(cwd, "cut-demo", "build")?.stage, "freeze");

  // The writer is killed between the open and the last byte: `readJson` gets
  // something that is not JSON, and there is no stage a reader could act on.
  writeFileSync(planProgressPath(cwd, "cut-demo", "build"), '{"stage": "free');
  assert.equal(readPlanProgress(cwd, "cut-demo", "build"), null);
  assert.equal(abandonedPlanProgress(cwd, "cut-demo", "build"), null);
});
