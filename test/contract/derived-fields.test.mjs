/**
 * Derived worker-result fields: the controller measures them, so the worker
 * protocol neither asks for them nor accepts them. `changedFiles` is the first
 * removal; the commit half of these tests pins the worktree-HEAD derivation the
 * remaining derived fields (commit, digest, worktreeIdentity) build on.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_WORKER_RESULT_FIELDS, parseWorkerResult } from "../../src/contract/worker-result.mjs";
import { createAttemptWorktree, createRunRef, git, gitHead, sealAttempt } from "../../src/repo/worktree.mjs";
import { initializeGit } from "./helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

test("derived field rejected in worker result", () => {
  const canonical = { status: "done", summary: "complete", verification: [], artifacts: [], missingContext: [] };
  assert.equal(parseWorkerResult(JSON.stringify(canonical)).status, "done");
  assert.ok(DERIVED_WORKER_RESULT_FIELDS.includes("changedFiles"), "changedFiles is a derived field");
  for (const field of DERIVED_WORKER_RESULT_FIELDS) {
    assert.throws(
      () => parseWorkerResult(JSON.stringify({ ...canonical, [field]: [] })),
      new RegExp(`worker result\\.${field} is derived by the controller`, "u"),
      `${field} must be rejected, never dropped`,
    );
  }
});

test("commit derived from worktree head", () => {
  const directory = mkdtempSync(join(tmpdir(), "derived-fields-worktree-"));
  writeFileSync(join(directory, "README.md"), "read\n");
  initializeGit(directory);
  const runId = "derived-fields-run";
  const runDir = runDirectory(directory, runId);
  const base = gitHead(directory);
  assert.ok(base, "the fixture repository has a head");
  createRunRef(directory, runId, base);

  const worktree = createAttemptWorktree({ repo: directory, runDir, runId, nodeId: "build", attempt: 1 });
  assert.equal(worktree.commit, gitHead(worktree.path), "the attempt records the worktree HEAD, not a guessed commit");

  writeFileSync(join(worktree.path, "output.txt"), "done\n");
  const sealed = sealAttempt({ repo: directory, path: worktree.path, baseSha: base, runId, nodeId: "build", attempt: 1 });
  assert.equal(sealed.sha, gitHead(worktree.path), "the sealed attempt is the commit the worktree HEAD names");
  assert.notEqual(sealed.sha, base, "the worktree commit is the attempt's new work");
  assert.equal(gitHead(directory), base, "the shared repository HEAD never becomes the attempt commit");
});

test("commit canonicalization", () => {
  const directory = mkdtempSync(join(tmpdir(), "derived-fields-canonical-"));
  writeFileSync(join(directory, "README.md"), "read\n");
  initializeGit(directory);
  const canonical = gitHead(directory);
  assert.ok(canonical, "the fixture repository has a head");
  assert.match(canonical, /^[0-9a-f]{40}$/u);

  // An abbreviation is canonicalized to the full commit sha...
  assert.equal(gitHead(directory, canonical.slice(0, 8)), canonical);

  // ...and that sha is validated as a single commit object, not merely as a
  // resolvable object: a tree does not survive the commit peel.
  assert.doesNotThrow(() => git(directory, ["cat-file", "-e", `${canonical}^{commit}`]));
  const tree = git(directory, ["rev-parse", "HEAD^{tree}"]);
  assert.throws(() => git(directory, ["cat-file", "-e", `${tree}^{commit}`]));

  // An abbreviation that names nothing is refused, never defaulted to empty.
  assert.equal(gitHead(directory, "0000000"), null);
});
