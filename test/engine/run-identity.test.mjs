import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controllerSnapshotIdentity } from "../../src/engine/run-identity.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/**
 * The controller identity hashes the executable snapshot, never the runner's
 * own scratch state written into it while a run is in flight: the sha must
 * move because tracked source changed, and only because of that.
 */

test(`controllerSnapshotIdentity's hash is unchanged by writes under ${RUNS_DIR_NAME}, but changes when tracked source changes`, () => {
  const snapshotPath = mkdtempSync(join(tmpdir(), "controller-snapshot-"));
  writeFileSync(join(snapshotPath, "controller.mjs"), "export const version = 1;\n");
  const before = controllerSnapshotIdentity(snapshotPath).sha;

  mkdirSync(join(snapshotPath, RUNS_DIR_NAME, "results"), { recursive: true });
  writeFileSync(join(snapshotPath, RUNS_DIR_NAME, "results", "build.json"), "{}\n");
  const afterRunsWrite = controllerSnapshotIdentity(snapshotPath).sha;
  assert.equal(afterRunsWrite, before, "a write under the runs directory never moves the controller identity");

  writeFileSync(join(snapshotPath, "controller.mjs"), "export const version = 2;\n");
  const afterSourceChange = controllerSnapshotIdentity(snapshotPath).sha;
  assert.notEqual(afterSourceChange, afterRunsWrite, "a change to tracked source does move the controller identity");
});
