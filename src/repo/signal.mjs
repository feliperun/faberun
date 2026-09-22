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
 * `attention` entry from `.runs/inbox.jsonl`. An attention belongs to one
 * campaign or none: an explicit `campaignId` decides, a null one is resolved
 * from the entry's `runId` (a run belongs to at most one campaign), and an
 * entry whose run no active campaign owns is shown once at run level instead
 * of under every campaign at once. It is bounded, because every session pays
 * for it in its first tokens.
 *
 * `parked` is decided by `classifyRunProgress`, never by reading `runOutcome`
 * here. `reduceRunOutcome` is a reduction over snapshots with no notion of
 * in-flight: a node whose status is `running` is not a success, so it reduces
 * to `parked` while the controller is still working on it. Measured
 * 2026-09-22 on a live run: `runOutcome "parked"`, one node `running`,
 * `controllerAlive true`. The linked-run renderer read that field raw and told
 * a takeover session to `resume` a run that was 23 minutes into its second
 * node. The standalone renderer had the conjunct (`&& state === "done"`) and
 * was right; two copies of one rule, one of them incomplete, so now there is
 * one copy and it lives in `chain.mjs` with the campaign decision it also
 * governs.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverCampaigns } from "../campaign/index.mjs";
import { runProgress } from "../engine/supervise.mjs";
import { readInbox } from "../notify/index.mjs";
import { repositoryForRunsDir } from "../run/paths.mjs";
import { SIGNAL_END, SIGNAL_START } from "./signal-block.mjs";
import { HANDOFF_FILE } from "../campaign/layout.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";

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
  const active = discoverCampaigns(runsDir).campaigns.filter(({ campaign }) => campaign.status !== "closed");
  const ownerByRun = runOwnerIndex(active);
  for (const { campaign } of active) {
    lines.push(`- faberun campaign \`${campaign.id}\`: active — read \`.runs/campaigns/${campaign.id}/${HANDOFF_FILE}\``);
    for (const runId of campaign.linkedRunIds) {
      linked.add(runId);
      lines.push(...runSignalLines(runsDir, runId));
    }
    const attention = campaignAttentionLine(runsDir, campaign, ownerByRun);
    if (attention) lines.push(attention);
  }
  for (const line of activeRunLines(runsDir, linked)) lines.push(line);
  const orphan = orphanAttentionLine(runsDir, ownerByRun);
  if (orphan) lines.push(orphan);
  if (!lines.length) return "";
  return `${SIGNAL_START}\n${HEADER}\n\n${boundLines(lines).join("\n")}\n${SIGNAL_END}`;
}

/**
 * Which active campaign owns each run, read from the campaigns' own
 * `linkedRunIds`. A run belongs to at most one campaign, so the first
 * campaign naming a run wins; a run no active campaign names is absent from
 * the map, and that absence — never a guess — is what makes an inbox entry
 * unattributable.
 *
 * @param {{campaign: import("../campaign/index.mjs").Campaign}[]} active
 * @returns {Map<string, string>}
 */
function runOwnerIndex(active) {
  /** @type {Map<string, string>} */
  const ownerByRun = new Map();
  for (const { campaign } of active) {
    for (const runId of campaign.linkedRunIds) {
      if (!ownerByRun.has(runId)) ownerByRun.set(runId, campaign.id);
    }
  }
  return ownerByRun;
}

/**
 * One linked run's outcome as block lines. A parked run is rendered by its own
 * declared nodes rather than being dropped for having no non-terminal one --
 * but only once `classifyRunProgress` agrees it settled.
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
  switch (classifyRunProgress(progress)) {
    case "succeeded":
      return [`  - run \`${runId}\`: succeeded (${progress.terminal}/${progress.total} nodes)`];
    case "canceled":
      return [`  - run \`${runId}\`: canceled`];
    case "waiting":
      return [`  - run \`${runId}\`: waiting${progress.waitingUntil ? ` until ${progress.waitingUntil}` : ""} — supervise \`node src/cli.mjs supervise ${runDir}\``];
    case "parked":
      break;
    default:
      // `unfinished`: either no snapshot yet, or a node still running. Both are
      // active work, not parked work, so neither may claim parked nodes.
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
    const classified = classifyRunProgress(progress);
    if (classified === "succeeded" || classified === "canceled") continue;
    const resume = `node src/cli.mjs resume ${runDir}`;
    if (classified === "parked") {
      const nodes = (progress.outcomeNodes ?? []).slice(0, MAX_PARKED_NODES).map(nodeText).join(", ");
      lines.push(`- faberun run \`${name}\`: parked — ${nodes || "no nodes named"} — resume \`${resume}\``);
    } else {
      lines.push(`- faberun run \`${name}\`: active (${progress.terminal}/${progress.total} nodes done) — read \`.runs/${name}/STATUS.md\`; \`resume\` or \`supervise\` it`);
    }
  }
  return lines;
}

/**
 * The most recent attention this campaign owns: an inbox entry when one
 * exists, otherwise the durable record on the campaign itself.
 *
 * @param {string} runsDir
 * @param {import("../campaign/index.mjs").Campaign} campaign
 * @param {Map<string, string>} ownerByRun
 * @returns {string|null}
 */
function campaignAttentionLine(runsDir, campaign, ownerByRun) {
  const latest = readInbox(runsDir)
    .filter((entry) => entry.type === "attention" && attentionBelongsTo(entry, campaign.id, ownerByRun))
    .at(-1);
  if (latest) return `  - attention: ${boundedAttention(latest.summary)}`;
  if (campaign.attention && typeof campaign.attention.message === "string") {
    const code = campaign.attention.code ? ` (${campaign.attention.code})` : "";
    return `  - attention: ${boundedAttention(`${campaign.attention.message}${code}`)}`;
  }
  return null;
}

/**
 * An attention belongs to one campaign or none. An explicit `campaignId` is
 * authoritative; a null one is resolved from the entry's `runId` through the
 * run-owner index. Measured 2026-09-21: all 12 attention entries in the live
 * inbox carry null, so the old `campaignId === null` fallback attributed an
 * orphan to every campaign at once, permanently. An entry whose run resolves
 * to no active campaign belongs to none and is surfaced once at run level by
 * `orphanAttentionLine`, not dropped.
 *
 * @param {import("../notify/index.mjs").InboxEntry} entry
 * @param {string} campaignId
 * @param {Map<string, string>} ownerByRun
 * @returns {boolean}
 */
function attentionBelongsTo(entry, campaignId, ownerByRun) {
  if (entry.campaignId !== null) return entry.campaignId === campaignId;
  return entry.runId !== null && ownerByRun.get(entry.runId) === campaignId;
}

/**
 * The most recent attention no campaign owns, as one run-level line. Dropping
 * it would trade the old wrong report (every campaign) for a missing one, and
 * the run-level section of the block is where campaign-less work already
 * lives.
 *
 * @param {string} runsDir
 * @param {Map<string, string>} ownerByRun
 * @returns {string|null}
 */
function orphanAttentionLine(runsDir, ownerByRun) {
  const latest = readInbox(runsDir)
    .filter((entry) => entry.type === "attention" && entry.campaignId === null && (entry.runId === null || !ownerByRun.has(entry.runId)))
    .at(-1);
  if (!latest) return null;
  const subject = latest.runId ? `run \`${latest.runId}\`` : "an entry with no run";
  return `- attention: ${subject} resolves to no campaign — ${boundedAttention(latest.summary)}`;
}

/**
 * @param {import("../engine/supervise.mjs").OutcomeNode} node
 * @returns {string}
 */
function nodeText(node) {
  return `\`${node.id}:${node.status ?? "unknown"}${node.errorCode ? ` ${node.errorCode}` : ""}\``;
}

/**
 * The managed block is a list of single lines, so a multi-line summary (the
 * inbox now carries `renderRunProgress`'s full, multi-line message for a
 * `node.terminal`/`run.terminal`/`attention` event) is collapsed to its first
 * line before the character bound applies. The block stays a pointer; the
 * whole message lives in the inbox, one read away.
 *
 * @param {string} value
 * @returns {string}
 */
function boundedAttention(value) {
  const line = value.split("\n")[0];
  return line.length <= ATTENTION_CHARS ? line : `${line.slice(0, ATTENTION_CHARS - 1)}…`;
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
 * Rewrites the managed signal block at the bottom of the repository's
 * AGENTS.md from the current runs state. Leaves the file untouched when there
 * is no AGENTS.md, no active work, or nothing changed. Returns true when the
 * file was written.
 *
 * The repository is named by the project registry, not derived as a sibling
 * of `runsDir`: since the runs directory moved under the home, a directory
 * climb would land inside `<home>/projects/<id>` and the block would silently
 * stop being maintained. A legacy `<repo>/.runs` has no registry entry, so it
 * keeps the parent-of answer, which is exact there.
 *
 * @param {string} runsDir
 * @returns {boolean}
 */
export function syncAgentSignal(runsDir) {
  const agentsPath = join(repositoryForRunsDir(runsDir) ?? dirname(runsDir), "AGENTS.md");
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
