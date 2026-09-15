/**
 * The controller's notification queue, one per run directory, plus the campaign
 * handoff render that must never take a run down with it.
 *
 * Notifications are serialized per run because the outbox is a file: two
 * concurrent appends interleave. `alreadyNotified` is the dedupe key check that
 * keeps a resumed run from re-announcing what the previous controller already
 * announced.
 */
import { NotifyQueue, appendInbox, renderNotification } from "../notify/index.mjs";
import { appendJsonl } from "../run/store.mjs";
import { compactCost, errorMessage } from "../util.mjs";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
 * The bounded, advisory-only spend thresholds a contract may declare at
 * `contract.nodeAdvisory`:
 *
 * - `costUsd` — US dollars, `>= 0`, no default;
 * - `durationSec` — seconds of wall clock from the node's `startedAt`, `>= 0`,
 *   no default.
 *
 * Either or both may be present. A crossing emits one advisory line per node
 * per threshold and never stops the node: the no-ceiling decision is deliberate
 * and measured against a recorded incident. Cost is only known once an
 * invocation closes, so a cost advisory fires when a new usage record has
 * landed; duration is observable live and fires from the tick that observes it.
 * One-shotness is durable, not in-process: the dedupe key is recorded in the
 * inbox and the run's `notify.jsonl`, so a controller restart reads the receipt
 * and never re-fires.
 *
 * @typedef {{costUsd?: number, durationSec?: number}} NodeAdvisoryPolicy
 */

/**
 * Every advisory threshold this node has crossed, in a stable order. A node
 * with no `startedAt` has never run, so duration is not judged; a node with no
 * recorded cost is not judged against the cost threshold.
 *
 * @param {{id: string, startedAt?: string|null, costUsd?: number|null}} state
 * @param {NodeAdvisoryPolicy|undefined} policy
 * @param {number} [now] epoch milliseconds
 * @returns {Array<{kind: "duration", threshold: number, value: number}|{kind: "cost", threshold: number, value: number}>}
 */
export function nodeAdvisoryCrossings(state, policy, now = Date.now()) {
  /** @type {Array<{kind: "duration", threshold: number, value: number}|{kind: "cost", threshold: number, value: number}>} */
  const crossings = [];
  if (!policy) return crossings;
  if (typeof policy.durationSec === "number" && typeof state.startedAt === "string") {
    const started = Date.parse(state.startedAt);
    if (Number.isFinite(started)) {
      const elapsedSec = Math.max(0, (now - started) / 1000);
      if (elapsedSec >= policy.durationSec) crossings.push({ kind: "duration", threshold: policy.durationSec, value: elapsedSec });
    }
  }
  if (typeof policy.costUsd === "number" && typeof state.costUsd === "number" && state.costUsd >= policy.costUsd) {
    crossings.push({ kind: "cost", threshold: policy.costUsd, value: state.costUsd });
  }
  return crossings;
}

/**
 * Emit one advisory through the campaign inbox and the run notify queue. The
 * durable dedupe is shared by both: `alreadyNotified` reads `notify.jsonl` and
 * `appendInbox` refuses a key already in `inbox.jsonl`, so a restart cannot
 * re-fire and two writers cannot double-send.
 *
 * The key names the threshold, not just the kind: the contract declares one
 * cost and one duration ceiling today, but a raised (or lowered) ceiling is a
 * different one-shot, and a kind-only key would silence the new crossing
 * forever. The threshold is part of the key so "one-shot per node per
 * threshold" stays true if the configured value moves.
 *
 * @param {string} runDir
 * @param {string} campaignId
 * @param {{id: string}} state
 * @param {{kind: "duration", threshold: number, value: number}|{kind: "cost", threshold: number, value: number}} crossing
 * @returns {Promise<boolean>} whether this call appended and delivered the line
 */
export async function emitNodeAdvisory(runDir, campaignId, state, crossing) {
  const runId = basename(runDir);
  const dedupeKey = `node.advisory:${runId}:${state.id}:${crossing.kind}:${crossing.threshold}`;
  if (alreadyNotified(runDir, dedupeKey)) return false;
  const summary = crossing.kind === "cost"
    ? `node ${state.id} crossed its advisory cost ${compactCost(crossing.threshold)} (recorded ${compactCost(crossing.value)}) · run ${runId}`
    : `node ${state.id} crossed its advisory duration ${crossing.threshold}s (elapsed ${crossing.value.toFixed(1)}s) · run ${runId}`;
  const appended = appendInbox(dirname(runDir), {
    type: "advisory",
    campaignId,
    runId,
    nodeId: state.id,
    dedupeKey,
    summary,
  });
  if (!appended.appended) return false;
  await notifyQueueFor(runDir).enqueue(/** @type {any} */ ({
    type: "advisory",
    campaignId,
    runId,
    nodeId: state.id,
    dedupeKey,
    summary,
  }));
  return true;
}

/**
 * Check every node of the run against the contract's advisory thresholds and
 * emit whatever it has newly crossed. Called once per controller tick; the
 * durable dedupe makes the repeated check cheap and idempotent.
 *
 * @param {{campaignId: string, nodeAdvisory?: NodeAdvisoryPolicy, nodes: {id: string}[]}} contract
 * @param {string} runDir
 * @param {Map<string, {id: string, startedAt?: string|null, costUsd?: number|null}>} states
 * @returns {Promise<number>} how many advisory lines were newly emitted
 */
export async function emitNodeAdvisories(contract, runDir, states) {
  const policy = contract.nodeAdvisory;
  if (!policy || (policy.costUsd === undefined && policy.durationSec === undefined)) return 0;
  let emitted = 0;
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    for (const crossing of nodeAdvisoryCrossings(state, policy)) {
      if (await emitNodeAdvisory(runDir, contract.campaignId, state, crossing)) emitted += 1;
    }
  }
  return emitted;
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
  const summary = renderNotification({
    type: "attention",
    runId,
    errorCode: options.code ?? null,
  });
  // The run-level attention also lands in the campaign-level inbox, which is
  // the append-only record the managed signal block summarises.
  appendInbox(dirname(runDir), {
    type: "attention",
    campaignId: options.campaignId ?? null,
    runId,
    errorCode: options.code ?? null,
    dedupeKey,
    summary,
  });
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
 * Campaign-level notifications have no run directory to queue into, so they
 * are recorded in `<runs-dir>/inbox.jsonl` and delivered through a queue whose
 * receipt log is `<campaign-dir>/notify.jsonl`. That is the defined home for a
 * campaign watcher's lines, which can be emitted with no run active.
 *
 * `appendInbox` is the durable dedupe: a key already recorded is neither
 * re-appended nor re-delivered, so a restarted watcher does not double-send.
 *
 * @param {{runsDir: string, campaignPath: string, campaignId?: string|null, runId?: string|null, nodeId?: string|null, status?: string|null, errorCode?: string|null, dedupeKey: string, summary: string, type?: string}} args
 * @returns {Promise<boolean>} whether a new notification was delivered
 */
export async function enqueueCampaignNotification(args) {
  const appended = appendInbox(args.runsDir, {
    type: "attention",
    campaignId: args.campaignId ?? null,
    runId: args.runId ?? null,
    nodeId: args.nodeId ?? null,
    status: args.status ?? null,
    errorCode: args.errorCode ?? null,
    dedupeKey: args.dedupeKey,
    summary: args.summary,
  });
  if (!appended.appended) return false;
  await notifyQueueFor(args.campaignPath).enqueue({
    type: "attention",
    campaignId: args.campaignId ?? null,
    runId: args.runId ?? null,
    nodeId: args.nodeId ?? null,
    status: args.status ?? null,
    errorCode: args.errorCode ?? null,
    dedupeKey: args.dedupeKey,
    summary: args.summary,
  });
  return true;
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
