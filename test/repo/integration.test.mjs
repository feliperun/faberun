import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

import { candidateOnlyFailures } from "../../src/engine/judge-gate.mjs";
import { retryDivergentCandidateCommands } from "../../src/engine/verify.mjs";
import {
  candidateRefName,
  git,
  createAttemptWorktree,
  createCandidateWorktree,
  createRunRef,
  gitHead,
  sealAttempt,
} from "../../src/repo/worktree.mjs";
import { integrateAttempt, promoteRun } from "../../src/repo/integrate.mjs";
import { initializeCampaign, recordPromotion } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { captureSourceIdentity } from "../../src/repo/source-identity.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

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
  // result sidecar every real worker leaves behind. `repo` stands in for the
  // attempt worktree here, so this `.runs` is the attempt-local result
  // sidecar R3 keeps in place -- it does not migrate with the rest.
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
  const runDir = runDirectory(repo, "parity-run");
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

test("a verifyCandidate stub built on retryDivergentCandidateCommands retries a divergent failure exactly once before the candidate is accepted", async () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-candidate-retry-"));
  const run = /** @param {...string} args */ (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "test@example.test");
  run("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "base\n");
  run("add", "-A");
  run("-c", "commit.gpgSign=false", "commit", "-qm", "base");
  const runDir = runDirectory(repo, "candidate-retry-run");
  mkdirSync(runDir, { recursive: true });
  const head = gitHead(repo, "HEAD");
  createRunRef(repo, "candidate-retry-run", head);

  const worktree = createAttemptWorktree({ repo, runDir, runId: "candidate-retry-run", nodeId: "build", attempt: 1 });
  writeFileSync(join(worktree.path, "output.txt"), "worker\n");
  const sealed = sealAttempt({ repo, path: worktree.path, baseSha: worktree.baseSha, runId: "candidate-retry-run", nodeId: "build", attempt: 1 });

  // The attempt's own recorded verification: the command that will diverge in
  // the candidate worktree already passed here.
  const attemptEvidence = { passed: true, commands: [{ argv: ["npm", "test"], passed: true }] };
  let retryCalls = 0;
  const verifyCandidate = async () => retryDivergentCandidateCommands(
    { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] },
    attemptEvidence,
    async (indexes) => {
      retryCalls += 1;
      return indexes.map(() => ({ argv: ["npm", "test"], passed: true, attempts: [] }));
    },
  );

  const result = await integrateAttempt({
    repo,
    runDir,
    runId: "candidate-retry-run",
    nodeId: "build",
    attempt: 1,
    attemptSha: sealed.sha,
    branch: worktree.branch,
    verificationEvidence: attemptEvidence,
    verifyCandidate,
  });

  assert.equal(retryCalls, 1, "the retry hook ran exactly once");
  assert.equal(result?.status, "accepted", "the candidate is accepted once the retry agrees with the attempt");
});

test("a verifyCandidate stub whose retry still fails leaves the candidate rejected", async () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-candidate-retry-fail-"));
  const run = /** @param {...string} args */ (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "test@example.test");
  run("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "base\n");
  run("add", "-A");
  run("-c", "commit.gpgSign=false", "commit", "-qm", "base");
  const runDir = runDirectory(repo, "candidate-retry-fail-run");
  mkdirSync(runDir, { recursive: true });
  const head = gitHead(repo, "HEAD");
  createRunRef(repo, "candidate-retry-fail-run", head);

  const worktree = createAttemptWorktree({ repo, runDir, runId: "candidate-retry-fail-run", nodeId: "build", attempt: 1 });
  writeFileSync(join(worktree.path, "output.txt"), "worker\n");
  const sealed = sealAttempt({ repo, path: worktree.path, baseSha: worktree.baseSha, runId: "candidate-retry-fail-run", nodeId: "build", attempt: 1 });

  const attemptEvidence = { passed: true, commands: [{ argv: ["npm", "test"], passed: true }] };
  let retryCalls = 0;
  const verifyCandidate = async () => retryDivergentCandidateCommands(
    { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] },
    attemptEvidence,
    async (indexes) => {
      retryCalls += 1;
      return indexes.map(() => ({ argv: ["npm", "test"], passed: false, attempts: [] }));
    },
  );

  const result = await integrateAttempt({
    repo,
    runDir,
    runId: "candidate-retry-fail-run",
    nodeId: "build",
    attempt: 1,
    attemptSha: sealed.sha,
    branch: worktree.branch,
    verificationEvidence: attemptEvidence,
    verifyCandidate,
  });

  assert.equal(retryCalls, 1, "the retry hook still ran exactly once, not repeatedly");
  assert.equal(result?.status, "verification_failed", "a second failure on retry stands as the verdict");
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

// ---------------------------------------------------------------------------
// Campaign promotion onto the landing branch (phase 3, rules 1 and 3).
//
// The promotion is the only place a branch other than a per-run ref moves. It
// is deliberately narrow: gated on a green final verification, never a
// force-update, never `main` without the operator's authorization, and never a
// branch a live worktree has checked out. `promoteRun` is pure git; the
// campaign record wraps it in `promoteRunInCampaign`.
// ---------------------------------------------------------------------------

/** @param {string} prefix @returns {string} a fresh repository with one commit */
function promotionRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const run = /** @param {...string} args */ (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "test@example.test");
  run("config", "user.name", "test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  run("add", "-A");
  run("-c", "commit.gpgSign=false", "commit", "-qm", "base");
  return repo;
}

/** @param {string} repo @param {string} file @param {string} content @param {string} message @returns {string} */
function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content);
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=test@example.test", "-c", "user.name=test", "-c", "commit.gpgSign=false", "commit", "-qm", message], { stdio: "ignore" });
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** @param {string} repo @param {string} ref @returns {string} */
function refSha(repo, ref) {
  return execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
}

test("a run whose finalVerification is red is not promoted even with every node done", () => {
  const repo = promotionRepo("runner-promote-final-");
  const base = refSha(repo, "HEAD");
  // The run integrated all of its work: its ref is a child of the base, which
  // is what "every node done" leaves behind. Promotion is still refused
  // because the contract-wide final verification is the separate gate.
  const runHead = commitFile(repo, "work.txt", "work\n", "run work");
  createRunRef(repo, "red-final", runHead);
  assert.throws(
    () => promoteRun({ repo, runId: "red-final", landBranch: "campaign/red", baseSha: base, finalVerificationPassed: false }),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "final_verification_not_green");
      assert.match(error.message, /final verification is not green/u);
      return true;
    },
  );
  assert.equal(gitHead(repo, "refs/heads/campaign/red"), null, "no branch was created or moved");
});

test("landBranch defaults to campaign/<campaignId> and is created at the first run's gitHead when absent", () => {
  const repo = promotionRepo("runner-promote-default-");
  const base = refSha(repo, "HEAD");
  const runHead = commitFile(repo, "run.txt", "run\n", "run");
  createRunRef(repo, "first-run", runHead);
  const runsDir = runsRoot(mkdtempSync(join(tmpdir(), "runner-promote-campaign-")));
  const { path: campaignPath, campaign } = initializeCampaign(runsDir, { campaignId: "chain", goal: "Chain the phases" });
  assert.equal(campaign.landBranch, "campaign/chain", "landBranch never defaults to main");
  const result = promoteRun({
    repo,
    runId: "first-run",
    landBranch: campaign.landBranch,
    baseSha: base,
    finalVerificationPassed: true,
    onPromoted: (record) => recordPromotion(campaignPath, { runId: record.runId, branch: record.branch, sha: record.sha, previousSha: record.previousSha, at: record.at }),
  });
  assert.equal(result.status, "promoted");
  assert.equal(result.branch, "campaign/chain");
  assert.equal(refSha(repo, "refs/heads/campaign/chain"), runHead, "the branch fast-forwarded onto the run's ref");
  assert.equal(readCampaign(campaignPath).promotions.length, 1);
});

test("promoting onto main without the explicit operator flag refuses", () => {
  const repo = promotionRepo("runner-promote-main-");
  const base = refSha(repo, "HEAD");
  const runHead = commitFile(repo, "run.txt", "run\n", "run");
  createRunRef(repo, "main-run", runHead);
  assert.throws(
    () => promoteRun({ repo, runId: "main-run", landBranch: "main", baseSha: base, finalVerificationPassed: true }),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "land_branch_main_requires_flag");
      assert.match(error.message, /refusing to promote main-run onto main/u);
      assert.match(error.message, /--allow-main/u);
      return true;
    },
  );
});

test("a non-fast-forward promotion refuses and never force-updates", () => {
  const repo = promotionRepo("runner-promote-ff-");
  const base = refSha(repo, "HEAD");
  const runHead = commitFile(repo, "run.txt", "run\n", "run");
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "other", base], { stdio: "ignore" });
  const other = commitFile(repo, "other.txt", "other\n", "other");
  execFileSync("git", ["-C", repo, "branch", "land", other], { stdio: "ignore" });
  createRunRef(repo, "ff-run", runHead);
  assert.throws(
    () => promoteRun({ repo, runId: "ff-run", landBranch: "land", baseSha: base, finalVerificationPassed: true }),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "land_branch_not_fast_forward");
      assert.match(error.message, /is not a fast-forward/u);
      assert.match(error.message, /never force-updates/u);
      return true;
    },
  );
  assert.equal(refSha(repo, "refs/heads/land"), other, "the branch was left where it was");
});

test("a landBranch checked out in another worktree refuses rather than moving the ref", () => {
  const repo = promotionRepo("runner-promote-checked-out-");
  const base = refSha(repo, "HEAD");
  const runHead = commitFile(repo, "run.txt", "run\n", "run");
  createRunRef(repo, "wt-run", runHead);
  execFileSync("git", ["-C", repo, "branch", "land", base], { stdio: "ignore" });
  const worktree = join(mkdtempSync(join(tmpdir(), "runner-promote-wt-")), "checkout");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "land"], { stdio: "ignore" });
  try {
    assert.throws(
      () => promoteRun({ repo, runId: "wt-run", landBranch: "land", baseSha: base, finalVerificationPassed: true }),
      (/** @type {Error & {code?: string}} */ error) => {
        assert.equal(error.code, "land_branch_checked_out");
        assert.match(error.message, /is checked out in/u);
        assert.match(error.message, /checkout/u);
        assert.match(error.message, /detach the checkout/u, "the refusal names the remedy");
        assert.match(error.message, /run the coordinator from a worktree/u, "the refusal names the remedy");
        return true;
      },
    );
    assert.equal(refSha(repo, "refs/heads/land"), base, "the branch did not move under the live checkout");
  } finally {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
  }
});

test("a crash after the branch moved but before the record leaves one promotion on re-issue", () => {
  const repo = promotionRepo("runner-promote-crash-");
  const base = refSha(repo, "HEAD");
  const runHead = commitFile(repo, "run.txt", "run\n", "run");
  createRunRef(repo, "crash-run", runHead);
  const runsDir = runsRoot(mkdtempSync(join(tmpdir(), "runner-promote-crashcamp-")));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "crash", goal: "Crash recovery" });
  // The ref moves, then the record write dies. This is the crash the rule
  // requires re-invocation to recognise rather than repeat.
  assert.throws(
    () => promoteRun({
      repo,
      runId: "crash-run",
      landBranch: "campaign/crash",
      baseSha: base,
      finalVerificationPassed: true,
      onPromoted: () => { throw new Error("crash after ref move"); },
    }),
    /crash after ref move/u,
  );
  assert.equal(refSha(repo, "refs/heads/campaign/crash"), runHead, "the branch moved before the crash");
  const reissued = promoteRun({
    repo,
    runId: "crash-run",
    landBranch: "campaign/crash",
    baseSha: base,
    finalVerificationPassed: true,
    onPromoted: (record) => recordPromotion(campaignPath, { runId: record.runId, branch: record.branch, sha: record.sha, previousSha: record.previousSha, at: record.at }),
  });
  assert.equal(reissued.status, "already_promoted", "re-issue recognises the promotion instead of repeating it");
  assert.equal(refSha(repo, "refs/heads/campaign/crash"), runHead);
  const promotions = readCampaign(campaignPath).promotions;
  assert.equal(promotions.length, 1, "one promotion, one record");
  assert.equal(promotions[0].sha, runHead);
});
