import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { syncAgentSignal } from "../repo/signal.mjs";
import { JUDGE_SCHEMA, PARKED, SETTLED, retryPrompt } from "./prompts.mjs";
import {
  applyJudgeProtocolFailure,
  applyJudgeRound,
} from "./review.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../harnesses/index.mjs";
import { routeRuntimeForState, routingBackoffActive } from "./failover.mjs";
import { quotaHeldRuntimes, runningPerRuntime, runtimeHasCapacity } from "./capacity.mjs";

import {
  bootstrapAttemptPath,
  bootstrapPath,
  cleanupBootstrapAttempts,
  readJson,
  writeJsonAtomic,
} from "../run/store.mjs";
import {
  acquire as acquireLock,
  lockStale,
  LockLostError,
  processStartToken,
  readLock,
} from "../run/lock.mjs";
import { registerRun, resolveCampaign } from "../campaign/index.mjs";
import { createRunRef, runRefName } from "../repo/worktree.mjs";
import { bootstrapNonceForProcess, waitForBootstrapAcknowledgement } from "./detach.mjs";
import {
  autoRetryNode,
  autoRetryParkedNodes,
  finalizeClosedJobs,
  terminalErrorCode,
} from "./lifecycle.mjs";
import { delay, errorCode } from "../util.mjs";
import { alreadyNotified, emitNodeAdvisories, notifyQueueFor, notifyQueuesByRun, renderCampaignHandoffSafely } from "./notify-queue.mjs";
import { detectStalls, invocationAlive, terminateProcess } from "./process.mjs";
import { transition, writeNode } from "./state.mjs";
import { listNodeSnapshots, readNodeSnapshot } from "../run/node-store.mjs";
import { render, renderFinalReport, writeFindingsArtifact } from "../report/final.mjs";
import { operationNextState, providerReceipts, settleInvocation } from "../run/operations.mjs";
import { appendUsageRecord, invocationCost, invocationUsage, recordInvocationUsage } from "../run/usage.mjs";
import { captureNodeScopeBoundaries, checkWorkerScope, emptyScope } from "./scope.mjs";
import { validateContractForLaunch } from "../campaign/chain.mjs";
import { validateNodeSnapshot } from "../contract/snapshot.mjs";
import { finalVerificationCommands, sharedVerificationCommands } from "../contract/final-verification.mjs";
import { startJudge, startWorker } from "./dispatch.mjs";
import { assertEnvironmentReady, captureRunIdentity, createRunMetadata, serializableContract, statesFingerprint } from "./run-identity.mjs";
import { blockDependents, runtimeAssignments } from "./assignment.mjs";
import { createHeartbeat, HEARTBEAT_INTERVAL_MS } from "./supervise.mjs";
import { runDirectory, runsRoot } from "../run/paths.mjs";

/** @typedef {import("../contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../contract/index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("../contract/index.mjs").EventRecord} EventRecord */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../contract/index.mjs").GateResult} GateResult */
/** @typedef {import("../contract/index.mjs").SnapshotError} SnapshotError */
/** @typedef {import("../contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").RecoveryOutcome} RecoveryOutcome */
/** @typedef {import("./lifecycle.mjs").InvocationProbe} InvocationProbe */
/** @typedef {import("../contract/worker-result.mjs").WorkerResult} WorkerResult */
/** @typedef {{runDir: string, states: Map<string, NodeSnapshot>, ok: boolean, error?: Error}} RunOutcome */

/**
 * The wall-clock milliseconds one verification-command set may legitimately
 * occupy: each command's own `timeoutSec` repeated `repeat` times. The schema
 * already normalizes `timeoutSec` to 120 and `repeat` to 1, but a caller may
 * hand an un-normalized command, so both are defaulted here too.
 *
 * @param {import("../contract/index.mjs").VerificationCommand[]|undefined} commands
 * @returns {number}
 */
export function verificationBudgetMs(commands) {
  return (commands ?? []).reduce((total, command) => {
    const timeoutSec = typeof command?.timeoutSec === "number" ? command.timeoutSec : 120;
    const repeat = Number.isInteger(command?.repeat) && /** @type {number} */ (command.repeat) > 0 ? /** @type {number} */ (command.repeat) : 1;
    return total + timeoutSec * repeat * 1_000;
  }, 0);
}

/**
 * The budget a node is judged against, in milliseconds. It is the sum of every
 * bounded phase the node can legitimately occupy without a state transition:
 * its worker invocation (`timeoutSec`), its packet verification plus the
 * contract's `sharedVerification` and, when it is phase-terminal, the
 * contract's `finalVerification`, an integration candidate run of that same
 * set, and the bounded command proofs of its gate. A frozen node is one that
 * has been silent longer than this, not merely longer than the worker timeout,
 * because a legitimate verification can be minutes long and must not be
 * mistaken for a freeze.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @returns {number}
 */
export function nodeBudgetBasisMs(contract, node) {
  const defaultTimeoutMs = (node.timeoutSec ?? contract.timeoutSec ?? 60) * 1_000;
  const sharedMs = verificationBudgetMs(sharedVerificationCommands(contract));
  const packetMs = verificationBudgetMs(node.taskPacket?.verification);
  const finalMs = verificationBudgetMs(finalVerificationCommands(contract, node));
  // The controller runs the packet set (with the contract-level shared set) once
  // after the worker and once against the integration candidate, and the
  // finalVerification set with each.
  const attemptMs = packetMs + sharedMs;
  const candidateMs = attemptMs + finalMs;
  const gateTimeoutMs = Math.max(1_000, Math.min(defaultTimeoutMs, 120_000));
  const commandProofs = (node.definitionOfDone ?? []).filter((item) => item.proof?.kind === "command").length;
  return defaultTimeoutMs + attemptMs + candidateMs + commandProofs * gateTimeoutMs + finalMs;
}

/**
 * The loop invariant that keeps a controller from spinning: a node that says it
 * is `running` while the controller holds no invocation for it can never be
 * finalized by anything, and the loop would tick forever at the poll interval.
 * Park it as `blocked`/`integration_unresolved` so the run reports attention.
 *
 * It is deliberately narrow — `running` and absent from `running` only — so it
 * never touches phase 2's parked `blocked`/`failed`/`exhausted`/`stalled`
 * states, and never overwrites the `runtime_tier_exhausted` waiting shape.
 *
 * A node whose closed job is being settled in the background (its id is a key
 * of `pendingSettlements`) is not this dead end either: its invocation has
 * already exited and left `running`, but the settlement promise still owns
 * deciding what happens to it, so it is left alone until that promise resolves.
 *
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {Map<string, Job>} running
 * @param {LockHandle|null} lock
 * @param {Map<string, Promise<void>>} [pendingSettlements]
 * @returns {string[]} the node ids this pass parked
 */
export function enforceRunningInvariant(runDir, states, running, lock, pendingSettlements = new Map()) {
  const parked = [];
  for (const [nodeId, state] of states) {
    if (state.status !== "running" || running.has(nodeId) || pendingSettlements.has(nodeId)) continue;
    transition(runDir, state, "blocked", {
      phase: state.phase,
      error: {
        code: "integration_unresolved",
        message: "node is running but the controller holds no invocation for it",
      },
    }, lock);
    parked.push(nodeId);
  }
  return parked;
}

/**
 * The fingerprint that decides whether a render is due: the shared
 * `statesFingerprint` (status, phase, attempt, revisions) plus each running
 * node's verification progress. A verification command completing and the
 * next one starting changes neither status nor phase, so the shared
 * fingerprint alone would never notice it; this is the one used to gate
 * `renderStatusIfChanged` and nothing else, so a resume's drift comparison
 * still uses the unextended `statesFingerprint`.
 *
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
function renderFingerprint(states) {
  const progress = [...states.values()].map((state) => {
    const verification = /** @type {{progress?: {index: number, total: number, argv: string}}|null|undefined} */ (state.verification);
    return verification?.progress ? `${state.id}:${verification.progress.index}/${verification.progress.total}:${verification.progress.argv}` : "";
  }).join("|");
  return `${statesFingerprint(states)}#${progress}`;
}

/**
 * Move a cancelled run's directory out of the way of its own id, once, so
 * the launch that needs the id back can create it fresh. Never called for
 * any other reason a run directory might already exist -- this is the one
 * occupant a launch is allowed to displace on its own.
 *
 * @param {string} runDir
 * @returns {void}
 */
function archiveCanceledRunDir(runDir) {
  let archivedPath = `${runDir}.canceled-${Date.now()}`;
  let suffix = 0;
  while (existsSync(archivedPath)) {
    suffix += 1;
    archivedPath = `${runDir}.canceled-${Date.now()}-${suffix}`;
  }
  renameSync(runDir, archivedPath);
}

/**
 * @param {string} contractPath
 * @param {{detachedBootstrap?: boolean, baseRef?: string}} [options]
 *   `detachedBootstrap` is set only by the CLI entry when this process is its
 *   own detached child, and makes the controller wait for the launcher's
 *   acknowledgement; `baseRef` is the CLI's own `--base-ref`, re-validated
 *   here so a launch and the run it starts agree about what the contract was
 *   checked against
 * @returns {Promise<RunOutcome>}
 */
export async function runContract(contractPath, options = {}) {
  const absoluteContractPath = resolve(contractPath);
  const contract = validateContractForLaunch(JSON.parse(readFileSync(absoluteContractPath, "utf8")), absoluteContractPath, { baseRef: options.baseRef });
  const runDir = runDirectory(contract.cwd, contract.id);
  if (existsSync(runDir)) {
    // A cancelled run is the one prior occupant of this id a fresh launch may
    // move aside on its own: `cancel` already released the git names (the run
    // ref, every node's attempt branch) this launch needs back, and the
    // cancel-request marker plus a stale controller lock is what proves no
    // process can still be writing into it. Anything else at this path --
    // still running, or settled without ever being cancelled -- keeps
    // refusing exactly as before; the operator's evidence is never silently
    // claimed.
    const wasCanceled = existsSync(join(runDir, "cancel.request.json")) && lockStale(readLock(runDir));
    if (!wasCanceled) throw new Error(`run already exists: ${runDir}`);
    archiveCanceledRunDir(runDir);
  }
  mkdirSync(runsRoot(contract.cwd), { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`run already exists: ${runDir}`);
    throw error;
  }
  const lock = acquireLock(runDir);
  try {
    const runtimePlan = await runtimeAssignments(contract);
    const scopeBoundaries = captureNodeScopeBoundaries(contract);
    const sourceIdentity = await captureRunIdentity(contract, scopeBoundaries);
    const integrationRef = createRunRef(contract.cwd, contract.id, sourceIdentity.gitHead);
    lock.assert();
    const runsDir = runsRoot(contract.cwd);
    const campaign = resolveCampaign(runsDir, contract.campaignId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeJsonAtomic(join(runDir, "contract.json"), serializableContract(contract));
    writeJsonAtomic(join(runDir, "judge.schema.json"), JUDGE_SCHEMA);
    writeJsonAtomic(join(runDir, "run.json"), createRunMetadata(lock, sourceIdentity, {}, integrationRef));
    registerRun(campaign.path, contract.id);
    renderCampaignHandoffSafely(campaign, runsDir, runDir);

    const states = new Map();
    for (const node of contract.nodes) {
      /** @type {NodeSnapshot} */
      const state = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        id: node.id,
        type: node.type,
        sourceIdentity: node.sourceIdentity,
        packetHash: node.packetHash,
        status: "pending",
        phase: "waiting",
        attempt: 0,
        revisions: 0,
        runtime: null,
        blockedBy: [],
        startedAt: null,
        updatedAt: new Date().toISOString(),
        result: null,
        verification: null,
        scope: emptyScope(/** @type {import("../repo/workspace.mjs").WorkspaceScopeBoundary} */ (scopeBoundaries.get(node.id))),
        gate: null,
        error: null,
        judgeFailures: 0,
        routing: {
          history: [],
          currentOverride: null,
          assignments: runtimePlan.assignments[node.id],
          availability: runtimePlan.availability,
        },
        progress: null,
        invocations: [],
        executionOverrides: [],
        worktree: { status: "unassigned", path: null, branch: null, commit: null, baseSha: null },
        integratedHead: null,
      };
      states.set(node.id, state);
      writeNode(runDir, state, lock);
    }
    syncAgentSignal(runsDir);
    const outcome = await driveRun(contract, runDir, states, campaign, lock, sourceIdentity, {}, options);
    syncAgentSignal(runsDir);
    return outcome;
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {CampaignRef} campaign
 * @param {LockHandle} lock
 * @param {SourceIdentity} sourceIdentity
 * @param {{identityWarnings?: string[], relaunchCount?: number, lastRelaunchProgressAt?: string|null, attention?: {code: string, message: string, at: string}|null}} [resume] resume-only records persisted on the run metadata
 * @param {{detachedBootstrap?: boolean}} [options] set by the CLI entry alone
 * @returns {Promise<RunOutcome>}
 */
export async function driveRun(contract, runDir, states, campaign, lock, sourceIdentity, resume = {}, options = {}) {
  lock.assert();
  await assertEnvironmentReady(contract, runDir, sourceIdentity);
  const runsDir = runsRoot(contract.cwd);
  const bootstrapNonce = bootstrapNonceForProcess();
  // Only the CLI entry can answer this: a nonce inherited by evals/run.mjs or
  // by a test must not make the controller wait for an acknowledgement nobody
  // is going to write.
  const detachedBootstrap = options.detachedBootstrap === true;
  // A controller restart must not erase the supervisor's durable relaunch
  // guard. `resume.mjs` does not thread those fields, so the controller reads
  // the run it is rewriting and carries them itself.
  const persistedMetadata = existsSync(join(runDir, "run.json")) ? readJson(join(runDir, "run.json")) : {};
  const runMetadata = createRunMetadata(lock, sourceIdentity, {
    ...resume,
    ...(persistedMetadata.relaunchCount !== undefined ? { relaunchCount: /** @type {number} */ (persistedMetadata.relaunchCount) } : {}),
    ...(persistedMetadata.lastRelaunchProgressAt !== undefined ? { lastRelaunchProgressAt: /** @type {string|null} */ (persistedMetadata.lastRelaunchProgressAt) } : {}),
    // A resume that actually changed node state may clear attention by passing
    // `attention: null`; only then does the persisted record lose.
    ...(persistedMetadata.attention !== undefined && resume.attention === undefined ? { attention: /** @type {{code: string, message: string, at: string}|null} */ (persistedMetadata.attention) } : {}),
  }, runRefName(contract.id));
  writeJsonAtomic(join(runDir, "run.json"), runMetadata);
  writeJsonAtomic(bootstrapPath(runDir), {
    status: "ready",
    nonce: bootstrapNonce,
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    runDir,
    metadataPath: join(runDir, "run.json"),
    at: new Date().toISOString(),
  });
  writeJsonAtomic(bootstrapAttemptPath(runDir, bootstrapNonce), readJson(bootstrapPath(runDir)));
  cleanupBootstrapAttempts(runDir, bootstrapNonce);
  if (detachedBootstrap) await waitForBootstrapAcknowledgement(runDir, {
      nonce: bootstrapNonce,
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
  });
  lock.assert();
  renderCampaignHandoffSafely(campaign, runsDir, runDir);

  /** @type {string|null} */
  let statusFingerprint = null;
  /** @param {boolean} force @param {LockHandle|null} [renderLock] */
  const renderStatusIfChanged = (force = false, renderLock = lock) => {
    const fingerprint = renderFingerprint(states);
    if (!force && fingerprint === statusFingerprint) return;
    statusFingerprint = fingerprint;
    render(runDir, runsDir, contract, states, renderLock);
  };
  // A node's own settlement (its controller verification, its judge round) can
  // be minutes long, and it now runs off the tick's critical path in
  // `pendingSettlements` so dispatch never waits behind it -- but that whole
  // time status.json would otherwise report whatever the last tick left it at.
  // A timer renders between ticks too; it is cheap even when idle because
  // `renderFingerprint` still change-detects, so a quiet run writes nothing
  // extra.
  const statusTimer = setInterval(() => renderStatusIfChanged(), contract.pollIntervalMs);
  statusTimer.unref();
  let handoffFingerprint = statesFingerprint(states);
  const renderHandoffIfChanged = () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === handoffFingerprint) return;
    handoffFingerprint = fingerprint;
    renderCampaignHandoffSafely(campaign, runsDir, runDir);
  };
  // Progress never notifies (TECH-SPEC lean, rule 6): only a node reaching a
  // terminal state wakes the notify queue. status.json (written every render)
  // is the progress surface now.
  const notifyQueue = notifyQueueFor(runDir);
  /** @type {string|null} */
  let notificationFingerprint = null;
  const notifyStateChanges = async () => {
    const fingerprint = statesFingerprint(states);
    if (fingerprint === notificationFingerprint) return;
    notificationFingerprint = fingerprint;
    for (const state of states.values()) {
      if (!SETTLED.has(state.status)) continue;
      const runId = basename(runDir);
      const dedupeKey = `node.terminal:${runId}:${state.id}:${state.status}:${state.attempt ?? 0}:${state.revisions ?? 0}`;
      if (alreadyNotified(runDir, dedupeKey)) continue;
      await notifyQueue.enqueue({
        type: "node.terminal",
        campaignId: campaign.campaign.id,
        runId,
        nodeId: state.id,
        status: state.status,
        attempt: state.attempt ?? 0,
        errorCode: terminalErrorCode(state),
        dedupeKey,
      });
    }
  };

  /** @type {Map<string, Job>} */
  const running = new Map();
  // One promise per node currently settling a closed job -- its controller
  // verification, its candidate verification, its judge round -- kept off the
  // tick's critical path so an eligible sibling still dispatches into a free
  // slot while this node's own invocation has already exited. A node's own
  // steps stay ordered because only one settlement per node is ever in flight
  // (see the dispatch loop below); a *different* node's settlement is queued
  // behind whichever one is already running (`settlementQueue`), not run
  // alongside it -- `finalizeClosedJobs` shares state a concurrent second call
  // would corrupt: the phase-continuation selection that picks at most one
  // live node to carry a session forward, and `repo/integrate.mjs`'s one
  // candidate ref and worktree per run. Only *dispatching a sibling* skips
  // ahead of a node's settlement; two nodes' settlements never interleave.
  /** @type {Map<string, Promise<void>>} */
  const pendingSettlements = new Map();
  /** @type {Promise<void>} */
  let settlementQueue = Promise.resolve();
  let canceled = false;
  const cancel = () => { canceled = true; };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  process.once("SIGHUP", cancel);
  // The heartbeat's `at` is owned by an unref'd timer inside this writer, never
  // by the loop body below: a node's settlement can still run for minutes off
  // the tick's critical path (`pendingSettlements`), and the heartbeat must
  // keep answering "the process is alive" while it does.
  const heartbeat = createHeartbeat({ runDir, intervalMs: HEARTBEAT_INTERVAL_MS });
  const heartbeatNodes = new Map(contract.nodes.map((node) => [node.id, node]));
  let heartbeatFingerprint = statesFingerprint(states);
  /** @type {Map<string, number>} */
  const heartbeatOutputAt = new Map();
  const activeHeartbeatNodes = () => [...states.values()]
    .filter((state) => state.status === "running" && heartbeatNodes.has(state.id))
    .map((state) => ({ nodeId: state.id, budgetBasis: nodeBudgetBasisMs(contract, /** @type {ValidatedNode} */ (heartbeatNodes.get(state.id))) }));
  // A programmer error surfacing inside a background settlement must still
  // crash the whole run, exactly as an unguarded `await finalizeClosedJobs`
  // used to: it is recorded here and thrown from the top of the loop on the
  // very next tick, rather than immediately, so it cannot itself become the
  // block a sibling's dispatch is waiting behind. A lost lock is not this --
  // the loop's own `lock.assert()` calls surface that same condition on their
  // own schedule, so it is left for them.
  /** @type {unknown} */
  let backgroundSettlementFailure = null;
  // Mark every job that closed this tick as settling, and free its slot,
  // without waiting for any of them: that alone is what lets an eligible
  // sibling dispatch into the freed slot while this node's minutes-long
  // controller verification or judge round is still running. The actual
  // settlement work is chained onto `settlementQueue`, one node at a time in
  // the order its job closed, so it still runs exactly as serialized against
  // every *other* node's settlement as it did when this loop awaited
  // `finalizeClosedJobs` directly -- `finalizeClosedJobs` runs against a
  // one-entry map per node, so this is one call per node rather than the one
  // batched call it used to be, but the chain still runs them one at a time.
  // A settlement may itself dispatch the node's next phase (a judge, a
  // revision) through the same `startJudge`/`startWorker` calls dispatch below
  // uses, so it is handed the real `running` to dispatch into: a job it starts
  // is counted against `maxParallel` from the instant the process exists, and
  // `applyRejection` reads that same map to decide whether the run has a slot
  // for the revision at all. It used to dispatch into the throwaway one-entry
  // map instead, copied back only once the settlement returned, which is how
  // run state-location-and-routing-economics-13 came to hold two workers under
  // `maxParallel: 1` on 2026-09-21. What it may *settle* is still only its own
  // node: the one-entry map below is the job, not the run. The node's own
  // steps stay ordered by never starting a second settlement for a node whose
  // first has not yet cleared `pendingSettlements`.
  const settleClosedJobsInBackground = () => {
    for (const [nodeId, job] of [...running]) {
      if (pendingSettlements.has(nodeId) || !job.closed || invocationAlive(job.invocation)) continue;
      running.delete(nodeId);
      const settlement = settlementQueue
        .then(() => finalizeClosedJobs(contract, runDir, states, new Map([[nodeId, job]]), lock, campaign.path, running))
        .finally(() => pendingSettlements.delete(nodeId));
      // The queue itself must never reject -- a rejected settlement (a lost
      // lock, a programmer error) would otherwise wedge every node queued
      // behind it. The rejection still reaches whoever awaits the real
      // `settlement` promise (`pendingSettlements`, below).
      settlementQueue = settlement.catch(() => {});
      // Handled here so an in-flight settlement never becomes an unhandled
      // rejection when nobody happens to await `pendingSettlements` before the
      // process exits; the original promise, still held below, carries the
      // rejection to whichever checkpoint (cancel, shutdown) awaits it.
      settlement.catch((error) => {
        if (!(error instanceof LockLostError) && backgroundSettlementFailure === null) backgroundSettlementFailure = error;
      });
      pendingSettlements.set(nodeId, settlement);
    }
  };
  // Captured once, before the loop, rather than re-derived every tick: it is
  // "parked when this controller invocation started" (autoRetryParkedNodes's
  // own contract), and a node a background settlement parks between two ticks
  // -- rather than synchronously within one, as it always did before
  // settlement moved off the tick's critical path -- must still read as newly
  // parked whichever later tick first observes it, not as already-parked
  // because a per-tick snapshot happened to be taken after it landed.
  const parkedBefore = new Set([...states.values()].filter((state) => PARKED.has(state.status)).map((state) => state.id));
  const anyUnsettled = () => [...states.values()].some((state) => !SETTLED.has(state.status));
  try {
    // A `while` that re-checked this at the very top of every tick would exit
    // the instant a background settlement flips the run's last unsettled node
    // straight to a terminal status between two ticks -- before the tick body
    // that would have run `autoRetryParkedNodes` against that new status ever
    // gets to. The entry guard skips the loop entirely when there is nothing
    // to do at all (a resume of an already-settled run still does zero
    // iterations); once inside, the exit check moves to the bottom, after the
    // body, so that body always sees a freshly-parked node at least once
    // before the loop is allowed to end.
    if (anyUnsettled()) for (;;) {
      lock.assert();
      if (backgroundSettlementFailure !== null) throw backgroundSettlementFailure;
      if (existsSync(join(runDir, "cancel.request.json"))) canceled = true;
      if (canceled) {
        // A settlement already in flight owns the one decision a cancellation
        // must not race: what this node's own invocation resolved to. Let it
        // land on its real terminal status (and, when it re-dispatched a judge
        // or a revision, on the new job that landed in `running`) before this
        // branch decides which nodes are merely canceled.
        await Promise.all([...pendingSettlements.values()]);
        const jobs = [...running.values()];
        await Promise.all(jobs.map((job) => terminateProcess(job)));
        const envelopes = new Map();
        for (const job of jobs) envelopes.set(job.invocation.id, recordInvocationUsage(job, { accumulate: false }));
        for (const job of jobs) {
          const invocation = job.state.invocations?.find((item) => item.id === job.invocation.id) ?? job.invocation;
          const scopeOk = job.phase !== "worker" || checkWorkerScope(contract, runDir, job, lock);
          settleInvocation(runDir, invocation, {
            status: scopeOk ? "canceled" : "failed",
            usage: invocation.usage ?? null,
            costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
            receipts: providerReceipts(envelopes.get(job.invocation.id)),
            error: scopeOk ? null : job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
        }
        running.clear();
        for (const state of states.values()) {
          if (!SETTLED.has(state.status)) transition(runDir, state, "canceled", { phase: "canceled" }, lock);
        }
        break;
      }

      // Advisory spend lines are checked every tick, closed job or not: a
      // crossing must be visible while the spend is happening on a node still
      // running, not only once it closes. `finalizeClosedJobs` used to open
      // with this same check; calling it once here, rather than once per
      // node settled this tick, is what keeps it at one pass per tick now
      // that settlement runs per node in `settleClosedJobsInBackground`.
      await emitNodeAdvisories(contract, runDir, states);
      settleClosedJobsInBackground();
      await detectStalls(contract, running, async (job, status, error) => {
        const envelope = recordInvocationUsage(job);
        job.state.usage = invocationUsage(job.state);
        job.state.costUsd = invocationCost(job.state);
        const invocation = job.state.invocations?.find((item) => item.id === job.invocation.id) ?? job.invocation;
        appendUsageRecord(runDir, invocation);
        if (job.phase === "worker" && !checkWorkerScope(contract, runDir, job, lock)) {
          settleInvocation(runDir, invocation, {
            status: "failed",
            usage: invocation.usage ?? null,
            costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
            receipts: providerReceipts(envelope),
            error: job.state.error ?? { code: "scope_check_failed", message: "worker scope check failed" },
            nextState: operationNextState(job.state),
          });
          return;
        }
        settleInvocation(runDir, invocation, {
          status,
          usage: invocation.usage ?? null,
          costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
          receipts: providerReceipts(envelope),
          error,
          nextState: operationNextState(job.state),
        });
        // A judge killed on its own wall clock produced no verdict. That is a
        // judge protocol defect, not a node outcome: it earns the one bounded
        // re-ask, and only then the review mode settles the node.
        if (job.phase === "judge" && (error.code === "wall_clock_timeout" || error.code === "turn_limit")) {
          await applyJudgeProtocolFailure(contract, job.node, job.state, runDir, running, lock, states, campaign.path, error.message);
          return;
        }
        // A timeout whose attempt seal is non-empty earns the one automatic
        // retry (phase 5b supplies the seal); with no seal it parks here.
        if (autoRetryNode(runDir, job.state, error.code, lock)) return;
        transition(runDir, job.state, status, { phase: job.phase, error }, lock);
      }, async (job) => {
        writeNode(runDir, job.state, lock);
      });
      // A node left `running` with no job is a dead end; park it before the
      // dispatch pass so it cannot hide behind a healthy sibling. A node
      // whose closed job is settling in the background is not that dead end
      // -- `pendingSettlements` is what tells this apart from one truly
      // abandoned.
      enforceRunningInvariant(runDir, states, running, lock, pendingSettlements);
      // Before dependants are blocked, a node that parked on this tick gets
      // its one automatic retry: it becomes pending, so `blockDependents` sees
      // nothing to block and the dependants stay `pending`/`phase: "waiting"`
      // until it parks for good.
      autoRetryParkedNodes(contract, runDir, states, lock, parkedBefore);
      blockDependents(contract, runDir, states, lock);

      const slots = contract.maxParallel - running.size;
      if (slots > 0) {
        const ready = contract.nodes.filter((node) => {
          const state = states.get(node.id);
          return state?.status === "pending" && !pendingSettlements.has(node.id)
            && node.dependsOn.every((id) => states.get(id)?.status === "done");
        });
        // Per-runtime capacity is judged per dispatch, not per tick: the
        // counts include what this tick has already started, and a runtime a
        // sibling is waiting out a quota reset on accepts nothing new.
        const counts = runningPerRuntime(running.values());
        const held = quotaHeldRuntimes(states.values(), Date.now());
        let dispatched = 0;
        for (const node of ready) {
          if (dispatched >= slots) break;
          const state = states.get(node.id);
          if (!state || routingBackoffActive(state, state.phase)) continue;
          const routed = routeRuntimeForState(contract, node, state, state.phase === "judge" ? "judge" : "worker");
          if (!runtimeHasCapacity(routed.id, contract, counts, held)) continue;
          counts.set(routed.id, (counts.get(routed.id) ?? 0) + 1);
          dispatched += 1;
          // A node recovered pending a re-ask judge (its own worker attempt
          // already accepted, `state.result` durable) reaches `settleDone` /
          // `integrateAttempt` exactly like a closed job's own settlement
          // does, on the same per-run candidate ref and worktree
          // `settlementQueue` exists to serialize -- so it is dispatched the
          // same way: chained onto the queue rather than awaited here, using
          // `running` itself as its dispatch map, so the judge it starts is
          // counted the instant it exists. The node's own order is untouched
          // (still one entry at a time, gated by `pendingSettlements`); only
          // the tick stops waiting behind it.
          if (state.phase === "judge" && state.result) {
            const workerResult = state.result;
            const settlement = settlementQueue
              .then(() => startJudge(contract, node, state, runDir, running, workerResult, lock, states, campaign.path))
              .then((round) => applyJudgeRound(round, contract, node, state, runDir, running, lock, states, campaign.path, workerResult))
              .finally(() => pendingSettlements.delete(node.id));
            settlementQueue = settlement.catch(() => {});
            settlement.catch((error) => {
              if (!(error instanceof LockLostError) && backgroundSettlementFailure === null) backgroundSettlementFailure = error;
            });
            pendingSettlements.set(node.id, settlement);
            continue;
          }
          state.attempt += 1;
          const prompt = state.gate?.verdict === "fail" ? retryPrompt(node, state.gate) : node.prompt;
          startWorker(contract, node, state, runDir, running, prompt, lock, states, campaign.path);
        }
      }

      renderHandoffIfChanged();
      renderStatusIfChanged();
      await notifyStateChanges();
      // A node state transition is progress; provider output is progress; a
      // node merely still existing is neither, which is what keeps a frozen
      // sibling from hiding behind a healthy one.
      const heartbeatFingerprintNow = statesFingerprint(states);
      if (heartbeatFingerprintNow !== heartbeatFingerprint) {
        heartbeatFingerprint = heartbeatFingerprintNow;
        heartbeat.progress();
      }
      for (const [nodeId, job] of running) {
        const observed = typeof job.lastOutputAt === "number" ? job.lastOutputAt : 0;
        if (observed > (heartbeatOutputAt.get(nodeId) ?? 0)) {
          heartbeatOutputAt.set(nodeId, observed);
          const node = heartbeatNodes.get(nodeId);
          if (node) heartbeat.progress(nodeId, nodeBudgetBasisMs(contract, node));
        }
      }
      heartbeat.setActive(activeHeartbeatNodes());
      // A background settlement can flip a node straight to a parked
      // terminal status during this same tick's own later awaits
      // (`detectStalls`, `notifyStateChanges`), after the auto-retry pass
      // above already ran and saw it as not-yet-parked. Running it once more
      // here, immediately before the exit check, is what stops the loop from
      // mistaking that freshly-parked node for settled and exiting before it
      // ever got its automatic retry; a node it reopens dispatches on the
      // next tick rather than this one, which `anyUnsettled()` below still
      // correctly keeps the loop alive for.
      autoRetryParkedNodes(contract, runDir, states, lock, parkedBefore);
      if (!anyUnsettled()) break;
      await delay(contract.pollIntervalMs);
    }
    // The loop above exits (by the bottom check above or the cancel branch's
    // `break`) the instant every node's state looks settled, but a
    // settlement's own trailing work -- sealing a candidate's acceptance,
    // removing its worktree, enqueueing its terminal notification -- can
    // still be running after the transition that made the state look
    // terminal. Nothing past this point (the final render, the findings
    // artifact, the run-terminal notification, releasing the lock) may run
    // ahead of that trailing work.
    await Promise.all([...pendingSettlements.values()]);
    // A settlement's own `finally` deletes it from `pendingSettlements` the
    // instant it settles, win or lose -- so a rejection recorded here can
    // already be gone from the map above by the time this line runs, with
    // nothing left to await it. The loop's own top-of-tick check
    // (`if (backgroundSettlementFailure !== null) throw ...`) cannot save
    // that case either: the loop has already exited. Checked again here,
    // once, so a background settlement failure can never read as a clean
    // finish just because it settled on the same tick the run's last node
    // did.
    if (backgroundSettlementFailure !== null) throw backgroundSettlementFailure;
  } catch (error) {
    if (!(error instanceof LockLostError)) throw error;
    // A settlement still merges whatever it started into `running` in its own
    // `finally`, win or lose, regardless of whether anything awaits it; wait
    // for that to land (never rejecting itself, so a second lock-loss here
    // cannot mask the one already being handled) before the termination sweep
    // reads `running`.
    await Promise.allSettled([...pendingSettlements.values()]);
    await Promise.all([...running.values()].map((job) => terminateProcess(job)));
    notifyQueuesByRun.delete(runDir);
    return { runDir, states, ok: false, error };
  } finally {
    clearInterval(statusTimer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGHUP", cancel);
    heartbeat.stop();
    lock.release();
  }
  renderStatusIfChanged(false, null);
  renderCampaignHandoffSafely(campaign, runsDir, runDir);
  writeFindingsArtifact(runDir, contract, states);
  const failed = [...states.values()].filter((state) => state.status !== "done");
  const runId = basename(runDir);
  const runDedupeKey = `run.terminal:${runId}:${failed.length ? "attention" : "done"}`;
  if (!alreadyNotified(runDir, runDedupeKey)) {
    await notifyQueue.enqueue({
      type: "run.terminal",
      campaignId: campaign.campaign.id,
      runId,
      done: states.size - failed.length,
      total: states.size,
      dedupeKey: runDedupeKey,
    });
  }
  // Delivery is lossy: there is no retry budget to wait out, so the controller
  // returns as soon as the terminal notification has been attempted once.
  notifyQueuesByRun.delete(runDir);
  process.stdout.write(`[run] ${contract.id} ${failed.length ? `failed · ${runDir} · findings.json` : `done · ${runDir}`}\n`);
  if ([...states.values()].some((state) => state.usage)) {
    const report = renderFinalReport(runDir, contract, states);
    process.stdout.write(report);
  }
  return { runDir, states, ok: failed.length === 0 };
}

/**
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @returns {NodeSnapshot[]}
 */
export function readRunNodes(runDir, contract) {
  const names = listNodeSnapshots(runDir);
  const expected = new Map(contract.nodes.map((node) => [`${node.id}.json`, node]));
  for (const name of names) if (!expected.has(name)) throw new TypeError(`unexpected persisted node snapshot ${name}`);
  return contract.nodes.map((node) => {
    const name = `${node.id}.json`;
    if (!names.includes(name)) throw new TypeError(`missing persisted node snapshot ${name}`);
    return validateNodeSnapshot(readNodeSnapshot(runDir, node.id), node);
  });
}

