import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, promoteRunInCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @returns {string} a fresh repository with one commit */
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "runner-chain-restart-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.test"]);
  git(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", "base"]);
  return repo;
}

/** @param {string} repo @param {string} file @param {string} content @param {string} message @returns {string} */
function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

// A coordinator restart re-runs promotion for a node whose run had already
// landed. By the time the restart replays it, a later run may have already
// advanced the land branch further, so promoteRun's already_promoted result
// reports that later head, not the replayed run's own head. Recording that
// verbatim would add a spurious promotion for the replayed run.

test("a coordinator restart replaying an already-promoted run does not re-record after the land branch has since advanced", () => {
  const repo = initRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const runOneHead = commitFile(repo, "one.txt", "one\n", "run one");
  const runTwoHead = commitFile(repo, "two.txt", "two\n", "run two");

  const runsDir = runsRoot(mkdtempSync(join(tmpdir(), "runner-chain-restart-campaign-")));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "restart", goal: "Coordinator restart replay" });

  const first = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead: runOneHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(first.status, "promoted");
  const second = promoteRunInCampaign({ campaignPath, repo, runId: "run-2", runHead: runTwoHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(second.status, "promoted");

  const replay = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead: runOneHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(replay.status, "already_promoted");
  assert.equal(replay.sha, runTwoHead, "already_promoted reports the branch's current head, not run-1's own head");

  const promotions = readCampaign(campaignPath).promotions;
  assert.equal(promotions.length, 2, "one promotion per run that actually moved the branch; the replay adds nothing");
});
