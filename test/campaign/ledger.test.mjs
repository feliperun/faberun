import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCampaign, initializeCampaign, preserveCampaignLedger, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

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
