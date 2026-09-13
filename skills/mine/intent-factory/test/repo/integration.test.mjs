import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

import { candidateOnlyFailures } from "../../src/engine/judge-gate.mjs";
import {
  candidateRefName,
  git,
  createAttemptWorktree,
  createCandidateWorktree,
  createRunRef,
  sealAttempt,
} from "../../src/repo/worktree.mjs";
import { captureSourceIdentity } from "../../src/repo/source-identity.mjs";

test("run creation source identity includes resolved cwd and task-packet hashes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-source-"));
  const contract = {
    id: "source-run",
    campaignId: "source-campaign",
    cwd,
    nodes: [
      { id: "first", packetHash: "a".repeat(64) },
      { id: "second", packetHash: "b".repeat(64) },
    ],
  };
  const identity = captureSourceIdentity(contract, { luna: "test-harness 1" });
  assert.equal(identity.cwd, cwd);
  assert.deepEqual(identity.packetHashes, { first: "a".repeat(64), second: "b".repeat(64) });
  assert.ok(identity.harnessVersions, "harness versions recorded");
  assert.equal(identity.harnessVersions.luna, "test-harness 1");
});

test("re-sealing an attempt whose only entry is the node_modules link is a no-op", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-seal-"));
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.runs/\n");
  writeFileSync(join(repo, "source.txt"), "work\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "sealed attempt");
  const sealed = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // The link `.gitignore`'s `node_modules/` cannot match, plus the ignored
  // result sidecar every real worker leaves behind.
  mkdirSync(join(repo, "installed"));
  symlinkSync(join(repo, "installed"), join(repo, "node_modules"));
  mkdirSync(join(repo, ".runs"), { recursive: true });
  writeFileSync(join(repo, ".runs", "result.json"), "{}\n");

  const result = sealAttempt({ repo, path: repo, baseSha: sealed, runId: "run", nodeId: "node", attempt: 2 });
  assert.equal(result.sha, sealed, "a clean attempt keeps its existing seal instead of failing to commit nothing");
  assert.equal(result.empty, true, "no diff against the base it was sealed at");
});

test("the target repository's commit hooks cannot block an attempt seal", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-seal-hooks-"));
  /** @param {...string} args */
  const run = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "test@example.test");
  run("config", "user.name", "test");
  writeFileSync(join(repo, "source.txt"), "work\n");
  run("add", "-A");
  run("-c", "commit.gpgSign=false", "commit", "-qm", "seed");

  // A plain failing `pre-commit`, the shape the Python pre-commit framework
  // and hand-installed hooks both produce. Measured 2026-09-13: this failed
  // every seal, and since the seal message never varies between attempts,
  // every node of every run against such a repository failed identically with
  // no way out. The seal is the factory's own bookkeeping on a throwaway
  // branch, so it answers to the factory and not to the repository's
  // conventions for human commits.
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", { mode: 0o755 });

  const sealed = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "worker-output.txt"), "written by the attempt\n");
  const result = sealAttempt({ repo, path: repo, baseSha: sealed, runId: "run", nodeId: "node", attempt: 1 });
  assert.notEqual(result.sha, sealed, "the attempt's work was committed");
  assert.equal(result.empty, false);
  const committed = execFileSync("git", ["-C", repo, "show", "--name-only", "--format=", result.sha], { encoding: "utf8" }).trim();
  assert.equal(committed, "worker-output.txt");
});

test("the attempt and integration candidate worktrees get the same environment", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-parity-"));
  const git = /** @param {...string} args */ (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "source.txt"), "work\n");
  git("add", "-A");
  git("-c", "commit.gpgSign=false", "commit", "-qm", "base");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // The installed dependencies a verification command shells out to.
  mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
  const runDir = join(repo, ".runs", "parity-run");
  mkdirSync(runDir, { recursive: true });
  createRunRef(repo, "parity-run", head);

  const attempt = createAttemptWorktree({ repo, runDir, runId: "parity-run", nodeId: "node", attempt: 1 });
  execFileSync("git", ["-C", repo, "update-ref", candidateRefName("parity-run"), head], { stdio: "ignore" });
  const candidate = createCandidateWorktree({ repo, runDir, runId: "parity-run" });

  for (const [label, path] of [["attempt", attempt.path], ["candidate", candidate]]) {
    assert.ok(lstatSync(join(path, "node_modules")).isSymbolicLink(), `${label} worktree links node_modules`);
    assert.equal(
      realpathSync(join(path, "node_modules")),
      realpathSync(join(repo, "node_modules")),
      `${label} worktree resolves to the repository's installed dependencies`,
    );
  }
});

test("candidate-only verification failures name the environment divergence", () => {
  const attempt = {
    commands: [
      { argv: ["npm", "test"], passed: true },
      { argv: ["npm", "run", "lint"], passed: true },
    ],
  };
  const candidate = {
    commands: [
      { argv: ["npm", "test"], passed: false },
      { argv: ["npm", "run", "lint"], passed: true },
    ],
  };
  assert.deepEqual(
    candidateOnlyFailures(attempt, candidate),
    ["npm test"],
    "a command the attempt passed and the candidate failed is a worktree disagreement, not a defect in the work",
  );

  // A command that failed in both is the node's own problem, not divergence.
  assert.deepEqual(
    candidateOnlyFailures(
      { commands: [{ argv: ["npm", "test"], passed: false }] },
      { commands: [{ argv: ["npm", "test"], passed: false }] },
    ),
    [],
  );
  assert.deepEqual(candidateOnlyFailures(null, null), []);
});

test("a failing git command carries git's own reason into the error", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-giterr-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  assert.throws(
    () => git(repo, ["rev-parse", "--verify", "refs/heads/does-not-exist"]),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /Command failed/u, "keeps the command that failed");
      assert.match(
        error.message,
        /fatal|unknown revision|Needed a single revision/iu,
        "and says why, instead of dropping git's stderr",
      );
      return true;
    },
  );
});
