import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIGNAL_END,
  SIGNAL_START,
  syncAgentSignal,
} from "../../src/repo/signal.mjs";
import { closeCampaign, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

/**
 * @returns {{repo: string, runsDir: string, agentsPath: string}}
 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "signal-repo-"));
  const runsDir = runsRoot(repo);
  const agentsPath = join(repo, "AGENTS.md");
  writeFileSync(agentsPath, "# Rules\n\nline one\n");
  return { repo, runsDir, agentsPath };
}

/**
 * @param {string} runsDir
 * @param {string} runId
 * @param {string[]} statuses
 */
function writeRunNodes(runsDir, runId, statuses) {
  const nodeDir = join(runsDir, runId, "nodes");
  mkdirSync(nodeDir, { recursive: true });
  statuses.forEach((status, index) => {
    writeFileSync(join(nodeDir, `node-${index}.json`), JSON.stringify({ status }));
  });
}

test("writes a signal block for an active campaign and an active run", () => {
  const { runsDir, agentsPath } = makeRepo();
  initializeCampaign(runsDir, { campaignId: "demo", goal: "deliver demo" });
  writeRunNodes(runsDir, "run-a", ["done", "running"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.match(text, /^# Rules\n\nline one\n\n<!-- faberun-active:start/, "original content kept on top");
  assert.match(text, /campaign `demo`: active/);
  assert.match(text, /run `run-a`: active \(1\/2 nodes done\)/);
  assert.match(text, /deterministic detached process/u);
  assert.match(text, /do not poll `status` in a loop/u);
  assert.equal(text.split(SIGNAL_START).length - 1, 1, "single block");
});

test("updates the block in place without duplicating", () => {
  const { runsDir, agentsPath } = makeRepo();
  writeRunNodes(runsDir, "run-a", ["running"]);
  syncAgentSignal(runsDir);
  assert.equal(syncAgentSignal(runsDir), false, "no change means no write");
  writeRunNodes(runsDir, "run-b", ["pending"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.equal(text.split(SIGNAL_START).length - 1, 1);
  assert.match(text, /run `run-a`/);
  assert.match(text, /run `run-b`/);
});

test("removes the block when everything is terminal", () => {
  const { runsDir, agentsPath } = makeRepo();
  const campaign = initializeCampaign(runsDir, { campaignId: "demo", goal: "g" });
  writeRunNodes(runsDir, "run-a", ["done", "failed"]);
  syncAgentSignal(runsDir);
  appendJournal(campaign.path, {
    type: "retrospective",
    eventId: "demo-retro",
    at: new Date().toISOString(),
    sessionId: "test",
    text: "Retrospective: done.",
  });
  closeCampaign(campaign.path);
  writeRunNodes(runsDir, "run-a", ["done", "done"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.ok(!text.includes(SIGNAL_START) && !text.includes(SIGNAL_END), "block removed");
  assert.match(text, /^# Rules\n\nline one\n$/, "original content intact");
});

test("does nothing when AGENTS.md is missing", () => {
  const repo = mkdtempSync(join(tmpdir(), "signal-no-agents-"));
  const runsDir = runsRoot(repo);
  writeRunNodes(runsDir, "run-a", ["running"]);
  assert.equal(syncAgentSignal(runsDir), false);
  assert.ok(!existsSync(join(repo, "AGENTS.md")), "no file created");
});

// A run linked to a campaign is classified by the same rule as a standalone
// one. Measured 2026-09-22 on a live run: `reduceRunOutcome` is a reduction
// over snapshots with no notion of in-flight, so a `running` node -- not a
// success, not a tier-exhausted wait -- reduced to `parked`, and this renderer
// read that field raw. The block told a takeover session to `resume` a run
// whose controller was 23 minutes into its second node.
test("a linked run with a node still running is active, not parked", () => {
  const { runsDir, agentsPath } = makeRepo();
  const campaign = initializeCampaign(runsDir, { campaignId: "live", goal: "keep working" });
  writeRunNodes(runsDir, "run-live", ["done", "running"]);
  registerRun(campaign.path, "run-live");
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.match(text, /run `run-live`: active/u);
  assert.doesNotMatch(text, /run `run-live`: parked/u);
  assert.doesNotMatch(text, /resume .*run-live/u, "a live controller is never told to resume");
});

test("a linked run whose every node settled unsuccessfully is parked with its nodes", () => {
  const { runsDir, agentsPath } = makeRepo();
  const campaign = initializeCampaign(runsDir, { campaignId: "stuck", goal: "park" });
  writeRunNodes(runsDir, "run-stuck", ["done", "blocked"]);
  registerRun(campaign.path, "run-stuck");
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.match(text, /run `run-stuck`: parked/u);
  assert.match(text, /resume .*run-stuck/u, "a settled run keeps its resume command");
});

// Closing a campaign used to promote its parked runs rather than retire them:
// they stopped being indented children of a campaign and became top-level
// standalone entries that stayed forever. Measured 2026-09-22: 26 closed
// campaigns in the live project, seven parked runs from three of them in the
// block against one live run, each carrying a `resume` command for work a
// closed campaign had already settled.
test("a parked run of a closed campaign is retired from the block", () => {
  const { runsDir, agentsPath } = makeRepo();
  const closed = initializeCampaign(runsDir, { campaignId: "settled", goal: "was settled" });
  writeRunNodes(runsDir, "run-settled", ["blocked"]);
  registerRun(closed.path, "run-settled");
  appendJournal(closed.path, {
    type: "retrospective",
    eventId: "settled-retro",
    at: new Date().toISOString(),
    sessionId: "test",
    text: "Retrospective: settled.",
  });
  closeCampaign(closed.path);
  const open = initializeCampaign(runsDir, { campaignId: "open", goal: "still going" });
  writeRunNodes(runsDir, "run-open", ["running"]);
  registerRun(open.path, "run-open");
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.doesNotMatch(text, /run-settled/u, "a closed campaign's run is its own business");
  assert.match(text, /run `run-open`: active/u, "the live run still shows");
});

test("a parked run no campaign ever linked still blocks a naive fresh start", () => {
  const { runsDir, agentsPath } = makeRepo();
  writeRunNodes(runsDir, "run-orphan", ["blocked"]);
  assert.equal(syncAgentSignal(runsDir), true);
  const text = readFileSync(agentsPath, "utf8");
  assert.match(text, /run `run-orphan`: parked/u);
  assert.match(text, /resume .*run-orphan/u);
});
