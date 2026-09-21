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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentSignalBlock } from "../../src/repo/signal.mjs";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
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
