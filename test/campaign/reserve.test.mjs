import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { closeCampaign, initializeCampaign } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import {
  RESERVE_DIR,
  RESERVE_STATE_FILE,
  configureCampaignReserve,
  readCampaignReserve,
  reconcileCampaignReservation,
  releaseCampaignReservation,
  reserveCampaignCost,
} from "../../src/campaign/reserve.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

// ---------------------------------------------------------------------------
// The optional campaign balance and its reserve gate (ADR 0011): arming the
// balance, holding known costs atomically, releasing or reconciling them,
// keeping unmeasured costs unknown and recording late charges.
// ---------------------------------------------------------------------------
test("a campaign arms, rereads and validates the optional reserve balance", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-config-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-config", goal: "Arm a balance" });
  assert.equal(reserveUsdOf(path), undefined, "a campaign without a balance reads as unconfigured");

  assert.throws(() => configureCampaignReserve(path, -1), /reserveUsd must be a non-negative number/u);
  assert.throws(() => configureCampaignReserve(path, Number.NaN), /reserveUsd must be a non-negative number/u);
  configureCampaignReserve(path, 100);
  assert.equal(reserveUsdOf(path), 100);
  configureCampaignReserve(path, 25.5);
  assert.equal(reserveUsdOf(path), 25.5, "re-arming the balance rewrites the field");

  // The schema refuses a hand-edited record whose balance is not a finite
  // non-negative number, and zero is a valid balance distinct from absent.
  const record = JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8"));
  record.reserveUsd = "hundred";
  writeFileSync(join(path, CAMPAIGN_FILE), JSON.stringify(record));
  assert.throws(() => readCampaign(path), /campaign\.reserveUsd must be a non-negative number/u);
  record.reserveUsd = -5;
  writeFileSync(join(path, CAMPAIGN_FILE), JSON.stringify(record));
  assert.throws(() => readCampaign(path), /campaign\.reserveUsd must be a non-negative number/u);
  record.reserveUsd = 0;
  writeFileSync(join(path, CAMPAIGN_FILE), JSON.stringify(record));
  assert.equal(reserveUsdOf(path), 0, "a zero balance is valid and gates every known-cost dispatch");

  appendJournal(path, {
    type: "retrospective",
    eventId: "reserve-retro",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: balance proven.",
  });
  closeCampaign(path);
  assert.throws(() => configureCampaignReserve(path, 10), /campaign is closed/u);
});
test("an unconfigured balance gates nothing and writes no reserve state", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-absent-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-absent", goal: "Record spend without a reserve" });

  const decision = reserveCampaignCost(path, { runId: "run-1", costUsd: 1000 });
  assert.equal(decision.admitted, true, "without a balance nothing is gated, however large the cost");
  assert.equal(decision.armed, false);
  assert.equal(decision.reservation, null);
  assert.equal(existsSync(join(path, RESERVE_DIR, RESERVE_STATE_FILE)), false, "no reservation state is written for an unconfigured balance");

  const status = readCampaignReserve(path);
  assert.equal(status.armed, false);
  assert.equal(status.configuredUsd, null);
  assert.equal(status.availableUsd, null);
  assert.deepEqual(status.reservations, []);
});
test("an unmeasured cost is admitted without a hold and reconciles to the real charge", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-unknown-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-unknown", goal: "Keep unmeasured costs unknown" });
  configureCampaignReserve(path, 100);

  const unknown = reserveCampaignCost(path, { runId: "run-1", node: "build", costUsd: null });
  assert.equal(unknown.admitted, true, "a call with no price is not blocked");
  assert.equal(unknown.reservation?.costUsd, null, "the exposure is recorded as unknown, never as a zero");
  assert.equal(unknown.availableUsd, 100, "an unknown cost holds nothing");
  assert.equal(readCampaignReserve(path).unknownExposureCount, 1);

  const known = reserveCampaignCost(path, { costUsd: 30 });
  assert.equal(known.admitted, true);
  assert.equal(readCampaignReserve(path).availableUsd, 70);

  const settled = reconcileCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (unknown).reservation.id, 12);
  assert.equal(settled.status, "charged");
  assert.equal(settled.chargedUsd, 12);
  assert.equal(settled.lateChargeUsd, null, "a charge against no reservation cannot be late");

  const status = readCampaignReserve(path);
  assert.equal(status.availableUsd, 58, "the real charge lands on the balance once it arrives");
  assert.equal(status.chargedUsd, 12);
  assert.equal(status.unknownExposureCount, 0, "the exposure is reconciled, not forgotten");

  assert.throws(
    () => reconcileCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (unknown).reservation.id, null),
    /costUsd must be a non-negative number/u,
    "reconciling requires a real charge, not another unknown",
  );
});
test("reservations release without a charge and reconcile late charges against actual spend", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-reconcile-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-reconcile", goal: "Release and reconcile" });
  configureCampaignReserve(path, 100);

  const a = reserveCampaignCost(path, { costUsd: 30 });
  const b = reserveCampaignCost(path, { costUsd: 20 });
  assert.equal(readCampaignReserve(path).availableUsd, 50);

  const released = releaseCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (a).reservation.id);
  assert.equal(released.status, "released");
  assert.equal(readCampaignReserve(path).availableUsd, 80, "a released hold returns to the balance");
  const again = releaseCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (a).reservation.id);
  assert.equal(again.status, "released", "releasing a released reservation is a no-op");

  const charged = reconcileCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (b).reservation.id, 25);
  assert.equal(charged.status, "charged");
  assert.equal(charged.lateChargeUsd, 5, "the part of the charge that passed the reservation is recorded");
  const status = readCampaignReserve(path);
  assert.equal(status.availableUsd, 75, "the real charge, not the reservation, comes off the balance");
  assert.equal(status.chargedUsd, 25);
  assert.equal(status.heldUsd, 0);

  const replay = reconcileCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (b).reservation.id, 25);
  assert.equal(replay.chargedUsd, 25, "reconciling the same charge twice is idempotent");
  assert.equal(readCampaignReserve(path).chargedUsd, 25);
  assert.throws(
    () => reconcileCampaignReservation(path, /** @type {{reservation: {id: string}}} */ (b).reservation.id, 26),
    /already charged/u,
    "a different amount for a settled reservation refuses",
  );
  assert.throws(() => releaseCampaignReservation(path, "no-such-reservation"), /no reservation no-such-reservation/u);
  assert.throws(() => reconcileCampaignReservation(path, "no-such-reservation", 1), /no reservation no-such-reservation/u);
});
test("simultaneous competing reservations admit only what the balance covers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-race-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-race", goal: "Refuse what the balance cannot cover" });
  configureCampaignReserve(path, 100);

  const [first, second] = await Promise.all([
    Promise.resolve().then(() => reserveCampaignCost(path, { runId: "run-a", costUsd: 80 })),
    Promise.resolve().then(() => reserveCampaignCost(path, { runId: "run-b", costUsd: 80 })),
  ]);
  const admissions = [first, second].filter((decision) => decision.admitted);
  assert.equal(admissions.length, 1, "two competing 80 USD reservations against a 100 USD balance cannot both be admitted");
  const refused = [first, second].find((decision) => !decision.admitted);
  assert.equal(refused?.reservation, null);
  assert.equal(refused?.availableUsd, 20, "the refusal reports what the winner left");

  const status = readCampaignReserve(path);
  assert.equal(status.heldUsd, 80);
  assert.equal(status.reservations.length, 1);
  assert.equal(status.availableUsd, 20);
});
test("two processes reserving simultaneously admit exactly one against the balance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-reserve-processes-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "reserve-processes", goal: "Gate across processes" });
  configureCampaignReserve(path, 100);

  const scriptPath = join(directory, "reserve-child.mjs");
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../../src/campaign/reserve.mjs", import.meta.url))).href;
  writeFileSync(scriptPath, `import { reserveCampaignCost } from ${JSON.stringify(moduleUrl)};
const [campaignPath, cost] = process.argv.slice(2);
const decision = reserveCampaignCost(campaignPath, { costUsd: Number(cost) });
process.stdout.write(JSON.stringify({ admitted: decision.admitted, availableUsd: decision.availableUsd }));
`);

  const outcomes = await Promise.all([80, 80].map((cost) => reserveInChild(scriptPath, path, cost)));
  assert.deepEqual(outcomes.filter((outcome) => outcome.admitted).length, 1, "the lock admits one competitor and refuses the other");
  const refused = outcomes.find((outcome) => !outcome.admitted);
  assert.equal(refused?.availableUsd, 20);

  const status = readCampaignReserve(path);
  assert.equal(status.heldUsd, 80, "the state file carries exactly the winner's hold");
  assert.equal(status.reservations.length, 1);
});

/**
 * The balance off the record. The `Campaign` typedef has not grown the field
 * in this node, so the read casts: the schema is what validates it.
 * @param {string} path
 * @returns {number|undefined}
 */
function reserveUsdOf(path) {
  return /** @type {any} */ (readCampaign(path)).reserveUsd;
}

/** Reserve once from a fresh process, so two callers genuinely contend for the reserve lock.
 * @param {string} scriptPath
 * @param {string} campaignPath
 * @param {number} costUsd
 */
async function reserveInChild(scriptPath, campaignPath, costUsd) {
  const child = spawn(process.execPath, [scriptPath, campaignPath, String(costUsd)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`reserve child exited with ${code}: ${stderr || stdout}`);
  return JSON.parse(stdout);
}
