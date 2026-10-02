/**
 * `campaign watch --wake`: the loop that turns a campaign's own records into
 * the lines an operator is woken with, and the single-watcher lock that keeps
 * two of them from doubling every wake.
 *
 * Separate from `cli/campaign.mjs` because that file owns argv, dispatch and
 * usage for the campaign verb, and this is neither: it is a long-running
 * supervisor with a poll interval, an idle policy, a durable dedupe through
 * the inbox, and a lock with its own staleness rule. `cli/campaign.mjs` keeps
 * the thin `watch` operation that reads the flags and calls in here.
 *
 * The idle episode is durable too, in `watch-idle.json` beside the lock: the
 * idle alert's key carries the episode, and an episode kept only in memory
 * re-anchors on every restart, which either re-sends a window the operator
 * already saw or stays silent through the next one.
 *
 * The campaign alerts -- phase completed, recovery exhausted, decision
 * needed, closure -- are derived from the same projection the page and the
 * CLI read (`buildCampaignProgress`), never from a second scan of raw run
 * files, so every surface answers the campaign from one set of numbers, and
 * are deduplicated by campaign and episode through the inbox
 * (`alert:<id>:<campaign>:<episode>`, the keys the ALERTS catalogue in
 * `report/locale.mjs` declares). The automatic progress update is rendered
 * from that projection alone -- never a model -- and is an explicit opt-in
 * through `FABERUN_NOTIFY_EVENTS`; when the transport answers with a receipt
 * naming a message id, the anchor in `watch-progress.json` records it, and
 * the next update inside the fifteen-minute window travels as an edit of
 * that message. The anchor is written only after the receipt returns, so an
 * editable message is claimed only on evidence, and it carries the state
 * signature it announced, so an unchanged campaign never re-sends. An
 * attention event is always a new message: alerts never consult the anchor.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { lockStale, pidAlive, processStartToken, readLock } from "../run/lock.mjs";
import { writeJsonAtomic } from "../run/store.mjs";
import { readCampaign } from "./record.mjs";
import { notifyQueueFor } from "../engine/notify-queue.mjs";
import { appendInbox, deliverNotification, deliverableEventTypes, progressEditTarget, readInbox, wakeCapabilityNotice } from "../notify/index.mjs";
import { buildCampaignProgress } from "../report/progress.mjs";
import { ALERTS, chooseLanguage, labelsFor } from "../report/locale.mjs";
import { errorCode, readJsonTolerant } from "../util.mjs";

/** How often the watcher re-reads the campaign when the operator named no interval. */
export const DEFAULT_WAKE_POLL_MS = 30_000;

/** How long without a material event before the watcher reports the campaign idle. */
const WAKE_IDLE_AFTER_MS = 20 * 60_000;

/**
 * Where the watcher records the idle episode it is in. The idle alert's dedupe
 * key embeds the instant the episode began, so that anchor has to outlive the
 * process; the file lives beside `watch.lock` because the one campaign watcher
 * owns both.
 */
const WATCH_IDLE_FILE = "watch-idle.json";

/**
 * Where the watcher records the progress message a transport acknowledged:
 * the message id from the transport's receipt, the instant of that receipt,
 * and the state signature the message announced. Beside `watch.lock`, whose
 * single watcher owns both; the anchor outlives the process, so a restart
 * keeps editing the message the operator can still see and never re-sends a
 * state that was already announced.
 */
const WATCH_PROGRESS_FILE = "watch-progress.json";

/**
 * The dedupe key for one alert occurrence: the catalogue's two keys, campaign
 * and episode (`report/locale.mjs`'s ALERTS declares the same pair), joined
 * under the alert's id, so the same occurrence sends once through the inbox
 * no matter how many polls or restarts re-derive it.
 *
 * @param {string} alertId
 * @param {string} campaignId
 * @param {string} episode
 * @returns {string}
 */
function alertKey(alertId, campaignId, episode) {
  return `alert:${alertId}:${campaignId}:${episode}`;
}

/**
 * The fields of the shared projection (`buildCampaignProgress`) the watcher
 * reads. The projection's own module types its return as
 * `Record<string, unknown>`, so every consumer narrows the fields it needs
 * its own way; this is the watcher's narrowing, and it names exactly the
 * fields the alerts and the progress update are rendered from -- never the
 * whole shape, which is the projection's to own.
 *
 * @typedef {object} CampaignProjection
 * @property {{done: number, total: number}} counts
 * @property {{nodeId: string}|null} activity
 * @property {number|null} costTotalUsd
 * @property {{contractId: string|null, counts: {done: number, total: number}, nodes: {id: string, status: string}[]}[]} phases
 * @property {{contractId: string}|null} currentPhase
 */

/**
 * The one line an automatic progress update says, rendered entirely from the
 * projection's own numbers and the campaign's wording home: nodes done over
 * declared, the node in flight, the recorded spend. The same persisted state
 * yields the same bytes on every poll and every restart -- that is the whole
 * guarantee, and the reason no model is asked to phrase it.
 *
 * @param {CampaignProjection} progress
 * @param {(key: string) => string} labels
 * @returns {string}
 */
function progressSummaryText(progress, labels) {
  /** @type {string[]} */
  const parts = [`${progress.counts.done}/${progress.counts.total} ${labels("done")}`];
  if (progress.activity) parts.push(`${labels("running")} ${progress.activity.nodeId}`);
  if (typeof progress.costTotalUsd === "number") parts.push(`$${progress.costTotalUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/**
 * The closure alert's detail: the campaign's final counts and its recorded
 * spend.
 *
 * @param {CampaignProjection} progress
 * @param {(key: string) => string} labels
 * @param {string} campaignId
 * @returns {string}
 */
function closureDetail(progress, labels, campaignId) {
  const cost = typeof progress.costTotalUsd === "number" ? ` · $${progress.costTotalUsd.toFixed(2)}` : "";
  return `${campaignId} · ${progress.counts.done}/${progress.counts.total} ${labels("done")}${cost}`;
}

/**
 * The automatic progress update's delivery: an explicit opt-in through
 * `FABERUN_NOTIFY_EVENTS` (`progress` is not in the default set -- it is the
 * one recurring message, and exactly the flood the default set exists to
 * keep off the operator's phone). The summary arrives already rendered from
 * the projection; `editOfMessageId`, when the caller anchors one, asks the
 * transport to edit that message instead of sending a new one. Resolves
 * `null` when nothing was attempted, so the caller's anchor stays untouched.
 *
 * @param {string} campaignId
 * @param {string} summary
 * @param {string|null} editOfMessageId
 * @returns {Promise<import("../notify/index.mjs").DeliveryResult|null>}
 */
async function deliverProgressUpdate(campaignId, summary, editOfMessageId) {
  if (!deliverableEventTypes().has("progress")) return null;
  return deliverNotification({
    type: "progress",
    campaignId,
    summary,
    ...(editOfMessageId ? { editOfMessageId } : {}),
  });
}

const TERMINAL_NODE_STATUSES = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);

/**
 * The watcher loop. The campaign alerts are derived from the projection and
 * announced through `notify`, which by default records them in
 * `<runs-dir>/inbox.jsonl` and delivers them to the campaign's
 * `notify.jsonl`; the inbox is both the durable record and the dedupe, so an
 * occurrence already recorded is never re-sent. The idle line is keyed by
 * campaign, by the durable idle episode and by the twenty-minute window
 * inside it. The automatic progress update is not an alert: it is delivered
 * through `sendProgress`, which returns the transport's receipt, and the
 * receipt -- only the receipt -- writes the `watch-progress.json` anchor.
 * The injectable seams exist so a test can drive the loop deterministically.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {{pollMs?: number, once?: boolean, now?: () => number, sleep?: (ms: number) => Promise<void>, emit?: (line: string) => void, notify?: (event: {type: string, campaignId: string, dedupeKey: string, summary: string, runId?: string|null, nodeId?: string|null, status?: string|null, errorCode?: string|null}) => Promise<void>|void, sendProgress?: (campaignId: string, summary: string, editOfMessageId: string|null) => Promise<{ok: boolean, messageId?: string}|null>, lock?: {release: () => void}}} [options]
 * @returns {Promise<void>}
 */
export async function watchCampaignWake(campaignPath, runsDir, options = {}) {
  const pollMs = options.pollMs ?? DEFAULT_WAKE_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const emit = options.emit ?? ((line) => process.stdout.write(`${line}\n`));
  const notify = options.notify ?? ((event) => notifyQueueFor(campaignPath).enqueue({
    type: "attention",
    campaignId: event.campaignId,
    dedupeKey: event.dedupeKey,
    summary: event.summary,
    runId: event.runId ?? null,
    nodeId: event.nodeId ?? null,
    status: event.status ?? null,
    errorCode: event.errorCode ?? null,
  }));
  const sendProgress = options.sendProgress ?? deliverProgressUpdate;
  const seen = new Set(readInbox(runsDir).map((entry) => entry.dedupeKey));
  const lock = options.lock ?? acquireWatchLock(campaignPath);
  emit(wakeCapabilityNotice());
  let lastActiveAt = now();
  /** @type {number|null} */
  let idleSince = null;
  let first = true;
  try {
    for (;;) {
      const campaign = readCampaign(campaignPath);
      /**
       * Persist first, deliver second: the inbox entry is the durable dedupe,
       * so a restart or a second watcher skips a line already recorded even
       * when delivery is injected.
       *
       * @param {string} dedupeKey @param {string} summary @param {{runId?: string|null, nodeId?: string|null, status?: string|null, errorCode?: string|null}} [extra]
       */
      const announce = async (dedupeKey, summary, extra = {}) => {
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const appended = appendInbox(runsDir, { type: "attention", campaignId: campaign.id, dedupeKey, summary, ...extra });
        if (!appended.appended) return;
        emit(summary);
        await notify({ type: "attention", campaignId: campaign.id, dedupeKey, summary, ...extra });
      };
      const language = chooseLanguage(process.env, [campaign.goal]);
      const labels = labelsFor(language);
      const nowMs = now();
      /** @type {CampaignProjection|null} */
      let progress = null;
      try {
        progress = /** @type {CampaignProjection} */ (buildCampaignProgress(runsDir, campaign.id, nowMs));
      } catch {
        // A projection that cannot be built (a torn record, an unreadable
        // journal) yields no alerts and no progress update this poll; the
        // status loop and the idle clock below still run, and the next poll
        // re-reads everything.
        progress = null;
      }
      /**
       * One alert occurrence, worded by the catalogue and deduped by campaign
       * and episode through the inbox. Alerts are always new messages: none
       * of them ever consults the progress anchor.
       *
       * @param {string} alertId @param {string} episode @param {string} detail
       */
      const announceAlert = async (alertId, episode, detail) => {
        const spec = ALERTS.find((entry) => entry.id === alertId);
        if (!spec) throw new Error(`campaign watch: no catalogue entry for alert ${alertId}`);
        await announce(alertKey(alertId, campaign.id, episode), `campaign-watch: ${spec.text[language]}: ${detail}`);
      };
      if (campaign.status !== "active") {
        if (progress) await announceAlert("closure", campaign.id, closureDetail(progress, labels, campaign.id));
        emit(`campaign-watch: ${campaign.id} is ${campaign.status}; stopping`);
        return;
      }
      if (progress) {
        for (const phase of progress.phases) {
          if (phase.contractId === null) continue;
          if (phase.counts.total > 0 && phase.counts.done === phase.counts.total) {
            await announceAlert("phase-completed", phase.contractId, `${phase.contractId} · ${phase.counts.done}/${phase.counts.total} ${labels("done")}`);
          }
          for (const node of phase.nodes) {
            if (node.status === "exhausted") {
              await announceAlert("recovery-exhausted", `${phase.contractId}:${node.id}`, `${phase.contractId} · ${node.id}`);
            } else if (node.status === "blocked") {
              await announceAlert("decision-needed", `${phase.contractId}:${node.id}`, `${phase.contractId} · ${node.id}`);
            }
          }
        }
      }
      // A restart resumes the episode this campaign was already in. The key
      // carries the episode's anchor, so resuming it is what keeps a window
      // already announced quiet and the next window audible.
      if (first) {
        const storedSince = readIdleEpisode(campaignPath, campaign.id);
        if (storedSince !== null) idleSince = storedSince;
      }
      let anyActive = false;
      for (const runId of campaign.linkedRunIds) {
        const status = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runsDir, runId, "status.json")));
        if (!status || !Array.isArray(status.nodes)) continue;
        const terminal = status.nodes.every((/** @type {any} */ node) => TERMINAL_NODE_STATUSES.has(String(node.status)));
        if (!terminal) {
          anyActive = true;
          const runLock = readLock(join(runsDir, runId));
          const stale = !runLock || /** @type {{invalid?: true}} */ (runLock).invalid || lockStale(runLock);
          if (stale && !first) {
            await announce(`stale:${runId}`, `campaign-watch: ${runId} has non-terminal nodes but no live controller; resume it`, { runId });
          }
        }
      }
      if (anyActive) {
        lastActiveAt = nowMs;
        if (idleSince !== null) {
          idleSince = null;
          clearIdleEpisode(campaignPath);
        }
      } else if (idleSince === null) {
        idleSince = lastActiveAt;
        writeIdleEpisode(campaignPath, campaign.id, idleSince);
      }
      if (idleSince !== null && nowMs - idleSince >= WAKE_IDLE_AFTER_MS) {
        const key = `idle:${campaign.id}:${new Date(idleSince).toISOString()}:${Math.floor((nowMs - idleSince) / WAKE_IDLE_AFTER_MS)}`;
        await announce(key, `campaign-watch: ${campaign.id} active but no run has been active for ${Math.round((nowMs - idleSince) / 60_000)} min; dispatch the next step`);
      }
      // The automatic progress update. The anchor is the record of what was
      // already announced: the same state signature is never delivered
      // twice, whatever restarted in between. When there is something new to
      // say, a still-editable message is edited in place, and the anchor is
      // claimed only from the transport's receipt -- a delivery without a
      // receipt claims nothing, and the next poll tries again.
      if (progress) {
        const signature = `${progress.counts.done}/${progress.counts.total}:${progress.activity?.nodeId ?? "-"}:${progress.currentPhase?.contractId ?? "-"}`;
        const anchor = readProgressAnchor(campaignPath, campaign.id);
        if (!anchor || anchor.signature !== signature) {
          const editOfMessageId = progressEditTarget(anchor, nowMs);
          const receipt = await sendProgress(campaign.id, progressSummaryText(progress, labels), editOfMessageId);
          if (receipt) {
            if (receipt.ok && typeof receipt.messageId === "string" && receipt.messageId) {
              writeProgressAnchor(campaignPath, campaign.id, { messageId: receipt.messageId, at: nowMs, signature });
            } else {
              clearProgressAnchor(campaignPath);
            }
          }
        }
      }
      first = false;
      if (options.once === true) return;
      await sleep(pollMs);
    }
  } finally {
    lock.release();
  }
}

/**
 * The idle anchor a restart resumes, or null when no episode is in progress. A
 * record naming another campaign, or whose instant does not parse, is no
 * anchor: a campaign directory is just a path, and a stale file must never seed
 * the key with an identity nothing can check.
 *
 * @param {string} campaignPath
 * @param {string} campaignId
 * @returns {number|null} epoch milliseconds the episode began
 */
function readIdleEpisode(campaignPath, campaignId) {
  const record = /** @type {{campaignId?: unknown, idleSince?: unknown}|null} */ (readJsonTolerant(join(campaignPath, WATCH_IDLE_FILE)));
  if (!record || record.campaignId !== campaignId || typeof record.idleSince !== "string") return null;
  const started = Date.parse(record.idleSince);
  return Number.isFinite(started) ? started : null;
}

/**
 * @param {string} campaignPath
 * @param {string} campaignId
 * @param {number} idleSince epoch milliseconds
 */
function writeIdleEpisode(campaignPath, campaignId, idleSince) {
  writeJsonAtomic(join(campaignPath, WATCH_IDLE_FILE), { campaignId, idleSince: new Date(idleSince).toISOString() });
}

/**
 * @param {string} campaignPath
 */
function clearIdleEpisode(campaignPath) {
  try {
    unlinkSync(join(campaignPath, WATCH_IDLE_FILE));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * The progress anchor a restart resumes, or null when none stands. A record
 * naming another campaign, a message id it does not carry, or an instant or
 * state signature that does not parse is no anchor: the anchor claims a
 * message the transport acknowledged, and a claim without all of that is
 * exactly the claim the receipt rule forbids.
 *
 * @param {string} campaignPath
 * @param {string} campaignId
 * @returns {{messageId: string, at: number, signature: string}|null}
 */
function readProgressAnchor(campaignPath, campaignId) {
  const record = /** @type {{campaignId?: unknown, messageId?: unknown, at?: unknown, signature?: unknown}|null} */ (readJsonTolerant(join(campaignPath, WATCH_PROGRESS_FILE)));
  if (!record
    || record.campaignId !== campaignId
    || typeof record.messageId !== "string" || !record.messageId
    || typeof record.at !== "string"
    || typeof record.signature !== "string") return null;
  const at = Date.parse(record.at);
  return Number.isFinite(at) ? { messageId: record.messageId, at, signature: record.signature } : null;
}

/**
 * @param {string} campaignPath
 * @param {string} campaignId
 * @param {{messageId: string, at: number, signature: string}} anchor
 */
function writeProgressAnchor(campaignPath, campaignId, anchor) {
  writeJsonAtomic(join(campaignPath, WATCH_PROGRESS_FILE), {
    campaignId,
    messageId: anchor.messageId,
    at: new Date(anchor.at).toISOString(),
    signature: anchor.signature,
  });
}

/**
 * @param {string} campaignPath
 */
function clearProgressAnchor(campaignPath) {
  try {
    unlinkSync(join(campaignPath, WATCH_PROGRESS_FILE));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

const WATCH_LOCK_FILE = "watch.lock";

/**
 * A durable campaign-watch lock, one watcher per campaign across processes.
 * A live holder is never taken over; a dead or recycled pid's lock is stale
 * and is replaced, so a restart after a crash is not blocked. The same
 * liveness rule as the controller lock: a pid is dead only when the probe
 * proves it.
 *
 * @param {string} campaignPath
 * @returns {{pid: number, processStartToken: string|null, startedAt: string, release: () => void}}
 */
export function acquireWatchLock(campaignPath) {
  const path = join(campaignPath, WATCH_LOCK_FILE);
  /** @type {{pid?: number, processStartToken?: string|null, startedAt?: string}} */
  let occupant = {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const record = { pid: process.pid, processStartToken: processStartToken(process.pid), startedAt: new Date().toISOString() };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      return {
        ...record,
        release() {
          try {
            unlinkSync(path);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      occupant = /** @type {{pid?: number, processStartToken?: string|null}} */ (JSON.parse(readFileSync(path, "utf8")));
    } catch {
      occupant = {};
    }
    if (!watchLockStale(occupant)) {
      throw new Error(`campaign watch is already running (pid ${occupant.pid})`);
    }
    try {
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  throw new Error("campaign watch lock contention did not settle");
}

/**
 * @param {{pid?: number, processStartToken?: string|null}} occupant
 * @returns {boolean}
 */
function watchLockStale(occupant) {
  if (typeof occupant.pid !== "number") return true;
  if (!pidAlive(occupant.pid)) return true;
  return Boolean(occupant.processStartToken) && processStartToken(occupant.pid) !== occupant.processStartToken;
}
