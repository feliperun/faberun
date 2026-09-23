import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCampaigns } from "../../src/campaign/index.mjs";
import { CAMPAIGN_FILE, campaignsDir } from "../../src/campaign/layout.mjs";
import { repairCampaignRecords } from "../../src/run/migrate.mjs";

// The repair scans a runs root directly and never resolves a project, but the
// suite never lets a fixture reach the operator's own home, so an unset
// variable still gets a throwaway.
if (!process.env.FABERUN_HOME) {
  process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));
}

// Campaign-record repair: a record written before `status` existed is
// repaired by the migrate verb instead of being reported corrupt forever.

/**
 * A campaign record written 2026-08-18, before `status` was required: id,
 * goal and linkedRunIds, no status.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function historicalRecord(overrides = {}) {
  return {
    id: "run-harness-audit-20260818",
    goal: "Audit the run harness",
    linkedRunIds: [],
    createdAt: "2026-08-18T09:00:00.000Z",
    updatedAt: "2026-08-18T09:30:00.000Z",
    ...overrides,
  };
}

/**
 * @param {string} runsDir
 * @param {string} dirName
 * @param {Record<string, unknown>|string} record
 * @returns {string}
 */
function writeRecord(runsDir, dirName, record) {
  const dir = join(campaignsDir(runsDir), dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CAMPAIGN_FILE);
  writeFileSync(file, typeof record === "string" ? record : `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

test("a record written before status existed is repaired to closed and the repair is named", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runner-record-repair-"));
  const file = writeRecord(runsDir, "run-harness-audit-20260818", historicalRecord());
  const reported = discoverCampaigns(runsDir).corrupt.find((entry) => entry.id === "run-harness-audit-20260818");
  assert.ok(reported, "the record is corrupt before the repair");
  assert.match(reported.error.message, /campaign\.status/u);

  assert.deepEqual(repairCampaignRecords(runsDir), [{ id: "run-harness-audit-20260818", field: "status" }]);

  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.status, "closed", "the absent field takes the default current writes apply");
  assert.deepEqual(record, historicalRecord({ status: "closed" }), "no field other than status changes");
  const after = discoverCampaigns(runsDir);
  assert.deepEqual(after.corrupt, [], "the repaired record is no longer reported corrupt");
  const entry = after.campaigns.find((item) => item.campaign.id === "run-harness-audit-20260818");
  assert.equal(entry?.campaign.status, "closed");
});

test("a record corrupt for any other reason stays corrupt and is not touched", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runner-record-repair-other-"));
  const cases = /** @type {[string, Record<string, unknown>|string][]} */ ([
    ["no-id", { goal: "Audit the run harness", linkedRunIds: [], createdAt: "2026-08-18T09:00:00.000Z", updatedAt: "2026-08-18T09:30:00.000Z" }],
    ["bad-goal", historicalRecord({ id: "bad-goal", goal: 42 })],
    ["bad-runs", historicalRecord({ id: "bad-runs", linkedRunIds: "run-1" })],
    ["bad-status", historicalRecord({ id: "bad-status", status: "open" })],
    ["malformed", "{ not json"],
  ]);
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [dirName, record] of cases) files.set(dirName, writeRecord(runsDir, dirName, record));
  const before = new Map([...files].map(([name, file]) => [name, readFileSync(file, "utf8")]));

  assert.deepEqual(repairCampaignRecords(runsDir), [], "nothing is repaired, so nothing is named");

  for (const [name, file] of files) {
    assert.equal(readFileSync(file, "utf8"), before.get(name), `${name} is byte for byte untouched`);
  }
  assert.deepEqual(
    discoverCampaigns(runsDir).corrupt.map((entry) => entry.id).sort(),
    ["bad-goal", "bad-runs", "bad-status", "malformed", "no-id"],
  );
});

test("a record already carrying status is not rewritten", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runner-record-repair-has-status-"));
  const file = writeRecord(runsDir, "still-driving", historicalRecord({ id: "still-driving", status: "active" }));
  const before = readFileSync(file, "utf8");

  assert.deepEqual(repairCampaignRecords(runsDir), []);
  assert.equal(readFileSync(file, "utf8"), before);
  const entry = discoverCampaigns(runsDir).campaigns.find((item) => item.campaign.id === "still-driving");
  assert.equal(entry?.campaign.status, "active");
});

test("running the repair twice changes nothing the second time", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runner-record-repair-idempotent-"));
  const file = writeRecord(runsDir, "run-harness-audit-20260818", historicalRecord());
  assert.deepEqual(repairCampaignRecords(runsDir), [{ id: "run-harness-audit-20260818", field: "status" }]);
  const once = readFileSync(file, "utf8");

  assert.deepEqual(repairCampaignRecords(runsDir), [], "the second run names no repair");
  assert.equal(readFileSync(file, "utf8"), once, "the second run writes nothing");
});
