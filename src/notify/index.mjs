/**
 * Direct notification dispatcher (TECH-SPEC lean, rule 6). On `node.terminal`,
 * `run.terminal` and `attention` the controller renders the message through
 * `renderRunProgress` (`report/message.mjs`) from the run's own persisted
 * state, delivers that one text to every bound transport at once, and appends
 * one receipt (`delivered`, `failed` or `no_transport`, with the timestamp
 * and one entry per transport) to `<run-dir>/notify.jsonl`. Two transports
 * exist, additive and independently opted in: `FABERUN_NOTIFY_BIN`, an
 * executable called with the event as JSON on stdin (a phone, a chat), and
 * `FABERUN_NOTIFY_SESSION`, the harness session the controller was launched
 * from (`session.mjs`), which is what wakes the operator's seat. Delivery is
 * lossy: an event is attempted once per transport, a failure schedules no
 * further attempt and is never requeued, and the controller never waits on a
 * retry it will not make. The next read of the run's own artefacts carries
 * the full state. With no transport bound nothing is spawned and a
 * `no_transport` receipt is recorded instead — there is no implicit desktop
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
import { NOTIFY_SESSION_ENV, deliverToSessions, resolveSessionTargets, sessionWakeNotice } from "./session.mjs";
import { errorMessage } from "../util.mjs";

/**
 * `report/message.mjs` reaches back to this module (through
 * `run/node-store.mjs` -> `run/disk-gc.mjs` -> `host/preflight.mjs`, which
 * reads `NOTIFY_BIN_ENV`), so a static top-level import of it here would be a
 * real cycle: `host/preflight.mjs` would read `NOTIFY_BIN_ENV` while this
 * module's own top level was still mid-evaluation, before the `const` is
 * assigned. A dynamic import resolves this module first and defers loading
 * `report/message.mjs` until the first call, by which point this module has
 * already finished initializing -- so the cycle is real but harmless. Cached
 * after the first call so every subsequent render reuses the same module.
 * @type {Promise<typeof import("../report/message.mjs")>|null}
 */
let progressModule = null;
/** @returns {Promise<typeof import("../report/message.mjs")>} */
function loadProgressModule() {
  progressModule ??= import("../report/message.mjs");
  return progressModule;
}

export const NOTIFY_BIN_ENV = "FABERUN_NOTIFY_BIN";
const MACOS_TRANSPORT = "os-macos";

/**
 * Every variable that binds a notification transport. The controller is the
 * only process that delivers: a worker, a judge or a verification command
 * that inherits these would notify on the controller's behalf -- and in this
 * repository, whose workers run its own test suite, every fixture controller
 * the suite spawns would deliver its terminal events for real. Measured
 * 2026-09-21: a run launched with `FABERUN_NOTIFY_SESSION=auto` woke the
 * operator's session seven times in minutes from `test/repo/base-ref.test.mjs`
 * fixtures its worker ran. `withoutNotifyEnv` is the boundary every child
 * crosses; `test/setup.mjs` neutralises the same names inside the suite.
 */
export const NOTIFY_EVENTS_ENV = "FABERUN_NOTIFY_EVENTS";
export const NOTIFY_LANG_ENV = "FABERUN_NOTIFY_LANG";
export const NOTIFY_ENV_NAMES = Object.freeze([NOTIFY_BIN_ENV, NOTIFY_SESSION_ENV, NOTIFY_EVENTS_ENV, NOTIFY_LANG_ENV]);

/** Every event type the dispatcher can be asked to deliver. */
export const NOTIFY_EVENT_TYPES = Object.freeze(["node.terminal", "run.terminal", "attention", "advisory"]);

/**
 * What leaves the controller when `FABERUN_NOTIFY_EVENTS` is unset: a phase
 * settling, a node that waits on a person, and an advisory threshold the
 * operator declared. A node settling stays in `notify.jsonl` as a `filtered`
 * receipt. The operator's own words, 2026-09-22, after a run of two nodes
 * produced four wake-ups: "só fechamento de fase e atenção acordam, nó
 * individual fica no log" -- and before that, after the phone flood, "só
 * milestones e fechamentos de fase". Measured on the campaign that prompted
 * it: five phases of two or three nodes would be about 20 messages with every
 * event, about 7 with these.
 */
export const DEFAULT_NOTIFY_EVENTS = Object.freeze(["run.terminal", "attention", "advisory"]);

/** The two languages the message renders its wording in; `FABERUN_NOTIFY_LANG` may name either. */
export const NOTIFY_LANGUAGES = Object.freeze(["en", "pt"]);

/**
 * The event types the environment lets out, as a set. Unknown items are left
 * out here and reported by `notifySettingProblems`; an empty value is the
 * default, never "nothing".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>}
 */
export function deliverableEventTypes(env = process.env) {
  const items = (env[NOTIFY_EVENTS_ENV] ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return new Set(items.length ? items.filter((item) => NOTIFY_EVENT_TYPES.includes(item)) : DEFAULT_NOTIFY_EVENTS);
}

/**
 * Every notify setting the environment gets wrong, one sentence each, for
 * `doctor` and `preflight`. Empty when everything parses.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function notifySettingProblems(env = process.env) {
  const problems = [];
  const events = (env[NOTIFY_EVENTS_ENV] ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  for (const item of events) {
    if (!NOTIFY_EVENT_TYPES.includes(item)) problems.push(`${NOTIFY_EVENTS_ENV} item "${item}" is not one of ${NOTIFY_EVENT_TYPES.join(", ")}`);
  }
  const lang = (env[NOTIFY_LANG_ENV] ?? "").trim();
  if (lang && !NOTIFY_LANGUAGES.includes(lang)) problems.push(`${NOTIFY_LANG_ENV}=${lang} is not one of ${NOTIFY_LANGUAGES.join(", ")}`);
  return problems;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv} a copy with every notify transport unbound
 */
export function withoutNotifyEnv(env) {
  const copy = { ...env };
  for (const name of NOTIFY_ENV_NAMES) delete copy[name];
  return copy;
}
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

/**
 * The one-line, character-based bound this module used to enforce on every
 * rendered summary. The primary path (below) now defers to
 * `PROGRESS_MESSAGE_MAX_BYTES` in `report/progress.mjs`, which bounds the
 * whole rendered message in bytes rather than characters, because that
 * message is no longer one line. `SUMMARY_CHARS` survives only to bound the
 * degraded template `renderNotification` falls back to when a caller has no
 * `runDir` to render from.
 */
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
/** @typedef {{type: "node.terminal"|"run.terminal"|"attention"|"advisory", runId: string|null, campaignId?: string|null, nodeId?: string|null, status?: string|null, attempt?: number|null, errorCode?: string|null, done?: number|null, total?: number|null, dedupeKey?: string|null, runDir?: string|null, costUsd?: number|null, summary?: string|null, eventId?: string}} NotifyEvent */
/** @typedef {{id: string, ok: boolean, error?: string}} TransportOutcome one transport's own outcome, named so the receipt says which took the message */
/** @typedef {{ok: boolean, error?: string, noTransport?: boolean, transports?: TransportOutcome[]}} DeliveryResult */

/**
 * Render the message for an event. For `node.terminal`, `run.terminal` and
 * `attention` this delegates to `renderRunProgress`, which reads the run's
 * own persisted state (its contract, its node snapshots, its usage) from
 * `event.runDir` -- so whatever calls this function once gets exactly the
 * string every audience of that event sees: the inbox entry's `summary` and
 * the transport's stdin are never rendered separately and never drift.
 *
 * `runDir` is absent, or names a directory with no readable run scaffold
 * (no `contract.json`, no `run.json`, a node snapshot that fails validation),
 * on two kinds of paths: a caller with no run directory at all, and a render
 * that fails against a run that is present but broken. Both fall back to
 * `degradedNotification` below, a fixed one-line, counters-only template --
 * still one render, still the same text for every audience, just a coarser
 * one. A render failure must never propagate: this function backs the lossy
 * notify queue, and a broken render must not turn into a lost receipt.
 *
 * The unknown-type case is checked synchronously (it throws, it never
 * returns a rejected promise a caller might forget to handle); the known
 * types resolve asynchronously because loading `report/progress.mjs` is
 * itself async (see `loadProgressModule`).
 *
 * @param {NotifyEvent} event
 * @returns {Promise<string>}
 */
export function renderNotification(event) {
  switch (event.type) {
    case "node.terminal":
    case "run.terminal":
    case "attention":
      return renderDelegated(event);
    default:
      throw new TypeError(`renderNotification: unknown event type ${String(event.type)}`);
  }
}

/**
 * @param {NotifyEvent} event
 * @returns {Promise<string>}
 */
async function renderDelegated(event) {
  if (typeof event.runDir !== "string" || !event.runDir) return degradedNotification(event);
  try {
    const { renderRunProgress } = await loadProgressModule();
    return renderRunProgress(event.runDir, event);
  } catch {
    return degradedNotification(event);
  }
}

/**
 * The fixed one-line message this module rendered for every event before
 * `renderRunProgress` existed, from counters and identifiers only (node id,
 * run id or directory, state, attempt, error code, done/total, cost), never
 * from model text:
 *   `node <id> failed · run <id> · attempt 2 · verification_failed · resume <run-dir>`
 *   `run <id> done · 3/3 nodes · $4.21`
 *   `node <id> needs you · run <id> · <error code>`
 *
 * @param {NotifyEvent} event
 * @returns {string}
 */
function degradedNotification(event) {
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
  if (env[NOTIFY_BIN_ENV]) return null;
  if (resolveSessionTargets(env).length) return null;
  return NOTIFY_NO_TRANSPORT_WARNING;
}

/**
 * What `campaign watch --wake` must say about waking. The external transport
 * never wakes anything (`os-macos` and every `FABERUN_NOTIFY_BIN` executable
 * are `canWake: false`: they push to a person); the session transports are
 * the only `canWake: true`, and the notice says which of them the environment
 * resolves to, so the verb never implies a session was woken when none will be.
 *
 * @param {string|undefined} [bin]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function wakeCapabilityNotice(bin = process.env[NOTIFY_BIN_ENV], env = process.env) {
  const session = sessionWakeNotice(env);
  if (!bin) {
    return `no external notify transport is configured; --wake records to .runs/inbox.jsonl and the AGENTS.md managed block; ${session}`;
  }
  if (bin === MACOS_TRANSPORT) {
    return `os-macos cannot wake a session (canWake: false); --wake records to .runs/inbox.jsonl and the AGENTS.md managed block; ${session}`;
  }
  return `notify transport ${bin} declares canWake: false; --wake records to .runs/inbox.jsonl and the AGENTS.md managed block; ${session}`;
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
 * Deliver one event through every bound transport at once: the external
 * executable and each resolved harness session, all given the same rendered
 * text. The result is `ok` when any one of them took the message, carries
 * every transport's own outcome for the receipt, and is
 * `{ok: false, noTransport: true}` when nothing at all is bound -- without
 * spawning or connecting anything.
 *
 * @param {{type: string, summary: string, campaignId?: string|null, [key: string]: unknown}} event
 * @param {{bin?: string, env?: NodeJS.ProcessEnv, spawn?: typeof defaultSpawn, timeoutMs?: number}} [options]
 * @returns {Promise<DeliveryResult>}
 */
async function deliverNotification(event, options = {}) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? env[NOTIFY_BIN_ENV];
  const targets = resolveSessionTargets(env);
  /** @type {Promise<TransportOutcome>[]} */
  const attempts = [];
  if (bin) {
    const external = bin === MACOS_TRANSPORT
      ? createMacosNotifier({ spawn: options.spawn }).deliver(/** @type {any} */ (event))
      : spawnDeliver(bin, event, options);
    attempts.push(external.then((result) => ({ id: bin === MACOS_TRANSPORT ? MACOS_TRANSPORT : "bin", ...result })));
  }
  /** @type {Promise<TransportOutcome[]>} */
  const sessions = targets.length ? deliverToSessions(event, targets, { timeoutMs: options.timeoutMs, env }) : Promise.resolve([]);
  if (!attempts.length && !targets.length) return { ok: false, noTransport: true, transports: [] };
  const transports = [...(await Promise.all(attempts)), ...(await sessions)];
  const failures = transports.filter((outcome) => !outcome.ok).map((outcome) => `${outcome.id}: ${outcome.error ?? "failed"}`);
  return {
    ok: transports.some((outcome) => outcome.ok),
    ...(failures.length ? { error: failures.join("; ") } : {}),
    transports,
  };
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
      : await renderNotification(enriched);
    // Consumers deduplicate by eventId (the Ford adapter rejects an event without
    // one), so every delivery carries a stable id derived from the dedupe key.
    const eventId = enriched.eventId
      ?? createHash("sha256").update(enriched.dedupeKey ?? JSON.stringify(enriched)).digest("hex");
    // An event type the environment keeps out of every transport is still a
    // receipt -- `filtered`, with the rendered summary -- so the log says what
    // happened to it, and the resume's dedupe sees it as already handled.
    const filtered = !deliverableEventTypes().has(enriched.type);
    /** @type {DeliveryResult} */
    let result;
    if (filtered) {
      result = { ok: false, transports: [] };
    } else {
      try {
        result = await this.deliver({ ...enriched, summary, eventId });
      } catch (error) {
        // A transport that rejects is a failed delivery, not a controller fault:
        // the receipt is still appended and the failure is dropped like any other.
        result = { ok: false, error: errorMessage(error) };
      }
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
      status: filtered ? "filtered" : result.ok ? "delivered" : result.noTransport ? "no_transport" : "failed",
      // One entry per bound transport, so a receipt that says `delivered`
      // also says whether the phone, the session, or both took the message.
      transports: result.transports ?? [],
      at: new Date(this.now()).toISOString(),
    };
    if (!filtered && !result.ok && !result.noTransport) receipt.error = result.error ?? null;
    appendFileSync(join(this.runDir, NOTIFY_LOG_FILE), `${JSON.stringify(receipt)}\n`);
  }
}
