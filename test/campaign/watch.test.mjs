import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { readInbox } from "../../src/notify/index.mjs";
import { watchCampaignWake } from "../../src/campaign/watch.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// The wording these tests pin is the test's, not this machine's: an
// operator's FABERUN_NOTIFY_LANG must never choose which language the
// assertions read.
process.env.FABERUN_NOTIFY_LANG = "en";

/** The watcher's idle window: twenty minutes with no run active. */
const IDLE_WINDOW_MS = 20 * 60_000;

/** @param {string} prefix @returns {string} */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * One watcher session, `--once` against a clock the test owns. A session is a
 * whole process lifetime as far as the durable dedupe can tell, which is what
 * makes it the honest unit for a restart.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {number} atMs
 * @param {Record<string, unknown>} [seams] overrides for individual injectables (sendProgress, lock)
 * @returns {Promise<Array<{campaignId: string, dedupeKey: string, summary: string}>>}
 */
async function poll(campaignPath, runsDir, atMs, seams = {}) {
  /** @type {Array<{campaignId: string, dedupeKey: string, summary: string}>} */
  const events = [];
  await watchCampaignWake(campaignPath, runsDir, {
    once: true,
    now: () => atMs,
    emit: () => {},
    notify: (event) => { events.push(event); },
    ...seams,
  });
  return events;
}

/**
 * One watcher session with the progress delivery under the test's control.
 * Every call is a fresh session, so `sent` shows exactly what this session
 * delivered and what it asked to edit.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {number} atMs
 * @param {(campaignId: string, summary: string, editOfMessageId: string|null) => Promise<{ok: boolean, messageId?: string}|null>} sendProgress
 * @returns {Promise<{events: Array<{dedupeKey: string, summary: string}>, sent: Array<{summary: string, editOfMessageId: string|null}>}>}
 */
async function pollProgress(campaignPath, runsDir, atMs, sendProgress) {
  /** @type {Array<{summary: string, editOfMessageId: string|null}>} */
  const sent = [];
  const events = await poll(campaignPath, runsDir, atMs, {
    sendProgress: async (/** @type {string} */ campaignId, /** @type {string} */ summary, /** @type {string|null} */ editOfMessageId) => {
      sent.push({ summary, editOfMessageId });
      return sendProgress(campaignId, summary, editOfMessageId);
    },
  });
  return { events, sent };
}

/** @param {Array<{dedupeKey: string}>} events @returns {Array<{campaignId: string, dedupeKey: string, summary: string}>} */
function idleAlerts(events) {
  return /** @type {Array<{campaignId: string, dedupeKey: string, summary: string}>} */ (events.filter((event) => event.dedupeKey.startsWith("idle:")));
}

/**
 * One linked run's snapshot. A non-terminal node is what the watcher reads as
 * activity; a terminal one leaves the campaign idle.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @param {string} nodeStatus
 */
function writeRunStatus(runsDir, runId, nodeStatus) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ nodes: [{ id: "build", status: nodeStatus }], summary: `1/1 nodes ${nodeStatus}` }));
}

/** The durable episode anchor a campaign carries, or null. @param {string} campaignPath @returns {{campaignId?: string, idleSince?: string}|null} */
function readAnchor(campaignPath) {
  const path = join(campaignPath, "watch-idle.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/**
 * One linked run the projection can read: the contract the run launched with
 * and one snapshot per node, filled with the fields the snapshot reader
 * expects so only the statuses under test vary.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @param {{id: string, goal?: string, nodes: Array<{id: string, dependsOn: string[]}>}} contract
 * @param {Array<Record<string, unknown>>} snapshots
 * @returns {string}
 */
function writePhaseRun(runsDir, runId, contract, snapshots) {
  const runDir = join(runsDir, runId);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), JSON.stringify(contract));
  for (const snapshot of snapshots) {
    writeFileSync(join(runDir, "nodes", `${snapshot.id}.json`), JSON.stringify({
      attempt: 1,
      startedAt: "2026-09-29T10:00:00.000Z",
      updatedAt: "2026-09-29T10:05:00.000Z",
      invocations: [],
      error: null,
      worktree: null,
      result: { summary: "" },
      ...snapshot,
    }));
  }
  return runDir;
}

/** One node's snapshot, rewritten in place. @param {string} runDir @param {string} nodeId @param {string} status @param {string} updatedAt */
function markNode(runDir, nodeId, status, updatedAt) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  snapshot.status = status;
  snapshot.updatedAt = updatedAt;
  writeFileSync(path, JSON.stringify(snapshot));
}

/**
 * The campaign record flipped to closed, the way a fixture does it: the
 * watcher reads the status and the projection reads the closedAt.
 *
 * @param {string} campaignPath @param {string} closedAt
 */
function closeRecord(campaignPath, closedAt) {
  const recordPath = join(campaignPath, "campaign.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.status = "closed";
  record.closedAt = closedAt;
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

/** The progress anchor file's parsed contents, or null. @param {string} campaignPath @returns {Record<string, unknown>|null} */
function readProgressAnchorFile(campaignPath) {
  const path = join(campaignPath, "watch-progress.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

test("two idle campaigns in one runs root alert on their own campaign keys", async () => {
  const runsDir = runsRoot(tempDir("watch-idle-pair-"));
  const alpha = initializeCampaign(runsDir, { campaignId: "alpha", goal: "prove alpha alerts on its own key" });
  const beta = initializeCampaign(runsDir, { campaignId: "beta", goal: "prove beta alerts on its own key" });
  const start = Date.parse("2026-09-29T12:00:00.000Z");

  assert.deepEqual(await poll(alpha.path, runsDir, start), [], "the episode begins silently");
  assert.deepEqual(await poll(beta.path, runsDir, start), [], "the episode begins silently");

  const alphaAlerts = idleAlerts(await poll(alpha.path, runsDir, start + IDLE_WINDOW_MS + 60_000));
  const betaAlerts = idleAlerts(await poll(beta.path, runsDir, start + IDLE_WINDOW_MS + 60_000));

  assert.equal(alphaAlerts.length, 1, "alpha is idle and alerts");
  assert.equal(betaAlerts.length, 1, "beta still alerts; alpha's key does not consume it");
  assert.match(alphaAlerts[0].dedupeKey, /^idle:alpha:2026-09-29T12:00:00\.000Z:1$/u);
  assert.match(betaAlerts[0].dedupeKey, /^idle:beta:2026-09-29T12:00:00\.000Z:1$/u);
  assert.match(alphaAlerts[0].summary, /campaign-watch: alpha active but no run has been active for 21 min/u);
  assert.match(betaAlerts[0].summary, /campaign-watch: beta active but no run has been active for 21 min/u);

  assert.deepEqual(
    readInbox(runsDir).map((entry) => entry.campaignId),
    ["alpha", "beta"],
    "the shared inbox records both idle campaigns",
  );
});

test("a restart inside one window stays quiet and the next window alerts again", async () => {
  const runsDir = runsRoot(tempDir("watch-idle-restart-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "restart", goal: "prove the episode survives a restart" });
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  assert.deepEqual(await poll(path, runsDir, start), []);

  const first = idleAlerts(await poll(path, runsDir, start + IDLE_WINDOW_MS + 60_000));
  assert.equal(first.length, 1, "the first window alerts");
  assert.equal(first[0].dedupeKey, "idle:restart:2026-09-29T12:00:00.000Z:1");
  assert.deepEqual(readAnchor(path), { campaignId: "restart", idleSince: "2026-09-29T12:00:00.000Z" }, "the episode anchors on the instant the campaign went idle");

  // A restart five minutes later: a new process with a fresh in-memory clock.
  assert.deepEqual(await poll(path, runsDir, start + 25 * 60_000), [], "the window already announced is not re-sent");
  // The persisted anchor, not the restart, decides when the next window is due.
  const second = idleAlerts(await poll(path, runsDir, start + 41 * 60_000));
  assert.equal(second.length, 1, "the next window alerts after the restart");
  assert.equal(second[0].dedupeKey, "idle:restart:2026-09-29T12:00:00.000Z:2");
});

test("idleness returning after a run is a new episode and alerts again", async () => {
  const runsDir = runsRoot(tempDir("watch-idle-episode-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "episodes", goal: "prove a second idle episode alerts" });
  registerRun(path, "run-a");
  writeRunStatus(runsDir, "run-a", "running");
  assert.deepEqual(idleAlerts(await poll(path, runsDir, Date.parse("2026-09-29T12:00:00.000Z"))), [], "a run is active, so nothing is idle");

  writeRunStatus(runsDir, "run-a", "done");
  const firstIdle = Date.parse("2026-09-29T13:00:00.000Z");
  assert.deepEqual(idleAlerts(await poll(path, runsDir, firstIdle)), [], "the episode begins silently");
  const firstEpisode = idleAlerts(await poll(path, runsDir, firstIdle + IDLE_WINDOW_MS + 60_000));
  assert.equal(firstEpisode.length, 1);
  assert.equal(firstEpisode[0].dedupeKey, "idle:episodes:2026-09-29T13:00:00.000Z:1");

  // The node runs again: the episode ends and its anchor is dropped.
  writeRunStatus(runsDir, "run-a", "running");
  assert.deepEqual(idleAlerts(await poll(path, runsDir, firstIdle + 30 * 60_000)), [], "activity ends the episode");
  assert.equal(readAnchor(path), null, "no episode is in progress while a run is active");

  writeRunStatus(runsDir, "run-a", "done");
  const secondIdle = Date.parse("2026-09-29T14:00:00.000Z");
  assert.deepEqual(idleAlerts(await poll(path, runsDir, secondIdle)), [], "a fresh episode begins silently");
  const secondEpisode = idleAlerts(await poll(path, runsDir, secondIdle + IDLE_WINDOW_MS + 60_000));
  assert.equal(secondEpisode.length, 1, "idleness returning alerts again");
  assert.equal(secondEpisode[0].dedupeKey, "idle:episodes:2026-09-29T14:00:00.000Z:1");
  assert.notEqual(secondEpisode[0].dedupeKey, firstEpisode[0].dedupeKey, "the two episodes have distinct keys");

  assert.deepEqual(
    readInbox(runsDir).filter((entry) => String(entry.dedupeKey).startsWith("idle:")).map((entry) => entry.dedupeKey),
    ["idle:episodes:2026-09-29T13:00:00.000Z:1", "idle:episodes:2026-09-29T14:00:00.000Z:1"],
  );
});

test("an anchor naming another campaign, or an unparsable one, is no episode", async () => {
  const runsDir = runsRoot(tempDir("watch-idle-foreign-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "mine", goal: "prove a foreign anchor is ignored" });
  const start = Date.parse("2026-09-29T12:00:00.000Z");

  // Three windows old, and written for a campaign that is not this one: if the
  // anchor were adopted, the poll below would announce window 3 immediately.
  writeFileSync(join(path, "watch-idle.json"), JSON.stringify({ campaignId: "someone-else", idleSince: new Date(start - 3 * IDLE_WINDOW_MS).toISOString() }));
  assert.deepEqual(idleAlerts(await poll(path, runsDir, start)), [], "the foreign anchor is ignored");
  assert.deepEqual(readInbox(runsDir), []);

  // A torn record must not take the watcher down either: the episode starts
  // now, and nothing is due at the instant it starts.
  writeFileSync(join(path, "watch-idle.json"), "{\"idleSince\":");
  assert.deepEqual(idleAlerts(await poll(path, runsDir, start + IDLE_WINDOW_MS + 60_000)), [], "a torn anchor is ignored");
});

test("the four campaign alerts come from the shared projection, deduped by campaign and episode", async () => {
  const runsDir = runsRoot(tempDir("watch-projection-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "proj", goal: "prove the alerts read the projection" });
  registerRun(path, "phase-one");
  registerRun(path, "phase-two");
  writePhaseRun(runsDir, "phase-one",
    { id: "phase-one", goal: "the finished phase", nodes: [{ id: "build", dependsOn: [] }, { id: "docs", dependsOn: ["build"] }] },
    [
      { id: "build", status: "done" },
      { id: "docs", status: "done" },
    ]);
  writePhaseRun(runsDir, "phase-two",
    { id: "phase-two", goal: "the stuck phase", nodes: [{ id: "verify", dependsOn: [] }, { id: "decide", dependsOn: ["verify"] }] },
    [
      { id: "verify", status: "exhausted" },
      { id: "decide", status: "blocked" },
    ]);

  const events = await poll(path, runsDir, Date.parse("2026-09-29T12:00:00.000Z"));
  assert.deepEqual(
    events.map((event) => event.dedupeKey).sort(),
    [
      "alert:decision-needed:proj:phase-two:decide",
      "alert:phase-completed:proj:phase-one",
      "alert:recovery-exhausted:proj:phase-two:verify",
    ],
    "each occurrence alerts once, keyed by campaign and episode",
  );
  const summaryOf = (/** @type {string} */ key) => events.find((event) => event.dedupeKey === key)?.summary ?? "";
  assert.match(summaryOf("alert:phase-completed:proj:phase-one"), /campaign-watch: phase completed: phase-one · 2\/2 done/u);
  assert.match(summaryOf("alert:recovery-exhausted:proj:phase-two:verify"), /campaign-watch: recovery exhausted: phase-two · verify/u);
  assert.match(summaryOf("alert:decision-needed:proj:phase-two:decide"), /campaign-watch: decision needed: phase-two · decide/u);

  // Every poll is a fresh session re-reading the shared inbox: the repeat
  // below is quiet because the dedupe is durable, not because of memory.
  assert.deepEqual(await poll(path, runsDir, Date.parse("2026-09-29T12:00:30.000Z")), [], "the same episodes never re-send");
});

test("a campaign that stops being active alerts closure once, deduped by the campaign itself", async () => {
  const runsDir = runsRoot(tempDir("watch-closure-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "closed-early", goal: "prove closure alerts once" });
  registerRun(path, "only-run");
  writePhaseRun(runsDir, "only-run",
    { id: "only-run", goal: "the only phase", nodes: [{ id: "build", dependsOn: [] }] },
    [{ id: "build", status: "done" }]);
  closeRecord(path, "2026-09-29T12:00:00.000Z");

  const events = await poll(path, runsDir, Date.parse("2026-09-29T12:30:00.000Z"));
  assert.equal(events.length, 1, "closure is the one alert a closed campaign issues");
  assert.equal(events[0].dedupeKey, "alert:closure:closed-early:closed-early");
  assert.match(events[0].summary, /campaign-watch: campaign closed: closed-early · 1\/1 done/u);
  assert.deepEqual(await poll(path, runsDir, Date.parse("2026-09-29T12:31:00.000Z")), [], "closure is deduped by campaign");
});

test("a progress update edits the anchored message inside fifteen minutes and starts a new one outside", async () => {
  const runsDir = runsRoot(tempDir("watch-progress-window-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "window", goal: "prove the window edits in place" });
  registerRun(path, "live-run");
  const runDir = writePhaseRun(runsDir, "live-run",
    { id: "live-run", goal: "work in flight", nodes: [{ id: "build", dependsOn: [] }, { id: "docs", dependsOn: ["build"] }] },
    [
      { id: "build", status: "done" },
      { id: "docs", status: "running", startedAt: "2026-09-29T11:55:00.000Z" },
    ]);
  const receipts = async () => ({ ok: true });
  let receiptIndex = 0;
  const receiptWithId = async () => ({ ok: true, messageId: `m${(receiptIndex += 1)}` });
  const start = Date.parse("2026-09-29T12:00:00.000Z");

  const first = await pollProgress(path, runsDir, start, receiptWithId);
  assert.deepEqual(first.sent, [{ summary: "1/2 done · running docs", editOfMessageId: null }], "the first update is a new message, worded by the projection alone");
  assert.deepEqual(readProgressAnchorFile(path), {
    campaignId: "window",
    messageId: "m1",
    at: "2026-09-29T12:00:00.000Z",
    signature: "1/2:docs:live-run",
  }, "the anchor is claimed from the receipt, with the state it announced");

  // docs settles five minutes later: inside the window, the same message is
  // edited, and the anchor follows the new receipt.
  markNode(runDir, "docs", "done", "2026-09-29T12:05:00.000Z");
  const second = await pollProgress(path, runsDir, start + 5 * 60_000, receiptWithId);
  assert.deepEqual(second.sent, [{ summary: "2/2 done", editOfMessageId: "m1" }]);
  assert.equal(readProgressAnchorFile(path)?.messageId, "m2");

  // A change after the window: a new message, not an edit of the old one.
  registerRun(path, "next-run");
  writePhaseRun(runsDir, "next-run",
    { id: "next-run", goal: "the next phase", nodes: [{ id: "review", dependsOn: [] }, { id: "land", dependsOn: ["review"] }] },
    [{ id: "review", status: "running", startedAt: "2026-09-29T12:20:00.000Z" }]);
  const third = await pollProgress(path, runsDir, start + 20 * 60_000, receiptWithId);
  assert.deepEqual(third.sent, [{ summary: "2/4 done · running review", editOfMessageId: null }], "the window's edge closes it");
  assert.equal(readProgressAnchorFile(path)?.messageId, "m3");

  // Unchanged state never re-sends, whatever the clock says.
  const quiet = await pollProgress(path, runsDir, start + 40 * 60_000, receiptWithId);
  assert.deepEqual(quiet.sent, [], "the anchored signature is the record of what was already said");
  assert.equal(receiptIndex, 3);

  // A transport that answers nothing still delivered (exit 0): the next
  // update is a new message, because no receipt named a message to edit.
  writePhaseRun(runsDir, "next-run",
    { id: "next-run", goal: "the next phase", nodes: [{ id: "review", dependsOn: [] }, { id: "land", dependsOn: ["review"] }] },
    [
      { id: "review", status: "running", startedAt: "2026-09-29T12:20:00.000Z" },
      { id: "land", status: "running", startedAt: "2026-09-29T12:44:00.000Z", updatedAt: "2026-09-29T12:45:00.000Z" },
    ]);
  const unclaimed = await pollProgress(path, runsDir, start + 45 * 60_000, receipts);
  assert.deepEqual(unclaimed.sent, [{ summary: "2/4 done · running land", editOfMessageId: null }]);
  assert.equal(readProgressAnchorFile(path), null, "a delivery without a receipt claims nothing");
});

test("a progress anchor is claimed only on a receipt, and a failed delivery drops the claim", async () => {
  const runsDir = runsRoot(tempDir("watch-progress-claim-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "claim", goal: "prove the claim needs a receipt" });
  registerRun(path, "claim-run");
  const runDir = writePhaseRun(runsDir, "claim-run",
    { id: "claim-run", goal: "one node", nodes: [{ id: "build", dependsOn: [] }] },
    [{ id: "build", status: "running", startedAt: "2026-09-29T11:55:00.000Z" }]);
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  /** @type {{ok: boolean, messageId?: string}|null} */
  let receipt = { ok: false };

  const attemptOne = await pollProgress(path, runsDir, start, async () => receipt);
  assert.deepEqual(attemptOne.sent.map((entry) => entry.editOfMessageId), [null]);
  assert.equal(readProgressAnchorFile(path), null, "a failed delivery claims nothing");

  receipt = { ok: true };
  const attemptTwo = await pollProgress(path, runsDir, start + 60_000, async () => receipt);
  assert.deepEqual(attemptTwo.sent.map((entry) => entry.editOfMessageId), [null], "each attempt is a new message until a receipt names one");
  assert.equal(readProgressAnchorFile(path), null, "an exit without a message id claims no editable message");

  receipt = { ok: true, messageId: "wam-9" };
  const anchored = await pollProgress(path, runsDir, start + 120_000, async () => receipt);
  assert.deepEqual(anchored.sent.map((entry) => entry.editOfMessageId), [null]);
  assert.deepEqual(readProgressAnchorFile(path), {
    campaignId: "claim",
    messageId: "wam-9",
    at: "2026-09-29T12:02:00.000Z",
    signature: "0/1:build:claim-run",
  });

  markNode(runDir, "build", "done", "2026-09-29T12:03:00.000Z");
  receipt = { ok: false };
  const failed = await pollProgress(path, runsDir, start + 180_000, async () => receipt);
  assert.deepEqual(failed.sent, [{ summary: "1/1 done", editOfMessageId: "wam-9" }], "the claim held long enough to try an edit");
  assert.equal(readProgressAnchorFile(path), null, "the failed delivery drops the claim");

  receipt = { ok: true, messageId: "wam-10" };
  const retried = await pollProgress(path, runsDir, start + 240_000, async () => receipt);
  assert.deepEqual(retried.sent, [{ summary: "1/1 done", editOfMessageId: null }], "without a claim the retry is a new message");
  assert.equal(readProgressAnchorFile(path)?.messageId, "wam-10");
});

test("a restart re-announces nothing and keeps editing the message the receipt anchored", async () => {
  const runsDir = runsRoot(tempDir("watch-progress-restart-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "restart-progress", goal: "prove the anchor outlives the process" });
  registerRun(path, "long-run");
  const runDir = writePhaseRun(runsDir, "long-run",
    { id: "long-run", goal: "slow work", nodes: [{ id: "build", dependsOn: [] }] },
    [{ id: "build", status: "running", startedAt: "2026-09-29T11:55:00.000Z" }]);
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  const receiptWithId = async () => ({ ok: true, messageId: "m1" });

  const firstSession = await pollProgress(path, runsDir, start, receiptWithId);
  assert.equal(firstSession.sent.length, 1);

  // A fresh session five minutes later, state unchanged: nothing to say.
  const quietSession = await pollProgress(path, runsDir, start + 5 * 60_000, receiptWithId);
  assert.deepEqual(quietSession.sent, [], "the durable anchor carries the signature already announced");

  // A change while the anchor is still inside its window: the edit survives
  // the restart, because the anchor did.
  markNode(runDir, "build", "done", "2026-09-29T12:06:00.000Z");
  const secondSession = await pollProgress(path, runsDir, start + 6 * 60_000, receiptWithId);
  assert.deepEqual(secondSession.sent, [{ summary: "1/1 done", editOfMessageId: "m1" }]);
});

test("an attention event is a new message through the alert path and never touches the edit chain", async () => {
  const runsDir = runsRoot(tempDir("watch-attention-new-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "attention", goal: "prove attention is a new message" });
  registerRun(path, "stuck-run");
  const runDir = writePhaseRun(runsDir, "stuck-run",
    { id: "stuck-run", goal: "one decision", nodes: [{ id: "verify", dependsOn: [] }] },
    [{ id: "verify", status: "running", startedAt: "2026-09-29T11:55:00.000Z" }]);
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  const receiptWithId = async () => ({ ok: true, messageId: "m1" });

  const before = await pollProgress(path, runsDir, start, receiptWithId);
  assert.equal(before.sent.length, 1, "the progress message exists and is anchored");

  markNode(runDir, "verify", "blocked", "2026-09-29T12:01:00.000Z");
  const after = await pollProgress(path, runsDir, start + 60_000, receiptWithId);
  assert.deepEqual(
    after.events.map((event) => event.dedupeKey),
    ["alert:decision-needed:attention:stuck-run:verify"],
    "the attention event travels the alert path as its own new message",
  );
  assert.deepEqual(after.sent, [{ summary: "0/1 done", editOfMessageId: "m1" }], "only the progress message is ever edited");
  assert.match(after.events[0].summary, /campaign-watch: decision needed: stuck-run · verify/u);
});

test("with progress opted in, the default delivery is the notify transport alone and no model is asked", async () => {
  const runsDir = runsRoot(tempDir("watch-progress-optin-"));
  const { path } = initializeCampaign(runsDir, { campaignId: "optin", goal: "prove the default path needs only the transport" });
  registerRun(path, "solo-run");
  writePhaseRun(runsDir, "solo-run",
    { id: "solo-run", goal: "quiet work", nodes: [{ id: "build", dependsOn: [] }] },
    [{ id: "build", status: "running", startedAt: "2026-09-29T11:55:00.000Z" }]);
  const logPath = join(tempDir("watch-progress-optin-log-"), "deliveries.log");
  const binPath = `${logPath}-bin.sh`;
  writeFileSync(binPath, [
    "#!/bin/sh",
    "cat - > /dev/null",
    `echo invoked >> '${logPath}'`,
    `n=$(($(cat '${logPath}.count' 2>/dev/null || echo 0) + 1))`,
    `echo "$n" > '${logPath}.count'`,
    `printf '{"messageId":"m%s"}\\n' "$n"`,
    "",
  ].join("\n"));
  chmodSync(binPath, 0o755);

  const names = ["FABERUN_NOTIFY_EVENTS", "FABERUN_NOTIFY_BIN", "FABERUN_NOTIFY_SESSION"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.FABERUN_NOTIFY_EVENTS = "progress";
  process.env.FABERUN_NOTIFY_BIN = binPath;
  delete process.env.FABERUN_NOTIFY_SESSION;
  try {
    // The plain path: no injected seams at all, the watcher's own defaults.
    await watchCampaignWake(path, runsDir, { once: true, now: () => Date.parse("2026-09-29T12:00:00.000Z"), emit: () => {} });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }

  const deliveries = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
  assert.equal(deliveries.length, 1, "the transport was the only thing invoked, exactly once");
  assert.deepEqual(readProgressAnchorFile(path), {
    campaignId: "optin",
    messageId: "m1",
    at: "2026-09-29T12:00:00.000Z",
    signature: "0/1:build:solo-run",
  }, "the receipt the bin printed claimed the anchor");
});
