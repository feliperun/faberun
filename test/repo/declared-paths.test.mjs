import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mirrorCoverageWarnings, unsnapshottedWriteWarnings } from "../../src/repo/declared-paths.mjs";
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

/**
 * @param {string[]} writeFiles
 * @param {string[][]} verification
 * @returns {import("../../src/contract/index.mjs").ValidatedNode}
 */
function nodeWriting(writeFiles, verification) {
  return /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (/** @type {unknown} */ ({
    id: "n",
    taskPacket: { writeFiles, verification: verification.map((argv) => ({ argv })) },
  }));
}

// Measured 2026-09-22 and the reason this detector exists: a node rewrote the
// dispatch gate in src/engine/run-identity.mjs, ran three suites, passed all
// of them and its judge, and broke 56 of the 385 tests in test/engine/ -- the
// directory its own module lives in.
test("a node writing a src layer with no test from that layer is warned", () => {
  const node = nodeWriting(
    ["src/engine/run-identity.mjs"],
    [["node", "--test", "test/host/preflight.test.mjs"]],
  );
  const warnings = mirrorCoverageWarnings(node, 0, process.cwd());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /writes src\/engine\/ but no verification command runs a test under test\/engine\//u);
});

test("running a test this contract writes is not coverage of its layer", () => {
  const node = nodeWriting(
    ["src/engine/run-identity.mjs", "test/engine/live-gate.test.mjs"],
    [["node", "--test", "test/engine/live-gate.test.mjs"]],
  );
  const own = mirrorCoverageWarnings(node, 0, process.cwd());
  assert.equal(own.length, 1, "its own new test proves the test runs, not that the layer works");

  // A sibling node's new test is no better: the campaign wrote that one too.
  const sibling = mirrorCoverageWarnings(
    node,
    0,
    process.cwd(),
    ["node --test test/engine/live-verdict.test.mjs"],
    new Set(["test/engine/live-verdict.test.mjs"]),
  );
  assert.equal(sibling.length, 1, "a sibling's new test is still the contract's own");
});

test("a pre-existing test from the layer is coverage, wherever the command is declared", () => {
  const node = nodeWriting(
    ["src/engine/run-identity.mjs", "test/engine/live-gate.test.mjs"],
    [["node", "--test", "test/engine/live-gate.test.mjs", "test/engine/failover.test.mjs"]],
  );
  assert.deepEqual(mirrorCoverageWarnings(node, 0, process.cwd()), []);

  const viaFinal = nodeWriting(["src/engine/run-identity.mjs"], [["npm", "run", "typecheck"]]);
  assert.deepEqual(
    mirrorCoverageWarnings(viaFinal, 0, process.cwd(), ["node --test --test-concurrency=1 test/engine/failover.test.mjs"]),
    [],
    "a shared or final command covering the layer is coverage just the same",
  );
});

test("a src path with no mirrored test directory names no layer", () => {
  const util = nodeWriting(["src/util.mjs"], [["npm", "run", "typecheck"]]);
  assert.deepEqual(mirrorCoverageWarnings(util, 0, process.cwd()), [], "util.mjs owns no domain and has no mirror");

  const docs = nodeWriting(["docs/COMMANDS.md"], [["npm", "run", "typecheck"]]);
  assert.deepEqual(mirrorCoverageWarnings(docs, 0, process.cwd()), [], "a non-source write names no layer");

  const entry = nodeWriting(["src/cli.mjs"], [["npm", "run", "typecheck"]]);
  assert.match(mirrorCoverageWarnings(entry, 0, process.cwd())[0], /writes src\/cli\//u, "the entry point mirrors test/cli/");
});
