/**
 * The machine-wide record of how much of each account's provider-reported
 * usage window is spent, and how much usage the account has been asked to
 * spend between window reads. It is separate from the availability store
 * because it answers a different question: availability says whether a
 * provider answered, this says how close the account is to refusing. Measured
 * 2026-09-24: the Codex week went from 86% to 94% in one afternoon of judge
 * readings, and nothing read it until the owner looked.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { usageWindowsPath } from "./paths.mjs";
import { writeJsonAtomic } from "./store.mjs";
import { codexHome, codexUsageWindows } from "../harnesses/codex/usage-window.mjs";
import { addMeasured } from "../harnesses/session-metrics.mjs";

/** @typedef {import("../harnesses/codex/usage-window.mjs").UsageWindow} UsageWindow */
/** @typedef {import("../harnesses/session-metrics.mjs").UsageCounters} UsageCounters */
/** @typedef {{windows: UsageWindow[], observedAt: string, totals?: UsageCounters}} AccountWindows */

/**
 * @param {string} account the account key, e.g. `codex:<CODEX_HOME>`
 * @param {UsageWindow[]} windows
 * @param {number} [now]
 * @returns {void}
 */
export function recordUsageWindows(account, windows, now = Date.now()) {
  if (windows.length === 0) return;
  const store = loadStore();
  store.accounts[account] = { windows, observedAt: new Date(now).toISOString() };
  const path = usageWindowsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, store);
}

/**
 * The account's windows that have not reset yet, or an empty list.
 *
 * @param {string} account
 * @param {number} [now]
 * @returns {UsageWindow[]}
 */
export function readUsageWindows(account, now = Date.now()) {
  const record = loadStore().accounts[account];
  if (!record || !Array.isArray(record.windows)) return [];
  return record.windows.filter((window) => typeof window.usedPercent === "number" && Date.parse(window.resetsAt) > now);
}

/** @returns {{schemaVersion: number, accounts: Record<string, AccountWindows>}} */
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(usageWindowsPath(), "utf8"));
    if (parsed && parsed.schemaVersion === 1 && parsed.accounts && typeof parsed.accounts === "object") return parsed;
  } catch {
    // ENOENT on a machine that never recorded a window, or a store a truncated
    // write left unreadable: either way nothing is known, which reads as no warning.
  }
  return { schemaVersion: 1, accounts: {} };
}

/**
 * The account a runtime spends from, when its provider reports windows; null
 * for every harness that reports none (only Codex is measured to).
 *
 * @param {{harness: string}} runtime
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function usageAccountOf(runtime, env = process.env) {
  return runtime.harness === "codex" ? `codex:${codexHome(env)}` : null;
}

/**
 * Record what a finished invocation's provider reported about its account.
 *
 * @param {{harness: string}} runtime
 * @param {string|null|undefined} continuationId the provider's thread id
 * @param {{env?: Record<string, string|undefined>, now?: number}} [options]
 * @returns {void}
 */
export function recordInvocationWindows(runtime, continuationId, options = {}) {
  const account = usageAccountOf(runtime, options.env);
  if (!account || !continuationId) return;
  recordUsageWindows(account, codexUsageWindows(continuationId, options), options.now);
}

/** @returns {UsageCounters} */
function emptyCounters() {
  return { bytes: null, inputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null, outputTokens: null };
}

/**
 * Two counter sets into one: a measured value wins over an unmeasured one,
 * and a counter neither side measured stays null. Every field is named -- the
 * totals are never indexed by a dynamic counter name.
 *
 * @param {UsageCounters|undefined} left
 * @param {UsageCounters} right
 * @returns {UsageCounters}
 */
function addCounters(left, right) {
  return {
    bytes: addMeasured(left?.bytes ?? null, right.bytes),
    inputTokens: addMeasured(left?.inputTokens ?? null, right.inputTokens),
    cacheReadInputTokens: addMeasured(left?.cacheReadInputTokens ?? null, right.cacheReadInputTokens),
    cacheWriteInputTokens: addMeasured(left?.cacheWriteInputTokens ?? null, right.cacheWriteInputTokens),
    outputTokens: addMeasured(left?.outputTokens ?? null, right.outputTokens),
  };
}

/**
 * The strict rollup of per-node counter sets: a counter is summed only when
 * every entry measured it, so a rollup over partly-measured nodes is null
 * rather than a partial sum -- the same refusal the cost evidence makes for
 * an unpriced invocation.
 *
 * @param {(UsageCounters|null|undefined)[]} counters
 * @returns {UsageCounters}
 */
export function sumCounters(counters) {
  /** @param {number|null} left @param {number|null} right @returns {number|null} */
  const strict = (left, right) => left === null || right === null ? null : left + right;
  const [first] = counters;
  /** @type {UsageCounters} */
  let totals = {
    bytes: first?.bytes ?? null,
    inputTokens: first?.inputTokens ?? null,
    cacheReadInputTokens: first?.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: first?.cacheWriteInputTokens ?? null,
    outputTokens: first?.outputTokens ?? null,
  };
  for (const entry of counters.slice(1)) {
    totals = {
      bytes: strict(totals.bytes, entry?.bytes ?? null),
      inputTokens: strict(totals.inputTokens, entry?.inputTokens ?? null),
      cacheReadInputTokens: strict(totals.cacheReadInputTokens, entry?.cacheReadInputTokens ?? null),
      cacheWriteInputTokens: strict(totals.cacheWriteInputTokens, entry?.cacheWriteInputTokens ?? null),
      outputTokens: strict(totals.outputTokens, entry?.outputTokens ?? null),
    };
  }
  return totals;
}

/**
 * Roll one finished invocation's measured counters onto its account's running
 * totals, the machine-wide record of what each account has been asked to
 * spend between window reads. A counter the invocation did not measure leaves
 * the running total alone, and a harness that reports no account adds nothing.
 *
 * @param {{harness: string}} runtime
 * @param {UsageCounters} counters
 * @param {{env?: Record<string, string|undefined>, now?: number}} [options]
 * @returns {void}
 */
export function addAccountUsage(runtime, counters, options = {}) {
  const account = usageAccountOf(runtime, options.env);
  if (!account) return;
  const store = loadStore();
  const existing = store.accounts[account];
  store.accounts[account] = existing && Array.isArray(existing.windows)
    ? { windows: existing.windows, observedAt: existing.observedAt, totals: addCounters(existing.totals, counters) }
    : { windows: [], observedAt: new Date(options.now ?? Date.now()).toISOString(), totals: addCounters(emptyCounters(), counters) };
  const path = usageWindowsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, store);
}

/**
 * The account's rolled-up invocation counters, or null before anything was
 * rolled onto it.
 *
 * @param {string} account
 * @returns {UsageCounters|null}
 */
export function readAccountUsage(account) {
  return loadStore().accounts[account]?.totals ?? null;
}
