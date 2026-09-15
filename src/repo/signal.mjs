/**
 * The faberun signal block in the target repository's AGENTS.md.
 *
 * Every agent that opens the repository — whatever the harness — reads
 * AGENTS.md before its first prompt. The runner mirrors its active state
 * there so a takeover session learns that active work exists without
 * probing .runs/. The block is machine-managed: agents read it, never edit
 * it.
 *
 * The defect this module fixes is what the block says, not whether it is
 * rewritten. A run that parked — every node terminal but none successful —
 * used to disappear, because the old renderer only listed runs holding a
 * node that was not terminal. A session reading the block learned nothing
 * about the work that most needs it. The block now renders the phase-2
 * `runOutcome` per linked run: `parked` with its nodes, their error codes and
 * the exact `resume` command; `succeeded` as one line; plus the most recent
 * campaign-level `attention` entry from `.runs/inbox.jsonl`. It is bounded,
 * because every session pays for it in its first tokens.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverCampaigns } from "../campaign/index.mjs";
import { runProgress } from "../engine/supervise.mjs";
import { readInbox } from "../notify/index.mjs";
import { SIGNAL_END, SIGNAL_START } from "./signal-block.mjs";
import { HANDOFF_FILE } from "../campaign/layout.mjs";

export { SIGNAL_END, SIGNAL_START } from "./signal-block.mjs";

/** Keep the block cheap for every session; a campaign with many runs is summarised, not dumped. */
const SIGNAL_LINES_BYTE_BUDGET = 2_600;
/** How many parked nodes are named before the rest are counted. */
const MAX_PARKED_NODES = 6;
/** One attention entry, bounded like a notification summary. */
const ATTENTION_CHARS = 200;

const HEADER = "Before starting new work here, check `.runs/`: if a campaign is active or a run is not terminal, continue it instead of starting over — read its `HANDOFF.md`/`STATUS.md`, attach to the campaign, and `resume` or `supervise` the run. Active runs are supervised by a deterministic detached process: do not poll `status` in a loop — on resume, check status once and act only on terminal states.";

/**
 * @param {string} runsDir
 * @returns {string}
 */
export function renderAgentSignalBlock(runsDir) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<string>} */
  const linked = new Set();
  const { campaigns } = discoverCampaigns(runsDir);
  for (const { campaign } of campaigns.filter(({ campaign }) => campaign.status !== "closed")) {
    lines.push(`- faberun campaign \`${campaign.id}\`: active — read \`.runs/campaigns/${campaign.id}/${HANDOFF_FILE}\``);
    for (const runId of campaign.linkedRunIds) {
      linked.add(runId);
      lines.push(...runSignalLines(runsDir, runId));
    }
    const attention = campaignAttentionLine(runsDir, campaign);
    if (attention) lines.push(attention);
  }
  for (const line of activeRunLines(runsDir, linked)) lines.push(line);
  if (!lines.length) return "";
  return `${SIGNAL_START}\n${HEADER}\n\n${boundLines(lines).join("\n")}\n${SIGNAL_END}`;
}

/**
 * One linked run's outcome as block lines. `runProgress` folds the phase-2
 * `runOutcome`, so a parked run is rendered by its own declared nodes rather
 * than being dropped for having no non-terminal one.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {string[]}
 */
function runSignalLines(runsDir, runId) {
  const runDir = join(runsDir, runId);
  const resume = `node src/cli.mjs resume ${runDir}`;
  if (!existsSync(runDir)) {
    return [`  - run \`${runId}\`: missing — resume \`${resume}\``];
  }
  const progress = runProgress(runDir);
  switch (progress.runOutcome) {
    case "succeeded":
      return [`  - run \`${runId}\`: succeeded (${progress.terminal}/${progress.total} nodes)`];
    case "canceled":
      return [`  - run \`${runId}\`: canceled`];
    case "waiting":
      return [`  - run \`${runId}\`: waiting${progress.waitingUntil ? ` until ${progress.waitingUntil}` : ""} — supervise \`node src/cli.mjs supervise ${runDir}\``];
    case "parked":
      break;
    default:
      // No snapshot yet: the run exists but has not proved an outcome. It is
      // active work, not parked work, so it must not claim parked nodes.
      return [`  - run \`${runId}\`: active — read \`.runs/${runId}/STATUS.md\`; \`resume\` or \`supervise\` it`];
  }
  const nodes = progress.outcomeNodes ?? [];
  const shown = nodes.slice(0, MAX_PARKED_NODES).map(nodeText).join(", ");
  const more = nodes.length > MAX_PARKED_NODES ? `, +${nodes.length - MAX_PARKED_NODES} more` : "";
  return [`  - run \`${runId}\`: parked — ${shown || "no nodes named"}${more} — resume \`${resume}\``];
}

/**
 * Standalone runs that no active campaign links. A parked run is included, so
 * a run with no campaign at all still blocks a naive "start fresh".
 *
 * @param {string} runsDir
 * @param {Set<string>} linked
 * @returns {string[]}
 */
function activeRunLines(runsDir, linked) {
  if (!existsSync(runsDir)) return [];
  /** @type {string[]} */
  const lines = [];
  for (const name of readdirSync(runsDir)) {
    if (linked.has(name)) continue;
    const nodeDir = join(runsDir, name, "nodes");
    if (!existsSync(nodeDir)) continue;
    const runDir = join(runsDir, name);
    const progress = runProgress(runDir);
    // A nodes directory with no committed snapshot is a creation in progress,
    // not evidence of work; the old renderer left it off and so does this one.
    if (progress.runOutcome === undefined && progress.total === 0) continue;
    if (progress.runOutcome === "succeeded" || progress.runOutcome === "canceled") continue;
    const resume = `node src/cli.mjs resume ${runDir}`;
    if (progress.runOutcome === "parked" && progress.state === "done") {
      const nodes = (progress.outcomeNodes ?? []).slice(0, MAX_PARKED_NODES).map(nodeText).join(", ");
      lines.push(`- faberun run \`${name}\`: parked — ${nodes || "no nodes named"} — resume \`${resume}\``);
    } else {
      lines.push(`- faberun run \`${name}\`: active (${progress.terminal}/${progress.total} nodes done) — read \`.runs/${name}/STATUS.md\`; \`resume\` or \`supervise\` it`);
    }
  }
  return lines;
}

/**
 * The most recent campaign-level attention: an inbox entry when one exists,
 * otherwise the durable record on the campaign itself.
 *
 * @param {string} runsDir
 * @param {import("../campaign/index.mjs").Campaign} campaign
 * @returns {string|null}
 */
function campaignAttentionLine(runsDir, campaign) {
  const latest = readInbox(runsDir)
    .filter((entry) => entry.type === "attention" && (entry.campaignId === campaign.id || entry.campaignId === null))
    .at(-1);
  if (latest) return `  - attention: ${boundedAttention(latest.summary)}`;
  if (campaign.attention && typeof campaign.attention.message === "string") {
    const code = campaign.attention.code ? ` (${campaign.attention.code})` : "";
    return `  - attention: ${boundedAttention(`${campaign.attention.message}${code}`)}`;
  }
  return null;
}

/**
 * @param {import("../engine/supervise.mjs").OutcomeNode} node
 * @returns {string}
 */
function nodeText(node) {
  return `\`${node.id}:${node.status ?? "unknown"}${node.errorCode ? ` ${node.errorCode}` : ""}\``;
}

/** @param {string} value @returns {string} */
function boundedAttention(value) {
  return value.length <= ATTENTION_CHARS ? value : `${value.slice(0, ATTENTION_CHARS - 1)}…`;
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function boundLines(lines) {
  /** @type {string[]} */
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > SIGNAL_LINES_BYTE_BUDGET) {
      out.push("- … signal truncated; read the campaign HANDOFF.md for the rest");
      break;
    }
    out.push(line);
    bytes += size;
  }
  return out;
}

/**
 * Rewrites the managed signal block at the bottom of <repo>/AGENTS.md from
 * the current .runs state. Leaves the file untouched when there is no
 * AGENTS.md, no active work, or nothing changed. Returns true when the file
 * was written.
 *
 * @param {string} runsDir
 * @returns {boolean}
 */
export function syncAgentSignal(runsDir) {
  const agentsPath = join(dirname(runsDir), "AGENTS.md");
  if (!existsSync(agentsPath)) return false;
  const current = readFileSync(agentsPath, "utf8");
  const block = renderAgentSignalBlock(runsDir);
  const start = current.indexOf(SIGNAL_START);
  const end = current.indexOf(SIGNAL_END);
  if (!block && start < 0 && end < 0) return false;
  let before;
  let after;
  if (start >= 0 && end > start) {
    before = current.slice(0, start).trimEnd();
    after = current.slice(end + SIGNAL_END.length);
  } else if (start >= 0) {
    before = current.slice(0, start).trimEnd();
    after = "";
  } else if (end >= 0) {
    before = current.slice(0, end).trimEnd();
    after = current.slice(end + SIGNAL_END.length);
  } else {
    before = current.trimEnd();
    after = "";
  }
  const next = [before, block, after.trimStart()].filter((part) => part.length).join("\n\n") + "\n";
  if (next === current) return false;
  writeFileSync(agentsPath, next);
  return true;
}
