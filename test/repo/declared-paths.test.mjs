import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unsnapshottedWriteWarnings } from "../../src/repo/declared-paths.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/** @param {string} root @param {...string} args */
function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

test(`a declared write under ${RUNS_DIR_NAME} is warned as unobservable, distinct from a write a .gitignore rule hides`, () => {
  const cwd = mkdtempSync(join(tmpdir(), "declared-paths-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.test");
  git(cwd, "config", "user.name", "test");
  writeFileSync(join(cwd, ".gitignore"), "ignored-dir/\n");
  writeFileSync(join(cwd, "visible.txt"), "seen\n");
  git(cwd, "add", "-A");
  git(cwd, "-c", "commit.gpgSign=false", "commit", "-qm", "seed");

  const node = {
    id: "build",
    taskPacket: {
      writeFiles: [
        `${RUNS_DIR_NAME}/results/build.json`,
        "ignored-dir/output.txt",
        "visible.txt",
      ],
      writeRoots: [],
    },
  };
  const warnings = unsnapshottedWriteWarnings(/** @type {any} */ (node), 2, cwd);
  assert.equal(warnings.length, 2, "the runs write and the gitignored write both warn, the visible write does not");
  assert.ok(warnings.some((warning) => warning.includes(`writeFiles under ${RUNS_DIR_NAME}/`)), "the runs directory root is named in a warning");
  assert.ok(warnings.some((warning) => warning.includes("writeFiles under ignored-dir/")), "the gitignored root is named in a warning");
});

test(`a declared write under ${RUNS_DIR_NAME} warns with no .gitignore rule involved at all`, () => {
  const cwd = mkdtempSync(join(tmpdir(), "declared-paths-unconditional-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.test");
  git(cwd, "config", "user.name", "test");
  writeFileSync(join(cwd, "not-ignored.txt"), "seen\n");
  git(cwd, "add", "-A");
  git(cwd, "-c", "commit.gpgSign=false", "commit", "-qm", "seed");

  const node = {
    id: "build",
    taskPacket: {
      writeFiles: [`${RUNS_DIR_NAME}/x.json`, "not-ignored.txt"],
      writeRoots: [],
    },
  };
  const warnings = unsnapshottedWriteWarnings(/** @type {any} */ (node), 0, cwd);
  // Unlike "not-ignored.txt", which no rule hides and which therefore never
  // warns, the runs directory is unobservable by construction -- it warns
  // with no .gitignore in the repository at all.
  assert.deepEqual(warnings, [`nodes[0] (build): writeFiles under ${RUNS_DIR_NAME}/ are outside the workspace snapshot, so the closed-scope gate cannot observe them`]);
});
