import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../run/store.mjs";
import { requireId, requirePacketHash, requireString, requireTimestamp } from "../contract/assert.mjs";
import { promoteRun } from "../repo/integrate.mjs";
import { CAMPAIGN_FILE, GOAL_TEXT_BYTES, JOURNAL_FILE, PROJECTION_FILE, campaignDir, campaignsDir } from "./layout.mjs";
import { readCampaign } from "./record.mjs";
import { appendJournal, normalizeText, readJournalForDedupe } from "./journal.mjs";
import { readProjectionState } from "./projection.mjs";
import { handoffFromState, materializeHandoff } from "./handoff.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{path: string, digest: string}} CampaignContract */
/** @typedef {{runId: string, contractPath?: string, branch: string, sha: string, previousSha: string|null, at: string}} PromotionRecord */
/** @typedef {{code: string, message: string, at: string, contractPath?: string, contractId?: string, runId?: string, node?: string|null, status?: string|null, resume?: string}} CampaignAttention */
/** @typedef {{id: string, goal: string, status: "active"|"closed", linkedRunIds: string[], contracts: CampaignContract[], landBranch: string, promotions: PromotionRecord[], attention?: CampaignAttention, createdAt: string, updatedAt: string, closedAt?: string}} Campaign */
/** @typedef {{type: string, eventId: string, at: string, sessionId?: string, text?: string, tool?: string, transcript?: string|null, transcriptUnavailable?: boolean, format?: string|null, cursor?: string|null, decisionId?: string, supersedes?: string, runId?: string, questionId?: string, campaignId?: string, nodeId?: string|null, phase?: string, checkpointsDone?: number, checkpointsTotal?: number, runtime?: string|null, state?: string, lastProgressAt?: string, attention?: string|null}} JournalEntry */
/** @typedef {{updatedAt: string|null, decisions: Record<string, JournalEntry>, questions: Record<string, JournalEntry>, constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], sessions: JournalEntry[], next: JournalEntry|null, evicted: Record<string, number>}} Projection */
/** @typedef {{cursor: number, byte: number, size: number, projection: Projection}} ProjectionRecord */
/** @typedef {{id: string, exists: boolean, total: number, summary: string, attention: {id: string, status: string, note: string}[], unreadable: string|null}} RunSummary */
/** @typedef {{campaign: Campaign, updatedAt: string, linkedRuns: RunSummary[], activeDecisions: JournalEntry[], constraints: JournalEntry[], intents: JournalEntry[], outcomes: JournalEntry[], nextEntry: JournalEntry|null, questions: JournalEntry[], sessions: JournalEntry[], totals: {decisions: number, constraints: number, intents: number, outcomes: number, questions: number, sessions: number}, evicted: Record<string, number>}} Handoff */

/**
 * @param {string} runsDir
 * @param {{campaignId: string, goal: unknown, at?: string, contracts?: CampaignContract[], landBranch?: string}} options
 * @returns {{path: string, campaign: Campaign}}
 */
export function initializeCampaign(runsDir, { campaignId, goal, at = new Date().toISOString(), contracts = [], landBranch = undefined }) {
  requireId(campaignId, "campaignId");
  requireTimestamp(at, "at");
  const path = campaignDir(runsDir, campaignId);
  if (existsSync(path)) throw new Error(`campaign already exists: ${path}`);
  mkdirSync(path, { recursive: true });
  const validatedContracts = contracts.map((entry, index) => {
    requireString(entry.path, `contracts[${index}].path`);
    requirePacketHash(entry.digest, `contracts[${index}].digest`);
    return { path: entry.path, digest: entry.digest };
  });
  const branch = landBranch ?? `campaign/${campaignId}`;
  requireString(branch, "landBranch");
  /** @type {Campaign} */
  const campaign = {
    id: campaignId,
    goal: normalizeText(goal, "goal", GOAL_TEXT_BYTES),
    status: "active",
    linkedRunIds: [],
    contracts: validatedContracts,
    landBranch: branch,
    promotions: [],
    createdAt: at,
    updatedAt: at,
  };
  writeJsonAtomic(join(path, CAMPAIGN_FILE), campaign);
  appendJournal(path, { type: "campaign.initialized", at, eventId: randomUUID() });
  return { path, campaign };
}

/**
 * @param {string} runsDir
 * @returns {{campaigns: {path: string, campaign: Campaign}[], corrupt: {id: string, path: string, error: Error}[]}}
 */
export function discoverCampaigns(runsDir) {
  const root = campaignsDir(runsDir);
  if (!existsSync(root)) return { campaigns: [], corrupt: [] };
  /** @type {{path: string, campaign: Campaign}[]} */
  const campaigns = [];
  /** @type {{id: string, path: string, error: Error}[]} */
  const corrupt = [];
  for (const name of readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const path = join(root, name);
    if (!existsSync(join(path, CAMPAIGN_FILE))) {
      corrupt.push({ id: name, path, error: new Error(`campaign.json missing in ${path}`) });
      continue;
    }
    try {
      campaigns.push({ path, campaign: readCampaign(path) });
    } catch (error) {
      corrupt.push({ id: name, path, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { campaigns, corrupt };
}

/**
 * @param {string} runsDir
 * @param {string|null|undefined} [campaignId]
 * @returns {{path: string, campaign: Campaign}}
 */
export function resolveCampaign(runsDir, campaignId) {
  if (campaignId !== undefined && campaignId !== null) {
    requireId(campaignId, "campaignId");
    const path = campaignDir(runsDir, campaignId);
    return { path, campaign: readCampaign(path) };
  }
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  if (corrupt.length) {
    throw new Error(`corrupt campaign entries: ${corrupt.map((entry) => entry.id).join(", ")}`);
  }
  const active = campaigns.filter((entry) => entry.campaign.status === "active");
  if (!active.length) {
    if (campaigns.length) {
      throw new Error(`no active campaign under ${campaignsDir(runsDir)}; all campaigns are closed`);
    }
    throw new Error(`no campaign found under ${campaignsDir(runsDir)}; initialize one with: faberun campaign init`);
  }
  if (active.length > 1) {
    const ids = active.map((entry) => entry.campaign.id).join(", ");
    throw new Error(`multiple campaigns found (${ids}); choose one by id`);
  }
  return active[0];
}

/**
 * @param {string} campaignPath
 * @param {{at?: string, eventId?: string}} options
 * @returns {{path: string, campaign: Campaign, ledgerFiles: string[]}}
 */
export function closeCampaign(campaignPath, { at = new Date().toISOString(), eventId = randomUUID() } = {}) {
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign already closed: ${campaign.id}`);
  if (!readJournalForDedupe(campaignPath).some((entry) => entry.type === "retrospective")) {
    throw new Error(`campaign ${campaign.id} has no recorded retrospective; record one with note --kind retrospective before close`);
  }
  const repoRoot = resolve(campaignPath, "..", "..", "..");
  const ledgerFiles = preserveCampaignLedger(campaignPath, repoRoot);
  const closed = /** @type {Campaign} */ ({ ...campaign, status: "closed", closedAt: at, updatedAt: at });
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), closed);
  appendJournal(campaignPath, { type: "campaign.closed", at, eventId });
  return { path: campaignPath, campaign: closed, ledgerFiles };
}

/**
 * Copy a campaign's journal, record and each linked run's usage into
 * `<repoRoot>/docs/campaigns/<id>/ledger/` so the comparative arm of the
 * planner has a session-side baseline even after `.runs/` (gitignored) is
 * pruned. Nothing in this tree redacts token counts, costs or operator notes
 * before this point, so the copy is verbatim; the pre-commit secret scan is
 * the guard against anything that should not land in git.
 *
 * Idempotent: re-running it (a second `close` on an already-closed campaign
 * cannot reach this, but a direct call can) overwrites the same destination
 * files rather than duplicating them. A linked run without a `usage.jsonl`
 * (never launched, or pruned) is skipped rather than thrown.
 *
 * @param {string} campaignPath
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function preserveCampaignLedger(campaignPath, repoRoot) {
  const campaign = readCampaign(campaignPath);
  const runsDir = resolve(campaignPath, "..", "..");
  const ledgerDir = join(repoRoot, "docs", "campaigns", campaign.id, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  const written = [];
  for (const name of [JOURNAL_FILE, CAMPAIGN_FILE]) {
    const source = join(campaignPath, name);
    if (!existsSync(source)) continue;
    const destination = join(ledgerDir, name);
    copyFileSync(source, destination);
    written.push(destination);
  }
  for (const runId of campaign.linkedRunIds) {
    const source = join(runsDir, runId, "usage.jsonl");
    if (!existsSync(source)) continue;
    const destination = join(ledgerDir, `${runId}.usage.jsonl`);
    copyFileSync(source, destination);
    written.push(destination);
  }
  return written;
}

/**
 * @param {string} campaignPath
 * @param {string} runId
 * @param {string} at
 * @returns {Campaign}
 */
export function registerRun(campaignPath, runId, at = new Date().toISOString()) {
  requireId(runId, "runId");
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  if (campaign.linkedRunIds.includes(runId)) {
    campaign.updatedAt = at;
    writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
    return campaign;
  }
  campaign.linkedRunIds.push(runId);
  campaign.updatedAt = at;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
  appendJournal(campaignPath, { type: "run.registered", at, eventId: randomUUID(), runId });
  return campaign;
}

/**
 * The digest of a contract's authored bytes: the raw file, before validation
 * canonicalizes or resolves anything. This is what a manifest entry records,
 * so tampering between authoring and launch is detectable without validating
 * the contract early (validation is deferred because a readFile may name a
 * file a predecessor has not created yet).
 *
 * @param {string} contractPath
 * @returns {string}
 */
export function authoredContractDigest(contractPath) {
  return createHash("sha256").update(readFileSync(contractPath)).digest("hex");
}

/**
 * Refuse a manifest entry whose file no longer matches the bytes it recorded.
 * The chain calls this at launch, before it validates N+1 against the landing
 * branch.
 *
 * @param {CampaignContract} entry
 * @returns {void}
 */
export function assertContractManifestIntact(entry) {
  requireString(entry.path, "contract path");
  requirePacketHash(entry.digest, "contract digest");
  const actual = authoredContractDigest(entry.path);
  if (actual !== entry.digest) {
    throw Object.assign(
      new Error(`contract ${entry.path} changed after it was authored; refusing to launch bytes the manifest did not record`),
      { code: "contract_authored_bytes_changed" },
    );
  }
}

/**
 * Persist one promotion in the campaign record. Idempotent by run id and the
 * sha it landed: a re-invocation after a crash between the branch move and
 * this write repairs the record without adding a second promotion.
 *
 * @param {string} campaignPath
 * @param {PromotionRecord} entry
 * @returns {PromotionRecord}
 */
export function recordPromotion(campaignPath, entry) {
  requireId(entry.runId, "promotion.runId");
  requireString(entry.branch, "promotion.branch");
  requireString(entry.sha, "promotion.sha");
  requireTimestamp(entry.at, "promotion.at");
  const campaign = readCampaign(campaignPath);
  const existing = campaign.promotions.find((record) => record.runId === entry.runId && record.sha === entry.sha);
  if (existing) return existing;
  campaign.promotions.push(entry);
  campaign.updatedAt = entry.at;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), campaign);
  return entry;
}

/**
 * Record a durable attention entry on the campaign and keep it active. The
 * chain parks here when a contract's run did not succeed, when a contract no
 * longer validates, or when two digests disagree; the message names the
 * contract, the node and the status whenever they exist.
 *
 * @param {string} campaignPath
 * @param {CampaignAttention} attention
 * @returns {Campaign}
 */
export function parkCampaign(campaignPath, attention) {
  requireString(attention.code, "campaign.attention.code");
  requireString(attention.message, "campaign.attention.message");
  requireTimestamp(attention.at, "campaign.attention.at");
  const campaign = readCampaign(campaignPath);
  const parked = /** @type {Campaign} */ ({ ...campaign, attention, updatedAt: attention.at });
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), parked);
  return parked;
}

/**
 * A promotion record is only worth keeping when it actually moved the land
 * branch. `promoteRun`'s `already_promoted` result reports the branch's
 * *current* head, which may have advanced past this run since it last landed
 * (another run promoted in between, or a coordinator restart is replaying the
 * same call); recording it would add a second entry for a run that never
 * moved anything.
 *
 * @param {import("../repo/integrate.mjs").PromoteRecord} record
 * @returns {boolean}
 */
export function promotionMovedBranch(record) {
  return record.status === "promoted";
}

/**
 * Promote a run onto the campaign's landing branch and record it. The branch
 * name comes from the campaign record, never from the caller, so a campaign
 * cannot be promoted somewhere its manifest does not name.
 *
 * @param {{campaignPath: string, repo: string, runId: string, runHead?: string|null, baseSha?: string|null, finalVerificationPassed: boolean, allowMain?: boolean, contractPath?: string}} args
 * @returns {import("../repo/integrate.mjs").PromoteRecord}
 */
export function promoteRunInCampaign({ campaignPath, repo, runId, runHead, baseSha, finalVerificationPassed, allowMain = false, contractPath }) {
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  return promoteRun({
    repo,
    runId,
    landBranch: campaign.landBranch,
    runHead,
    baseSha,
    finalVerificationPassed,
    allowMain,
    onPromoted: (record) => {
      if (!promotionMovedBranch(record)) return;
      recordPromotion(campaignPath, {
        runId: record.runId,
        ...(contractPath === undefined ? {} : { contractPath }),
        branch: record.branch,
        sha: record.sha,
        previousSha: record.previousSha,
        at: record.at,
      });
    },
  });
}

/**
 * @param {string} campaignPath
 * @param {string} runsDir
 * @returns {string}
 */
export function renderHandoff(campaignPath, runsDir) {
  const campaign = readCampaign(campaignPath);
  const { state, cursor, byte, size, changed } = readProjectionState(campaignPath, campaign);
  const handoff = handoffFromState(campaign, state, runsDir);
  const text = materializeHandoff(campaignPath, handoff);
  if (changed) writeJsonAtomic(join(campaignPath, PROJECTION_FILE), { cursor, byte, size, projection: state });
  return text;
}

/**
 * @param {string} runDir
 * @returns {string|null}
 */
export function renderRunHandoff(runDir) {
  const contractPath = join(runDir, "contract.json");
  if (!existsSync(contractPath)) return null;
  const contract = /** @type {JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8")));
  if (!contract.campaignId) return null;
  const runsDir = resolve(runDir, "..");
  const path = campaignDir(runsDir, /** @type {string} */ (contract.campaignId));
  if (!existsSync(join(path, CAMPAIGN_FILE))) return null;
  return renderHandoff(path, runsDir);
}

