/**
 * The closed campaign evidence copy: only the files consumed by campaign and
 * eval projectors cross from the operator home into the versioned ledger.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readMetricNodeSnapshots } from "./metrics-command.mjs";
import { CAMPAIGN_FILE, JOURNAL_FILE, LEDGER_SOURCE_MANIFEST_FILE } from "./layout.mjs";
import { readCampaign } from "./record.mjs";

/** @typedef {{runId: string, source: string}} LedgerSkip */
/** @typedef {{written: string[], skipped: LedgerSkip[]}} LedgerPreservation */
/** @typedef {{runId: string, source: string}} LedgerChange */
/** @typedef {{copied: LedgerChange[], gone: LedgerChange[]}} LedgerReledger */

const RUN_SOURCES = [
  ["events.jsonl", "events.jsonl"],
  ["usage.jsonl", "usage.jsonl"],
  ["notify.jsonl", "notify.jsonl"],
];

/** Fields consumed by `projectMetrics` and `projectEvalIndicators`; worker prose never crosses the ledger boundary. */
export const EVENT_PROJECTION_FIELDS = Object.freeze([
  "at", "node", "to", "phase", "runtime", "verdict", "proofApproved", "passed", "override", "recovery", "error", "revisions",
]);
/** Fields consumed by `projectMetrics`; notification messages and transport details never cross the ledger boundary. */
export const NOTIFY_PROJECTION_FIELDS = Object.freeze(["at", "dedupeKey", "attempt", "status"]);

/**
 * Copy a campaign's projector sources into its versioned ledger. Missing run
 * sources are reported so a pruned run cannot make the close fail or look
 * complete by accident. Repeated calls overwrite the same paths.
 *
 * @param {string} campaignPath
 * @param {string} repoRoot
 * @returns {LedgerPreservation}
 */
export function preserveCampaignLedger(campaignPath, repoRoot) {
  const campaign = readCampaign(campaignPath);
  const runsDir = resolve(campaignPath, "..", "..");
  const ledgerDir = join(repoRoot, "docs", "campaigns", campaign.id, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  /** @type {string[]} */
  const written = [];
  /** @type {LedgerSkip[]} */
  const skipped = [];
  const priorManifest = readSourceManifest(ledgerDir);
  const absent = new Set(priorManifest.absent);
  const preserved = new Set(priorManifest.preserved);
  for (const name of [JOURNAL_FILE, CAMPAIGN_FILE]) {
    const source = join(campaignPath, name);
    if (!existsSync(source)) continue;
    const destination = join(ledgerDir, name);
    copyFileSync(source, destination);
    written.push(destination);
  }
  for (const runId of campaign.linkedRunIds) {
    const runDir = join(runsDir, runId);
    for (const [sourceName, destinationSuffix] of RUN_SOURCES) {
      const source = join(runDir, sourceName);
      const destinationName = `${runId}.${destinationSuffix}`;
      if (!existsSync(source)) {
        skipped.push({ runId, source: sourceName });
        if (!preserved.has(destinationName)) absent.add(destinationName);
        continue;
      }
      absent.delete(destinationName);
      preserved.add(destinationName);
      const destination = join(ledgerDir, destinationName);
      if (sourceName === "events.jsonl" || sourceName === "notify.jsonl") {
        writeFileSync(destination, projectJsonl(source, sourceName === "events.jsonl" ? EVENT_PROJECTION_FIELDS : NOTIFY_PROJECTION_FIELDS));
      } else {
        copyFileSync(source, destination);
      }
      written.push(destination);
    }
    const nodesSource = join(runDir, "nodes");
    if (!existsSync(nodesSource)) {
      skipped.push({ runId, source: "nodes" });
      if (!preserved.has(`${runId}.nodes.json`)) absent.add(`${runId}.nodes.json`);
      continue;
    }
    absent.delete(`${runId}.nodes.json`);
    preserved.add(`${runId}.nodes.json`);
    const nodesDestination = join(ledgerDir, `${runId}.nodes.json`);
    writeFileSync(nodesDestination, `${JSON.stringify(readMetricNodeSnapshots(runDir))}\n`);
    written.push(nodesDestination);
  }
  const proposalsSource = join(campaignPath, "proposals");
  if (existsSync(proposalsSource)) {
    const proposalsDestination = join(ledgerDir, "proposals");
    cpSync(proposalsSource, proposalsDestination, { recursive: true });
    written.push(...filesUnder(proposalsSource).map((path) => join(proposalsDestination, path)));
  }
  const manifest = join(ledgerDir, LEDGER_SOURCE_MANIFEST_FILE);
  writeFileSync(manifest, `${JSON.stringify({ schemaVersion: 1, absent: [...absent].sort(), preserved: [...preserved].sort() })}\n`);
  written.push(manifest);
  return { written, skipped };
}

/**
 * Complete an already closed ledger from the run files still in the operator
 * home. A destination is replaced only when the source strictly extends its
 * bytes; this keeps a ledger's evidence stable when a run was rewritten or
 * truncated after close. Missing run sources are reported as gone.
 *
 * @param {string} campaignPath
 * @param {string} repoRoot
 * @returns {LedgerReledger & {ledgerDir: string}}
 */
export function reledgerCampaignLedger(campaignPath, repoRoot) {
  const campaign = readCampaign(campaignPath);
  const runsDir = resolve(campaignPath, "..", "..");
  const ledgerDir = join(repoRoot, "docs", "campaigns", campaign.id, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  /** @type {LedgerChange[]} */
  const copied = [];
  /** @type {LedgerChange[]} */
  const gone = [];
  const sourceManifest = readSourceManifest(ledgerDir);
  const preserved = new Set(sourceManifest.preserved);
  const absent = new Set(sourceManifest.absent);
  for (const runId of campaign.linkedRunIds) {
    const runDir = join(runsDir, runId);
    for (const [sourceName, destinationSuffix] of RUN_SOURCES) {
      const source = join(runDir, sourceName);
      const change = { runId, source: sourceName };
      if (!existsSync(source)) {
        gone.push(change);
        continue;
      }
      const destination = join(ledgerDir, `${runId}.${destinationSuffix}`);
      const projected = sourceName === "events.jsonl" || sourceName === "notify.jsonl"
        ? projectJsonl(source, sourceName === "events.jsonl" ? EVENT_PROJECTION_FIELDS : NOTIFY_PROJECTION_FIELDS)
        : source;
      if (sourceName === "events.jsonl" || sourceName === "notify.jsonl") {
        if (writeIfStrictExtension(destination, projected)) copied.push(change);
      } else if (copyIfStrictExtension(projected, destination)) copied.push(change);
      if (existsSync(destination)) {
        preserved.add(`${runId}.${destinationSuffix}`);
        absent.delete(`${runId}.${destinationSuffix}`);
      }
    }
    const nodesSource = join(runDir, "nodes");
    const nodesChange = { runId, source: "nodes" };
    if (!existsSync(nodesSource)) {
      gone.push(nodesChange);
      continue;
    }
    const nodesDestination = join(ledgerDir, `${runId}.nodes.json`);
    const projection = `${JSON.stringify(readMetricNodeSnapshots(runDir))}\n`;
    if (writeIfStrictExtension(nodesDestination, projection)) copied.push(nodesChange);
    if (existsSync(nodesDestination)) {
      preserved.add(`${runId}.nodes.json`);
      absent.delete(`${runId}.nodes.json`);
    }
  }
  const proposalsSource = join(campaignPath, "proposals");
  if (existsSync(proposalsSource)) {
    for (const relative of filesUnder(proposalsSource)) {
      const source = join(proposalsSource, relative);
      const destination = join(ledgerDir, "proposals", relative);
      if (copyIfStrictExtension(source, destination)) copied.push({ runId: campaign.id, source: `proposals/${relative}` });
    }
  }
  const ledgerCampaign = join(ledgerDir, CAMPAIGN_FILE);
  if (existsSync(ledgerCampaign)) {
    const existing = readJsonObject(ledgerCampaign);
    if (existing?.id === campaign.id && existing.status !== "closed" && campaign.status === "closed") {
      writeFileSync(ledgerCampaign, readFileSync(join(campaignPath, CAMPAIGN_FILE)));
    }
  } else if (existsSync(join(campaignPath, CAMPAIGN_FILE))) {
    copyFileSync(join(campaignPath, CAMPAIGN_FILE), ledgerCampaign);
  }
  writeFileSync(join(ledgerDir, LEDGER_SOURCE_MANIFEST_FILE), `${JSON.stringify({ schemaVersion: 1, absent: [...absent].sort(), preserved: [...preserved].sort() })}\n`);
  return { ledgerDir, copied, gone };
}

/**
 * @param {string} source
 * @param {string} destination
 * @returns {boolean}
 */
function copyIfStrictExtension(source, destination) {
  const bytes = readFileSync(source);
  return writeIfStrictExtension(destination, bytes);
}

/**
 * @param {string} destination
 * @param {Buffer|string} source
 * @returns {boolean}
 */
function writeIfStrictExtension(destination, source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination)) {
    writeFileSync(destination, bytes);
    return true;
  }
  const existing = readFileSync(destination);
  if (bytes.length <= existing.length || !bytes.subarray(0, existing.length).equals(existing)) return false;
  writeFileSync(destination, bytes);
  return true;
}

/** @param {string} path @param {readonly string[]} fields @returns {string} */
function projectJsonl(path, fields) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  const projected = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    const value = JSON.parse(lines[index]);
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const record = {};
    for (const field of fields) if (Object.hasOwn(source, field)) record[field] = projectedField(source[field], field);
    projected.push(JSON.stringify(record));
  }
  return projected.length === 0 ? "" : `${projected.join("\n")}\n`;
}

/** @param {unknown} value @param {string} field @returns {unknown} */
function projectedField(value, field) {
  if (field !== "override" || value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const object = /** @type {Record<string, unknown>} */ (value);
  return Object.hasOwn(object, "kind") ? { kind: object.kind } : {};
}

/** @param {string} root @returns {{absent: string[], preserved: string[]}} */
function readSourceManifest(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, LEDGER_SOURCE_MANIFEST_FILE), "utf8"));
    return {
      absent: Array.isArray(value?.absent) ? /** @type {unknown[]} */ (value.absent).filter((entry) => typeof entry === "string") : [],
      preserved: Array.isArray(value?.preserved) ? /** @type {unknown[]} */ (value.preserved).filter((entry) => typeof entry === "string") : [],
    };
  } catch {
    // An old ledger has no origin manifest; its files remain subject to the legacy missing-source rules.
    return { absent: [], preserved: [] };
  }
}

/** @param {string} path @returns {Record<string, unknown>|null} */
function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
  } catch {
    // A malformed old ledger record cannot prove that it is already closed.
    return null;
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return filesUnder(join(root, entry.name)).map((path) => join(entry.name, path));
    return [entry.name];
  });
}
