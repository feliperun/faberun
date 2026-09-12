/**
 * Direct notification dispatcher (TECH-SPEC lean, rule 6). On `node.terminal`,
 * `run.terminal` and `attention` the controller renders a one-line message
 * from a fixed per-type template, calls `INTENT_FACTORY_NOTIFY_BIN` with the
 * event as JSON on stdin, and appends a receipt (`delivered`, `failed` or
 * `no_transport`, with the timestamp) to `<run-dir>/notify.jsonl`. Delivery is
 * lossy: an event is attempted once, a failure schedules no further attempt and
 * is never requeued, and the controller never waits on a retry it will not
 * make. The next read of the run's own artefacts carries the full state. With
 * no transport bound (`INTENT_FACTORY_NOTIFY_BIN` unset) nothing is spawned and
 * a `no_transport` receipt is recorded instead — there is no implicit desktop
 * fallback. The macOS notifier is reachable only by setting
 * `INTENT_FACTORY_NOTIFY_BIN=os-macos`, an explicit opt-in, never a default.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMacosNotifier } from "./os-macos.mjs";
import { errorMessage } from "../util.mjs";

const NOTIFY_BIN_ENV = "INTENT_FACTORY_NOTIFY_BIN";
const MACOS_TRANSPORT = "os-macos";
export const NOTIFY_LOG_FILE = "notify.jsonl";
/**
 * The bounded retry budget the dispatcher used to spend before giving up.
 * `campaign/metrics.mjs` still reads it through `notifyReceiptRate`: a `failed`
 * receipt at the final attempt counts as settled. Delivery is lossy now, so no
 * receipt carries an attempt past the first and a failed delivery no longer
 * satisfies that indicator — the metric is unchanged and reports the drop.
 */
export const MAX_ATTEMPTS = 3;

const SUMMARY_CHARS = 200;

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{type: "node.terminal"|"run.terminal"|"attention", runId: string, campaignId?: string|null, nodeId?: string|null, status?: string|null, attempt?: number|null, errorCode?: string|null, done?: number|null, total?: number|null, dedupeKey?: string|null, runDir?: string|null, costUsd?: number|null, eventId?: string}} NotifyEvent */
/** @typedef {{ok: boolean, error?: string, noTransport?: boolean}} DeliveryResult */

/**
 * Render the fixed one-line message for an event, from counters and
 * identifiers only (node id, run id or directory, state, attempt, error
 * code, done/total, cost), never from model text:
 *   `node <id> failed · run <id> · attempt 2 · verification_failed · resume <run-dir>`
 *   `run <id> done · 3/3 nodes · $4.21`
 *   `node <id> needs you · run <id> · <error code>`
 * `runDir` and `costUsd`, when present on the event, come from the run's own
 * `status.json` (`NotifyQueue.enqueue` reads it) — never from the model.
 *
 * @param {NotifyEvent} event
 * @returns {string}
 */
export function renderNotification(event) {
  const runId = event.runId ?? "-";
  switch (event.type) {
    case "node.terminal": {
      const ok = event.status === "done" || event.status === "no-op";
      const errorPart = event.errorCode ? ` · ${event.errorCode}` : "";
      const resumePart = !ok && event.runDir ? ` · resume ${event.runDir}` : "";
      return truncate(`node ${event.nodeId ?? "-"} ${event.status ?? "-"} · run ${runId} · attempt ${event.attempt ?? 0}${errorPart}${resumePart}`);
    }
    case "run.terminal": {
      const done = event.done ?? 0;
      const total = event.total ?? 0;
      const state = total > done ? "attention" : "done";
      const costPart = typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(2)}` : "";
      return truncate(`run ${runId} ${state} · ${done}/${total} nodes${costPart}`);
    }
    case "attention": {
      const subject = event.nodeId ? `node ${event.nodeId} needs you · run ${runId}` : `run ${runId} needs you`;
      const errorPart = event.errorCode ? ` · ${event.errorCode}` : "";
      return truncate(`${subject}${errorPart}`);
    }
    default:
      throw new TypeError(`renderNotification: unknown event type ${String(event.type)}`);
  }
}

/**
 * The run's total cost so far, read from its own `status.json` (the single
 * source `writeStatusArtifacts` refreshes every tick). Missing or unreadable
 * is `null`: a notification never blocks or fails on this being unavailable.
 *
 * @param {string} runDir
 * @returns {number|null}
 */
function readRunCostUsd(runDir) {
  try {
    const payload = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
    const costUsd = payload?.usage?.costUsd;
    return typeof costUsd === "number" ? costUsd : null;
  } catch {
    return null;
  }
}

/** @param {string} value @returns {string} */
function truncate(value) {
  return value.length <= SUMMARY_CHARS ? value : `${value.slice(0, SUMMARY_CHARS - 1)}…`;
}

/**
 * Deliver one event through the bound transport. No transport bound resolves
 * `{ok: false, noTransport: true}` without spawning anything.
 *
 * @param {{type: string, summary: string, campaignId?: string|null, [key: string]: unknown}} event
 * @param {{bin?: string, spawn?: typeof defaultSpawn, timeoutMs?: number}} [options]
 * @returns {Promise<DeliveryResult>}
 */
function deliverNotification(event, options = {}) {
  const bin = options.bin ?? process.env[NOTIFY_BIN_ENV];
  if (!bin) return Promise.resolve({ ok: false, noTransport: true });
  if (bin === MACOS_TRANSPORT) {
    return createMacosNotifier({ spawn: options.spawn }).deliver(/** @type {any} */ (event));
  }
  return spawnDeliver(bin, event, options);
}

/**
 * @param {string} bin
 * @param {JsonObject} event
 * @param {{spawn?: typeof defaultSpawn, timeoutMs?: number}} options
 * @returns {Promise<DeliveryResult>}
 */
function spawnDeliver(bin, event, { spawn = defaultSpawn, timeoutMs = 5_000 } = {}) {
  return new Promise((resolveDelivery) => {
    let child;
    try {
      child = spawn(bin, [], { stdio: ["pipe", "ignore", "pipe"], env: process.env });
    } catch (error) {
      resolveDelivery({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    /** @param {DeliveryResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDelivery(result);
    };
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1024);
    });
    child.once("error", (error) => finish({ ok: false, error: errorMessage(error) }));
    child.once("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr || `notification exited ${code}` }));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ESRCH: the child already exited before the timeout kill; finish still resolves.
      }
      finish({ ok: false, error: `notification timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

/**
 * Per-run notification dispatcher. `enqueue` renders the message, attempts
 * delivery once, and appends one receipt to `<runDir>/notify.jsonl` whatever
 * the outcome. There is no pending queue to hold a failure and no scheduled
 * retry: a failed delivery is recorded and dropped. A resume or an audit reads
 * the receipt log for what happened and `status.json` for the state, which the
 * next controller re-derives from disk instead of replaying a notify backup.
 */
export class NotifyQueue {
  /**
   * @param {{runDir: string, deliver?: typeof deliverNotification, now?: () => number}} options
   */
  constructor({ runDir, deliver = deliverNotification, now = () => Date.now() }) {
    this.runDir = runDir;
    this.deliver = deliver;
    this.now = now;
  }

  /**
   * Enrich the event with `runDir` and the run's current `costUsd` (from its
   * own `status.json`, never the model) before rendering its summary, so
   * `resume <run-dir>` and the run-terminal cost are counters and
   * identifiers the templates can use without the caller supplying them.
   * Delivery is awaited exactly once; a failure is recorded, not rescheduled.
   *
   * @param {NotifyEvent} event
   * @returns {Promise<void>}
   */
  async enqueue(event) {
    const enriched = { ...event, runDir: this.runDir, costUsd: readRunCostUsd(this.runDir) };
    const summary = renderNotification(enriched);
    // Consumers deduplicate by eventId (the Ford adapter rejects an event without
    // one), so every delivery carries a stable id derived from the dedupe key.
    const eventId = enriched.eventId
      ?? createHash("sha256").update(enriched.dedupeKey ?? JSON.stringify(enriched)).digest("hex");
    const result = await this.deliver({ ...enriched, summary, eventId });
    /** @type {JsonObject} */
    const receipt = {
      eventId,
      type: enriched.type,
      runId: enriched.runId ?? null,
      nodeId: enriched.nodeId ?? null,
      nodeStatus: enriched.status ?? null,
      errorCode: enriched.errorCode ?? null,
      done: enriched.done ?? null,
      total: enriched.total ?? null,
      dedupeKey: enriched.dedupeKey ?? null,
      summary,
      attempt: 1,
      status: result.ok ? "delivered" : result.noTransport ? "no_transport" : "failed",
      at: new Date(this.now()).toISOString(),
    };
    if (!result.ok && !result.noTransport) receipt.error = result.error ?? null;
    appendFileSync(join(this.runDir, NOTIFY_LOG_FILE), `${JSON.stringify(receipt)}\n`);
  }
}
