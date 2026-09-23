import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCampaign, initializeCampaign, preserveCampaignLedger, registerRun, reledgerCampaign } from "../../src/campaign/index.mjs";
import { campaignCli } from "../../src/cli/campaign.mjs";
import { readMetricNodeSnapshots } from "../../src/campaign/metrics-command.mjs";
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
  assert.deepEqual(entries, ["campaign.json", "journal.jsonl", "run-with-usage.usage.jsonl", "sources.json"]);
  assert.equal(closed.ledgerFiles.length, 4);

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
  assert.equal(first.written.length, second.written.length);
  assert.equal(readFileSync(join(ledgerDir, "run-1.usage.jsonl"), "utf8"), '{"tokens":3}\n');
});

test("a closed ledger carries every source the projectors read", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-ledger-sources-"));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "all-sources", goal: "Preserve every projector source" });
  registerRun(created.path, "run-a");
  registerRun(created.path, "run-b");
  const runA = join(runsDir, "run-a");
  const runB = join(runsDir, "run-b");
  mkdirSync(join(runA, "nodes"), { recursive: true });
  mkdirSync(join(runB, "nodes"), { recursive: true });
  writeFileSync(join(runA, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done", attempt: 1, revisions: 2, review: "blocking", prompt: "not ledger evidence" }));
  writeFileSync(join(runB, "nodes", "test.json"), JSON.stringify({ id: "test", status: "running", attempt: 2, revisions: 1, review: null, diff: "not ledger evidence" }));
  for (const [runDir, prefix] of [[runA, "a"], [runB, "b"]]) {
    writeFileSync(join(runDir, "events.jsonl"), `{"type":"${prefix}.event"}\n`);
    writeFileSync(join(runDir, "usage.jsonl"), `{"tokens":${prefix === "a" ? 1 : 2}}\n`);
  }
  writeFileSync(join(runA, "notify.jsonl"), '{"status":"delivered"}\n');
  mkdirSync(join(created.path, "proposals"), { recursive: true });
  writeFileSync(join(created.path, "proposals", "proposal.md"), "proposal evidence\n");
  appendJournal(created.path, {
    type: "retrospective",
    eventId: "retro-all-sources",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: all sources preserved.",
  });

  const closed = closeCampaign(created.path);
  const ledgerDir = join(repo, "docs", "campaigns", "all-sources", "ledger");
  const expectedFiles = [
    "campaign.json",
    "journal.jsonl",
    "proposals/proposal.md",
    "run-a.events.jsonl",
    "run-a.nodes.json",
    "run-a.notify.jsonl",
    "run-a.usage.jsonl",
    "run-b.events.jsonl",
    "run-b.nodes.json",
    "run-b.usage.jsonl",
    "sources.json",
  ];
  assert.deepEqual(expectedFiles.map((path) => existsSync(join(ledgerDir, path))), expectedFiles.map(() => true));
  assert.equal(existsSync(join(ledgerDir, "run-b.notify.jsonl")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(ledgerDir, "run-a.nodes.json"), "utf8")), readMetricNodeSnapshots(runA));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(ledgerDir, "run-a.nodes.json"), "utf8"))[0]).sort(), ["attempt", "id", "review", "revisions", "status"]);
  assert.deepEqual(closed.ledgerSkipped, [{ runId: "run-b", source: "notify.jsonl" }]);

  const firstListing = readdirSync(ledgerDir, { recursive: true }).sort();
  const second = preserveCampaignLedger(created.path, repo);
  const secondListing = readdirSync(ledgerDir, { recursive: true }).sort();
  assert.deepEqual(secondListing, firstListing);
  assert.deepEqual(second.skipped, closed.ledgerSkipped);
});

test("reledger completes a ledger without losing what it had", async () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-reledger-"));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "reledger", goal: "Complete the evidence ledger" });
  registerRun(created.path, "run-live");
  registerRun(created.path, "run-gone");
  const runDir = join(runsDir, "run-live");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "usage.jsonl"), "original usage\n");
  recordRetrospective(created.path, "retro-reledger");
  closeCampaign(created.path);

  const ledgerDir = join(repo, "docs", "campaigns", "reledger", "ledger");
  const usageLedger = join(ledgerDir, "run-live.usage.jsonl");
  writeFileSync(usageLedger, "longer existing ledger\n");
  writeFileSync(join(runDir, "usage.jsonl"), "short source\n");
  writeFileSync(join(runDir, "events.jsonl"), '{"type":"late.event"}\n');
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done", attempt: 1, revisions: 0, review: null }));
  mkdirSync(join(created.path, "proposals"), { recursive: true });
  writeFileSync(join(created.path, "proposals", "late.md"), "late proposal\n");

  await campaignCli(["reledger", "reledger", "--cwd", repo]);
  assert.equal(readFileSync(join(ledgerDir, "run-live.events.jsonl"), "utf8"), '{}\n');
  assert.equal(readFileSync(usageLedger, "utf8"), "longer existing ledger\n");
  assert.ok(existsSync(join(ledgerDir, "run-live.nodes.json")));
  assert.equal(readFileSync(join(ledgerDir, "proposals", "late.md"), "utf8"), "late proposal\n");
  const closedCampaign = JSON.parse(readFileSync(join(ledgerDir, "campaign.json"), "utf8"));
  const precloseCampaign = { ...closedCampaign, status: "active" };
  delete precloseCampaign.closedAt;
  delete precloseCampaign.requirements;
  writeFileSync(join(ledgerDir, "campaign.json"), JSON.stringify(precloseCampaign) + "\n");
  reledgerCampaign(created.path);
  assert.equal(JSON.parse(readFileSync(join(ledgerDir, "campaign.json"), "utf8")).status, "closed");
  const report = reledgerCampaign(created.path);
  assert.ok(report.gone.some(({ runId, source }) => runId === "run-gone" && source === "events.jsonl"));
  const firstLedger = /** @type {string[]} */ (readdirSync(ledgerDir, { recursive: true })).filter((path) => path !== "proposals").sort();
  const firstBytes = firstLedger.map((path) => [path, readFileSync(join(ledgerDir, path), "utf8")]);

  await campaignCli(["reledger", "reledger", "--cwd", repo]);
  const secondLedger = /** @type {string[]} */ (readdirSync(ledgerDir, { recursive: true })).filter((path) => path !== "proposals").sort();
  const secondBytes = secondLedger.map((path) => [path, readFileSync(join(ledgerDir, path), "utf8")]);
  assert.deepEqual(secondLedger, firstLedger);
  assert.deepEqual(secondBytes, firstBytes);
  assert.ok(secondBytes.some(([path]) => path === "run-live.events.jsonl"));
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
  assert.deepEqual(closed.ledgerFiles, [join(ledgerDir, "journal.jsonl"), join(ledgerDir, "campaign.json"), join(ledgerDir, "sources.json")]);
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

test("ledger event and notify projections exclude free text and machine paths", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-ledger-projection-"));
  const runsDir = runsRoot(repo);
  const created = initializeCampaign(runsDir, { campaignId: "projected", goal: "Project safe evidence" });
  registerRun(created.path, "run-a");
  const runDir = join(runsDir, "run-a");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done", attempt: 1, revisions: 0, review: null }));
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ node: "build", to: "done", at: "2026-09-23T10:00:00.000Z", summary: "secret-token /Users/frb/private/resume" }) + "\n");
  writeFileSync(join(runDir, "notify.jsonl"), JSON.stringify({ dedupeKey: "build", attempt: 1, status: "delivered", at: "2026-09-23T10:00:01.000Z", message: "secret-token /Users/frb/private/resume" }) + "\n");
  recordRetrospective(created.path, "retro-projected");
  closeCampaign(created.path);
  const ledgerDir = join(repo, "docs", "campaigns", "projected", "ledger");
  const ledgerText = readFileSync(join(ledgerDir, "run-a.events.jsonl"), "utf8") + readFileSync(join(ledgerDir, "run-a.notify.jsonl"), "utf8");
  assert.equal(ledgerText.includes("secret-token"), false);
  assert.equal(ledgerText.includes("/Users/frb/private"), false);
  assert.deepEqual(JSON.parse(readFileSync(join(ledgerDir, "run-a.events.jsonl"), "utf8")), {
    node: "build",
    to: "done",
    at: "2026-09-23T10:00:00.000Z",
  });
  assert.deepEqual(JSON.parse(readFileSync(join(ledgerDir, "run-a.notify.jsonl"), "utf8")), {
    dedupeKey: "build",
    attempt: 1,
    status: "delivered",
    at: "2026-09-23T10:00:01.000Z",
  });
});
