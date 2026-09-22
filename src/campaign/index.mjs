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
import { projectIdForRunsDir, repositoryForRunsDir } from "../run/paths.mjs";
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
/** @typedef {{runId: string, node: string, passed: boolean|null, verdict: string|null}} RequirementNodeEvidence */
/** @typedef {{requirementId: string, status: "covered"|"open", nodes: RequirementNodeEvidence[]}} RequirementClosure */
/** @typedef {{id: string, goal: string, status: "active"|"closed", linkedRunIds: string[], contracts: CampaignContract[], landBranch: string, promotions: PromotionRecord[], attention?: CampaignAttention, requirements?: RequirementClosure[], createdAt: string, updatedAt: string, closedAt?: string}} Campaign */
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
  const journal = readJournalForDedupe(campaignPath);
  if (!journal.some((entry) => entry.type === "retrospective")) {
    throw new Error(`campaign ${campaign.id} has no recorded retrospective; record one with note --kind retrospective before close`);
  }
  const unacknowledged = unacknowledgedAdvisories(campaignPath, campaign, journal);
  if (unacknowledged.length) {
    throw new Error(`campaign ${campaign.id} has judge findings no note has answered: ${unacknowledged.join("; ")}. Read them with \`faberun findings <run-dir>\`, then name the node in a note (\`campaign note ${campaign.id} --kind outcome --run-id <run-id> --text "...<node>..."\`) before close`);
  }
  const repoRoot = campaignRepoRoot(campaignPath);
  const ledgerFiles = preserveCampaignLedger(campaignPath, repoRoot);
  // The closure travels on the record itself, computed in one deterministic
  // pass over the linked runs' own files before the close is written.
  const requirements = buildRequirementClosure(campaignPath, campaign);
  /** @type {Campaign} */
  const closed = { ...campaign, status: "closed", closedAt: at, updatedAt: at, requirements };
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), closed);
  appendJournal(campaignPath, { type: "campaign.closed", at, eventId });
  return { path: campaignPath, campaign: closed, ledgerFiles };
}

/**
 * Judge findings on nodes the gate accepted, which no journal note names.
 *
 * A gate that accepts a node whose findings sit below `failOn` is correct and
 * documented. What was wrong is that the campaign could then be closed with
 * the finding never read by anyone: measured 2026-09-21, a synthesis node's
 * `gate.verdict` was `fail` with a real finding, `STATUS` said `passed`, and
 * the campaign's own retrospective recorded that every gate passed first
 * time. A close is the last moment the claim can still be corrected.
 *
 * Acknowledgement is a note that names the node id. The node id is the
 * identifier the run, the contract and the findings output all already use,
 * so matching on it asks the operator for nothing new; matching on a
 * finding's prose would be matching on text the judge wrote, which is not a
 * stable name.
 *
 * @param {string} campaignPath
 * @param {Campaign} campaign
 * @param {{type: string, text?: unknown}[]} journal
 * @returns {string[]} one `runId/nodeId (N findings, maxSeverity)` per unanswered node, sorted
 */
function unacknowledgedAdvisories(campaignPath, campaign, journal) {
  const runsDir = resolve(campaignPath, "..", "..");
  const noteText = journal
    .filter((entry) => typeof entry.text === "string")
    .map((entry) => /** @type {string} */ (entry.text))
    .join("\n");
  /** @type {string[]} */
  const pending = [];
  for (const runId of [...campaign.linkedRunIds].sort()) {
    const contract = readRunJson(join(runsDir, runId, "contract.json"));
    const nodes = contract !== null && Array.isArray(contract.nodes) ? /** @type {JsonObject[]} */ (contract.nodes) : [];
    for (const node of nodes) {
      const nodeId = typeof node.id === "string" ? node.id : "";
      if (!nodeId) continue;
      const snapshot = readRunJson(join(runsDir, runId, "nodes", `${nodeId}.json`));
      if (snapshot === null) continue;
      // Only an accepted node: on a rejected one the findings are the
      // rejection itself, and the run already refuses to read as finished.
      if (snapshot.status !== "done" && snapshot.status !== "no-op") continue;
      const gate = /** @type {JsonObject|null|undefined} */ (snapshot.gate);
      const findings = gate && Array.isArray(gate.findings) ? gate.findings : [];
      if (findings.length === 0) continue;
      if (noteText.includes(nodeId)) continue;
      pending.push(`${runId}/${nodeId} (${findings.length} ${findings.length === 1 ? "finding" : "findings"}, ${typeof gate?.maxSeverity === "string" ? gate.maxSeverity : "unknown"})`);
    }
  }
  return pending.sort();
}

/**
 * The requirement closure a close records: one entry per requirement id the
 * linked runs' contracts declared, correlated only by the identifiers the runs
 * carried -- the contract node's declaration and the id the done node snapshot
 * itself carries, stamped there by the engine -- never by requirement text. A
 * requirement no done node carries is recorded as open rather than omitted.
 * Deterministic and free of external calls: runs are visited in sorted id
 * order, nodes in contract order, requirement ids sorted, and the only inputs
 * are files already on disk. A run that never launched (or was pruned)
 * contributes nothing.
 *
 * @param {string} campaignPath
 * @param {Campaign} campaign
 * @returns {RequirementClosure[]}
 */
function buildRequirementClosure(campaignPath, campaign) {
  const runsDir = resolve(campaignPath, "..", "..");
  /** @type {Map<string, RequirementNodeEvidence[]>} */
  const covered = new Map();
  /** @type {Set<string>} */
  const declared = new Set();
  for (const runId of [...campaign.linkedRunIds].sort()) {
    const contract = readRunJson(join(runsDir, runId, "contract.json"));
    const nodes = contract !== null && Array.isArray(contract.nodes) ? /** @type {JsonObject[]} */ (contract.nodes) : [];
    for (const node of nodes) {
      const nodeId = typeof node.id === "string" ? node.id : "";
      const requirementIds = Array.isArray(node.requirementIds) ? node.requirementIds : [];
      if (!nodeId || requirementIds.length === 0) continue;
      const snapshot = readRunJson(join(runsDir, runId, "nodes", `${nodeId}.json`));
      const done = snapshot !== null && snapshot.status === "done";
      const carried = snapshot !== null && Array.isArray(snapshot.requirementIds) ? /** @type {unknown[]} */ (snapshot.requirementIds) : [];
      const verification = snapshot !== null ? /** @type {JsonObject|null|undefined} */ (snapshot.verification) : undefined;
      const gate = snapshot !== null ? /** @type {JsonObject|null|undefined} */ (snapshot.gate) : undefined;
      const passed = verification && typeof verification.passed === "boolean" ? verification.passed : null;
      const verdict = gate && typeof gate.verdict === "string" ? gate.verdict : null;
      for (const requirementId of requirementIds) {
        if (typeof requirementId !== "string") continue;
        declared.add(requirementId);
        if (!done || !carried.includes(requirementId)) continue;
        const evidence = covered.get(requirementId) ?? [];
        evidence.push({ runId, node: nodeId, passed, verdict });
        covered.set(requirementId, evidence);
      }
    }
  }
  return [...declared].sort().map((requirementId) => {
    const nodes = covered.get(requirementId) ?? [];
    return { requirementId, status: nodes.length > 0 ? "covered" : "open", nodes };
  });
}

/**
 * @param {string} path
 * @returns {JsonObject|null} null when the file is absent or not JSON: a run
 * that never launched contributes nothing to the closure rather than failing
 * the close, the same discipline `preserveCampaignLedger` applies to a run
 * without a usage ledger.
 */
function readRunJson(path) {
  try {
    return /** @type {JsonObject} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The repository a campaign's ledger is preserved into. Under the home layout
 * the campaign path carries the project id at the resolver's fixed position,
 * so the repository is looked up live in the registry rather than derived by
 * climbing: a project reassociated after the campaign was created preserves
 * at its current repository, which a path cached anywhere would not. A
 * campaign under a legacy `<repo>/.runs` keeps the old three-directory climb,
 * which is exact there because the campaign path ends `<repo>/.runs/campaigns/<id>`.
 *
 * @param {string} campaignPath
 * @returns {string}
 */
function campaignRepoRoot(campaignPath) {
  const runsDir = resolve(campaignPath, "..", "..");
  const repository = repositoryForRunsDir(runsDir);
  if (repository) return repository;
  if (projectIdForRunsDir(runsDir)) {
    throw new Error(`no project record for ${campaignPath}; the registry cannot name the repository its ledger belongs to`);
  }
  return resolve(campaignPath, "..", "..", "..");
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
 * Append a contract to an active campaign's manifest, digesting its authored
 * bytes exactly as `campaign init --contract` does. This is what an operator
 * used to do by hand-editing `campaign.json` and recomputing
 * `authoredContractDigest` themselves -- a step that parks the campaign for
 * good on a typo, since `assertContractManifestIntact` refuses a digest that
 * does not match at launch.
 *
 * Idempotent by path and bytes: adding the same contract path a second time,
 * with the file unchanged since, finds its digest already recorded and
 * returns the campaign untouched. A second call after the file changed
 * updates the recorded digest in place rather than duplicating the entry.
 *
 * @param {string} campaignPath
 * @param {string} contractPath
 * @param {{at?: string}} [options]
 * @returns {{campaign: Campaign, added: boolean}}
 */
export function addContractToCampaign(campaignPath, contractPath, { at = new Date().toISOString() } = {}) {
  requireTimestamp(at, "at");
  requireString(contractPath, "contractPath");
  if (!existsSync(contractPath)) throw new Error(`contract not found: ${contractPath}`);
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  const digest = authoredContractDigest(contractPath);
  const existingIndex = campaign.contracts.findIndex((entry) => entry.path === contractPath);
  if (existingIndex !== -1 && campaign.contracts[existingIndex].digest === digest) {
    return { campaign, added: false };
  }
  const entry = { path: contractPath, digest };
  const contracts = existingIndex === -1
    ? [...campaign.contracts, entry]
    : campaign.contracts.map((existing, index) => (index === existingIndex ? entry : existing));
  const updated = /** @type {Campaign} */ ({ ...campaign, contracts, updatedAt: at });
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), updated);
  return { campaign: updated, added: true };
}

/**
 * Replace a manifest entry -- matched by its current, recorded path -- with a
 * freshly authored contract. Re-authoring a phase after a blocked or failed
 * node is the normal case in this repository, not the exception, so this is
 * the command form of the hand edit an operator otherwise repeats every time.
 *
 * When the campaign's `attention` names the contract being replaced (its
 * `contractPath` matches `oldPath`), the attention is cleared in the same
 * write, so a stale park cannot go on refusing `campaign supervise` once the
 * contract it named is gone. This does not go through `unparkCampaign`
 * (`./unpark.mjs`, which owns the `campaign.unparked` journal event): that
 * module already imports `chain.mjs`, which imports this one, and importing
 * it back here would close that cycle.
 *
 * @param {string} campaignPath
 * @param {string} oldPath
 * @param {string} newPath
 * @param {{at?: string}} [options]
 * @returns {{campaign: Campaign, replaced: CampaignContract, clearedAttention: CampaignAttention|null}}
 */
export function replaceContractInCampaign(campaignPath, oldPath, newPath, { at = new Date().toISOString() } = {}) {
  requireTimestamp(at, "at");
  requireString(oldPath, "oldPath");
  requireString(newPath, "newPath");
  if (!existsSync(newPath)) throw new Error(`contract not found: ${newPath}`);
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  const index = campaign.contracts.findIndex((entry) => entry.path === oldPath);
  if (index === -1) throw new Error(`no contract at ${oldPath} in campaign ${campaign.id}`);
  const replaced = { path: newPath, digest: authoredContractDigest(newPath) };
  const contracts = campaign.contracts.map((entry, position) => (position === index ? replaced : entry));
  const attention = campaign.attention;
  const clearAttention = attention !== undefined && attention.contractPath === oldPath;
  /** @type {Campaign} */
  const updated = { ...campaign, contracts, updatedAt: at };
  if (clearAttention) delete updated.attention;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), updated);
  return { campaign: updated, replaced, clearedAttention: clearAttention ? /** @type {CampaignAttention} */ (attention) : null };
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

