/**
 * Attention attribution in the managed AGENTS.md signal block.
 *
 * An inbox attention belongs to one campaign or none: an explicit
 * `campaignId` is authoritative, and a null one is resolved from the entry's
 * `runId`, because a run belongs to at most one campaign. The old rule —
 * `campaignId === null` matched every campaign — attributed an orphan to
 * every active campaign at once; these tests pin runId resolution and the
 * run-level line that keeps an unowned attention visible.
 */

import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentSignalBlock } from "../../src/repo/signal.mjs";
import { closeCampaign, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { appendInbox } from "../../src/notify/index.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

/** @returns {{runsDir: string}} */
function makeRunsDir() {
  const repo = mkdtempSync(join(tmpdir(), "signal-attribution-"));
  return { runsDir: runsRoot(repo) };
}

test("an attention naming a run of campaign A appears under A and not under B", () => {
  const { runsDir } = makeRunsDir();
  const alpha = initializeCampaign(runsDir, { campaignId: "alpha", goal: "goal alpha" });
  initializeCampaign(runsDir, { campaignId: "beta", goal: "goal beta" });
  registerRun(alpha.path, "run-alpha");
  appendInbox(runsDir, {
    type: "attention",
    runId: "run-alpha",
    dedupeKey: "attribution:run-alpha",
    summary: "alpha worker needs you",
  });
  const text = renderAgentSignalBlock(runsDir);
  assert.match(text, /campaign `alpha`: active/u);
  assert.match(text, /campaign `beta`: active/u);
  assert.equal(text.split("  - attention:").length - 1, 1, "one campaign-level attention, not one per campaign");
  assert.ok(
    text.indexOf("  - attention: alpha worker needs you") > text.indexOf("campaign `alpha`: active"),
    "the attention sits in alpha's section",
  );
});

test("an attention whose run resolves to no campaign appears under neither but stays visible", () => {
  const { runsDir } = makeRunsDir();
  const alpha = initializeCampaign(runsDir, { campaignId: "alpha", goal: "goal alpha" });
  initializeCampaign(runsDir, { campaignId: "beta", goal: "goal beta" });
  registerRun(alpha.path, "run-alpha");
  appendInbox(runsDir, {
    type: "attention",
    runId: "run-orphan",
    dedupeKey: "attribution:run-orphan",
    summary: "orphan worker needs you",
  });
  const text = renderAgentSignalBlock(runsDir);
  assert.ok(!text.includes("  - attention:"), "no campaign claims it");
  assert.match(
    text,
    /- attention: run `run-orphan` resolves to no campaign — orphan worker needs you/u,
    "still visible at run level",
  );
  assert.ok(
    text.indexOf("- attention: run `run-orphan`") > text.indexOf("campaign `beta`: active"),
    "the orphan line sits below every campaign section",
  );
});

test("an entry that already carries a campaignId keeps working", () => {
  const { runsDir } = makeRunsDir();
  initializeCampaign(runsDir, { campaignId: "alpha", goal: "goal alpha" });
  const beta = initializeCampaign(runsDir, { campaignId: "beta", goal: "goal beta" });
  registerRun(beta.path, "run-beta");
  appendInbox(runsDir, {
    type: "attention",
    campaignId: "beta",
    runId: "run-beta",
    dedupeKey: "attribution:explicit",
    summary: "beta worker needs you",
  });
  const text = renderAgentSignalBlock(runsDir);
  assert.equal(text.split("  - attention:").length - 1, 1);
  assert.ok(
    text.indexOf("  - attention: beta worker needs you") > text.indexOf("campaign `beta`: active"),
    "the explicit campaignId still decides",
  );
  assert.ok(!text.includes("resolves to no campaign"), "an attributed entry is not re-reported at run level");
});

// A closed campaign still owns its runs. Indexing only the active campaigns
// made every attention from a closed one unattributable, so it was surfaced
// at run level as an orphan and stayed there for good -- measured 2026-09-22
// on the live block, one from harden-chain-and-verification, closed six days
// earlier. Owned but under no active campaign is simply not shown.
test("an attention from a closed campaign's run is owned, not orphaned", () => {
  const { runsDir } = makeRunsDir();
  const settled = initializeCampaign(runsDir, { campaignId: "settled", goal: "was settled" });
  registerRun(settled.path, "run-settled");
  appendJournal(settled.path, {
    type: "retrospective",
    eventId: "settled-retro",
    at: new Date().toISOString(),
    sessionId: "test",
    text: "Retrospective: settled.",
  });
  closeCampaign(settled.path);
  initializeCampaign(runsDir, { campaignId: "live", goal: "still going" });
  appendInbox(runsDir, {
    type: "attention",
    runId: "run-settled",
    dedupeKey: "attribution:run-settled",
    summary: "a settled campaign's worker once needed you",
  });
  const text = renderAgentSignalBlock(runsDir);
  assert.match(text, /campaign `live`: active/u);
  assert.doesNotMatch(text, /resolves to no campaign/u, "a closed campaign owns its run");
  assert.doesNotMatch(text, /a settled campaign's worker once needed you/u);
});

test("an attention whose run no campaign ever linked is still surfaced at run level", () => {
  const { runsDir } = makeRunsDir();
  initializeCampaign(runsDir, { campaignId: "live", goal: "still going" });
  appendInbox(runsDir, {
    type: "attention",
    runId: "run-nobody",
    dedupeKey: "attribution:run-nobody",
    summary: "nobody owns this one",
  });
  const text = renderAgentSignalBlock(runsDir);
  assert.match(text, /resolves to no campaign/u);
  assert.match(text, /nobody owns this one/u);
});
