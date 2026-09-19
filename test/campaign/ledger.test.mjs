import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCampaign, initializeCampaign, preserveCampaignLedger, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { reassociateProject } from "../../src/cli/project.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

// campaign close preserves ledger: journal, record and linked-run usage survive under docs/.

test("campaign close preserves ledger", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-ledger-"));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "ledgered", goal: "Preserve the ledger" });
  registerRun(created.path, "run-with-usage");
  registerRun(created.path, "run-without-usage");
  mkdirSync(join(runsDir, "run-with-usage"), { recursive: true });
  writeFileSync(join(runsDir, "run-with-usage", "usage.jsonl"), '{"tokens":1}\n');
  appendJournal(created.path, {
    type: "retrospective",
    eventId: "retro-1",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: shipped; no follow-ups.",
  });

  const closed = closeCampaign(created.path);
  const ledgerDir = join(repo, "docs", "campaigns", "ledgered", "ledger");
  assert.ok(existsSync(join(ledgerDir, "journal.jsonl")));
  assert.ok(existsSync(join(ledgerDir, "campaign.json")));
  assert.ok(existsSync(join(ledgerDir, "run-with-usage.usage.jsonl")));
  assert.ok(!existsSync(join(ledgerDir, "run-without-usage.usage.jsonl")));
  const entries = readdirSync(ledgerDir).sort();
  assert.deepEqual(entries, ["campaign.json", "journal.jsonl", "run-with-usage.usage.jsonl"]);
  assert.equal(closed.ledgerFiles.length, 3);

  assert.throws(() => closeCampaign(created.path), /already closed/u);
});

test("preserveCampaignLedger is idempotent across repeated calls", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-ledger-idempotent-"));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "idempotent", goal: "Prove idempotence" });
  registerRun(created.path, "run-1");
  mkdirSync(join(runsDir, "run-1"), { recursive: true });
  writeFileSync(join(runsDir, "run-1", "usage.jsonl"), '{"tokens":2}\n');

  const first = preserveCampaignLedger(created.path, repo);
  const ledgerDir = join(repo, "docs", "campaigns", "idempotent", "ledger");
  const firstListing = readdirSync(ledgerDir).sort();

  writeFileSync(join(runsDir, "run-1", "usage.jsonl"), '{"tokens":3}\n');
  const second = preserveCampaignLedger(created.path, repo);
  const secondListing = readdirSync(ledgerDir).sort();

  assert.deepEqual(firstListing, secondListing);
  assert.equal(first.length, second.length);
  assert.equal(readFileSync(join(ledgerDir, "run-1.usage.jsonl"), "utf8"), '{"tokens":3}\n');
});

/**
 * @param {string} campaignPath @param {string} eventId @returns {void}
 */
function recordRetrospective(campaignPath, eventId) {
  appendJournal(campaignPath, {
    type: "retrospective",
    eventId,
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: shipped; no follow-ups.",
  });
}

test("close preserves the ledger at the project's registered repository, not under the home", () => {
  const home = mkdtempSync(join(tmpdir(), "faberun-ledger-home-"));
  process.env.FABERUN_HOME = home;
  // realpath-resolved: the project registry keys on it, since $TMPDIR itself
  // is a symlink on macOS (`/var` -> `/private/var`).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "runner-campaign-ledger-repo-")));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "homed", goal: "Preserve inside the repository" });
  recordRetrospective(created.path, "retro-homed");

  const closed = closeCampaign(created.path);
  const ledgerDir = join(repo, "docs", "campaigns", "homed", "ledger");
  assert.deepEqual(closed.ledgerFiles, [join(ledgerDir, "journal.jsonl"), join(ledgerDir, "campaign.json")]);
  assert.ok(existsSync(join(ledgerDir, "journal.jsonl")), "the ledger lands inside the git repository");
  assert.equal(existsSync(join(home, "docs")), false, "nothing is preserved under the home");
});

test("a project reassociated after creation preserves the ledger at its new path", () => {
  const home = mkdtempSync(join(tmpdir(), "faberun-ledger-home-"));
  process.env.FABERUN_HOME = home;
  const original = mkdtempSync(join(tmpdir(), "runner-campaign-ledger-move-from-"));
  const runsDir = runsRoot(original);
  const created = initializeCampaign(runsDir, { campaignId: "moved", goal: "Follow the repository" });
  recordRetrospective(created.path, "retro-moved");
  const moved = join(tmpdir(), "runner-campaign-ledger-move-to");
  reassociateProject(home, moved, { from: original });

  closeCampaign(created.path);
  assert.ok(existsSync(join(moved, "docs", "campaigns", "moved", "ledger", "journal.jsonl")), "preserved at the current registered path");
  assert.equal(existsSync(join(original, "docs")), false, "not at the path the project has moved away from");
});
