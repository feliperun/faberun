import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
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
