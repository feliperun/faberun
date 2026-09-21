/**
 * The campaign roll-up, and the numbers it shares with the notification
 * message (`message.mjs`): the roll-up object itself, the remaining-time
 * estimate and a node's span are exported from here and imported there, so
 * the page and the message can never disagree about progress, cost or time.
 *
 * `renderCampaignProgress` -- the campaign-wide roll-up, answering the
 * owner's four questions from persisted state alone: what the campaign
 * delivered (per phase, its newest settled node's own words), what progress
 * it has made (done, settled and total across every phase, kept two
 * different numbers), what it cost (the campaign total plus per-role cost
 * with the three token counts carried beside it -- a role only partly
 * priced reports the dollars on record and its provenance still says
 * `partial`), and how long it ran -- to the record's own `closedAt` once it
 * has one -- with a labelled estimate of what is left. The phase list is the
 * campaign record's linked runs -- the history -- followed by every manifest
 * contract with no run yet -- the queue: the manifest alone is not the
 * history, because the orchestrator replaces its entry each phase and
 * forgets (measured 2026-09-18: manifest 1 contract, linkedRunIds 22, 20 run
 * directories on disk), while the record does not. A manifest contract whose
 * authored file is gone is left out rather than allowed to abort the render:
 * one missing file must not cost the page all four answers.
 *
 * Every number here comes from a reader that already owns it -- the status
 * payload (`renderStatusJson`, which already carries per-node phase, spans,
 * cost and per-role usage with provenance), the raw node snapshot (for the
 * worker's own `result.summary`, which the status payload does not carry),
 * and, for the campaign's money and tokens, the campaign record's own
 * `linkedRunIds`: each linked run's `usage.jsonl`, summed through the same
 * per-role arithmetic the status payload uses for this run alone. Nothing
 * here recomputes what one of those already answers.
 */
import { formatDuration, readRunUsage, renderStatusJson, roleUsage } from "./render.mjs";
import { nodeSnapshotPath, readNodeSnapshot } from "../run/node-store.mjs";
import { finite } from "../util.mjs";
import { SETTLED, SUCCESS } from "../engine/prompts.mjs";
import { campaignDir } from "../campaign/layout.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { computeNextItems } from "./next.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runDirectory } from "../run/paths.mjs";


const NO_SUMMARY = "(no summary recorded)";

/** @param {{startedAt: string|null, updatedAt: string|null}} node @returns {number|null} */
function spanMs(node) {
  if (!node.startedAt || !node.updatedAt) return null;
  const start = Date.parse(node.startedAt);
  const end = Date.parse(node.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** @param {{startedAt: string|null, updatedAt: string|null}} node @returns {string|null} */
export function spanOf(node) {
  const ms = spanMs(node);
  return ms === null ? null : formatDuration(ms);
}

/**
 * The remaining-time estimate, shared by the notification message
 * (`message.mjs`) and the campaign roll-up so neither invents a second one:
 * the mean span of the settled nodes alone -- a running node's partial
 * elapsed is never in `SETTLED`, so it never drags the mean down and the
 * estimate forward -- times how many nodes have not settled. `"complete"`
 * when nothing is left; `null` when nothing has settled to base the estimate
 * on -- absent, never zero, the same refusal this page applies to requirement
 * coverage.
 *
 * @param {{status: string}[]} nodes every node the estimate covers
 * @param {{status: string, startedAt: string|null, updatedAt: string|null}[]} spans the nodes that carry the timestamps to average
 * @returns {string|null}
 */
export function remainingEstimate(nodes, spans) {
  const unsettled = nodes.filter((node) => !SETTLED.has(node.status)).length;
  if (!unsettled) return "complete";
  const settledSpans = spans.filter((node) => SETTLED.has(node.status)).map(spanMs).filter((ms) => ms !== null);
  if (!settledSpans.length) return null;
  const meanMs = settledSpans.reduce((total, ms) => total + /** @type {number} */ (ms), 0) / settledSpans.length;
  return `~${formatDuration(meanMs * unsettled)} remaining (from ${settledSpans.length} settled node${settledSpans.length === 1 ? "" : "s"})`;
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
 * @param {string} runsDir
 * @param {string} campaignId
 * @returns {number|null}
 */
function campaignCumulativeCostUsd(runsDir, campaignId) {
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
/** @typedef {{contractId: string|null, runId: string|null, phase: string|null, name: string|null, goal: string|null, declaredRequirementIds: string[], nodes: RollupNode[], counts: {done: number, settled: number, total: number}, newestSettledNode: RollupNewestNode|null, recordGone?: boolean}} RollupPhase */
/** @typedef {{contractId: string, nodeId: string, summary: string}} RollupNewestNode */
/** @typedef {{reason: string, command: string, runnable: boolean}} RollupNextAction */

/**
 * The campaign roll-up: `renderRunProgress`'s campaign-wide sibling. Every
 * field comes from persisted state -- the campaign record, each linked run's
 * own directory, and the runs' usage ledgers -- never from a live model.
 *
 * @param {string} runsDir
 * @param {string} campaignId
 * @param {number} [now] epoch ms the roll-up is rendered at; defaults to the
 *   wall clock, and injected by tests so the clock can be held still
 * @returns {string}
 */
export function renderCampaignProgress(runsDir, campaignId, now = Date.now()) {
  return `${JSON.stringify(buildCampaignProgress(runsDir, campaignId, now), null, 2)}\n`;
}

/**
 * @param {string} runsDir
 * @param {string} campaignId
 * @param {number} now
 * @returns {Record<string, unknown>}
 */
export function buildCampaignProgress(runsDir, campaignId, now) {
  const campaignPath = campaignDir(runsDir, campaignId);
  const campaign = readCampaign(campaignPath);
  // The manifest is a queue of what is declared to run next, and the
  // orchestrator replaces its entry each phase, so a roll-up that walks it
  // alone reports a campaign of one phase after thirteen have landed
  // (measured 2026-09-18 on this campaign: manifest 1 contract,
  // linkedRunIds 22, 20 run directories on disk). The record does not
  // forget: every linked run is a phase that happened, in the order the
  // record registered it, and every manifest contract with no run is a
  // phase that has not started. Happened first, then next -- the order a
  // reader expects. A manifest contract whose id is already linked is the
  // same phase arriving by both roads (a launched run takes its contract's
  // id as its own), so it reports once, from the run's own directory --
  // decided before any snapshot is read, and without ever letting an
  // unreadable authored contract abort the render (`buildManifestPhase`).
  const linkedRunIds = new Set(campaign.linkedRunIds);
  const built = campaign.linkedRunIds.map((runId) => buildLinkedRunPhase(runsDir, runId));
  for (const entry of campaign.contracts) {
    const phase = buildManifestPhase(entry, linkedRunIds);
    if (phase) built.push(phase);
  }
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
    // The denominator is every node the campaign has ever declared: each
    // linked run's own contract copy plus each never-launched manifest
    // contract, so a campaign can never read as 100% while a declared phase
    // is unauthored work. A pruned run's nodes are gone with its directory
    // and count as nothing rather than as a guess. The percentage counts
    // `done` (`SUCCESS` alone), never `settled`: a running or blocked node is
    // not done either, but only `settled` also folds in blocked, failed and
    // exhausted, which would read as progress.
    percentDone: total ? Math.round((done / total) * 100) : 0,
    costByRole: campaignRoleUsage(runsDir, campaign.linkedRunIds),
    // The same sum the single-run message prints as "campaign total", from
    // the same ledgers -- the roll-up and the message cannot disagree about
    // what the campaign spent.
    costTotalUsd: campaignCumulativeCostUsd(runsDir, campaignId),
    newestSettledNode: newestSettledNode(settledNodes),
    time: campaignTime(campaign, phases, settledNodes, now),
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
 * persisted snapshots once it has. `null` when the entry contributes no
 * phase: its authored contract is unreadable, or its contract id is already
 * linked and has reported from the run's own directory -- decided before any
 * snapshot is read, so the dedupe never pays for the reads it discards.
 *
 * @param {{path: string, digest: string}} entry
 * @param {Set<string>} linkedRunIds
 * @returns {{output: RollupPhase, settledCandidates: {contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]}|null}
 */
function buildManifestPhase(entry, linkedRunIds) {
  let raw;
  try {
    raw = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(entry.path, "utf8")));
  } catch {
    // The authored contract is gone or unreadable, so the entry cannot name
    // its phase. If its run launched, the run is linked and the phase has
    // already reported from its own directory -- an anonymous placeholder
    // here would count one phase twice. If it never launched, the chain
    // parks the campaign on the missing file at its next supervise
    // (`validateManifestEntryAtLaunch` cannot even hash it), where the
    // operator decides; the page omits the declaration rather than showing
    // a phase nothing can read or run. Measured 2026-09-19: seven real
    // campaigns hit the first case, and this read -- unguarded in the
    // previous attempt -- aborted all four answers for each of them.
    return null;
  }
  const contractId = String(raw.id);
  if (linkedRunIds.has(contractId)) return null;
  const cwd = resolve(dirname(entry.path), typeof raw.cwd === "string" ? raw.cwd : ".");
  const runDir = runDirectory(cwd, contractId);
  // The same signal the chain itself uses to decide a contract has started
  // (`chain.mjs`'s own launch loop checks this file before it trusts a run
  // directory's contents).
  const hasRun = existsSync(join(runDir, "run.json"));
  return buildPhaseFromContract(raw, runDir, hasRun ? contractId : null);
}

/**
 * One phase's roll-up from its contract object, shared by the two roads a
 * phase arrives by: a manifest entry (whose run directory is derived from
 * the contract id) and a linked run (whose directory the campaign record
 * names directly). `runId` doubles as the has-run signal -- null means the
 * contract has never launched, so its nodes report `not_started` from the
 * declaration alone. `settledCandidates` carries the raw snapshot beside its
 * contract and node id, for the campaign-wide newest-summary and
 * remaining-time readers, which need the snapshot's own `result`, `status`
 * and spans -- content this function's own output never repeats.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} runDir
 * @param {string|null} runId
 * @returns {{output: RollupPhase, settledCandidates: {contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]}}
 */
function buildPhaseFromContract(raw, runDir, runId) {
  const hasRun = runId !== null;
  const contractId = String(raw.id);
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
      runId,
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
      newestSettledNode: newestSettledNode(settledCandidates),
      nodes,
      counts: { done, settled, total: nodes.length },
    },
    settledCandidates,
  };
}

/**
 * A phase from a run the campaign record links, read from the run's own
 * directory: its contract copy supplies the declared nodes, goal and phase
 * id, its snapshots supply what happened. A run id the record remembers but
 * whose directory is gone (pruned, or never materialised) is still a phase
 * that happened -- it is flagged `recordGone` and everything else about it
 * is left unknown rather than guessed; the run id itself is the readable
 * residue, being the name the operator ran.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {{output: RollupPhase, settledCandidates: {contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]}}
 */
function buildLinkedRunPhase(runsDir, runId) {
  try {
    const raw = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(join(runsDir, runId, "contract.json"), "utf8")));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("contract copy is not an object");
    return buildPhaseFromContract(raw, join(runsDir, runId), runId);
  } catch {
    return {
      output: {
        contractId: null,
        runId,
        phase: null,
        name: phaseName(runId),
        goal: null,
        declaredRequirementIds: [],
        newestSettledNode: null,
        nodes: [],
        counts: { done: 0, settled: 0, total: 0 },
        recordGone: true,
      },
      settledCandidates: [],
    };
  }
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
 * The campaign's per-role cost and token counts, summed from every linked
 * run's own `usage.jsonl` -- the same records `campaignCumulativeCostUsd`
 * sums the money from, so the per-role view and the campaign total cannot
 * disagree. Node snapshots cannot promise this: a pruned or torn run keeps
 * its usage ledger after its snapshots are gone. The three token kinds stay
 * three numbers -- they differ by two orders of magnitude on a real campaign
 * (measured 2026-09-18: 6.9M input against 333.5M cache-read) -- and a role
 * with no price on record reports its tokens as unpriced, never a zero. A
 * role only partly priced reports the dollars it does have on record, with
 * `costProvenance` still saying `partial` (`withRecordedCost`).
 *
 * @param {string} runsDir
 * @param {string[]} linkedRunIds
 * @returns {{worker: import("./render.mjs").RoleUsage, judge: import("./render.mjs").RoleUsage}}
 */
function campaignRoleUsage(runsDir, linkedRunIds) {
  /** @type {Record<string, unknown>[]} */
  const invocations = [];
  /** @type {Record<"worker"|"judge", number>} */
  const pricedUsd = { worker: 0, judge: 0 };
  for (const runId of linkedRunIds) {
    const path = join(runsDir, runId, "usage.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const value = /** @type {Record<string, unknown>} */ (record);
      invocations.push({
        role: value.role,
        costUsd: value.costUsd,
        usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadInputTokens: value.cacheReadInputTokens },
      });
      const cost = finite(value.costUsd);
      if ((value.role === "worker" || value.role === "judge") && cost !== null) pricedUsd[value.role] += cost;
    }
  }
  const roles = roleUsage(/** @type {import("../contract/index.mjs").NodeSnapshot[]} */ (/** @type {unknown} */ ([{ invocations }])));
  return {
    worker: withRecordedCost(roles.worker, pricedUsd.worker),
    judge: withRecordedCost(roles.judge, pricedUsd.judge),
  };
}

/**
 * The dollars a role has on record, even when only some of its invocations
 * carry a price. `summarizeRole` keeps `costUsd` null for a partly priced
 * role so no surface can read a partial sum as the whole cost; the campaign
 * page makes the other half of that trade -- it prints the recorded dollars
 * while `costProvenance` still says `partial` -- because "what did it cost?"
 * answered with null while real dollars sit in the ledger hides the answer
 * the page exists to give (measured 2026-09-18: $3.69 and $6.80 of recorded
 * spend rendering as no money at all). A fully unpriced role keeps null:
 * no dollars are on record, and none are invented.
 *
 * @param {import("./render.mjs").RoleUsage} role
 * @param {number} pricedUsd
 * @returns {import("./render.mjs").RoleUsage}
 */
function withRecordedCost(role, pricedUsd) {
  if (role.costUsd === null && pricedUsd > 0) return { ...role, costUsd: pricedUsd };
  return role;
}

/**
 * Answer four: how long the campaign has been running and what is left.
 * Elapsed runs from the campaign record's own `createdAt` -- the earliest
 * clock the record durably carries -- to its own `closedAt` once the record
 * carries one: a closed campaign's clock stopped when it closed, and an
 * elapsed that keeps counting to now reports how long ago the campaign was
 * born, not how long it ran (measured 2026-09-19: a campaign closed after
 * ~14h52m rendering 140h21m of running time). A first linked run's start
 * lives in a run directory pruning can take, and an elapsed that moves when
 * history is pruned is not a record. Remaining reuses `remainingEstimate`,
 * the single-run renderer's own rule, over the whole campaign's nodes.
 *
 * @param {import("../campaign/index.mjs").Campaign} campaign
 * @param {RollupPhase[]} phases
 * @param {{contractId: string, nodeId: string, snapshot: Record<string, unknown>}[]} settledCandidates
 * @param {number} now epoch ms
 * @returns {{startedAt: string|null, elapsed: string|null, remaining: string|null}}
 */
function campaignTime(campaign, phases, settledCandidates, now) {
  const startedAt = typeof campaign.createdAt === "string" ? campaign.createdAt : null;
  const start = startedAt === null ? NaN : Date.parse(startedAt);
  const closedAt = typeof campaign.closedAt === "string" ? campaign.closedAt : null;
  const closed = closedAt === null ? NaN : Date.parse(closedAt);
  const end = Number.isFinite(closed) ? closed : now;
  const nodes = phases.flatMap((phase) => phase.nodes);
  const spans = settledCandidates.map((candidate) => ({
    status: String(candidate.snapshot.status),
    startedAt: typeof candidate.snapshot.startedAt === "string" ? candidate.snapshot.startedAt : null,
    updatedAt: typeof candidate.snapshot.updatedAt === "string" ? candidate.snapshot.updatedAt : null,
  }));
  return {
    startedAt,
    elapsed: Number.isFinite(start) ? formatDuration(Math.max(0, end - start)) : null,
    // A campaign with no readable node at all has nothing to estimate from
    // and nothing to be complete about: absent, like the estimate itself.
    remaining: nodes.length ? remainingEstimate(nodes, spans) : null,
  };
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
