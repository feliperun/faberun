/**
 * The machine-wide record of how much of each account's provider-reported
 * usage window is spent. It is separate from the availability store because
 * it answers a different question: availability says whether a provider
 * answered, this says how close the account is to refusing. Measured
 * 2026-09-24: the Codex week went from 86% to 94% in one afternoon of judge
 * readings, and nothing read it until the owner looked.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { usageWindowsPath } from "./paths.mjs";
import { writeJsonAtomic } from "./store.mjs";
import { codexHome, codexUsageWindows } from "../harnesses/codex/usage-window.mjs";

/** @typedef {import("../harnesses/codex/usage-window.mjs").UsageWindow} UsageWindow */
/** @typedef {{windows: UsageWindow[], observedAt: string}} AccountWindows */

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
