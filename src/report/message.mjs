/**
 * The notification message: one text for every audience of a terminal
 * event -- the harness session the controller was launched from, a phone, the
 * campaign inbox, the receipt -- rendered once by the producer from the run's
 * persisted state, never by the receiver from a query. A session that had to
 * run a command to learn what happened would spend a model turn and tool
 * calls per event and paraphrase the result; a phone cannot run anything.
 * The text is plain: emoji as labels, `·` as the separator, no markdown, so a
 * transcript, a chat and a status bar render it the same.
 *
 * It is a module apart from `progress.mjs` because that module is the
 * campaign roll-up, the page; this is the one-screen message. They share the
 * numbers -- the roll-up itself, the remaining-time estimate, a node's span --
 * through that module's exports, so the message and the page can never
 * disagree about progress, cost or time.
 */
import { renderStatusJson } from "./render.mjs";
import { buildCampaignProgress, remainingEstimate, spanOf } from "./progress.mjs";
import { readNodeSnapshot } from "../run/node-store.mjs";
import { boundedUtf8, compactTokens } from "../util.mjs";
import { SETTLED, SUCCESS } from "../engine/prompts.mjs";
import { dirname } from "node:path";

/** @typedef {import("./render.mjs").StatusPayloadNode} StatusPayloadNode */
/** @typedef {import("./render.mjs").RoleUsage} RoleUsage */
/** @typedef {import("../notify/index.mjs").NotifyEvent} NotifyEvent */
/** @typedef {{percentDone: number, nodesTotal: number, phasesDone: number, phasesTotal: number, costTotalUsd: number|null, elapsed: string|null, remaining: string|null}} CampaignSummary */

/**
 * The message's byte ceiling. Measured 2026-09-21 on the live campaign's
 * fifteenth run: the six numbered lines (headline, phase, campaign, cost,
 * time, decide) come to ~560 bytes, so the ceiling leaves ~1.4 KiB for the
 * one unbounded block, the worker's own summary, which is bounded on its own
 * below and truncated first when a long id triple still overflows.
 */
export const PROGRESS_MESSAGE_MAX_BYTES = 2048;

/**
 * The worker's own words, bounded before the ceiling applies. Measured
 * 2026-09-21: one real summary filled 1.5 KiB of a 2 KiB message and pushed
 * every number below it, which is the verbosity the phone complained about.
 * A notification wants one sentence; the full text stays in the node snapshot
 * and on the campaign page.
 */
const WORKER_SUMMARY_MAX_BYTES = 240;

const NO_SUMMARY = "(no summary recorded)";

/**
 * The sender's mark, first on line one of every message. A Claude Code
 * transcript, a Codex thread and a WhatsApp chat all show that first line
 * before the rest, so the source and the outcome must fit in it.
 */
const SENDER = "🐦 Faberun";

/** One glyph per node outcome, rendered identically by every audience. */
const OUTCOME = Object.freeze({
  pending: "⏳",
  running: "▶️",
  done: "✅",
  "no-op": "⏭️",
  blocked: "⛔",
  failed: "❌",
  exhausted: "🔋",
  stalled: "🐢",
  canceled: "🚫",
});

/** A node in none of these states waits on a person: the predicate the status pointer's `needsYou` uses. */
const QUIET_STATES = new Set(["pending", "running", "done", "no-op"]);

/**
 * @param {string} runDir
 * @param {NotifyEvent} event
 * @returns {string}
 */
export function renderRunProgress(runDir, event) {
  const payload = /** @type {{campaignId: string, usage: {inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}, roles: {worker: RoleUsage, judge: RoleUsage}, nodes: StatusPayloadNode[]}} */
    (JSON.parse(renderStatusJson(runDir)));
  const subject = subjectNode(payload.nodes, event.nodeId ?? null);
  const raw = readNodeSnapshot(runDir, subject.id);
  const phaseNodes = payload.nodes.filter((node) => node.phase === subject.phase);
  const done = payload.nodes.filter((node) => SUCCESS.has(node.status)).length;
  const needsYou = payload.nodes.filter((node) => !QUIET_STATES.has(node.status)).length;
  const campaign = campaignSummary(dirname(runDir), payload.campaignId);

  const lines = [headline(event, subject, done, payload.nodes.length, needsYou, campaign)];
  if (event.type === "attention") lines.push(attentionLine(runDir, subject, raw));
  lines.push(
    phaseLine(subject, phaseNodes),
    campaignLine(payload.campaignId, campaign),
    costLine(payload),
    timeLine(subject),
  );
  const valueLineIndex = lines.push(valueLine(raw)) - 1;

  return boundToCeiling(lines, valueLineIndex);
}

/**
 * Line one carries what a reader decides on without expanding: who sent it,
 * which node or run and how it ended, how far the phase and the campaign
 * are, what the campaign has cost, and whether anything waits on a person.
 *
 * @param {NotifyEvent} event
 * @param {StatusPayloadNode} subject
 * @param {number} done
 * @param {number} total
 * @param {number} needsYou
 * @param {CampaignSummary|null} campaign
 * @returns {string}
 */
function headline(event, subject, done, total, needsYou, campaign) {
  const outcome = event.type === "attention"
    ? `node ${subject.id} 👀 needs you${subject.errorCode ? ` (${subject.errorCode})` : ""}`
    : event.type === "run.terminal"
      ? `run ${event.runId ?? "-"} ${needsYou ? "👀 attention" : `${OUTCOME.done} done`}`
      : `node ${subject.id} ${OUTCOME[subject.status] ?? "❔"} ${subject.status}`;
  const campaignPart = campaign ? `campaign ${campaign.percentDone}%` : "campaign -";
  return `${SENDER} · ${outcome} · phase ${done}/${total} · ${campaignPart} · ${formatUsd(campaign?.costTotalUsd ?? null)} · needs you: ${needsYou}`;
}

/**
 * Done and settled are two numbers here as on the campaign page: a phase
 * whose last node blocked has nothing left in flight and is still not
 * complete, and saying "complete" there is the lie the split exists to
 * prevent. `next` is named only while a node is still to run.
 *
 * @param {StatusPayloadNode} subject
 * @param {StatusPayloadNode[]} phaseNodes
 * @returns {string}
 */
function phaseLine(subject, phaseNodes) {
  const done = phaseNodes.filter((node) => SUCCESS.has(node.status)).length;
  const pct = phaseNodes.length ? Math.round((done / phaseNodes.length) * 100) : 0;
  const next = phaseNodes.find((node) => !SETTLED.has(node.status));
  const outlook = next
    ? `${remainingEstimate(phaseNodes, phaseNodes) ?? "no estimate yet"} · next ${next.id}`
    : settledOutlook(done, phaseNodes.length);
  return `📦 phase ${subject.phase ?? "-"} · ${done}/${phaseNodes.length} nodes · ${pct}% · ${outlook}`;
}

/** @param {number} done @param {number} total @returns {string} */
function settledOutlook(done, total) {
  return done === total ? "complete" : `nothing in flight, ${total - done} settled without finishing`;
}

/**
 * @param {string} campaignId
 * @param {CampaignSummary|null} campaign
 * @returns {string}
 */
function campaignLine(campaignId, campaign) {
  if (!campaign) return `🧭 campaign ${campaignId} · record unavailable`;
  const outlook = campaign.remaining === "complete"
    ? (campaign.percentDone === 100 ? "complete" : "nothing in flight")
    : (campaign.remaining ?? "no estimate yet");
  return `🧭 campaign ${campaignId} · ${campaign.phasesDone}/${campaign.phasesTotal} phases · ${campaign.percentDone}% of ${campaign.nodesTotal} nodes · ${campaign.elapsed ?? "-"} elapsed · ${outlook}`;
}

/**
 * The run's money and tokens. The per-role split is shown only when a role
 * is priced: "run $2.20 · worker unpriced · judge unpriced" reads as a
 * contradiction, when it only means the ledger priced the run and not the
 * roles.
 *
 * @param {{usage: {inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}, roles: {worker: RoleUsage, judge: RoleUsage}}} payload
 * @returns {string}
 */
function costLine(payload) {
  const { usage, roles } = payload;
  const split = roles.worker.costUsd !== null || roles.judge.costUsd !== null
    ? ` · worker ${roleCost(roles.worker)} · judge ${roleCost(roles.judge)}`
    : "";
  // Tokens come from the two roles, the reading the old message printed
  // beside an unpriced role, so a run whose usage ledger is empty still
  // reports what its snapshots recorded.
  const tokens = /** @param {"inputTokens"|"outputTokens"|"cacheReadInputTokens"} kind */ (kind) => compactTokens(roles.worker[kind] + roles.judge[kind]);
  return `💸 run ${formatUsd(usage.costUsd)}${split} · ${tokens("inputTokens")} in · ${tokens("outputTokens")} out · ${tokens("cacheReadInputTokens")} cache`;
}

/** @param {StatusPayloadNode} subject @returns {string} */
function timeLine(subject) {
  const revisions = subject.revisions ? ` · revisions ${subject.revisions}` : "";
  const runtime = subject.workerRuntime ? ` · ${subject.workerRuntime}` : "";
  return `⏱️ node ${spanOf(subject) ?? "-"} · attempt ${subject.attempt}${revisions}${runtime}`;
}

/**
 * The worker's own words, never the renderer's, bounded to a sentence's
 * worth so the numbers above it stay in view on a phone.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
function valueLine(raw) {
  const result = /** @type {{summary?: unknown}|null} */ (raw.result && typeof raw.result === "object" ? raw.result : null);
  const summary = typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : null;
  return `💬 ${boundedUtf8(summary ?? NO_SUMMARY, WORKER_SUMMARY_MAX_BYTES)}`;
}

/**
 * Two decimals, the way a person reads money in a notification; the
 * six-decimal `compactCost` stays for ledgers and tables, where exactness
 * matters more than a glance. A cost under a cent is said to be under a cent
 * rather than rounded to nothing; unknown is `$-`.
 *
 * @param {number|null} value
 * @returns {string}
 */
function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$-";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** @param {RoleUsage} role @returns {string} */
function roleCost(role) {
  if (role.costUsd !== null) return formatUsd(role.costUsd);
  return role.costProvenance === "none" ? "-" : "unpriced";
}

/**
 * The campaign-wide numbers the message carries, taken from the same roll-up
 * `renderCampaignProgress` prints so the two never disagree. `null` when the
 * campaign record cannot be read at all: a run that belongs to no readable
 * campaign still gets its message, with the campaign line saying so.
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {CampaignSummary|null}
 */
function campaignSummary(runsDir, campaignId) {
  let progress;
  try {
    progress = buildCampaignProgress(runsDir, campaignId, Date.now());
  } catch {
    return null;
  }
  const phases = /** @type {{counts: {done: number, total: number}}[]} */ (progress.phases);
  const counts = /** @type {{total: number}} */ (progress.counts);
  const time = /** @type {{elapsed: string|null, remaining: string|null}} */ (progress.time);
  // A record that declares no node at all is a run outside any campaign the
  // reader can see; its line says so rather than reporting 0% of nothing.
  if (counts.total === 0) return null;
  return {
    percentDone: /** @type {number} */ (progress.percentDone),
    nodesTotal: counts.total,
    phasesDone: phases.filter((phase) => phase.counts.total > 0 && phase.counts.done === phase.counts.total).length,
    phasesTotal: phases.length,
    costTotalUsd: /** @type {number|null} */ (progress.costTotalUsd),
    elapsed: time.elapsed,
    remaining: time.remaining,
  };
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
    return `👀 decide: answer node ${subject.id}'s missing context${asked} → resume ${runDir} --answer ${subject.id}=<answer-file>`;
  }
  const gate = /** @type {{findings?: unknown}|null} */ (raw.gate && typeof raw.gate === "object" ? raw.gate : null);
  if (subject.status === "exhausted" && Array.isArray(gate?.findings) && gate.findings.length) {
    return `👀 decide: review node ${subject.id}'s gate findings → findings ${runDir}`;
  }
  return `👀 decide: resolve node ${subject.id} (${subject.status}) → status ${runDir}`;
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
