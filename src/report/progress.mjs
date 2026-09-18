/**
 * One rendered progress message for a human, from a run's persisted state
 * plus one terminal event: campaign, phase and node with a glyph for the
 * node's outcome; percent and count done and left; this node's own span; the
 * phase's estimated remaining time, from settled spans alone; the next node
 * in the phase, or that the phase is complete; what the node delivered, in
 * the worker's own words; and cost by role plus the campaign's cumulative
 * cost.
 *
 * Every number here comes from a reader that already owns it -- the status
 * payload (`renderStatusJson`, which already carries per-node phase, spans,
 * cost and per-role usage with provenance), the raw node snapshot (for the
 * worker's own `result.summary`, which the status payload does not carry),
 * and, for the campaign's cumulative cost, the campaign record's own
 * `linkedRunIds` summed through the same per-run usage reader the status
 * payload uses for this run alone. Nothing here recomputes what one of those
 * already answers.
 */
import { MARK, formatDuration, formatRole, readRunUsage, renderStatusJson } from "./render.mjs";
import { readNodeSnapshot } from "../run/node-store.mjs";
import { boundedUtf8, compactCost } from "../util.mjs";
import { SETTLED } from "../engine/prompts.mjs";
import { campaignDir } from "../campaign/layout.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { dirname, join } from "node:path";

/** @typedef {import("./render.mjs").StatusPayloadNode} StatusPayloadNode */
/** @typedef {import("../notify/index.mjs").NotifyEvent} NotifyEvent */

/**
 * The message's byte ceiling. A three-node run, both roles priced and a
 * two-sentence worker summary, measures ~430 bytes; this leaves headroom for
 * a long campaign/phase/node id triple while still bounding an adversarial
 * worker summary (the protocol's own 4 KiB ceiling), which is the only
 * unbounded block and the one truncated first.
 */
export const PROGRESS_MESSAGE_MAX_BYTES = 2048;

const NO_SUMMARY = "(no summary recorded)";

/**
 * @param {string} runDir
 * @param {NotifyEvent} event
 * @returns {string}
 */
export function renderRunProgress(runDir, event) {
  const payload = /** @type {{campaignId: string, usage: {costUsd: number|null}, roles: {worker: import("./render.mjs").RoleUsage, judge: import("./render.mjs").RoleUsage}, nodes: StatusPayloadNode[]}} */
    (JSON.parse(renderStatusJson(runDir)));
  const subject = subjectNode(payload.nodes, event.nodeId ?? null);
  const raw = readNodeSnapshot(runDir, subject.id);
  const phaseNodes = payload.nodes.filter((node) => node.phase === subject.phase);
  const total = payload.nodes.length;
  const done = payload.nodes.filter((node) => SETTLED.has(node.status)).length;
  const donePct = total ? Math.round((done / total) * 100) : 0;

  const lines = [
    `${MARK[subject.status] ?? "[?]"} campaign ${payload.campaignId} · phase ${subject.phase ?? "-"} · node ${subject.id}`,
    `${done}/${total} nodes done · ${donePct}% done · ${100 - donePct}% left`,
    `this node: ${spanOf(subject) ?? "-"}`,
    phaseEstimateLine(phaseNodes),
    nextNodeLine(phaseNodes),
  ];
  if (event.type === "attention") lines.push(attentionLine(runDir, subject, raw));
  const valueLineIndex = lines.push(valueLine(raw)) - 1;
  lines.push(costLine(runDir, payload));

  return boundToCeiling(lines, valueLineIndex);
}

/**
 * The event's own node when it names one and the run still has it, else the
 * most recently settled node (a `run.terminal` event names the run, not a
 * node), else the run's first node.
 *
 * @param {StatusPayloadNode[]} nodes
 * @param {string|null} nodeId
 * @returns {StatusPayloadNode}
 */
function subjectNode(nodes, nodeId) {
  const named = nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
  if (named) return named;
  const settled = nodes.filter((node) => SETTLED.has(node.status) && node.updatedAt);
  const latest = settled.sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt))).at(-1);
  return latest ?? nodes[0];
}

/** @param {{startedAt: string|null, updatedAt: string|null}} node @returns {number|null} */
function spanMs(node) {
  if (!node.startedAt || !node.updatedAt) return null;
  const start = Date.parse(node.startedAt);
  const end = Date.parse(node.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** @param {{startedAt: string|null, updatedAt: string|null}} node @returns {string|null} */
function spanOf(node) {
  const ms = spanMs(node);
  return ms === null ? null : formatDuration(ms);
}

/**
 * The phase's estimated remaining time, from the spans of its own settled
 * nodes alone: a running node's partial elapsed is never in `SETTLED`, so it
 * never drags the mean down and the estimate forward.
 *
 * @param {StatusPayloadNode[]} phaseNodes
 * @returns {string}
 */
function phaseEstimateLine(phaseNodes) {
  const remaining = phaseNodes.filter((node) => !SETTLED.has(node.status));
  if (!remaining.length) return "phase estimate: complete";
  const spans = phaseNodes.filter((node) => SETTLED.has(node.status)).map(spanMs).filter((ms) => ms !== null);
  if (!spans.length) return "phase estimate: unknown (no settled node yet)";
  const meanMs = spans.reduce((total, ms) => total + /** @type {number} */ (ms), 0) / spans.length;
  return `phase estimate: ~${formatDuration(meanMs * remaining.length)} remaining (from ${spans.length} settled node${spans.length === 1 ? "" : "s"})`;
}

/** @param {StatusPayloadNode[]} phaseNodes @returns {string} */
function nextNodeLine(phaseNodes) {
  const next = phaseNodes.find((node) => !SETTLED.has(node.status));
  return next ? `next: ${next.id}` : "next: phase complete";
}

/**
 * The worker's own words, never the renderer's: the raw snapshot's own
 * `result.summary`, labelled as such so a reader never mistakes it for the
 * renderer's judgment.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
function valueLine(raw) {
  const result = /** @type {{summary?: unknown}|null} */ (raw.result && typeof raw.result === "object" ? raw.result : null);
  const summary = typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : null;
  return `worker says: ${summary ?? NO_SUMMARY}`;
}

/**
 * The attention variant names what must be decided and the exact command
 * that unblocks it, the way `src/report/next.mjs` does for its own items.
 *
 * @param {string} runDir
 * @param {StatusPayloadNode} subject
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
function attentionLine(runDir, subject, raw) {
  const result = /** @type {{status?: unknown, summary?: unknown, missingContext?: unknown}|null} */ (raw.result && typeof raw.result === "object" ? raw.result : null);
  if (result?.status === "blocked_context") {
    const missing = Array.isArray(result.missingContext) ? result.missingContext.filter((entry) => typeof entry === "string") : [];
    const asked = missing.length ? ` (needs ${missing.join(", ")})` : "";
    return `decide: answer node ${subject.id}'s missing context${asked} → resume ${runDir} --answer ${subject.id}=<answer-file>`;
  }
  const gate = /** @type {{findings?: unknown}|null} */ (raw.gate && typeof raw.gate === "object" ? raw.gate : null);
  if (subject.status === "exhausted" && Array.isArray(gate?.findings) && gate.findings.length) {
    return `decide: review node ${subject.id}'s gate findings → findings ${runDir}`;
  }
  return `decide: resolve node ${subject.id} (${subject.status}) → status ${runDir}`;
}

/**
 * The campaign's cumulative cost: every linked run's own usage.jsonl total
 * (a phase-run per plan phase), summed through the same reader the status
 * payload uses for this run alone -- never this run's own total standing in
 * for the campaign's, which is the phase's spend, not the campaign's.
 *
 * `null` when the campaign record cannot be read at all (never once a
 * linked run's own usage is merely unpriced or missing, which `readRunUsage`
 * already folds into the sum as a no-op).
 *
 * @param {string} runDir
 * @param {string} campaignId
 * @returns {number|null}
 */
function campaignCumulativeCostUsd(runDir, campaignId) {
  const runsDir = dirname(runDir);
  let campaign;
  try {
    campaign = readCampaign(campaignDir(runsDir, campaignId));
  } catch {
    return null;
  }
  let total = null;
  for (const runId of campaign.linkedRunIds) {
    const cost = readRunUsage(join(runsDir, runId)).costUsd;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total;
}

/**
 * @param {string} runDir
 * @param {{campaignId: string, roles: {worker: import("./render.mjs").RoleUsage, judge: import("./render.mjs").RoleUsage}}} payload
 * @returns {string}
 */
function costLine(runDir, payload) {
  const cumulative = campaignCumulativeCostUsd(runDir, payload.campaignId);
  return `cost — worker ${formatRole(payload.roles.worker)} · judge ${formatRole(payload.roles.judge)} · campaign total ${compactCost(cumulative)}`;
}

/**
 * The value block is the only unbounded part of the message, so it is the
 * only one truncated when the whole message would exceed the ceiling.
 *
 * @param {string[]} lines
 * @param {number} valueLineIndex
 * @returns {string}
 */
function boundToCeiling(lines, valueLineIndex) {
  const overflow = Buffer.byteLength(lines.join("\n"), "utf8") - PROGRESS_MESSAGE_MAX_BYTES;
  if (overflow <= 0) return lines.join("\n");
  const valueLineBytes = Buffer.byteLength(lines[valueLineIndex], "utf8");
  const trimmed = [...lines];
  trimmed[valueLineIndex] = boundedUtf8(lines[valueLineIndex], Math.max(0, valueLineBytes - overflow));
  return trimmed.join("\n");
}
