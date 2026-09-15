/**
 * `operator-brief.md`: the smallest set of durable facts a fresh seat needs to
 * take over a campaign, inside a hard 4 KiB budget.
 *
 * It is a pure function of recorded facts -- the projected state plus each
 * linked run's `status.json` -- so the same facts always produce the same bytes
 * and a brief can be rebuilt from the append-only journal alone. No model
 * writes it: a generated summary could not be reconstructed after the seat that
 * would have generated it died, which is the only case the brief exists for.
 *
 * The budget is a hard ceiling, not a target. A brief that overflows is the
 * symptom of incomplete durable state, so what does not fit is dropped as whole
 * records with a visible omission note, never by slicing the document.
 */
import { BRIEF_BYTES, BRIEF_FILE, ID_CAP_FLOOR } from "./layout.mjs";
import { boundedText, compactCost, compactTokens, finite, readJsonTolerant } from "../util.mjs";
import { join } from "node:path";
import { readCampaign } from "./record.mjs";
import { readProjectionState } from "./projection.mjs";
import { writeTextAtomic } from "../run/store.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").JournalEntry} JournalEntry */
/** @typedef {import("./index.mjs").Projection} Projection */
/** @typedef {{id: string, exists: boolean, summary: string, controller: string, phase: string|null, done: number, total: number, costUsd: number|null, inputTokens: number|null, outputTokens: number|null, attention: {id: string, status: string, note: string}[]}} BriefRun */
/** @typedef {{campaign: Campaign, updatedAt: string, phase: string|null, checkpoints: {done: number, total: number}, runs: BriefRun[], openQuestions: JournalEntry[], transitions: JournalEntry[], budget: {costUsd: number|null, inputTokens: number|null, outputTokens: number|null}, notes: JournalEntry[], commands: string[]}} Brief */
/** @typedef {{limit: number, used: number, lines: string[]}} BriefBudget */

const BRIEF_TEXT_BYTES = 512;
const TEXT_CAPS = [BRIEF_TEXT_BYTES, 256, 128, 64, 0];
const SECTION_FLOOR_BYTES = 256;
const TRANSITION_LIMIT = 3;
const OPERATOR_NOTE_LIMIT = 5;
const RUN_LINE_LIMIT = 8;
const QUESTION_LINE_LIMIT = 8;
const ATTENTION_LINE_LIMIT = 3;
const QUIET_NODE_STATUSES = ["pending", "running", "done", "no-op"];

/**
 * The facts of one brief, split from its rendering so the same facts always
 * render the same markdown.
 *
 * @param {Campaign} campaign
 * @param {Projection} state
 * @param {BriefRun[]} runSummaries
 * @returns {Brief}
 */
export function briefFromState(campaign, state, runSummaries) {
  return {
    campaign,
    updatedAt: state.updatedAt ?? campaign.updatedAt,
    phase: runSummaries.find((run) => run.phase !== null)?.phase ?? null,
    checkpoints: {
      done: runSummaries.reduce((total, run) => total + run.done, 0),
      total: runSummaries.reduce((total, run) => total + run.total, 0),
    },
    runs: runSummaries,
    openQuestions: sortEntries(Object.values(state.questions)),
    transitions: recentTransitions(state),
    budget: totalBudget(runSummaries),
    notes: state.intents.slice(-OPERATOR_NOTE_LIMIT),
    commands: briefCommands(campaign.id),
  };
}

/**
 * @param {string} campaignPath
 * @param {Brief} brief
 * @returns {string}
 */
export function materializeBrief(campaignPath, brief) {
  const text = fitBrief(brief);
  writeTextAtomic(join(campaignPath, BRIEF_FILE), text);
  return text;
}

/**
 * Read the campaign's live projection and each linked run's `status.json`, then
 * materialize the brief. `heartbeat.json` does not exist in this tree -- the
 * projection and per-run status are the durable sources.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @returns {string}
 */
export function renderBrief(campaignPath, runsDir) {
  const campaign = readCampaign(campaignPath);
  const { state } = readProjectionState(campaignPath, campaign);
  return materializeBrief(campaignPath, briefFromState(campaign, state, readRunBriefs(runsDir, campaign.linkedRunIds)));
}

/**
 * @param {string} runsDir
 * @param {string[]} runIds
 * @returns {BriefRun[]}
 */
function readRunBriefs(runsDir, runIds) {
  return runIds.map((runId) => runBrief(runId, readJsonTolerant(join(runsDir, runId, "status.json"))));
}

/**
 * @param {string} runId
 * @param {unknown} status
 * @returns {BriefRun}
 */
function runBrief(runId, status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return missingRunBrief(runId);
  const record = /** @type {Record<string, any>} */ (status);
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const usage = record.usage && typeof record.usage === "object" ? /** @type {Record<string, unknown>} */ (record.usage) : {};
  const active = nodes.find((node) => node.status === "running")
    ?? nodes.find((node) => !QUIET_NODE_STATUSES.includes(String(node.status)));
  /** @type {string|null} */
  let phase = null;
  if (active) {
    if (typeof active.phase === "string") phase = active.phase;
    else if (typeof active.executionPhase === "string") phase = active.executionPhase;
  }
  return {
    id: runId,
    exists: true,
    summary: typeof record.summary === "string" ? record.summary : "",
    controller: typeof record.controller?.state === "string" ? record.controller.state : "none",
    phase,
    done: nodes.filter((node) => node.status === "done" || node.status === "no-op").length,
    total: nodes.length,
    costUsd: finite(usage.costUsd),
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    attention: nodes
      .filter((node) => !QUIET_NODE_STATUSES.includes(String(node.status)))
      .map((node) => ({
        id: String(node.id ?? ""),
        status: String(node.status ?? ""),
        note: typeof node.note === "string" ? node.note : typeof node.errorCode === "string" ? node.errorCode : "",
      })),
  };
}

/**
 * @param {string} runId
 * @returns {BriefRun}
 */
function missingRunBrief(runId) {
  return { id: runId, exists: false, summary: "no status.json yet", controller: "none", phase: null, done: 0, total: 0, costUsd: null, inputTokens: null, outputTokens: null, attention: [] };
}

/**
 * @param {Projection} state
 * @returns {JournalEntry[]}
 */
function recentTransitions(state) {
  /** @type {JournalEntry[]} */
  const entries = [
    ...state.sessions,
    ...Object.values(state.decisions),
    ...state.constraints,
    ...state.outcomes,
    ...Object.values(state.questions),
  ];
  if (state.next) entries.push(state.next);
  return sortEntries(entries).slice(-TRANSITION_LIMIT);
}

/**
 * @param {BriefRun[]} runs
 * @returns {{costUsd: number|null, inputTokens: number|null, outputTokens: number|null}}
 */
function totalBudget(runs) {
  /** @type {{costUsd: number|null, inputTokens: number|null, outputTokens: number|null}} */
  const budget = { costUsd: null, inputTokens: null, outputTokens: null };
  for (const run of runs) {
    if (typeof run.costUsd === "number") budget.costUsd = (budget.costUsd ?? 0) + run.costUsd;
    if (typeof run.inputTokens === "number") budget.inputTokens = (budget.inputTokens ?? 0) + run.inputTokens;
    if (typeof run.outputTokens === "number") budget.outputTokens = (budget.outputTokens ?? 0) + run.outputTokens;
  }
  return budget;
}

/**
 * @param {JournalEntry[]} entries
 * @returns {JournalEntry[]}
 */
function sortEntries(entries) {
  return [...entries].sort(compareEntries);
}

/**
 * @param {JournalEntry} left
 * @param {JournalEntry} right
 * @returns {number}
 */
function compareEntries(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  if (left.eventId !== right.eventId) return left.eventId < right.eventId ? -1 : 1;
  return 0;
}

/**
 * @param {string} campaignId
 * @returns {string[]}
 */
function briefCommands(campaignId) {
  return [
    `intent-factory campaign show ${campaignId}`,
    `intent-factory campaign sync ${campaignId} --session-id <session>`,
    `intent-factory campaign ack ${campaignId} --session-id <session> --event-id <event>`,
    `intent-factory campaign attach ${campaignId} --tool <tool> --session-id <session> (--transcript <path> | --no-transcript)`,
    `intent-factory campaign note ${campaignId} --session-id <session> --kind <kind> --text <text>`,
    `intent-factory campaign resolve ${campaignId} --session-id <session> --question-id <question> --text <text>`,
  ];
}

// The ceiling is enforced line by line against BRIEF_BYTES, and every section
// after the current one keeps a floor so a flood of run lines or questions can
// never starve the budget, the notes or the commands. Entry text shrinks
// through descending caps (like fitHandoff) until no section is lost entirely.
/**
 * @param {Brief} brief
 * @returns {string}
 */
function fitBrief(brief) {
  for (const cap of TEXT_CAPS) {
    const rendered = renderBudgeted(brief, cap);
    if (rendered.criticalLost === 0) return rendered.text;
  }
  return renderBudgeted(brief, 0).text;
}

/**
 * @param {Brief} brief
 * @param {number} cap
 * @returns {{text: string, criticalLost: number}}
 */
function renderBudgeted(brief, cap) {
  const idCap = Math.max(cap, ID_CAP_FLOOR);
  const budget = /** @type {BriefBudget} */ ({ limit: BRIEF_BYTES, used: 0, lines: [] });
  addLine(budget, `# campaign ${boundedText(brief.campaign.id, idCap)} brief`);
  addLine(budget, "");
  addLine(budget, `Updated: ${brief.updatedAt}`);
  addLine(budget, "");
  addLine(budget, `Goal: ${boundedText(brief.campaign.goal, cap)}`);
  addLine(budget, "");
  addLine(budget, `Phase: ${brief.phase === null ? "unknown" : boundedText(brief.phase, cap)} · checkpoints: ${brief.checkpoints.done}/${brief.checkpoints.total}`);
  addLine(budget, "");
  const runs = brief.runs.slice(-RUN_LINE_LIMIT).map((run) => runLine(run, cap, idCap));
  const questions = brief.openQuestions.slice(-QUESTION_LINE_LIMIT)
    .map((entry) => `- [${boundedText(entry.questionId ?? "-", idCap)}] ${boundedText(entry.text ?? "", cap)}`);
  const transitions = brief.transitions.map((entry) => `- ${transitionLine(entry, cap, idCap)}`);
  const notes = brief.notes.map((entry) => `- ${boundedText(entry.text ?? "", cap)} · ${boundedText(entry.sessionId ?? "-", idCap)} · ${boundedText(entry.at, idCap)}`);
  const commands = brief.commands.map((command) => `- ${command}`);
  let criticalLost = 0;
  criticalLost += addLineSection(budget, "Current state", [`- status: ${brief.campaign.status}`, `- linked runs: ${brief.runs.length}`], runs, "run summaries", 6);
  criticalLost += addLineSection(budget, "Open decisions", [], questions, "open decisions", 5);
  criticalLost += addLineSection(budget, "Recent transitions", [], transitions, "transitions", 4);
  criticalLost += addLineSection(budget, "Budget consumed", [], [`- ${budgetLine(brief.budget)}`], "budget lines", 3);
  criticalLost += addLineSection(budget, "Operator notes", [], notes, "operator notes", 2);
  criticalLost += addLineSection(budget, "Commands", [], commands, "commands", 1);
  return { text: `${budget.lines.join("\n")}\n`, criticalLost };
}

/**
 * @param {BriefBudget} budget
 * @param {string} title
 * @param {string[]} prefix
 * @param {string[]} lines
 * @param {string} label
 * @param {number} sectionsLeft
 * @returns {0|1}
 */
function addLineSection(budget, title, prefix, lines, label, sectionsLeft) {
  const limit = sectionLimit(sectionsLeft);
  addLine(budget, `## ${title}`);
  addLine(budget, "");
  for (const line of prefix) addLine(budget, line);
  if (!lines.length) {
    addLine(budget, "- none");
    addLine(budget, "");
    return 0;
  }
  const kept = fitLines(budget, lines, label, limit);
  addLine(budget, "");
  return kept === 0 ? 1 : 0;
}

/**
 * The absolute byte ceiling for a section: every section still to come keeps
 * its floor, so the last section is never starved by the first.
 *
 * @param {number} sectionsLeft
 * @returns {number}
 */
function sectionLimit(sectionsLeft) {
  return BRIEF_BYTES - SECTION_FLOOR_BYTES * Math.max(0, sectionsLeft - 1);
}

/**
 * Keep the latest whole lines that fit; older ones are summarized, never
 * silently dropped. Returns the number of lines actually added.
 *
 * @param {BriefBudget} budget
 * @param {string[]} lines
 * @param {string} label
 * @param {number} limit
 * @returns {number}
 */
function fitLines(budget, lines, label, limit) {
  /** @type {string[]} */
  const kept = [];
  let projected = budget.used;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = byteLength(lines[index]) + 1;
    if (projected + bytes > limit) break;
    projected += bytes;
    kept.unshift(lines[index]);
  }
  while (kept.length) {
    const note = `- ${lines.length - kept.length} earlier ${label} omitted`;
    if (projected + byteLength(note) + 1 <= limit) break;
    const removed = kept.shift();
    if (removed === undefined) break;
    projected -= byteLength(removed) + 1;
  }
  for (const line of kept) addLine(budget, line);
  const dropped = lines.length - kept.length;
  if (dropped > 0) addLine(budget, `- ${dropped} earlier ${label} omitted`);
  return kept.length;
}

/**
 * @param {BriefBudget} budget
 * @param {string} line
 * @returns {boolean}
 */
function addLine(budget, line) {
  const bytes = byteLength(line) + 1;
  if (budget.used + bytes > budget.limit) return false;
  budget.lines.push(line);
  budget.used += bytes;
  return true;
}

/**
 * @param {string} value
 * @returns {number}
 */
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * A run is one line so it is kept or dropped whole, never cut between its
 * summary and its attention states.
 *
 * @param {BriefRun} run
 * @param {number} cap
 * @param {number} idCap
 * @returns {string}
 */
function runLine(run, cap, idCap) {
  const id = boundedText(run.id, idCap);
  if (!run.exists) return `- ${id}: no status.json yet`;
  const attention = run.attention.slice(0, ATTENTION_LINE_LIMIT).map((node) => {
    const note = node.note ? ` ${boundedText(node.note, cap)}` : "";
    return `${boundedText(node.id, idCap)}: ${boundedText(node.status, cap)}${note}`;
  });
  const hidden = run.attention.length - ATTENTION_LINE_LIMIT;
  if (hidden > 0) attention.push(`${hidden} more`);
  const detail = attention.length ? ` · ${attention.join("; ")}` : "";
  return `- ${id}: ${boundedText(run.summary, cap)} · checkpoints ${run.done}/${run.total} · controller ${boundedText(run.controller, cap)}${detail}`;
}

/**
 * @param {JournalEntry} entry
 * @param {number} cap
 * @param {number} idCap
 * @returns {string}
 */
function transitionLine(entry, cap, idCap) {
  const id = entry.decisionId ?? entry.questionId ?? entry.runId;
  const label = id === undefined ? "" : `[${boundedText(id, idCap)}] `;
  const text = entry.type === "session.attached"
    ? `session ${boundedText(entry.sessionId ?? "-", idCap)} (${boundedText(entry.tool ?? "-", idCap)})`
    : boundedText(entry.text ?? "", cap);
  return `${boundedText(entry.at, idCap)} ${entry.type} ${label}${text}`;
}

/**
 * @param {{costUsd: number|null, inputTokens: number|null, outputTokens: number|null}} budget
 * @returns {string}
 */
function budgetLine(budget) {
  return `cost ${compactCost(budget.costUsd)} · input ${compactTokens(budget.inputTokens)} · output ${compactTokens(budget.outputTokens)} tokens`;
}
