/**
 * The notification message: one text for every audience of a terminal
 * event -- the harness session the controller was launched from, a phone, the
 * campaign inbox, the receipt -- rendered once by the producer from the run's
 * persisted state, never by the receiver from a query. A session that had to
 * run a command to learn what happened would spend a model turn and tool
 * calls per event and paraphrase the result; a phone cannot run anything.
 *
 * Three shapes, one per weight of event. A node settling is routine: the
 * outcome, then what was asked, what was done and how it was proven, then
 * the phase. A run settling is a milestone: what every node delivered, the
 * campaign's own bar, the money and the next command. A node needing a
 * person is an action: why, what was asked, and the exact command, first.
 * Every fact appears once; the first line alone answers what happened, to
 * what, and whether anything waits on a person, because a transcript preview
 * and a phone show that line before any other. Plain text and emoji only, so
 * a transcript, a chat and a status bar render it the same; the wording
 * follows the operator's own language (`locale.mjs`).
 *
 * It is a module apart from `progress.mjs` because that module is the
 * campaign roll-up, the page; this is the one-screen message. They share the
 * numbers -- the roll-up itself and the remaining-time estimate -- through
 * that module's exports, so the message and the page can never disagree.
 */
import { renderStatusJson } from "./render.mjs";
import { buildCampaignProgress, remainingEstimateMs } from "./progress.mjs";
import { detectLanguage, labelsFor } from "./locale.mjs";
import { readNodeSnapshot } from "../run/node-store.mjs";
import { campaignDir } from "../campaign/layout.mjs";
import { readJournal } from "../campaign/journal.mjs";
import { compareVersions, faberunHome, readUpdateCheck } from "../host/home.mjs";
import { packageVersion } from "../host/package.mjs";
import { boundedUtf8, compactTokens } from "../util.mjs";
import { SETTLED, SUCCESS } from "../engine/prompts.mjs";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** @typedef {import("./render.mjs").StatusPayloadNode} StatusPayloadNode */
/** @typedef {import("./render.mjs").RoleUsage} RoleUsage */
/** @typedef {import("../notify/index.mjs").NotifyEvent} NotifyEvent */
/** @typedef {import("./locale.mjs").Language} Language */
/** @typedef {{campaignId: string, usage: {inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null}, roles: {worker: RoleUsage, judge: RoleUsage}, nodes: StatusPayloadNode[]}} Payload */
/** @typedef {{id: string, goal: string|null, percentDone: number, nodesTotal: number, phasesDone: number, phasesTotal: number, costTotalUsd: number|null, elapsedMs: number|null, nextCommand: string|null}} CampaignSummary */
/** @typedef {{runDir: string, runId: string, payload: Payload, objectives: Map<string, string|null>, snapshots: Map<string, Record<string, unknown>>, campaign: CampaignSummary|null, label: (key: string) => string, subject: StatusPayloadNode}} View */

/**
 * The message's byte ceiling. Measured 2026-09-21 on the live campaign's
 * runs: a node message is ~450 bytes, a run message with five delivered
 * bullets ~1.1 KiB, because every quoted piece is cut to a sentence below.
 * The ceiling is the guard for a run with many nodes, where the delivered
 * bullets are dropped from the end before anything else is touched.
 */
export const PROGRESS_MESSAGE_MAX_BYTES = 2048;

/**
 * One sentence is what a notification quotes of any text -- an objective,
 * the worker's words, a judge finding. Measured 2026-09-21: the full worker
 * summary filled 1.5 KiB of a 2 KiB message and pushed every number below
 * it; the first sentence of the same summary was 118 characters and said
 * what was delivered.
 */
const SENTENCE_MAX_CHARS = 120;

/** How many delivered nodes a run message lists before folding the rest into a count. */
const DELIVERED_MAX_NODES = 5;

const BAR_CELLS = 10;
const RULE = "──────────────────────────────";
const SIGNATURE = "🐦 faberun";

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

/** The label key that phrases how a node ended, per outcome. @type {Readonly<Record<string, string>>} */
const OUTCOME_LABEL = Object.freeze({
  done: "doneIn",
  "no-op": "no-op",
  failed: "failedAfter",
  blocked: "blockedAfter",
  exhausted: "exhaustedAfter",
  stalled: "stalledAfter",
  canceled: "canceledAfter",
});

/** A node in none of these states waits on a person: the predicate the status pointer's `needsYou` uses. */
const QUIET_STATES = new Set(["pending", "running", "done", "no-op"]);

/**
 * @param {string} runDir
 * @param {NotifyEvent} event
 * @returns {string}
 */
export function renderRunProgress(runDir, event) {
  const payload = /** @type {Payload} */ (JSON.parse(renderStatusJson(runDir)));
  const runsDir = dirname(runDir);
  const objectives = readObjectives(runDir);
  const snapshots = new Map(payload.nodes.map((node) => [node.id, readSnapshotSafe(runDir, node.id)]));
  const campaign = campaignSummary(runsDir, payload.campaignId);
  const label = labelsFor(detectLanguage([campaign?.goal], journalTexts(runsDir, payload.campaignId), [...objectives.values()]));
  const subject = subjectNode(payload.nodes, event.nodeId ?? null);
  /** @type {View} */
  const view = { runDir, runId: event.runId ?? basename(runDir), payload, objectives, snapshots, campaign, label, subject };

  const body = event.type === "run.terminal" ? runTerminal(view) : event.type === "attention" ? attention(view) : nodeTerminal(view);
  const lines = [...body, RULE, footer(view, event.type), ...updateLine(label)];
  return boundToCeiling(lines);
}

/**
 * Routine: the outcome, then asked / done / proof, then the phase.
 *
 * @param {View} view
 * @returns {string[]}
 */
function nodeTerminal(view) {
  const { subject, label, snapshots, objectives } = view;
  const snapshot = snapshots.get(subject.id) ?? {};
  const model = subject.workerRuntime ? ` · ${modelName(subject.workerRuntime)}` : "";
  const error = subject.errorCode && !SUCCESS.has(subject.status) ? ` · ${subject.errorCode}` : "";
  const headline = `${OUTCOME[subject.status] ?? "❔"} ${subject.id} · ${label(OUTCOME_LABEL[subject.status] ?? "doneIn")} ${shortSpan(subject)} · ${formatUsd(subject.costUsd)}${model}${error}`;
  const pad = padder(label, ["asked", "did", "proof"]);
  return [
    headline,
    "",
    `📦 ${pad("asked")} ${firstSentence(objectives.get(subject.id) ?? label("noObjective"))}`,
    `   ${pad("did")} ${firstSentence(workerSummary(snapshot) ?? label("noSummary"))}`,
    `   ${pad("proof")} ${proofLine(view, subject, snapshot)}`,
    "",
    phaseLine(view),
  ];
}

/**
 * Milestone: what every node delivered, the proof total, the campaign's own
 * bar and the money.
 *
 * @param {View} view
 * @returns {string[]}
 */
function runTerminal(view) {
  const { payload, label, snapshots, campaign } = view;
  const nodes = payload.nodes;
  const done = nodes.filter((node) => SUCCESS.has(node.status)).length;
  const waiting = nodes.filter((node) => !QUIET_STATES.has(node.status)).length;
  const tail = waiting ? ` · ${waiting} ${label("needsYou")}` : "";
  const headline = `🏁 ${runLabel(view)} · ${done}/${nodes.length} ${label("done")} · ${shortDuration(runSpanMs(nodes))} · ${formatUsd(payload.usage.costUsd)}${tail}`;

  const delivered = nodes.filter((node) => SUCCESS.has(node.status));
  const bullets = delivered.slice(0, DELIVERED_MAX_NODES).map((node) => `   • ${node.id} — ${firstSentence(workerSummary(snapshots.get(node.id) ?? {}) ?? label("noSummary"))}`);
  if (delivered.length > DELIVERED_MAX_NODES) bullets.push(`   • +${delivered.length - DELIVERED_MAX_NODES} ${label("more")}`);

  let checks = 0;
  let judgePasses = 0;
  let revisions = 0;
  for (const node of nodes) {
    const snapshot = snapshots.get(node.id) ?? {};
    checks += verificationCommands(snapshot).filter((command) => command.passed).length;
    if (gateOf(snapshot)?.verdict === "pass") judgePasses += 1;
    revisions += node.revisions ?? 0;
  }

  const lines = [
    headline,
    "",
    `📦 ${label("delivered")}`,
    ...bullets,
    `   ${label("proof")}  ${checks} ${label("checksGreen")} · ${judgePasses} ${label("judgePasses")} · ${revisions} ${label("revisions")}`,
    "",
  ];
  if (campaign) {
    lines.push(`${bar(campaign.percentDone / 100)} ${campaign.id} ${campaign.percentDone}% · ${campaign.phasesDone}/${campaign.phasesTotal} ${label("phases")} · ${formatUsdCompact(campaign.costTotalUsd)} · ${shortDuration(campaign.elapsedMs)}`);
  }
  lines.push(tokensLine(view));
  return lines;
}

/**
 * Action: why the node waits, what was asked, and the exact command, first.
 *
 * @param {View} view
 * @returns {string[]}
 */
function attention(view) {
  const { subject, label, snapshots, objectives, runDir } = view;
  const snapshot = snapshots.get(subject.id) ?? {};
  const reason = subject.errorCode ?? subject.status;
  const headline = `👀 ${subject.id} ${label("needsYou")} · ${reason} · ${label("attempt")} ${subject.attempt} · ${shortSpan(subject)} · ${formatUsd(subject.costUsd)}`;
  const pad = padder(label, ["why", "asked", "do"]);
  return [
    headline,
    "",
    `⚠️ ${pad("why")} ${whyLine(view, subject, snapshot)}`,
    `   ${pad("asked")} ${firstSentence(objectives.get(subject.id) ?? label("noObjective"))}`,
    `   ${pad("do")} ${decideCommand(runDir, subject, snapshot)}`,
    "",
    phaseLine(view),
  ];
}

/**
 * The phase as a bar: nodes done over declared, then either the next node
 * with its estimate or how many nodes wait on a person. Done and settled are
 * two numbers here as on the campaign page: a phase whose last node blocked
 * has nothing left to run and is still not complete.
 *
 * @param {View} view
 * @returns {string}
 */
function phaseLine(view) {
  const { payload, subject, label } = view;
  const phaseNodes = payload.nodes.filter((node) => node.phase === subject.phase);
  const done = phaseNodes.filter((node) => SUCCESS.has(node.status)).length;
  const next = phaseNodes.find((node) => !SETTLED.has(node.status));
  let tail = "";
  if (next) {
    const eta = remainingEstimateMs(phaseNodes, phaseNodes);
    tail = ` · ${label("next")} ${next.id}${eta ? ` ~${shortDuration(eta)}` : ""}`;
  } else {
    const waiting = phaseNodes.filter((node) => !QUIET_STATES.has(node.status)).length;
    tail = waiting ? ` · ${waiting} ${label("waitingOnYou")}` : done === phaseNodes.length ? ` · ${label("complete")}` : "";
  }
  return `${bar(phaseNodes.length ? done / phaseNodes.length : 0)} ${done}/${phaseNodes.length} ${label("nodes")}${tail}`;
}

/**
 * Tokens from the two roles, the reading the status table prints, with the
 * cache share beside them: the number that says where a turn's money goes.
 *
 * @param {View} view
 * @returns {string}
 */
function tokensLine(view) {
  const { roles } = view.payload;
  const label = view.label;
  const sum = /** @param {"inputTokens"|"outputTokens"|"cacheReadInputTokens"} kind */ (kind) => roles.worker[kind] + roles.judge[kind];
  const input = sum("inputTokens");
  const output = sum("outputTokens");
  const cache = sum("cacheReadInputTokens");
  const total = input + output + cache;
  const share = total ? ` (${Math.round((cache / total) * 100)}%)` : "";
  return `💸 ${compactTokens(input)} ${label("in")} · ${compactTokens(output)} ${label("out")} · ${compactTokens(cache)} ${label("cache")}${share}`;
}

/**
 * The signature: who sent this and where the campaign stands, or, once a run
 * has settled, the one command that moves the campaign next.
 *
 * @param {View} view
 * @param {string} eventType
 * @returns {string}
 */
function footer(view, eventType) {
  const { campaign, label, payload } = view;
  if (eventType === "run.terminal" && campaign?.nextCommand) {
    // `next.mjs` prints verbs without the program name, the way the CLI's
    // own usage does; a message read away from a shell needs the whole line.
    const command = /^(faberun|node) /u.test(campaign.nextCommand) ? campaign.nextCommand : `faberun ${campaign.nextCommand}`;
    return `${SIGNATURE} · ${label("nextCommand")}: ${command}`;
  }
  if (!campaign) return `${SIGNATURE} · ${payload.campaignId}`;
  return `${SIGNATURE} · ${campaign.id} ${campaign.percentDone}% · ${formatUsdCompact(campaign.costTotalUsd)} · ${shortDuration(campaign.elapsedMs)}`;
}

/**
 * One line when the cached update check names a release newer than the one
 * running. The cache only, never the network: `faberun update --check`
 * refreshes it, and a notification must never wait on a request.
 *
 * @param {(key: string) => string} label
 * @returns {string[]}
 */
function updateLine(label) {
  let check;
  try {
    check = readUpdateCheck(faberunHome());
  } catch {
    // An unreadable install root is the banner's problem to report, not the message's.
    return [];
  }
  if (!check || compareVersions(check.latest, packageVersion()) <= 0) return [];
  return [`⬆️ faberun ${check.latest} ${label("available")} · ${label("runUpdate")} faberun update`];
}

/**
 * How a node was proven: the green checks, the judge's word, the revisions
 * it took. A node with neither check nor judge says so rather than nothing.
 *
 * @param {View} view
 * @param {StatusPayloadNode} node
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
function proofLine(view, node, snapshot) {
  const label = view.label;
  const commands = verificationCommands(snapshot);
  const passed = commands.filter((command) => command.passed).length;
  const parts = [];
  if (commands.length) parts.push(passed === commands.length ? `${commands.length} ${label("checksGreen")}` : `${passed}/${commands.length} ${label("checksOf")}`);
  const gate = gateOf(snapshot);
  parts.push(gate ? (gate.verdict === "pass" ? label("judgePass") : label("judgeRejected")) : label("noJudge"));
  if (node.revisions) parts.push(`${node.revisions} ${label("revisions")}`);
  return parts.join(" · ");
}

/**
 * Why a node waits: the context it asked for, the judge's first finding, or
 * the error the controller recorded. Quoted text keeps its own language.
 *
 * @param {View} view
 * @param {StatusPayloadNode} node
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
function whyLine(view, node, snapshot) {
  const label = view.label;
  const result = resultOf(snapshot);
  if (result?.status === "blocked_context") {
    const missing = Array.isArray(result.missingContext) ? result.missingContext.filter((entry) => typeof entry === "string") : [];
    return `${label("missing")}: ${missing.length ? missing.join(", ") : "?"}`;
  }
  const gate = gateOf(snapshot);
  const finding = /** @type {{description?: unknown, summary?: unknown, title?: unknown}|undefined} */ (Array.isArray(gate?.findings) ? gate.findings[0] : undefined);
  const findingText = [finding?.description, finding?.summary, finding?.title, gate?.summary].find((value) => typeof value === "string" && value.trim());
  if (gate && gate.verdict !== "pass" && typeof findingText === "string") return `${label("judge")}: "${firstSentence(findingText)}"`;
  const error = /** @type {{message?: unknown}|null} */ (snapshot.error && typeof snapshot.error === "object" ? snapshot.error : null);
  const message = typeof error?.message === "string" && error.message.trim() ? ` — ${firstSentence(error.message)}` : "";
  return `${label("error")}: ${node.errorCode ?? node.status}${message}`;
}

/**
 * The exact command that unblocks the node, the way `src/report/next.mjs`
 * names one for its own items.
 *
 * @param {string} runDir
 * @param {StatusPayloadNode} node
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
function decideCommand(runDir, node, snapshot) {
  if (resultOf(snapshot)?.status === "blocked_context") return `faberun resume ${runDir} --answer ${node.id}=<answer-file>`;
  const gate = gateOf(snapshot);
  if (Array.isArray(gate?.findings) && gate.findings.length) return `faberun findings ${runDir}`;
  return `faberun status ${runDir}`;
}

/**
 * The campaign-wide numbers the message carries, taken from the same roll-up
 * `renderCampaignProgress` prints so the two never disagree. `null` when the
 * campaign record cannot be read, or declares no node at all.
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
  if (counts.total === 0) return null;
  const time = /** @type {{startedAt: string|null}} */ (progress.time);
  const started = time.startedAt ? Date.parse(time.startedAt) : NaN;
  const nextAction = /** @type {{command: string}|null} */ (progress.nextAction ?? null);
  return {
    id: campaignId,
    goal: typeof progress.goal === "string" ? progress.goal : null,
    percentDone: /** @type {number} */ (progress.percentDone),
    nodesTotal: counts.total,
    phasesDone: phases.filter((phase) => phase.counts.total > 0 && phase.counts.done === phase.counts.total).length,
    phasesTotal: phases.length,
    costTotalUsd: /** @type {number|null} */ (progress.costTotalUsd),
    elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
    nextCommand: nextAction?.command ?? null,
  };
}

/**
 * The operator's own words in the campaign journal, for the language the
 * message is written in. An unreadable journal contributes nothing.
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {string[]}
 */
function journalTexts(runsDir, campaignId) {
  try {
    return readJournal(campaignDir(runsDir, campaignId)).map((entry) => entry.text).filter((text) => typeof text === "string");
  } catch {
    return [];
  }
}

/**
 * Each node's objective from the run's own contract copy: what the plan
 * asked, in the plan's language. An unreadable copy yields no objectives.
 *
 * @param {string} runDir
 * @returns {Map<string, string|null>}
 */
function readObjectives(runDir) {
  try {
    const contract = /** @type {{nodes?: {id?: unknown, taskPacket?: {objective?: unknown}}[]}} */ (JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")));
    return new Map((contract.nodes ?? []).map((node) => [String(node.id), typeof node.taskPacket?.objective === "string" ? node.taskPacket.objective : null]));
  } catch {
    return new Map();
  }
}

/** @param {string} runDir @param {string} nodeId @returns {Record<string, unknown>} */
function readSnapshotSafe(runDir, nodeId) {
  try {
    return readNodeSnapshot(runDir, nodeId);
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} snapshot @returns {{status?: unknown, summary?: unknown, missingContext?: unknown}|null} */
function resultOf(snapshot) {
  return snapshot.result && typeof snapshot.result === "object" ? /** @type {{status?: unknown, summary?: unknown, missingContext?: unknown}} */ (snapshot.result) : null;
}

/** @param {Record<string, unknown>} snapshot @returns {{verdict?: unknown, summary?: unknown, findings?: unknown}|null} */
function gateOf(snapshot) {
  return snapshot.gate && typeof snapshot.gate === "object" ? /** @type {{verdict?: unknown, summary?: unknown, findings?: unknown}} */ (snapshot.gate) : null;
}

/** @param {Record<string, unknown>} snapshot @returns {{passed?: unknown}[]} */
function verificationCommands(snapshot) {
  const verification = /** @type {{commands?: unknown}|null} */ (snapshot.verification && typeof snapshot.verification === "object" ? snapshot.verification : null);
  return Array.isArray(verification?.commands) ? verification.commands : [];
}

/** @param {Record<string, unknown>} snapshot @returns {string|null} */
function workerSummary(snapshot) {
  const summary = resultOf(snapshot)?.summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
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
 * `run 15 · suites-on-their-own-schedule` for a run id the chain named
 * `<campaign>-15-suites-on-their-own-schedule`: the campaign is already in
 * the footer, and the number is how the operator refers to the phase.
 *
 * @param {View} view
 * @returns {string}
 */
function runLabel(view) {
  const { runId, payload, label } = view;
  const prefix = `${payload.campaignId}-`;
  const rest = runId.startsWith(prefix) ? runId.slice(prefix.length) : runId;
  const numbered = /^(\d+[a-z]?)-(.+)$/u.exec(rest);
  return numbered ? `${label("run")} ${numbered[1]} · ${numbered[2]}` : `${label("run")} ${rest}`;
}

/**
 * @param {(key: string) => string} label
 * @param {string[]} keys the labels that share one column
 * @returns {(key: string) => string}
 */
function padder(label, keys) {
  const width = Math.max(...keys.map((key) => label(key).length));
  return (key) => label(key).padEnd(width + 1);
}

/**
 * The first sentence of a text, whitespace collapsed, cut at a word when it
 * still runs past the ceiling. A quotation that ends mid-word is what the
 * old message did and what a reader stumbles on.
 *
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const flat = text.replace(/\s+/gu, " ").trim();
  const match = /^(.*?[.!?])(?=\s|$)/u.exec(flat);
  const sentence = match ? match[1] : flat;
  if (sentence.length <= SENTENCE_MAX_CHARS) return sentence;
  const cut = sentence.slice(0, SENTENCE_MAX_CHARS - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${atWord > SENTENCE_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut}…`;
}

/** @param {number} fraction @returns {string} */
function bar(fraction) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(fraction * BAR_CELLS)));
  return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
}

/**
 * A duration a person reads at a glance: seconds under a minute, minutes
 * under an hour, hours and minutes under a day, days and hours beyond.
 *
 * @param {number|null} ms
 * @returns {string}
 */
function shortDuration(ms) {
  if (ms === null || !Number.isFinite(ms)) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** @param {{startedAt: string|null, updatedAt: string|null}} node @returns {string} */
function shortSpan(node) {
  if (!node.startedAt || !node.updatedAt) return "-";
  const start = Date.parse(node.startedAt);
  const end = Date.parse(node.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? shortDuration(Math.max(0, end - start)) : "-";
}

/** @param {StatusPayloadNode[]} nodes @returns {number|null} */
function runSpanMs(nodes) {
  const starts = nodes.map((node) => (node.startedAt ? Date.parse(node.startedAt) : NaN)).filter(Number.isFinite);
  const ends = nodes.map((node) => (node.updatedAt ? Date.parse(node.updatedAt) : NaN)).filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/** @param {string} runtime `harness/model` as the status payload labels it @returns {string} */
function modelName(runtime) {
  const slash = runtime.indexOf("/");
  return slash >= 0 ? runtime.slice(slash + 1) : runtime;
}

/**
 * Two decimals, the way a person reads money in a notification; the
 * six-decimal `compactCost` stays for ledgers and tables. A cost under a cent
 * is said to be under a cent rather than rounded to nothing; unknown is `$-`.
 *
 * @param {number|null} value
 * @returns {string}
 */
function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$-";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** Whole dollars once a campaign passes a hundred: `$132`, not `$132.21`, in a footer. @param {number|null} value @returns {string} */
function formatUsdCompact(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 100) return `$${Math.round(value)}`;
  return formatUsd(value);
}

/**
 * The delivered bullets are the only block that grows with the run, so they
 * are dropped from the end first when the whole message would exceed the
 * ceiling; a byte cut on the joined text is the last resort.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function boundToCeiling(lines) {
  const kept = [...lines];
  while (Buffer.byteLength(kept.join("\n"), "utf8") > PROGRESS_MESSAGE_MAX_BYTES) {
    const lastBullet = kept.map((line) => line.startsWith("   • ")).lastIndexOf(true);
    if (lastBullet < 0) break;
    kept.splice(lastBullet, 1);
  }
  return boundedUtf8(kept.join("\n"), PROGRESS_MESSAGE_MAX_BYTES);
}
