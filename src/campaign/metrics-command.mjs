/**
 * Filesystem and command layer for `faberun metrics`. This module owns the
 * command's flags and reads the campaign's run or ledger artefacts, while
 * `metrics.mjs` stays a pure function over parsed records.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { jsonObjectOf } from "./metrics-evals.mjs";
import { excludedRunIdsFor, projectMetrics } from "./metrics.mjs";
import { renderMetricsJson, renderMetricsReport } from "../report/metrics-report.mjs";
import { campaignDir, LEDGER_SOURCE_MANIFEST_FILE } from "./layout.mjs";
import { readCampaign } from "./record.mjs";
import { listNodeSnapshots, nodeSnapshotPath } from "../run/node-store.mjs";
import { runsRoot } from "../run/paths.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{runId: string, id: string, status: string, attempt?: number|null, revisions?: number|null, review?: string|null, sameProviderReview?: boolean|null}} RunNode */

/** Flags of `faberun metrics`, declared here so the router only names them. */
/** @type {import("node:util").ParseArgsOptionsConfig} */
export const METRICS_OPTIONS = {
  cwd: { type: "string" },
  ledger: { type: "string" },
  json: { type: "boolean" },
};

/** Text used by the generated manual for options whose effect is not derivable from their parser type. */
/** @type {Record<string, {value: string, effect: string, default: string}>} */
export const METRICS_MANUAL = {
  ledger: {
    value: "directory",
    effect: "Read the versioned campaign ledger instead of the operator's run directories.",
    default: "none",
  },
};

const RUN_EVENTS_FILE = "events.jsonl";
const USAGE_LOG_FILE = "usage.jsonl";
const NOTIFY_LOG_FILE = "notify.jsonl";

/**
 * @typedef {{
 *   campaignId: string,
 *   runIds: string[],
 *   events: unknown[],
 *   usageRecords: unknown[],
 *   notifications: unknown[],
 *   nodes: RunNode[],
 *   journal: unknown[],
 *   campaign: JsonObject,
 *   excludedRunIds: string[],
 *   missingSources: string[],
 * }} MetricsSources
 */

/**
 * Read the recorded sources of one campaign: every linked run's persisted
 * node snapshots, transition events (tagged with the run id, since a node id
 * is only unique within one run), `usage.jsonl` and `notify.jsonl`. A missing
 * artefact reads as empty, which the projector reports as a missing
 * measurement and never as a measured zero.
 *
 * @param {string} campaignPath
 * @param {{runsDir?: string, ledgerDir?: string}} [options]
 * @returns {MetricsSources}
 */
export function readMetricsSources(campaignPath, { runsDir = join(campaignPath, "..", ".."), ledgerDir = undefined } = {}) {
  const campaign = readCampaign(ledgerDir ?? campaignPath);
  /** @type {unknown[]} */
  const events = [];
  /** @type {unknown[]} */
  const usageRecords = [];
  /** @type {unknown[]} */
  const notifications = [];
  /** @type {RunNode[]} */
  const nodes = [];
  /** @type {unknown[]} */
  const journal = [];
  /** @type {string[]} */
  const missingSources = [];
  const absentAtOrigin = ledgerDir === undefined ? new Set() : readLedgerAbsentSources(ledgerDir);
  const journalPath = join(ledgerDir ?? campaignPath, "journal.jsonl");
  if (existsSync(journalPath)) journal.push(...readJsonlRecords(journalPath));
  else missingSources.push("journal.jsonl");
  for (const runId of campaign.linkedRunIds) {
    if (ledgerDir === undefined) {
      for (const record of readJsonlRecords(join(runsDir, runId, RUN_EVENTS_FILE))) events.push({ ...jsonObjectOf(record), runId });
      for (const record of readJsonlRecords(join(runsDir, runId, USAGE_LOG_FILE))) usageRecords.push({ ...jsonObjectOf(record), runId });
      for (const record of readJsonlRecords(join(runsDir, runId, NOTIFY_LOG_FILE))) notifications.push({ ...jsonObjectOf(record), runId });
      for (const node of readMetricNodeSnapshots(join(runsDir, runId))) nodes.push({ ...node, runId });
      continue;
    }
    /** @type {[string, unknown[]][]} */
    const sources = [
      [RUN_EVENTS_FILE, events],
      [USAGE_LOG_FILE, usageRecords],
      [NOTIFY_LOG_FILE, notifications],
    ];
    for (const [suffix, target] of sources) {
      const path = join(ledgerDir, `${runId}.${suffix}`);
      if (!existsSync(path)) {
        if (!absentAtOrigin.has(`${runId}.${suffix}`)) missingSources.push(`${runId}.${suffix}`);
        continue;
      }
      for (const record of readJsonlRecords(path)) target.push({ ...jsonObjectOf(record), runId });
    }
    const nodesPath = join(ledgerDir, `${runId}.nodes.json`);
    if (!existsSync(nodesPath)) {
      if (!absentAtOrigin.has(`${runId}.nodes.json`)) missingSources.push(`${runId}.nodes.json`);
      continue;
    }
    for (const node of readLedgerNodeSnapshots(nodesPath)) nodes.push({ ...node, runId });
  }
  const campaignObject = /** @type {JsonObject} */ (campaign);
  return {
    campaignId: campaign.id,
    runIds: [...campaign.linkedRunIds],
    events,
    usageRecords,
    notifications,
    nodes,
    journal,
    campaign: campaignObject,
    excludedRunIds: excludedRunIdsFor(campaignObject, []),
    missingSources,
  };
}

/** @param {string} ledgerDir @returns {Set<string>} */
function readLedgerAbsentSources(ledgerDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(ledgerDir, LEDGER_SOURCE_MANIFEST_FILE), "utf8"));
    const preserved = /** @type {Set<string>} */ (new Set(Array.isArray(manifest?.preserved) ? /** @type {unknown[]} */ (manifest.preserved).filter((source) => typeof source === "string") : []));
    return /** @type {Set<string>} */ (new Set(Array.isArray(manifest?.absent) ? /** @type {unknown[]} */ (manifest.absent).filter((source) => typeof source === "string" && !preserved.has(source)) : []));
  } catch {
    // An old ledger has no origin manifest, so an absent file remains incomplete evidence.
    return new Set();
  }
}

/** @param {string} path @returns {Omit<RunNode, "runId">[]} */
function readLedgerNodeSnapshots(path) {
  try {
    const records = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(records)) return [];
    return records.flatMap((record) => {
      const object = jsonObjectOf(record);
      if (object === null || typeof object.id !== "string" || typeof object.status !== "string") return [];
      return [{
        id: object.id,
        status: object.status,
        attempt: typeof object.attempt === "number" ? object.attempt : null,
        revisions: typeof object.revisions === "number" ? object.revisions : null,
        review: typeof object.review === "string" ? object.review : null,
        sameProviderReview: typeof object.sameProviderReview === "boolean" ? object.sameProviderReview : null,
      }];
    });
  } catch {
    // A torn ledger projection is incomplete evidence, represented by its empty source below.
    return [];
  }
}

/**
 * Persisted node snapshots of one run, reduced to the fields metrics reads.
 * Reading is tolerant of a run directory with no `nodes/` yet (freshly
 * dispatched) and of a snapshot that fails to parse (never blocks a report on
 * a torn write).
 *
 * @param {string} runDir
 * @returns {Omit<RunNode, "runId">[]}
 */
export function readMetricNodeSnapshots(runDir) {
  /** @type {Omit<RunNode, "runId">[]} */
  const nodes = [];
  for (const name of listNodeSnapshots(runDir)) {
    let record;
    try {
      record = jsonObjectOf(JSON.parse(readFileSync(nodeSnapshotPath(runDir, name.slice(0, -".json".length)), "utf8")));
    } catch {
      continue;
    }
    if (record === null || typeof record.id !== "string" || typeof record.status !== "string") continue;
    nodes.push({
      id: record.id,
      status: record.status,
      attempt: typeof record.attempt === "number" ? record.attempt : null,
      revisions: typeof record.revisions === "number" ? record.revisions : null,
      review: typeof record.review === "string" ? record.review : null,
      sameProviderReview: typeof record.sameProviderReview === "boolean" ? record.sameProviderReview : null,
    });
  }
  return nodes;
}

/**
 * `faberun metrics <campaign-id> [--cwd <dir>] [--json]`: project the
 * campaign's recorded artefacts and return what the command prints. Reading
 * only, and never a write: a report of a closed campaign must not touch it.
 *
 * @param {string} campaignId
 * @param {{cwd?: unknown, ledger?: unknown, json?: unknown}} [values]
 * @returns {string}
 */
export function renderCampaignMetrics(campaignId, values = {}) {
  const runsDir = runsRoot(resolve(typeof values.cwd === "string" && values.cwd !== "" ? values.cwd : process.cwd()));
  const ledgerDir = typeof values.ledger === "string" && values.ledger !== "" ? resolve(values.ledger) : undefined;
  const sources = readMetricsSources(campaignDir(runsDir, campaignId), { runsDir, ledgerDir });
  const metrics = projectMetrics(sources);
  return values.json === true ? renderMetricsJson(sources, metrics) : renderMetricsReport(sources, metrics);
}

/**
 * Records of one JSONL artefact. An unterminated final line was never a
 * committed record — the newline is written with the record — so it is skipped
 * rather than parsed.
 *
 * @param {string} path
 * @returns {unknown[]}
 */
function readJsonlRecords(path) {
  if (!existsSync(path)) return [];
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
