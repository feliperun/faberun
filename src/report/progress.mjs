/**
 * Two renderers sharing one module, so a notification and a campaign page can
 * never disagree about progress:
 *
 * `renderRunProgress` -- one message for a human, from a run's persisted
 * state plus one terminal event: campaign, phase and node with a glyph for
 * the node's outcome; percent and count done and left; this node's own span;
 * the phase's estimated remaining time, from settled spans alone; the next
 * node in the phase, or that the phase is complete; what the node delivered,
 * in the worker's own words; and cost by role plus the campaign's cumulative
 * cost.
 *
 * `renderCampaignProgress` -- the campaign-wide roll-up: every contract the
 * manifest declares, in manifest order, whether or not it has a run yet; each
 * contract's own nodes with their `dependsOn` edges and settlement state;
 * per-phase and campaign-wide settled/total counts; cost by role; the newest
 * settled node's own words; and the operator's next action when one exists.
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
import { MARK, formatDuration, formatRole, readRunUsage, renderStatusJson, roleUsage } from "./render.mjs";
import { nodeSnapshotPath, readNodeSnapshot } from "../run/node-store.mjs";
import { boundedUtf8, compactCost } from "../util.mjs";
import { SETTLED, SUCCESS } from "../engine/prompts.mjs";
import { campaignDir } from "../campaign/layout.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { computeNextItems } from "./next.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runDirectory } from "../run/paths.mjs";

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

/**
 * @typedef {{id: string, dependsOn: string[], status: string, attempt: number, workerRuntime: string|null, judgeRuntime: string|null, elapsedSpan: string|null, costUsd: number|null, runDir: string|null, workerLogPath: string|null, judgeLogPaths: string[], verificationRecordPath: string|null, attemptBranch: string|null, sealCommit: string|null}} RollupNode
 * `status` carries every `NodeStatus` plus two the manifest alone can
 * explain: `not_started` (the contract has no run yet) and `unreadable` (a
 * run exists but this node's own snapshot does not).
 * `workerRuntime` and `judgeRuntime` are two different facts, not one field
 * whichever role happened to run last: a gated node's `state.runtime` is
 * overwritten by the judge dispatch (`src/engine/dispatch.mjs` writes it at
 * three points), so a single `runtime` field reads as though the judge did
 * the worker's job. `judgeRuntime` is `null` for a node with no gate, or one
 * whose gate never ran -- never the worker's own runtime repeated.
 */
/**
 * `counts.done` and `counts.settled` are two different numbers: `done` is
 * `SUCCESS` alone (a reader's "finished"), `settled` is `SETTLED` (the
 * scheduler's "will not move again on its own", which also holds blocked,
 * failed and exhausted). A phase holding a blocked node settles without
 * finishing; a page that draws it from `settled` alone draws it as done,
 * which is the lie this split exists to prevent.
 */
/** @typedef {{contractId: string, runId: string|null, phase: string|null, name: string|null, goal: string|null, declaredRequirementIds: string[], nodes: RollupNode[], counts: {done: number, settled: number, total: number}}} RollupPhase */
/** @typedef {{contractId: string, nodeId: string, summary: string}} RollupNewestNode */
/** @typedef {{reason: string, command: string, runnable: boolean}} RollupNextAction */

/**
 * The campaign roll-up: `renderRunProgress`'s campaign-wide sibling. Every
 * field comes from persisted state -- the manifest, each linked run's own
 * nodes, and the campaign journal -- never from a live model.
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {string}
 */
export function renderCampaignProgress(runsDir, campaignId) {
  return `${JSON.stringify(buildCampaignProgress(runsDir, campaignId), null, 2)}\n`;
}

/**
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {Record<string, unknown>}
 */
function buildCampaignProgress(runsDir, campaignId) {
  const campaignPath = campaignDir(runsDir, campaignId);
  const campaign = readCampaign(campaignPath);
  const built = campaign.contracts.map((entry) => buildPhase(entry));
  const phases = built.map((entry) => entry.output);
  const settledNodes = built.flatMap((entry) => entry.settledCandidates);
  const done = phases.reduce((total, phase) => total + phase.counts.done, 0);
  const settled = phases.reduce((total, phase) => total + phase.counts.settled, 0);
  const total = phases.reduce((total2, phase) => total2 + phase.counts.total, 0);
  return {
    schemaVersion: 1,
    campaignId: campaign.id,
    goal: campaign.goal,
    landBranch: campaign.landBranch,
    phases,
    counts: { done, settled, total },
    // The denominator is every node every manifest contract declares, run or
    // not: a contract the manifest names but has not launched still counts
    // its nodes here (see `buildPhase`'s `not_started` branch), so a campaign
    // can never read as 100% while a declared phase is unauthored work. The
    // percentage counts `done` (`SUCCESS` alone), never `settled`: a running
    // or blocked node is not done either, but only `settled` also folds in
    // blocked, failed and exhausted, which would read as progress.
    percentDone: total ? Math.round((done / total) * 100) : 0,
    costByRole: roleUsage(/** @type {import("../contract/index.mjs").NodeSnapshot[]} */ (settledNodes.map((entry) => entry.snapshot))),
    newestSettledNode: newestSettledNode(settledNodes),
    // The chain calls this contract's own run directory the campaign's
    // repo root three levels above `campaignPath` (`record.mjs`'s
    // `preserveCampaignLedger` derives it the same way); reused here so the
    // next action's command matches what `next` itself would print.
    nextAction: campaignNextAction(runsDir, campaignId, resolve(campaignPath, "..", "..", "..")),
  };
}

/**
 * One manifest entry's roll-up: the contract's own declared nodes and graph
 * edges when it has never run, or those same nodes filled in from the run's
 * persisted snapshots once it has. `settledCandidates` carries the raw
 * snapshot beside its contract and node id, for the campaign-wide cost and
 * newest-summary readers, which need the snapshot's own `invocations` and
 * `result` -- content this function's own output never repeats.
 *
 * @param {{path: string, digest: string}} entry
 * @returns {{output: RollupPhase, settledCandidates: {contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]}}
 */
function buildPhase(entry) {
  const raw = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(entry.path, "utf8")));
  const contractId = String(raw.id);
  const cwd = resolve(dirname(entry.path), typeof raw.cwd === "string" ? raw.cwd : ".");
  const runDir = runDirectory(cwd, contractId);
  // The same signal the chain itself uses to decide a contract has started
  // (`chain.mjs`'s own launch loop checks this file before it trusts a run
  // directory's contents).
  const hasRun = existsSync(join(runDir, "run.json"));
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const phaseId = typeof rawNodes[0]?.phase === "string" ? rawNodes[0].phase : null;
  const workerRuntimeById = hasRun ? workerRuntimeMap(runDir) : new Map();

  /** @type {{contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]} */
  const settledCandidates = [];
  const nodes = rawNodes.map((node) => rollupNode(node, contractId, runDir, hasRun, settledCandidates, workerRuntimeById));
  const done = nodes.filter((node) => SUCCESS.has(node.status)).length;
  const settled = nodes.filter((node) => SETTLED.has(node.status)).length;

  return {
    output: {
      contractId,
      runId: hasRun ? contractId : null,
      phase: phaseId,
      name: phaseName(phaseId),
      goal: typeof raw.goal === "string" ? raw.goal : null,
      // Declared-not-measured, and empty until a frozen plan carries
      // requirement ids on the phase itself (R9/R10): there used to be a
      // scrape of requirement ids out of the campaign journal's decision
      // entries, keyed by whether a decision's own text happened to name
      // this phase or contract. Journal prose is not a traceability source —
      // a phase-decomposition decision that names every requirement id in
      // one sentence attributed all of them to whichever phase the decision
      // text mentioned, which is a wrong mapping, and a wrong mapping is
      // worse than a missing one.
      declaredRequirementIds: [],
      nodes,
      counts: { done, settled, total: nodes.length },
    },
    settledCandidates,
  };
}

/**
 * The honest per-node worker runtime, read from the same status payload
 * `buildStatusPayload` already computes (`workerRuntimeLabel`'s scan of the
 * invocation ledger for the worker that actually ran) -- never recomputed
 * here, so this reader and `status --json`/`report` can never disagree about
 * who worked a node. Empty when the run's own payload cannot be built at all
 * (e.g. a snapshot elsewhere in the run is corrupt), so one broken sibling
 * never hides this phase's readable nodes; `rollupNode` falls back to `null`
 * per node in that case, same as an unreadable snapshot would.
 *
 * @param {string} runDir
 * @returns {Map<string, string|null>}
 */
function workerRuntimeMap(runDir) {
  try {
    const payload = /** @type {{nodes: {id: string, workerRuntime: string|null}[]}} */ (JSON.parse(renderStatusJson(runDir)));
    return new Map(payload.nodes.map((entry) => [entry.id, entry.workerRuntime]));
  } catch {
    return new Map();
  }
}

/**
 * The judge that actually reviewed this node, read the same way
 * `workerRuntimeLabel` reads the worker: the invocation ledger's own last
 * `role: "judge"` entry. Unlike the worker there is no fallback to
 * `snapshot.runtime` -- a node with no gate, or one whose gate never ran, has
 * no judge invocation at all, and must report no judge runtime rather than
 * the worker's runtime standing in for it.
 *
 * @param {Record<string, unknown>[]} invocations
 * @returns {string|null}
 */
function judgeRuntimeLabel(invocations) {
  const judge = /** @type {{harness?: unknown, model?: unknown}|undefined} */ ([...invocations].reverse().find((invocation) => invocation?.role === "judge"));
  return judge?.harness && judge?.model ? `${judge.harness}/${judge.model}` : null;
}

/**
 * @param {Record<string, unknown>} node the manifest's own declared node
 * @param {string} contractId
 * @param {string} runDir
 * @param {boolean} hasRun
 * @param {{contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]} settledCandidates appended to when this node's own snapshot is readable
 * @param {Map<string, string|null>} workerRuntimeById
 * @returns {RollupNode}
 */
function rollupNode(node, contractId, runDir, hasRun, settledCandidates, workerRuntimeById) {
  const id = String(node.id);
  const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn.map(String) : [];
  const empty = { id, dependsOn, attempt: 0, workerRuntime: null, judgeRuntime: null, elapsedSpan: null, costUsd: null, workerLogPath: null, judgeLogPaths: /** @type {string[]} */ ([]), attemptBranch: null, sealCommit: null };
  if (!hasRun) return { ...empty, status: "not_started", runDir: null, verificationRecordPath: null };

  let snapshot;
  try {
    snapshot = readNodeSnapshot(runDir, id);
  } catch {
    return { ...empty, status: "unreadable", runDir, verificationRecordPath: nodeSnapshotPath(runDir, id) };
  }
  settledCandidates.push({ contractId, nodeId: id, snapshot });

  const invocations = Array.isArray(snapshot.invocations) ? snapshot.invocations : [];
  const worker = [...invocations].reverse().find((invocation) => invocation?.role === "worker");
  const judgeLogPaths = invocations
    .filter((invocation) => invocation?.role === "judge")
    .map((invocation) => invocation.stdoutPath)
    .filter((path) => typeof path === "string");
  const worktree = snapshot.worktree && typeof snapshot.worktree === "object" ? /** @type {Record<string, unknown>} */ (snapshot.worktree) : null;

  return {
    id,
    dependsOn,
    status: typeof snapshot.status === "string" ? snapshot.status : "unreadable",
    attempt: typeof snapshot.attempt === "number" ? snapshot.attempt : 0,
    workerRuntime: workerRuntimeById.get(id) ?? null,
    judgeRuntime: judgeRuntimeLabel(invocations),
    elapsedSpan: spanOf({ startedAt: typeof snapshot.startedAt === "string" ? snapshot.startedAt : null, updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null }),
    costUsd: typeof snapshot.costUsd === "number" ? snapshot.costUsd : null,
    runDir,
    workerLogPath: typeof worker?.stdoutPath === "string" ? worker.stdoutPath : null,
    judgeLogPaths,
    verificationRecordPath: nodeSnapshotPath(runDir, id),
    attemptBranch: typeof worktree?.branch === "string" ? worktree.branch : null,
    sealCommit: typeof worktree?.sealedSha === "string" ? worktree.sealedSha : null,
  };
}

/**
 * A phase id is not a name (the owner's own words on seeing `0b3` unlabelled):
 * hyphens become spaces and the first letter is capitalized, so
 * `verdict-and-write-check` reads as `Verdict and write check`.
 *
 * @param {string|null} phaseId
 * @returns {string|null}
 */
function phaseName(phaseId) {
  if (!phaseId) return null;
  const words = phaseId.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The most recently settled node across every linked run, campaign-wide --
 * `renderRunProgress`'s `subjectNode` narrowed to one run; here there is no
 * event naming a node, only whichever settled last.
 *
 * @param {{contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]} candidates
 * @returns {RollupNewestNode|null}
 */
function newestSettledNode(candidates) {
  const settled = candidates.filter((candidate) => SETTLED.has(/** @type {import("../contract/index.mjs").NodeStatus} */ (String(candidate.snapshot.status)))
    && typeof candidate.snapshot.updatedAt === "string");
  const latest = settled.sort((left, right) => String(left.snapshot.updatedAt).localeCompare(String(right.snapshot.updatedAt))).at(-1);
  if (!latest) return null;
  const result = /** @type {{summary?: unknown}|null} */ (latest.snapshot.result && typeof latest.snapshot.result === "object" ? latest.snapshot.result : null);
  const summary = typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : null;
  return { contractId: latest.contractId, nodeId: latest.nodeId, summary: summary ?? NO_SUMMARY };
}

/**
 * The operator's next action for this one campaign, reusing `next`'s own
 * ranked predicates rather than re-deriving them: a second implementation of
 * "what needs the operator" is exactly how a page and `faberun next` could
 * disagree. `null` when `next` has nothing runnable or worth naming for this
 * campaign (an empty command, e.g. "run live; nothing to do").
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @param {string} cwd
 * @returns {RollupNextAction|null}
 */
function campaignNextAction(runsDir, campaignId, cwd) {
  const item = computeNextItems(runsDir, cwd).find((candidate) => candidate.campaign === campaignId);
  if (!item || !item.command) return null;
  return { reason: item.reason, command: item.command, runnable: item.runnable };
}
