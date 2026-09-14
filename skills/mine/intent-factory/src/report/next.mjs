/**
 * `next`: one line per active campaign naming the single most urgent action
 * and, when every argument is derivable from state, the exact command to run.
 *
 * It is the read side of the operator loop, and deliberately narrower than
 * `status`: it enumerates campaigns with `discoverCampaigns`, reads each linked
 * run's controller lock and node snapshots the way `status` does, and applies
 * the six ranked predicates from the operator-loop spec — specific before
 * generic, so exactly one matches — then orders the lines by rank and campaign
 * id. It takes no lock and writes nothing; the only writes it could be tempted
 * into (resume, findings, close) are rendered as commands for the operator.
 *
 * Node snapshots are parsed here with a tolerant `JSON.parse` in a try/catch,
 * never through `loadRun`/`validateNodeSnapshot`: a torn snapshot is exactly
 * the case this command must survive and report, not crash on.
 */
import { join } from "node:path";
import { discoverCampaigns } from "../campaign/index.mjs";
import { readJournalForDedupe } from "../campaign/journal.mjs";
import { lockStale, readLock } from "../run/lock.mjs";
import { listNodeSnapshots, nodeSnapshotPath, readNodeSnapshot } from "../run/node-store.mjs";
import { errorMessage } from "../util.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{campaign: string, rank: number, reason: string, command: string, runnable: boolean}} NextItem */

/** Node states that are still in flight, versus every settled terminal state. */
const IN_PROGRESS = new Set(["pending", "running"]);
const SETTLED_DONE = new Set(["done", "no-op"]);

/**
 * The action list every renderer shares. A campaign contributes exactly one
 * item — the lowest-ranked predicate its runs and nodes match — and corrupt
 * campaigns contribute one item each, so nothing is skipped silently.
 *
 * @param {string} runsDir
 * @param {string} cwd absolute working directory, for `campaign close`/`note`
 * @returns {NextItem[]}
 */
export function computeNextItems(runsDir, cwd) {
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  /** @type {NextItem[]} */
  const items = [];
  for (const entry of corrupt) {
    items.push({
      campaign: entry.id,
      rank: 4,
      reason: `campaign ${entry.id} unreadable: ${errorMessage(entry.error)} (${entry.path})`,
      command: "",
      runnable: false,
    });
  }
  for (const entry of campaigns) {
    if (entry.campaign.status !== "active") continue;
    items.push(campaignItem(entry, runsDir, cwd));
  }
  items.sort((left, right) => left.rank - right.rank
    || (left.campaign < right.campaign ? -1 : left.campaign > right.campaign ? 1 : 0));
  return items;
}

/**
 * @param {string} runsDir
 * @param {string} cwd
 * @returns {string}
 */
export function renderNext(runsDir, cwd) {
  const items = computeNextItems(runsDir, cwd);
  if (!items.length) return "nothing needs anyone\n";
  return `${items.map(renderLine).join("\n")}\n`;
}

/**
 * @param {string} runsDir
 * @param {string} cwd
 * @returns {string}
 */
export function renderNextJson(runsDir, cwd) {
  const items = computeNextItems(runsDir, cwd);
  const payload = {
    schemaVersion: 1,
    items: items.map((item) => ({
      campaign: item.campaign,
      rank: item.rank,
      reason: item.reason,
      command: item.command,
      runnable: item.runnable,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {{path: string, campaign: Campaign}} entry
 * @param {string} runsDir
 * @param {string} cwd
 * @returns {NextItem}
 */
function campaignItem(entry, runsDir, cwd) {
  const campaign = entry.campaign;
  /** @type {NextItem[]} */
  const candidates = [];
  let inProgress = false;
  /** @type {string|null} */
  let liveRunId = null;

  for (const runId of campaign.linkedRunIds) {
    const runDir = join(runsDir, runId);
    const active = controllerLive(runDir);
    const { nodes, errors } = readRunNodes(runDir);
    if (!nodes.length && !errors.length) {
      // A linked run that never wrote a single snapshot is unknown, not
      // terminal: counting it as terminal here is exactly the vacuous rank-5
      // bug this item exists to prevent.
      candidates.push(emptyRunItem(campaign.id, runId, runDir));
    }
    for (const { nodeId, snapshot } of nodes) {
      const status = statusOf(snapshot);
      if (status !== null && IN_PROGRESS.has(status)) {
        inProgress = true;
        if (active && liveRunId === null) liveRunId = runId;
        if (!active) candidates.push(resumeItem(campaign.id, runId, runDir));
      } else if (status !== null && SETTLED_DONE.has(status)) {
        // Done, no-op: nothing needs the operator.
      } else if (status === "blocked" && isBlockedContext(snapshot)) {
        candidates.push(blockedContextItem(campaign.id, runId, runDir, nodeId, snapshot));
      } else if (status === "exhausted" && hasGateFindings(snapshot)) {
        candidates.push(findingsItem(campaign.id, runId, runDir, nodeId));
      } else if (status === "blocked" || status === "failed" || status === "exhausted"
        || status === "stalled" || status === "canceled") {
        candidates.push(statusItem(campaign.id, runId, runDir, nodeId, status, snapshot));
      } else {
        candidates.push(unrecognizedItem(campaign.id, runId, runDir, nodeId));
      }
    }
    for (const { nodeId, path, error } of errors) {
      candidates.push(tornItem(campaign.id, runId, runDir, nodeId, path, error));
    }
  }

  const best = candidates.reduce(
    (found, candidate) => (!found || candidate.rank < found.rank ? candidate : found),
    /** @type {NextItem|null} */ (null),
  );
  if (best) return best;
  if (!inProgress) return closureItem(campaign, entry.path, cwd);
  return {
    campaign: campaign.id,
    rank: 6,
    reason: `run ${liveRunId ?? campaign.linkedRunIds[0] ?? ""} live; nothing to do`,
    command: "",
    runnable: false,
  };
}

/**
 * A live controller is the exact inverse of the stale test: a lock that is
 * absent, `{invalid: true}` (unparsable), stale, or unreadable is not live.
 *
 * @param {string} runDir
 * @returns {boolean}
 */
function controllerLive(runDir) {
  let lock;
  try {
    lock = readLock(runDir);
  } catch {
    return false;
  }
  if (!lock || /** @type {{invalid?: true}} */ (lock).invalid) return false;
  return !lockStale(/** @type {import("../run/lock.mjs").LockRecord} */ (lock));
}

/**
 * @param {string} runDir
 * @returns {{nodes: {nodeId: string, snapshot: JsonObject}[], errors: {nodeId: string, path: string, error: unknown}[]}}
 */
function readRunNodes(runDir) {
  const names = listNodeSnapshots(runDir).sort();
  /** @type {{nodeId: string, snapshot: JsonObject}[]} */
  const nodes = [];
  /** @type {{nodeId: string, path: string, error: unknown}[]} */
  const errors = [];
  for (const name of names) {
    const nodeId = name.replace(/\.json$/u, "");
    const path = nodeSnapshotPath(runDir, nodeId);
    try {
      nodes.push({ nodeId, snapshot: readNodeSnapshot(runDir, nodeId) });
    } catch (error) {
      errors.push({ nodeId, path, error });
    }
  }
  return { nodes, errors };
}

/** @param {JsonObject} snapshot @returns {string|null} */
function statusOf(snapshot) {
  return typeof snapshot.status === "string" ? snapshot.status : null;
}

/** @param {JsonObject} snapshot @returns {{status?: unknown, summary?: unknown, missingContext?: unknown}|null} */
function resultOf(snapshot) {
  const result = snapshot.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return /** @type {{status?: unknown, summary?: unknown, missingContext?: unknown}} */ (result);
}

/** @param {JsonObject} snapshot @returns {{findings?: unknown}|null} */
function gateOf(snapshot) {
  const gate = snapshot.gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  return /** @type {{findings?: unknown}} */ (gate);
}

/** @param {JsonObject} snapshot @returns {{code?: unknown, message?: unknown}|null} */
function errorOf(snapshot) {
  const error = snapshot.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return /** @type {{code?: unknown, message?: unknown}} */ (error);
}

/** @param {JsonObject} snapshot @returns {boolean} */
function isBlockedContext(snapshot) {
  return resultOf(snapshot)?.status === "blocked_context";
}

/** @param {JsonObject} snapshot @returns {boolean} */
function hasGateFindings(snapshot) {
  const findings = gateOf(snapshot)?.findings;
  return Array.isArray(findings) && findings.length > 0;
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @returns {NextItem} */
function resumeItem(campaignId, runId, runDir) {
  return {
    campaign: campaignId,
    rank: 1,
    reason: `run ${runId} has a non-terminal node and no live controller`,
    command: `resume ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @param {string} nodeId @param {JsonObject} snapshot @returns {NextItem} */
function blockedContextItem(campaignId, runId, runDir, nodeId, snapshot) {
  const result = resultOf(snapshot);
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : "the worker stopped on missing context";
  const missing = Array.isArray(result?.missingContext)
    ? result.missingContext.filter((entry) => typeof entry === "string")
    : [];
  const asked = missing.length ? `; needs ${missing.join(", ")}` : "";
  return {
    campaign: campaignId,
    rank: 2,
    reason: `node ${nodeId} blocked on context: ${summary}${asked}`,
    command: `resume ${quoteArg(runDir)} --answer ${nodeId}=<answer-file>`,
    runnable: false,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @param {string} nodeId @returns {NextItem} */
function findingsItem(campaignId, runId, runDir, nodeId) {
  return {
    campaign: campaignId,
    rank: 3,
    reason: `node ${nodeId} exhausted with gate findings`,
    command: `findings ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @param {string} nodeId @param {string} status @param {JsonObject} snapshot @returns {NextItem} */
function statusItem(campaignId, runId, runDir, nodeId, status, snapshot) {
  const error = errorOf(snapshot);
  const code = typeof error?.code === "string" && error.code ? error.code : null;
  const message = typeof error?.message === "string" && error.message ? error.message : null;
  const blockedBy = Array.isArray(snapshot.blockedBy) ? snapshot.blockedBy.filter((id) => typeof id === "string") : [];
  let detail = "";
  if (status === "blocked" && blockedBy.length) detail = ` on ${blockedBy.join(", ")}`;
  else if (code) detail = ` [${code}]`;
  else if (message) detail = `: ${message}`;
  return {
    campaign: campaignId,
    rank: 4,
    reason: `node ${nodeId} ${status}${detail}`,
    command: `status ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @param {string} nodeId @returns {NextItem} */
function unrecognizedItem(campaignId, runId, runDir, nodeId) {
  return {
    campaign: campaignId,
    rank: 4,
    reason: `node ${nodeId} snapshot has no recognized status`,
    command: `status ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @returns {NextItem} */
function emptyRunItem(campaignId, runId, runDir) {
  return {
    campaign: campaignId,
    rank: 4,
    reason: `run ${runId} has no recorded nodes yet`,
    command: `status ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/** @param {string} campaignId @param {string} runId @param {string} runDir @param {string} nodeId @param {string} path @param {unknown} error @returns {NextItem} */
function tornItem(campaignId, runId, runDir, nodeId, path, error) {
  return {
    campaign: campaignId,
    rank: 4,
    reason: `node ${nodeId} snapshot unreadable: ${errorMessage(error)} (${path})`,
    command: `status ${quoteArg(runDir)}`,
    runnable: true,
  };
}

/**
 * Rank 5 checks the exact predicate `closeCampaign` enforces — a
 * `retrospective` journal entry — so what `next` reports and what `close`
 * refuses can never disagree. An unreadable journal reads as ineligible, never
 * as a crash.
 *
 * @param {Campaign} campaign
 * @param {string} campaignPath
 * @param {string} cwd
 * @returns {NextItem}
 */
function closureItem(campaign, campaignPath, cwd) {
  let eligible = false;
  try {
    eligible = readJournalForDedupe(campaignPath).some((entry) => entry.type === "retrospective");
  } catch {
    eligible = false;
  }
  const state = campaign.linkedRunIds.length === 0
    ? "no linked runs"
    : `all ${campaign.linkedRunIds.length} linked runs terminal`;
  if (eligible) {
    return {
      campaign: campaign.id,
      rank: 5,
      reason: `${state}; retrospective recorded`,
      command: `campaign close ${campaign.id} --cwd ${quoteArg(cwd)}`,
      runnable: true,
    };
  }
  return {
    campaign: campaign.id,
    rank: 5,
    reason: `${state}; no retrospective note (close would refuse)`,
    command: `campaign note ${campaign.id} --session-id <session-id> --kind retrospective --text <text>`,
    runnable: false,
  };
}

/** @param {NextItem} item @returns {string} */
function renderLine(item) {
  const prefix = `${item.campaign}: ${item.reason}`;
  if (!item.command) return prefix;
  return `${prefix} · ${item.command}${item.runnable ? "" : " [template]"}`;
}

/**
 * Quote a shell argument only when it needs it, so a normal path stays bare and
 * a path with a space (or any other shell metacharacter) is single-quoted.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteArg(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
