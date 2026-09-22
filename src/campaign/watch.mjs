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
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { lockStale, pidAlive, processStartToken, readLock } from "../run/lock.mjs";
import { readCampaign } from "./record.mjs";
import { notifyQueueFor } from "../engine/notify-queue.mjs";
import { appendInbox, readInbox, wakeCapabilityNotice } from "../notify/index.mjs";
import { errorCode, readJsonTolerant } from "../util.mjs";

/** How often the watcher re-reads the campaign when the operator named no interval. */
export const DEFAULT_WAKE_POLL_MS = 30_000;

/** How long without a material event before the watcher reports the campaign idle. */
const WAKE_IDLE_AFTER_MS = 20 * 60_000;

const TERMINAL_NODE_STATUSES = new Set(["done", "no-op", "blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);
const ATTENTION_NODE_STATUSES = new Set(["failed", "exhausted", "stalled", "canceled", "cancelled"]);

/**
 * The watcher loop. Each line is announced through `notify`, which by default
 * records it in `<runs-dir>/inbox.jsonl` and delivers it to the campaign's
 * `notify.jsonl`; the inbox is both the durable record and the dedupe, so a
 * line already recorded is never re-sent. The injectable seams exist so a
 * test can drive the loop deterministically.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {{pollMs?: number, once?: boolean, now?: () => number, sleep?: (ms: number) => Promise<void>, emit?: (line: string) => void, notify?: (event: {type: string, campaignId: string, dedupeKey: string, summary: string, runId?: string|null, nodeId?: string|null, status?: string|null, errorCode?: string|null}) => Promise<void>|void, lock?: {release: () => void}}} [options]
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
  const seen = new Set(readInbox(runsDir).map((entry) => entry.dedupeKey));
  const lock = options.lock ?? acquireWatchLock(campaignPath);
  emit(wakeCapabilityNotice());
  /** @type {Map<string, string>} */
  const runSignatures = new Map();
  let lastActiveAt = now();
  let first = true;
  try {
    for (;;) {
      const campaign = readCampaign(campaignPath);
      if (campaign.status !== "active") {
        emit(`campaign-watch: ${campaign.id} is ${campaign.status}; stopping`);
        return;
      }
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
      let anyActive = false;
      for (const runId of campaign.linkedRunIds) {
        const status = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runsDir, runId, "status.json")));
        if (!status || !Array.isArray(status.nodes)) continue;
        const terminal = status.nodes.every((/** @type {any} */ node) => TERMINAL_NODE_STATUSES.has(String(node.status)));
        const signature = status.nodes.map((/** @type {any} */ node) => `${node.id}:${node.status}:${node.errorCode ?? ""}`).join("|");
        const previous = runSignatures.get(runId);
        runSignatures.set(runId, signature);
        if (!terminal) {
          anyActive = true;
          const runLock = readLock(join(runsDir, runId));
          const stale = !runLock || /** @type {{invalid?: true}} */ (runLock).invalid || lockStale(runLock);
          if (stale && !first) {
            await announce(`stale:${runId}`, `campaign-watch: ${runId} has non-terminal nodes but no live controller; resume it`, { runId });
          }
        }
        if (!first && previous !== signature) {
          for (const node of status.nodes) {
            const attention = ATTENTION_NODE_STATUSES.has(String(node.status))
              || (node.status === "blocked" && !(Array.isArray(node.blockedBy) && node.blockedBy.length > 0));
            if (attention) {
              const key = `node:${runId}:${node.id}:${node.status}:${node.errorCode ?? ""}`;
              await announce(
                key,
                `campaign-watch: ${runId} node ${node.id} ${node.status}${node.errorCode ? ` [${node.errorCode}]` : ""}${node.note ? ` ${node.note}` : ""}`,
                { runId, nodeId: String(node.id), status: String(node.status), errorCode: node.errorCode ?? null },
              );
            }
          }
        }
        if (terminal) {
          await announce(`terminal:${runId}`, `campaign-watch: ${runId} terminal · ${status.summary ?? ""}`, { runId });
        }
      }
      const nowMs = now();
      if (anyActive) lastActiveAt = nowMs;
      else if (!first && nowMs - lastActiveAt >= WAKE_IDLE_AFTER_MS) {
        const key = `idle:${Math.floor((nowMs - lastActiveAt) / WAKE_IDLE_AFTER_MS)}`;
        await announce(key, `campaign-watch: ${campaign.id} active but no run has been active for ${Math.round((nowMs - lastActiveAt) / 60_000)} min; dispatch the next step`);
      }
      first = false;
      if (options.once === true) return;
      await sleep(pollMs);
    }
  } finally {
    lock.release();
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
