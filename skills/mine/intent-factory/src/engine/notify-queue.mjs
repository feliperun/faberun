/**
 * The controller's notification queue, one per run directory, plus the campaign
 * handoff render that must never take a run down with it.
 *
 * Notifications are serialized per run because the outbox is a file: two
 * concurrent appends interleave. `alreadyNotified` is the dedupe key check that
 * keeps a resumed run from re-announcing what the previous controller already
 * announced.
 */
import { NotifyQueue } from "../notify/index.mjs";
import { appendJsonl } from "../run/store.mjs";
import { errorMessage } from "../util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renderBrief } from "../campaign/brief.mjs";
import { renderHandoff } from "../campaign/index.mjs";

/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */

/**
 * One notify queue per run, so the notify.jsonl receipt log stays scoped to the
 * run that owns it across the whole controller lifetime. Delivery is lossy now,
 * so the queue holds no retry state; the map survives because a run's queue is
 * still the thing every enqueue goes through while the controller is alive.
 * @type {Map<string, NotifyQueue>}
 */
export const notifyQueuesByRun = new Map();
/** @param {string} runDir @returns {NotifyQueue} */
export function notifyQueueFor(runDir) {
  let queue = notifyQueuesByRun.get(runDir);
  if (!queue) {
    queue = new NotifyQueue({ runDir });
    notifyQueuesByRun.set(runDir, queue);
  }
  return queue;
}
/**
 * Whether `notify.jsonl` already carries a receipt for this exact logical
 * event. A resumed controller starts a fresh in-memory notify queue, so
 * without this durable check it would re-notify every node that was already
 * terminal before the resume; the durable log is the only thing that
 * survives the process boundary.
 *
 * @param {string} runDir
 * @param {string} dedupeKey
 * @returns {boolean}
 */
export function alreadyNotified(runDir, dedupeKey) {
  const path = join(runDir, "notify.jsonl");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).dedupeKey === dedupeKey) return true;
    } catch {
      // A torn trailing line was never a committed receipt.
    }
  }
  return false;
}

/**
 * The escalating re-nag schedule, in milliseconds from the moment the run was
 * first parked: 10 minutes, 1 hour, 4 hours, then every 4 hours after that.
 * The schedule is the whole point of a slot-keyed dedupe: an attention event
 * is not announced once and forgotten, it is announced once per slot until the
 * run is resumed or the campaign closes.
 */
export const ATTENTION_SCHEDULE_MS = [10 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
export const ATTENTION_REPEAT_MS = 4 * 60 * 60_000;

/**
 * Which schedule slot an elapsed time falls in, or `-1` before the first one.
 * Slot 0 is 10 minutes, slot 1 is 1 hour, slot 2 is 4 hours, slot 3 is 8 hours,
 * and so on every 4 hours thereafter.
 *
 * @param {number} elapsedMs milliseconds since the run was first parked
 * @returns {number}
 */
export function attentionScheduleSlot(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < ATTENTION_SCHEDULE_MS[0]) return -1;
  if (elapsedMs < ATTENTION_SCHEDULE_MS[1]) return 0;
  if (elapsedMs < ATTENTION_SCHEDULE_MS[2]) return 1;
  return 2 + Math.floor((elapsedMs - ATTENTION_SCHEDULE_MS[2]) / ATTENTION_REPEAT_MS);
}

/**
 * The durable dedupe key for one schedule slot of one parked interval. The
 * anchor is the instant the run was first parked, so a resume that clears the
 * attention and a later re-park start a fresh key rather than colliding with
 * the previous interval's receipts.
 *
 * @param {string} runId
 * @param {string} anchor ISO instant the run was first parked
 * @param {number} slot
 * @returns {string}
 */
export function attentionDedupeKey(runId, anchor, slot) {
  return `run.attention:${runId}:${anchor}:${slot}`;
}

/**
 * Emit the run-level attention event for the schedule slot `now` falls in, or
 * nothing when the schedule has not reached its first slot or this slot was
 * already announced. A receipt is the durable record, so a restarted
 * supervisor reads the same slot as already sent.
 *
 * @param {string} runDir
 * @param {{anchor: string, code?: string|null, campaignId?: string|null, now?: number}} options
 * @returns {Promise<number|null>} the emitted slot, or null when none was due
 */
export async function emitScheduledAttention(runDir, options) {
  const now = options.now ?? Date.now();
  const anchorMs = Date.parse(options.anchor);
  const slot = attentionScheduleSlot(now - anchorMs);
  if (slot < 0) return null;
  const runId = basename(runDir);
  const dedupeKey = attentionDedupeKey(runId, options.anchor, slot);
  if (alreadyNotified(runDir, dedupeKey)) return null;
  await notifyQueueFor(runDir).enqueue({
    type: "attention",
    campaignId: options.campaignId ?? null,
    runId,
    errorCode: options.code ?? null,
    dedupeKey,
  });
  return slot;
}
/**
 * @param {CampaignRef} campaign
 * @param {string} runsDir
 * @param {string} runDir
 * @returns {boolean}
 */
export function renderCampaignHandoffSafely(campaign, runsDir, runDir) {
  try {
    renderHandoff(campaign.path, runsDir);
    // The brief rides the same seam so it exists even when the seat dies
    // without warning; the journal, not the seat, is what makes it rebuildable.
    renderBrief(campaign.path, runsDir);
    return true;
  } catch (error) {
    /** @type {Record<string, unknown>} */
    const diagnostic = {
      type: "campaign.handoff-failed",
      at: new Date().toISOString(),
      campaignId: campaign.campaign.id,
      error: errorMessage(error),
    };
    try {
      appendJsonl(join(runDir, "events.jsonl"), diagnostic);
    } catch {
      // A failed diagnostic must not abort the controller either.
    }
    process.stderr.write(`[warn] campaign handoff render failed: ${errorMessage(error)}\n`);
    return false;
  }
}
