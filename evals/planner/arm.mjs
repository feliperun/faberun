import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { round4 } from "../../src/campaign/metrics-evals.mjs";
import { parseSpec } from "../../src/plan/spec.mjs";

/**
 * The comparative arm: the same `{value, direction, count}` indicator shape
 * `evals/metrics.mjs` projects from one run's own `events.jsonl`/`usage.jsonl`,
 * projected instead from two disjoint, already-closed sources -- the
 * preserved campaign records under each campaign's `docs/campaigns/<id>/ledger`
 * directory (the "session"
 * side: real work a human-directed session already closed) and operator-saved
 * reports under `evals/planner/reports/*.json` (the "planner" side: what
 * `faberun plan` produced against the same spec). Separate from
 * `evals/metrics.mjs` because that module projects from one live run's own
 * artefacts and this one only ever reads records that already exist; no live
 * planner run and no edit to any record happens here.
 *
 * `null` means unmeasured; `0` means measured zero. Every derivation below
 * that cannot be backed by a real record on the side it is asked about
 * returns `null` for that one campaign/report rather than guessing, and the
 * cross-campaign aggregate (`meanIndicator`) treats those `null`s as absent
 * observations, not as zeros pulling the mean down.
 */

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} ArmDirection */
/** @typedef {{value: number|null, direction: ArmDirection, count: number}} ArmIndicator */
/** @typedef {{schemaVersion: 1, side: "session"|"planner", provenance: JsonObject, campaigns: JsonObject[], indicators: Record<string, ArmIndicator>}} ArmReport */

const CAMPAIGNS_DIR = "docs/campaigns";
export const PLANNER_REPORTS_DIR = "evals/planner/reports";

/**
 * The indicator set both arms compute, and the direction that counts as
 * improvement for each -- fixed across both sides so `evals/run.mjs
 * --compare` (which only needs the same key set on both reports) works on
 * `session-arm.json` and `planner-arm.json` unmodified.
 */
export const ARM_INDICATOR_DIRECTIONS = {
  costPerClosedCheckpoint: "down",
  planningCost: "down",
  firstPassGateRate: "up",
  blockedContextRate: "down",
  nodesPerClosedCheckpoint: "informative",
  criticalFindingsPerPlan: "down",
};

/**
 * @param {string} path
 * @returns {JsonObject|null}
 */
function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return /** @type {JsonObject} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Records of one JSONL artefact. An unterminated final line was never a
 * committed record, and a corrupt line is skipped rather than thrown on --
 * this reads records this campaign never wrote, so a hand-edited or
 * truncated ledger file must not crash the arm, only under-count.
 *
 * @param {string} path
 * @returns {JsonObject[]}
 */
function readJsonlRecords(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {JsonObject[]} */
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    try {
      records.push(/** @type {JsonObject} */ (JSON.parse(lines[index])));
    } catch {
      // A hand-edited or truncated record is skipped, never thrown on.
    }
  }
  return records;
}

/**
 * Every campaign id directly under `docs/campaigns/` (a repo-relative walk
 * scoped by `repoRoot`, never the real repository's own root directly, so a
 * test can point this at a fixture tree). Mirrors what
 * `test/plan/existing-specs.test.mjs`'s own `specMarkdownFiles` walks, kept
 * separate rather than imported from there: that file is a test module, and
 * importing it here would register (and immediately run, outside `node
 * --test`) its own `test()` calls as a side effect of every ordinary
 * `evals/run.mjs` invocation.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function campaignIds(repoRoot) {
  const dir = join(repoRoot, CAMPAIGNS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Campaign ids that qualify for the comparative arm: a structured
 * `REQUIREMENTS.md` under `docs/campaigns/<id>/spec/` and a preserved
 * `ledger/campaign.json` alongside it. `specPaths`, repo-relative
 * `docs/campaigns/<id>/spec/REQUIREMENTS.md` paths, defaults to a walk of
 * `repoRoot` itself but is overridable so a test can supply a fixture's own
 * list directly.
 *
 * @param {{repoRoot: string, specPaths?: string[]}} options
 * @returns {string[]}
 */
export function qualifyingSessionCampaigns({ repoRoot, specPaths }) {
  const ids = (specPaths
    ? specPaths.map((path) => /^docs[/\\]campaigns[/\\]([^/\\]+)[/\\]spec[/\\]REQUIREMENTS\.md$/u.exec(path)?.[1] ?? null).filter((id) => id !== null)
    : campaignIds(repoRoot).filter((id) => existsSync(join(repoRoot, CAMPAIGNS_DIR, id, "spec", "REQUIREMENTS.md")))
  ).filter((id) => existsSync(join(repoRoot, CAMPAIGNS_DIR, /** @type {string} */ (id), "ledger", "campaign.json")));
  return [...new Set(/** @type {string[]} */ (ids))].sort();
}

/**
 * The repo-relative file path a requirement's proof names, or null when the
 * proof carries no file: a `judgment` proof names nothing, and a `command`
 * proof whose last whitespace-separated token is not a dot-extensioned path
 * (a bare `--test-name-pattern="..."` invocation with no trailing test file)
 * names nothing either. This is a coarse lexical read of the proof string,
 * not a shell parse -- good enough to tell "this requirement's proof points
 * at a real file" from "it does not", never used for anything sharper.
 *
 * @param {{kind: string, ref?: string}|null} proof
 * @returns {string|null}
 */
function proofFilePath(proof) {
  if (!proof) return null;
  if (proof.kind === "path") return proof.ref ?? null;
  if (proof.kind === "command" && typeof proof.ref === "string") {
    const last = proof.ref.trim().split(/\s+/u).at(-1);
    return last && !last.startsWith("-") && /\.[a-zA-Z0-9]+$/u.test(last) ? last : null;
  }
  return null;
}

/**
 * How many of a REQUIREMENTS.md's requirements carry a proof that names a
 * file that actually exists on disk -- the session side's stand-in for "a
 * closed checkpoint", since the ledger keeps no per-node terminal-status
 * record, only the requirements a campaign's own spec declared done.
 *
 * @param {string} repoRoot
 * @param {string} requirementsPath
 * @returns {number}
 */
function provenRequirementCount(repoRoot, requirementsPath) {
  const text = readFileSync(requirementsPath, "utf8");
  const { requirements } = parseSpec(text);
  return requirements.filter((requirement) => {
    const path = proofFilePath(requirement.proof);
    return path !== null && existsSync(resolve(repoRoot, path));
  }).length;
}

/**
 * Total cost across every `*.usage.jsonl` file directly under a ledger
 * directory, excluding `costProvenance: "unknown"` records exactly as
 * `evals/metrics.mjs`'s own `evalUsageCostOf` does -- null when the ledger
 * has no costed record at all, never a measured zero standing in for "there
 * is nothing to divide by".
 *
 * @param {string} ledgerDir
 * @returns {number|null}
 */
function ledgerUsageCost(ledgerDir) {
  if (!existsSync(ledgerDir)) return null;
  const files = readdirSync(ledgerDir).filter((name) => name.endsWith(".usage.jsonl"));
  let total = 0;
  let count = 0;
  for (const file of files) {
    for (const record of readJsonlRecords(join(ledgerDir, file))) {
      if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== "unknown") {
        total += record.costUsd;
        count += 1;
      }
    }
  }
  return count === 0 ? null : total;
}

/** An outcome note reporting a checkpoint's own first-round success. */
const FIRST_ATTEMPT_PATTERN = /\bfirst attempt\b/iu;
/** An outcome note that names an attempt count at all -- the denominator `FIRST_ATTEMPT_PATTERN` is a rate over. */
const ANY_ATTEMPT_PATTERN = /\bfirst attempt\b|\battempt\s*\d+\b/iu;
/** A decision or outcome note reporting a block, e.g. a `blocked_context` worker result or a scope block. */
const BLOCKED_PATTERN = /\bblocked\b/iu;

/**
 * `firstPassGateRate` and `blockedContextRate` mined from a campaign
 * journal's own free-text `outcome`/`decision` notes -- the only place a
 * preserved ledger records either fact, since the ledger keeps no
 * `events.jsonl` with per-node terminal-status transitions. A coarse text
 * proxy, declared as such: a campaign whose notes never mention an attempt
 * count, or carry no outcome/decision notes at all, reports null for the
 * indicator that needed them rather than a rate over zero notes.
 *
 * @param {JsonObject[]} journalEntries
 * @returns {{firstPassGateRate: number|null, blockedContextRate: number|null}}
 */
function journalGateSignals(journalEntries) {
  const outcomes = journalEntries.filter((entry) => entry.type === "outcome" && typeof entry.text === "string");
  const attemptMentions = outcomes.filter((entry) => ANY_ATTEMPT_PATTERN.test(/** @type {string} */ (entry.text)));
  const firstPass = attemptMentions.filter((entry) => FIRST_ATTEMPT_PATTERN.test(/** @type {string} */ (entry.text)));
  const decisionsAndOutcomes = journalEntries.filter((entry) => (entry.type === "outcome" || entry.type === "decision") && typeof entry.text === "string");
  const blocked = decisionsAndOutcomes.filter((entry) => BLOCKED_PATTERN.test(/** @type {string} */ (entry.text)));
  return {
    firstPassGateRate: attemptMentions.length === 0 ? null : firstPass.length / attemptMentions.length,
    blockedContextRate: decisionsAndOutcomes.length === 0 ? null : blocked.length / decisionsAndOutcomes.length,
  };
}

/**
 * Total node count across every `*.contract.json` a campaign's `control/`
 * directory preserved -- null when the campaign kept no `control/` directory
 * at all (several of the older campaigns predate that convention) or it
 * holds no contract.
 *
 * @param {string} campaignPath
 * @returns {number|null}
 */
function controlNodeCount(campaignPath) {
  const controlDir = join(campaignPath, "control");
  if (!existsSync(controlDir)) return null;
  const files = readdirSync(controlDir).filter((name) => name.endsWith(".contract.json"));
  if (files.length === 0) return null;
  let total = 0;
  for (const file of files) {
    const contract = readJsonIfExists(join(controlDir, file));
    if (contract && Array.isArray(contract.nodes)) total += contract.nodes.length;
  }
  return total;
}

/**
 * How many distinct runs a campaign record's own `promotions` list landed --
 * a "closed checkpoint" at the campaign-ledger granularity, since a
 * promotion is the one preserved record of a phase's work actually landing.
 * Deduplicated by `runId` because a promotion that moved nothing (the same
 * run promoted twice, `sha === previousSha`) is the ledger's own record of a
 * retry, not a second closed checkpoint.
 *
 * @param {JsonObject|null} campaignRecord
 * @returns {number|null}
 */
function closedCheckpointCount(campaignRecord) {
  const promotions = Array.isArray(campaignRecord?.promotions) ? /** @type {JsonObject[]} */ (campaignRecord.promotions) : [];
  if (promotions.length === 0) return null;
  const runIds = new Set(promotions.map((promotion) => promotion.runId).filter((id) => typeof id === "string"));
  return runIds.size === 0 ? null : runIds.size;
}

/**
 * One qualifying campaign's session-side indicator values, each a plain
 * number or null. Wrapping into `{value, direction, count}` happens once,
 * across every campaign, in `sessionArm`.
 *
 * @param {string} repoRoot
 * @param {string} campaignId
 * @returns {Record<string, number|null>}
 */
export function sessionArmForCampaign(repoRoot, campaignId) {
  const campaignPath = join(repoRoot, CAMPAIGNS_DIR, campaignId);
  const requirementsPath = join(campaignPath, "spec", "REQUIREMENTS.md");
  const ledgerDir = join(campaignPath, "ledger");
  const proven = provenRequirementCount(repoRoot, requirementsPath);
  const cost = ledgerUsageCost(ledgerDir);
  const gate = journalGateSignals(readJsonlRecords(join(ledgerDir, "journal.jsonl")));
  const nodes = controlNodeCount(campaignPath);
  const checkpoints = closedCheckpointCount(readJsonIfExists(join(ledgerDir, "campaign.json")));
  return {
    costPerClosedCheckpoint: cost === null || proven === 0 ? null : cost / proven,
    // The session side never ran a separate planning phase to cost: a
    // session's own worker/judge spend already includes whatever planning it
    // did in-line, with no record splitting the two apart.
    planningCost: null,
    firstPassGateRate: gate.firstPassGateRate,
    blockedContextRate: gate.blockedContextRate,
    nodesPerClosedCheckpoint: nodes === null || checkpoints === null || checkpoints === 0 ? null : nodes / checkpoints,
    // The session side ran no plan review step at all -- there is no
    // "findings per plan" record to read on this side, ever.
    criticalFindingsPerPlan: null,
  };
}

/**
 * @param {ArmDirection} direction
 * @param {(number|null)[]} values
 * @returns {ArmIndicator}
 */
function meanIndicator(direction, values) {
  const numeric = /** @type {number[]} */ (values.filter((value) => typeof value === "number" && Number.isFinite(value)));
  return {
    value: numeric.length === 0 ? null : round4(numeric.reduce((sum, value) => sum + value, 0) / numeric.length),
    direction,
    count: numeric.length,
  };
}

/**
 * @param {Record<string, unknown>[]} perEntry
 * @returns {Record<string, ArmIndicator>}
 */
function aggregateIndicators(perEntry) {
  /** @type {Record<string, ArmIndicator>} */
  const indicators = {};
  for (const [name, direction] of Object.entries(ARM_INDICATOR_DIRECTIONS)) {
    indicators[name] = meanIndicator(/** @type {ArmDirection} */ (direction), perEntry.map((entry) => /** @type {number|null} */ (entry[name])));
  }
  return indicators;
}

/**
 * The session arm: every qualifying campaign's own indicator values, and
 * their cross-campaign mean under `indicators` (the shape `evals/run.mjs
 * --compare` already consumes via its `indicators` unwrap).
 *
 * @param {{repoRoot: string, specPaths?: string[]}} options
 * @returns {ArmReport}
 */
export function sessionArm({ repoRoot, specPaths }) {
  const qualifying = qualifyingSessionCampaigns({ repoRoot, specPaths });
  const perCampaign = qualifying.map((campaignId) => ({ campaignId, ...sessionArmForCampaign(repoRoot, campaignId) }));
  return {
    schemaVersion: 1,
    side: "session",
    provenance: { generatedAt: new Date().toISOString(), campaigns: qualifying },
    campaigns: perCampaign,
    indicators: aggregateIndicators(perCampaign),
  };
}

/**
 * The `evals/planner/reports/*.json` file names present, sorted -- each one
 * an operator-saved report of running `faberun plan` against one campaign's
 * `REQUIREMENTS.md` (see `evals/README.md`'s "Comparative arm" section for
 * the shape and how it is produced; that is an operator action, never
 * something this module runs).
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function plannerReportFiles(repoRoot) {
  const dir = join(repoRoot, PLANNER_REPORTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

/**
 * One planner report's indicator values, mirroring `sessionArmForCampaign`'s
 * shape. The report's own `plan.nodeCount` stands in for the session side's
 * "proven requirement" count -- both name the unit of work a checkpoint (a
 * closed requirement, a planned node) divides cost by -- and `plan.roundsUsed
 * === 1` is this side's "first attempt" fact, recorded directly rather than
 * mined from prose because a planner report has no free-text journal.
 *
 * @param {JsonObject} report
 * @returns {Record<string, number|null>}
 */
function plannerArmForReport(report) {
  const usage = Array.isArray(report.usage) ? /** @type {JsonObject[]} */ (report.usage) : [];
  let cost = 0;
  let costCount = 0;
  for (const record of usage) {
    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== "unknown") {
      cost += record.costUsd;
      costCount += 1;
    }
  }
  const plan = report.plan && typeof report.plan === "object" ? /** @type {JsonObject} */ (report.plan) : {};
  const nodeCount = typeof plan.nodeCount === "number" && Number.isFinite(plan.nodeCount) ? plan.nodeCount : null;
  const criticalFindings = typeof plan.criticalFindings === "number" && Number.isFinite(plan.criticalFindings) ? plan.criticalFindings : null;
  const roundsUsed = typeof plan.roundsUsed === "number" && Number.isFinite(plan.roundsUsed) ? plan.roundsUsed : null;
  const blockedAttempts = typeof plan.blockedAttempts === "number" && Number.isFinite(plan.blockedAttempts) ? plan.blockedAttempts : null;
  const workerAttempts = usage.filter((record) => record.role === "worker").length;
  return {
    costPerClosedCheckpoint: costCount === 0 || !nodeCount ? null : cost / nodeCount,
    planningCost: costCount === 0 ? null : cost,
    firstPassGateRate: roundsUsed === null ? null : (roundsUsed === 1 ? 1 : 0),
    blockedContextRate: blockedAttempts === null || workerAttempts === 0 ? null : blockedAttempts / workerAttempts,
    nodesPerClosedCheckpoint: nodeCount,
    criticalFindingsPerPlan: criticalFindings,
  };
}

/**
 * The planner arm, from every `evals/planner/reports/*.json` present. Unlike
 * `sessionArm`, this can legitimately have nothing to report yet -- no
 * campaign has had `faberun plan` run against its `REQUIREMENTS.md` and
 * saved here -- in which case `campaigns` and every indicator's `count` are
 * empty/zero rather than the caller treating an empty planner arm as an
 * error.
 *
 * @param {{repoRoot: string}} options
 * @returns {ArmReport}
 */
export function plannerArm({ repoRoot }) {
  const files = plannerReportFiles(repoRoot);
  const reports = files.map((file) => ({ file, report: readJsonIfExists(join(repoRoot, PLANNER_REPORTS_DIR, file)) }));
  const perReport = reports.map(({ file, report }) => {
    const campaignId = typeof report?.campaignId === "string" ? report.campaignId : file.replace(/\.json$/u, "");
    return { campaignId, ...plannerArmForReport(report ?? {}) };
  });
  return {
    schemaVersion: 1,
    side: "planner",
    provenance: { generatedAt: new Date().toISOString(), reportFiles: files },
    campaigns: perReport,
    indicators: aggregateIndicators(perReport),
  };
}
