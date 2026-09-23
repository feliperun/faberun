/**
 * Reader for the versioned campaign evidence ledger used by eval projections.
 * It owns the ledger filename contract so `run.mjs` remains a command router
 * while `metrics.mjs` remains the pure projector and comparator.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readCampaign } from "../src/campaign/record.mjs";
import { LEDGER_SOURCE_MANIFEST_FILE } from "../src/campaign/layout.mjs";

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * Read all eval projector sources from one closed ledger. Missing files stay
 * visible by filename; they are not silently converted into measured zeros.
 *
 * @param {string} ledgerDir
 * @returns {{runIds: string[], events: unknown[], usageRecords: unknown[], missingSources: string[], excludedRunIds: string[]}}
 */
export function readEvalLedgerSources(ledgerDir) {
  const root = resolve(ledgerDir);
  const campaign = readCampaign(root);
  /** @type {unknown[]} */
  const events = [];
  /** @type {unknown[]} */
  const usageRecords = [];
  /** @type {string[]} */
  const missingSources = [];
  const absentAtOrigin = readLedgerAbsentSources(root);
  const excludedRunIds = campaign.replacements?.flatMap((replacement) => replacement.runIds) ?? [];
  for (const runId of campaign.linkedRunIds) {
    readLedgerJsonl(root, `${runId}.events.jsonl`, events, true, missingSources, absentAtOrigin);
    readLedgerJsonl(root, `${runId}.usage.jsonl`, usageRecords, true, missingSources, absentAtOrigin);
  }
  return { runIds: [...campaign.linkedRunIds], events, usageRecords, missingSources, excludedRunIds: [...new Set(excludedRunIds)] };
}

/**
 * @param {string} root
 * @param {string} name
 * @param {unknown[]} target
 * @param {boolean} tagRun
 * @param {string[]} missingSources
 * @param {Set<string>} absentAtOrigin
 * @returns {void}
 */
function readLedgerJsonl(root, name, target, tagRun, missingSources, absentAtOrigin) {
  const path = join(root, name);
  if (!existsSync(path)) {
    if (!absentAtOrigin.has(name)) missingSources.push(name);
    return;
  }
  const runId = name.slice(0, name.indexOf("."));
  for (const record of readJsonlRecords(path)) {
    target.push(tagRun ? { ...jsonObjectOf(record), runId } : record);
  }
}

/** @param {string} root @returns {Set<string>} */
function readLedgerAbsentSources(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, LEDGER_SOURCE_MANIFEST_FILE), "utf8"));
    const preserved = /** @type {Set<string>} */ (new Set(Array.isArray(manifest?.preserved) ? /** @type {unknown[]} */ (manifest.preserved).filter((source) => typeof source === "string") : []));
    return /** @type {Set<string>} */ (new Set(Array.isArray(manifest?.absent) ? /** @type {unknown[]} */ (manifest.absent).filter((source) => typeof source === "string" && !preserved.has(source)) : []));
  } catch {
    // An old ledger has no origin manifest, so an absent file remains incomplete evidence.
    return new Set();
  }
}

/**
 * @param {string} path
 * @returns {unknown[]}
 */
function readJsonlRecords(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {unknown[]} */
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    records.push(JSON.parse(lines[index]));
  }
  return records;
}

/** @param {unknown} value @returns {JsonObject|null} */
function jsonObjectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {JsonObject} */ (value) : null;
}
