import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { readInbox } from "../../src/notify/index.mjs";
import { watchCampaignWake } from "../../src/campaign/watch.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

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
 * @returns {Promise<Array<{campaignId: string, dedupeKey: string, summary: string}>>}
 */
async function poll(campaignPath, runsDir, atMs) {
  /** @type {Array<{campaignId: string, dedupeKey: string, summary: string}>} */
  const events = [];
  await watchCampaignWake(campaignPath, runsDir, {
    once: true,
    now: () => atMs,
    emit: () => {},
    notify: (event) => { events.push(event); },
  });
  return events;
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
