/**
 * Direct notification dispatcher (TECH-SPEC lean, rule 6). On `node.terminal`,
 * `run.terminal` and `attention` the controller renders a one-line message
 * from a fixed per-type template, calls `FABERUN_NOTIFY_BIN` with the
 * event as JSON on stdin, and appends a receipt (`delivered`, `failed` or
 * `no_transport`, with the timestamp) to `<run-dir>/notify.jsonl`. Delivery is
 * lossy: an event is attempted once, a failure schedules no further attempt and
 * is never requeued, and the controller never waits on a retry it will not
 * make. The next read of the run's own artefacts carries the full state. With
 * no transport bound (`FABERUN_NOTIFY_BIN` unset) nothing is spawned and
 * a `no_transport` receipt is recorded instead — there is no implicit desktop
 * fallback. The macOS notifier is reachable only by setting
 * `FABERUN_NOTIFY_BIN=os-macos`, an explicit opt-in, never a default.
 *
 * Measured 2026-09-16: `test/cli/cli.test.mjs`'s two notifier fixtures were
 * instrumented with `{at, phase}` timelines (spawned, stdin-end, exit) and run
 * over 80 times (targeted loops, four-way parallel full-file bursts, and a
 * 15-way parallel burst) alongside `node --test test/engine/` and
 * `test/contract/` as background load; every completed timeline resolved in
 * under 40ms end to end, and a direct spawn-to-first-line-of-JS measurement
 * under the same load never exceeded 306ms across 40 concurrent spawns --
 * ruling out class (a) (Node process launch under load), since 306ms is
 * ~16x below the 5000ms budget that has been observed to fire. Two genuine
 * `notification timed out after 5000ms` receipts turned up in leftover run
 * directories from other concurrent sessions on this shared machine (their
 * fixtures unmodified, so no timeline exists for them), confirming the flake
 * is real but requires contention this harness could not reliably reproduce
 * with an instrumented fixture. Class (c) (stdin never ends) is excluded by
 * inspection: `spawnDeliver` below always calls `child.stdin.end(...)`
 * synchronously right after spawning, unconditionally. That leaves class (b):
 * the previous implementation resolved on the child's `close` event, which
 * Node fires only once every stdio stream (including the piped, accumulating
 * `stderr`) has finished closing -- a fd inherited or held open by a
 * lingering grandchild, or slow to flush under load, delays `close` well
 * past the point the notifier process itself has already exited. `spawnDeliver`
 * now resolves on `exit` (fires as soon as the process itself terminates,
 * independent of stdio stream closure) instead of `close`, and no longer
 * gates delivery on the stderr stream ending. The timeout budget is left at
 * its original 5000ms: no measurement here justified raising it, and the (b)
 * fix removes the mechanism that budget was actually timing out on.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createMacosNotifier } from "./os-macos.mjs";
import { errorMessage } from "../util.mjs";

export const NOTIFY_BIN_ENV = "FABERUN_NOTIFY_BIN";
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

/**
 * The spawn-to-delivery budget for a non-macOS transport, in milliseconds.
 * Unchanged from its original value: the 2026-09-16 measurement (see the
 * module header) found no evidence this needed to be larger, only that the
 * previous implementation could time out waiting on `close` while the child
 * had already exited. That is fixed at the source in `spawnDeliver` below.
 */
export const notificationDeliveryTimeoutMs = 5_000;

const SUMMARY_CHARS = 200;

/**
 * The append-only, campaign-level record the managed `AGENTS.md` signal block
 * summarises. It lives at `<runs-dir>/inbox.jsonl` so a notification that
 * belongs to no single run — a campaign watcher line — has a durable home that
 * is not a run directory.
 *
 * Schema, one JSON object per line:
 * `{schemaVersion, eventId, at, type, campaignId, runId, nodeId, status,
 * errorCode, dedupeKey, summary}`. `eventId` is the sha256 hex of `dedupeKey`,
 * and an entry is appended only when no existing entry carries the same
 * `dedupeKey` (first write wins). Concurrent writers append whole lines with a
 * single `O_APPEND` write each, so lines never interleave; the check-then-append
 * is not atomic, so two writers racing on the same key may both append, and
 * readers collapse repeated keys. A torn trailing line from a crash is skipped
 * by `readInbox`.
 */
export const INBOX_FILE = "inbox.jsonl";
export const INBOX_SCHEMA_VERSION = 1;

/**
 * The named warning `doctor`, `preflight` and the foreground launch command
 * emit when no human transport is bound. It is a warning, not an error: the
 * opt-in is intentional and no default exists on any platform.
 */
export const NOTIFY_NO_TRANSPORT_WARNING = "no human notification transport is configured (FABERUN_NOTIFY_BIN unset): terminal events reach only .runs/inbox.jsonl and the AGENTS.md managed block";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{schemaVersion: number, eventId: string, at: string, type: string, campaignId: string|null, runId: string|null, nodeId: string|null, status: string|null, errorCode: string|null, dedupeKey: string, summary: string}} InboxEntry */
/** @typedef {{type: string, dedupeKey: string, summary: string, at?: string, campaignId?: string|null, runId?: string|null, nodeId?: string|null, status?: string|null, errorCode?: string|null}} InboxEvent */
/** @typedef {{type: "node.terminal"|"run.terminal"|"attention", runId: string|null, campaignId?: string|null, nodeId?: string|null, status?: string|null, attempt?: number|null, errorCode?: string|null, done?: number|null, total?: number|null, dedupeKey?: string|null, runDir?: string|null, costUsd?: number|null, summary?: string|null, eventId?: string}} NotifyEvent */
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
 * The named no-transport warning, or null when a transport is bound. The empty
 * string counts as unset, exactly as `deliverNotification` reads it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function noTransportWarning(env = process.env) {
  return env[NOTIFY_BIN_ENV] ? null : NOTIFY_NO_TRANSPORT_WARNING;
}

/**
 * What `campaign watch --wake` must say about waking. No adapter declares
 * `canWake: true` (`os-macos` is `canWake: false`), so the wake verb records
 * to the inbox and the managed block and never implies a session was woken.
 *
 * @param {string|undefined} [bin]
 * @returns {string}
 */
export function wakeCapabilityNotice(bin = process.env[NOTIFY_BIN_ENV]) {
  if (!bin) {
    return "no notify transport is configured; --wake records to .runs/inbox.jsonl and the AGENTS.md managed block; no session is woken";
  }
  if (bin === MACOS_TRANSPORT) {
    return "os-macos cannot wake a session (canWake: false); --wake records to .runs/inbox.jsonl and the AGENTS.md managed block";
  }
  return `notify transport ${bin} declares canWake: false; --wake records to .runs/inbox.jsonl and the AGENTS.md managed block; no session is woken`;
}

/** @param {string} runsDir @returns {string} */
export function inboxPath(runsDir) {
  return join(runsDir, INBOX_FILE);
}

/**
 * Read every committed inbox entry. A missing file is `[]`; a torn or
 * unparsable line is skipped, exactly as `alreadyNotified` treats one.
 *
 * @param {string} runsDir
 * @returns {InboxEntry[]}
 */
export function readInbox(runsDir) {
  let text;
  try {
    text = readFileSync(inboxPath(runsDir), "utf8");
  } catch {
    return [];
  }
  /** @type {InboxEntry[]} */
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(/** @type {InboxEntry} */ (parsed));
    } catch {
      // A torn trailing line was never a committed entry.
    }
  }
  return entries;
}

/**
 * Append one entry unless its `dedupeKey` is already present. `eventId` is the
 * hash of the key, so the identity is stable across processes and restarts.
 *
 * @param {string} runsDir
 * @param {InboxEvent} event
 * @returns {{appended: boolean, eventId: string, entry?: InboxEntry}}
 */
export function appendInbox(runsDir, event) {
  if (typeof event.dedupeKey !== "string" || !event.dedupeKey) {
    throw new TypeError("appendInbox: an entry requires a non-empty dedupeKey");
  }
  const eventId = createHash("sha256").update(event.dedupeKey).digest("hex");
  if (readInbox(runsDir).some((entry) => entry.dedupeKey === event.dedupeKey)) {
    return { appended: false, eventId };
  }
  /** @type {InboxEntry} */
  const entry = {
    schemaVersion: INBOX_SCHEMA_VERSION,
    eventId,
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    campaignId: event.campaignId ?? null,
    runId: event.runId ?? null,
    nodeId: event.nodeId ?? null,
    status: event.status ?? null,
    errorCode: event.errorCode ?? null,
    dedupeKey: event.dedupeKey,
    summary: event.summary,
  };
  mkdirSync(runsDir, { recursive: true });
  const fd = openSync(inboxPath(runsDir), "a", 0o600);
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
  } finally {
    closeSync(fd);
  }
  return { appended: true, eventId, entry };
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
 * Resolves on the child's own `exit`, not `close`: `close` waits for every
 * stdio stream to finish closing, and a piped `stderr` fd can be held open
 * by a lingering grandchild or be slow to flush under load well after the
 * notifier process itself has terminated. Gating delivery on that stream
 * closing (as the previous implementation did) could stall a healthy,
 * already-exited delivery until the timeout fired.
 *
 * @param {string} bin
 * @param {JsonObject} event
 * @param {{spawn?: typeof defaultSpawn, timeoutMs?: number}} options
 * @returns {Promise<DeliveryResult>}
 */
function spawnDeliver(bin, event, { spawn = defaultSpawn, timeoutMs = notificationDeliveryTimeoutMs } = {}) {
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
    child.once("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr || `notification exited ${code}` }));
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
    // A campaign-level line arrives already rendered; a run-level event is
    // rendered from its counters here. Either way the stored summary is the
    // one that reaches the transport and the receipt.
    const summary = typeof enriched.summary === "string" && enriched.summary
      ? enriched.summary
      : renderNotification(enriched);
    // Consumers deduplicate by eventId (the Ford adapter rejects an event without
    // one), so every delivery carries a stable id derived from the dedupe key.
    const eventId = enriched.eventId
      ?? createHash("sha256").update(enriched.dedupeKey ?? JSON.stringify(enriched)).digest("hex");
    /** @type {DeliveryResult} */
    let result;
    try {
      result = await this.deliver({ ...enriched, summary, eventId });
    } catch (error) {
      // A transport that rejects is a failed delivery, not a controller fault:
      // the receipt is still appended and the failure is dropped like any other.
      result = { ok: false, error: errorMessage(error) };
    }
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
