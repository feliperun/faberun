/**
 * Putting a worker or a judge in front of a node: resolve the runtime, choose
 * the continuation, build the prompt and the attempt workspace, spawn, and
 * record the invocation intent before a token is spent.
 *
 * It decides nothing about outcomes. `startJudge` runs the mechanical gate and
 * returns what it found -- `rejected`, `settle` or `dispatched` -- for the
 * caller to act on. It used to call `applyRejection` and `settleDone` itself,
 * which made dispatch depend on review policy and on settlement, and that is
 * the shape that kept `engine/` a web instead of a stack.
 */
import { JUDGE_SCHEMA, appendSandboxNotice, judgePrompt } from "./prompts.mjs";
import { LockLostError } from "../run/lock.mjs";
import { TOOL_OUTPUT_LIMIT_BYTES } from "../harnesses/exec-jsonl/index.mjs";
import { appendPreviousAttempt } from "./retry.mjs";
import {
  RESULT_MATERIALIZATION_PROMPT_HEADER,
  attemptWorkerResultPath,
  clearAttemptWorkerResult,
  clearWorkerResultFile,
  readWorkerResultFile,
  workerProtocolPrompt,
} from "./result-file.mjs";
import { attemptWorkspace, createAttemptWorktree, sealAttempt } from "../repo/worktree.mjs";
import { attemptWorktreePath } from "../run/paths.mjs";
import { basename, dirname, join } from "node:path";
import { errorCode, errorMessage } from "../util.mjs";
import { gateProofTimeoutMs } from "../contract/final-verification.mjs";
import { captureWorkspaceScope, captureWorkspaceSnapshot } from "../repo/workspace.mjs";
import { deterministicGate, judgeReaskReason, judgeRequired, judgeSkippedByScope } from "./judge-gate.mjs";
import { emptyScope, persistedScopeBoundary, workerScope } from "./scope.mjs";
import { hasOperationIntent, hasOperationSettlement, operationNeedsRecovery, operationNextState, persistInvocationIntent, providerReceipts, settleInvocation } from "../run/operations.mjs";
import { invocationCost, invocationUsage } from "../run/usage.mjs";
import { logPaths, startProcess } from "./process.mjs";
import { readBoundedTail } from "./transcript.mjs";
import { mkdirSync, statSync } from "node:fs";
import { READ_BYTE_LIMIT, READ_LINE_LIMIT, harnessCapabilities, normalizeProviderResult, writesWorkspace } from "../harnesses/index.mjs";
import { writeJsonAtomic } from "../run/store.mjs";
import { judgeReaskInstruction, reviewMode } from "../contract/review-modes.mjs";
import { routeRuntimeForState, runtimeSnapshot } from "./failover.mjs";
import { fingerprintRuntime, forceFreshSession, phaseInvocationPlan } from "./phase-session.mjs";

/** @typedef {import("./phase-session.mjs").SessionPolicy} SessionPolicy */
import { transition, writeNode } from "./state.mjs";

/**
 * What a judge round decided, for the caller to act on.
 * `rejected`: the mechanical gate failed, so nothing was dispatched.
 * `settle`: the gate passed and no judgment item needs arbitrating.
 * `dispatched`: a judge is running (or failed to start and the node is already
 * marked failed).
 *
 * @typedef {{kind: "rejected", verdict: JudgeVerdict}|{kind: "settle", gate: JudgeVerdict}|{kind: "dispatched"}} JudgeRound
 */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */

/** @typedef {import("../harnesses/index.mjs").CommandOptions} CommandOptions */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").VerificationState} VerificationState */
/** @typedef {import("../contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */



/** @param {Invocation} invocation @param {ValidatedContract} contract @param {ValidatedNode} node @param {RuntimeSnapshot} runtime @param {NodeSnapshot} state @param {string} runDir @param {"worker"|"judge"} role @param {"fresh"|"reuse"|"rotate"} mode @param {string|null} continuationId */
function stampInvocation(invocation, contract, node, runtime, state, runDir, role, mode, continuationId) {
  invocation.runId = basename(runDir);
  invocation.campaignId = contract.campaignId;
  invocation.nodeId = node.id;
  invocation.attempt = state.attempt;
  invocation.workspace = attemptWorkspace(state) ?? contract.cwd;
  invocation.worktreeBranch = state.worktree?.branch ?? null;
  invocation.worktreeBaseSha = state.worktree?.baseSha ?? null;
  invocation.planPhase = node.phase;
  invocation.role = role;
  invocation.runtimeFingerprint = fingerprintRuntime(runtime);
  invocation.model = runtime.model;
  invocation.reasoning = runtime.reasoning ?? null;
  invocation.sandbox = runtime.sandbox ?? null;
  invocation.continuationId = continuationId;
  invocation.continuationMode = mode;
  // The tier-exhaustion generation this invocation belongs to, stamped exactly
  // like `revision` so `planRoute` can scope its attempted set to the current
  // generation across a controller crash.
  /** @type {{cycle?: number}} */ (invocation).cycle = state.routing?.tierExhaustionCycle ?? 0;
}
/**
 * The declared weight of a node's readFiles at dispatch time: the sum of the
 * byte sizes of the files that exist in the attempt workspace. This is the
 * one quantity the controller can measure about a packet's reference load --
 * the worker prompt lists readFiles and the worker reads them itself, so what
 * it actually reads is the harness's business. A missing file counts 0 rather
 * than throwing: a declared path can be produced by a dependency that has not
 * run yet or removed by the tree since the packet was authored.
 *
 * @param {string[]} readFiles
 * @param {string} workspace
 * @returns {number}
 */
export function declaredReadBytes(readFiles, workspace) {
  let total = 0;
  for (const path of readFiles) {
    try {
      total += statSync(join(workspace, path)).size;
    } catch {
      // Missing or unreadable file: contributes no weight.
    }
  }
  return total;
}
/**
 * The mechanical worker tool policy for the provider boundary: hook settings
 * on Claude-compatible commands. Only an adapter whose surface can prove
 * enforcement (`capabilities.toolPolicy`) receives it; prompt text is not
 * enforcement.
 *
 * @param {RuntimeSnapshot} runtime
 * @param {ValidatedNode} node
 * @param {string} workspace
 * @returns {import("../harnesses/index.mjs").ToolPolicy|undefined}
 */
function workerToolPolicy(runtime, node, workspace) {
  if (runtime.capabilities.toolPolicy !== true) return undefined;
  return {
    foregroundOnly: true,
    maxToolOutputBytes: TOOL_OUTPUT_LIMIT_BYTES,
    workspace,
    writeFiles: node.taskPacket.writeFiles ?? [],
    writeRoots: node.taskPacket.writeRoots ?? [],
    maxReadLines: READ_LINE_LIMIT,
    maxReadBytes: READ_BYTE_LIMIT,
  };
}
/**
 * Build the bounded options shared by workers, judges, and gate revisions.
 * Only provider session continuation travels here; time is the controller's
 * only attempt control.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {RuntimeSnapshot} runtime
 * @param {{prompt: string, continuationId: string|null, mode: "fresh"|"reuse"|"rotate"}} phasePlan
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {import("../harnesses/index.mjs").CommandOptions} [extra]
 * @returns {import("../harnesses/index.mjs").CommandOptions}
 */
function invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, extra = {}) {
  // A harness that streams its stdout proves liveness through the event
  // monitor; a buffered one (zcode's `--json` writes only at exit) has one
  // live surface left, its own log stream, and the adapter decides whether
  // this dir means anything to it. Streaming harnesses get none: their log
  // dir would be dead weight the engine never watches.
  const streaming = harnessCapabilities(runtime).streamsOutput === true;
  return {
    ...extra,
    continuationId: runtime.capabilities.continuation === true ? phasePlan.continuationId : null,
    // The attempt's request ceiling. An adapter that can enforce it natively
    // takes it as a flag; the monitor enforces it for every streaming harness.
    maxTurns: node.maxTurns ?? contract.maxTurns,
    logDir: streaming ? null : join(runDir, "logs", `${node.id}.${state.attempt}.provider`),
  };
}
/**
 * Seal the worktree the previous attempt left behind so its edits become the
 * base of the next attempt instead of being abandoned in a discarded
 * worktree (TECH-SPEC lean v0.3 section 3 rule 4). By the time this runs,
 * `state.worktree` still points at the previous attempt — the caller always
 * increments `state.attempt` before dispatching the next one — so that
 * attempt's number is `state.attempt - 1`. Returns null when there is no
 * previous worktree to seal, or it carries no diff from its own base: the
 * next attempt is then cut from the integration head as before.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @returns {{sha: string, attempt: number}|null}
 */
function sealPreviousAttempt(contract, node, state) {
  const path = attemptWorkspace(state);
  if (!path || !state.worktree?.branch || !state.worktree.baseSha) return null;
  const attempt = state.attempt - 1;
  const sealed = sealAttempt({
    repo: contract.cwd,
    path,
    baseSha: state.worktree.baseSha,
    runId: contract.id,
    nodeId: node.id,
    attempt,
    exclude: state.verificationArtifacts,
  });
  return sealed.empty ? null : { sha: sealed.sha, attempt };
}
/**
 * Create the isolated workspace for the current attempt, or reuse the exact
 * one already recorded for a controller restart. A retried attempt continues
 * from the previous attempt's sealed sha rather than a fresh cut from the
 * integration head, so sealed work is never abandoned in a discarded
 * worktree.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @returns {string}
 */
function ensureAttemptWorkspace(contract, node, state, runDir, lock) {
  const expectedPath = attemptWorktreePath(runDir, contract.id, node.id, state.attempt);
  if (state.worktree?.path === expectedPath && attemptWorkspace(state)) return expectedPath;
  const previous = sealPreviousAttempt(contract, node, state);
  const worktree = createAttemptWorktree({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    nodeId: node.id,
    attempt: state.attempt,
    declaredReads: node.taskPacket.readFiles,
    base: previous?.sha,
  });
  const boundary = captureWorkspaceScope(worktree.path, workerScope(node.taskPacket));
  state.worktree = previous ? { ...worktree, previousAttempt: previous.attempt } : worktree;
  state.scope = emptyScope(boundary);
  writeNode(runDir, state, lock);
  return worktree.path;
}
/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {string} prompt
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {SessionPolicy} [policy] the session policy the rejection decision
 *   carried into dispatch; `forceFresh` starts a fresh provider session instead
 *   of reusing the failed attempt's continuation. A policy persisted on the
 *   snapshot by `applyRejection` is merged in and consumed.
 */
export function startWorker(contract, node, state, runDir, running, prompt, lock, states, campaignPath, policy = {}) {
  // Resolve before the workspace is created: the one-shot policy governs this
  // dispatch whether the caller passed it or `applyRejection` left it behind.
  const sessionPolicy = forceFreshSession(state, policy);
  let workspace;
  try {
    workspace = ensureAttemptWorkspace(contract, node, state, runDir, lock);
  } catch (error) {
    state.worktree = { ...(state.worktree ?? {}), status: "failed", path: state.worktree?.path ?? null, branch: state.worktree?.branch ?? null, commit: state.worktree?.commit ?? null, baseSha: state.worktree?.baseSha ?? null };
    transition(runDir, state, "failed", { phase: "worker", error: { code: errorCode(error) ?? "worktree_create_failed", message: errorMessage(error) } }, lock);
    return;
  }
  const runtime = routeRuntimeForState(contract, node, state, "worker");
  const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "worker", prompt, sessionPolicy);
  // The previous-attempt section still has to survive on a retried attempt,
  // so it is appended to the resolved prompt rather than the candidate handed
  // to phaseInvocationPlan.
  phasePlan.prompt = appendPreviousAttempt(phasePlan.prompt, state.previousAttempt);
  // The resolved worker's sandbox is a dispatch-time fact, not a packet one.
  phasePlan.prompt = appendSandboxNotice(phasePlan.prompt, runtime);
  // The worker prompt directs the provider to write the canonical result file;
  // make sure the directory exists before the provider is asked to.
  const resultPath = attemptWorkerResultPath(runDir, node.id, workspace);
  mkdirSync(dirname(resultPath), { recursive: true });
  const effectivePrompt = workerProtocolPrompt(phasePlan.prompt, resultPath, writesWorkspace(runtime));
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  if (Buffer.byteLength(effectivePrompt, "utf8") > 64 * 1024) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "worker_prompt_too_large", message: "worker prompt exceeds 65536 bytes" } }, lock);
    return;
  }
  /** @type {import("../repo/workspace.mjs").WorkspaceScopeBoundary} */
  let boundary;
  /** @type {unknown} */
  let baseline;
  try {
    boundary = persistedScopeBoundary(contract, node, state, workspace);
    baseline = captureWorkspaceSnapshot(workspace);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: errorMessage(error) } }, lock);
    return;
  }
  const snapshotPath = `${paths.prompt}.snapshot.json`;
  writeJsonAtomic(snapshotPath, baseline);
  state.phase = "worker";
  state.runtime = runtime;
  state.declaredReadBytes = declaredReadBytes(node.taskPacket.readFiles ?? [], workspace);
  // A new worker attempt has no accepted result yet. The canonical result
  // file is cleared when the previous attempt was explicitly rejected (failed
  // gate verdict), when no valid canonical file exists, or when the stale file
  // is a blocked_context result. A blocked_context result never reached a gate
  // and is still a valid, non-null canonical file, so the failed-gate and
  // missing-file conditions leave it in place and the re-dispatched node would
  // adopt its own stale blocked_context result again. A valid non-blocked file
  // at the start of a continuation attempt is durable evidence and must stay
  // in place so the completion path can adopt it.
  state.result = null;
  state.verification = null;
  state.scope = null;
  let existingCanonicalResult = null;
  try {
    existingCanonicalResult = readWorkerResultFile(runDir, node.id);
  } catch {
    existingCanonicalResult = null;
  }
  clearAttemptWorkerResult(workspace, node.id);
  if (state.gate?.verdict === "fail" || existingCanonicalResult === null || existingCanonicalResult?.status === "blocked_context") {
    clearWorkerResultFile(runDir, node.id);
  }
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  state.startedAt ??= new Date().toISOString();
  state.error = null;
  state.scope = emptyScope(boundary);
  writeNode(runDir, state, lock);
  try {
    const job = startProcess({
      contract, node, state, runtime, workspace, prompt: effectivePrompt, paths, phase: "worker",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, {
        toolPolicy: workerToolPolicy(runtime, node, workspace),
        // The pair a `bulk-read` delegation inside the worker accounts itself
        // against; providerCommand merges it into the spawned environment.
        env: { FABERUN_RUN_DIR: runDir, FABERUN_NODE_ID: node.id },
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, state, runDir, "worker", phasePlan.mode, phasePlan.continuationId);
        invocation.snapshotPath = snapshotPath;
        currentJob.scopeBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "worker",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: effectivePrompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
      onProgress: () => writeNode(runDir, state, lock),
    });
    transition(runDir, state, "running", { phase: "worker", runtime, error: null }, lock);
    running.set(node.id, job);
  } catch (error) {
    const invocation = state.invocations?.at(-1);
    if (invocation && hasOperationIntent(runDir, invocation.id) && operationNeedsRecovery(runDir, invocation.id)) {
      settleInvocation(runDir, invocation, {
        status: "failed",
        error: { code: "spawn_error", message: errorMessage(error) },
        reason: "provider did not start",
        nextState: operationNextState(state),
      });
    }
    transition(runDir, state, "failed", { phase: "worker", error: { code: "spawn_error", message: errorMessage(error) } }, lock);
  }
}
/**
 * A completed implementation may have omitted only its durable result. Resume
 * the exact provider session for one turn to materialize that file; never use
 * this path to restart implementation work.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {Invocation} sourceInvocation
 * @param {HarnessRuntime & {id: string|null}} runtime
 * @param {string|null} continuationId
 * @param {LockHandle} lock
 */
export function startResultMaterialization(contract, node, state, runDir, running, sourceInvocation, runtime, continuationId, lock) {
  const materializationRuntime = runtime.id ? runtimeSnapshot(contract, runtime.id) : null;
  if (!materializationRuntime || materializationRuntime.capabilities.continuation !== true || !continuationId) {
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "missing_worker_result", message: "worker completed without a canonical result file and this runtime did not provide a resumable session for the one-turn materialization" },
    }, lock);
    return;
  }
  const paths = logPaths(runDir, node.id, "worker", state.attempt);
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const resultPath = attemptWorkerResultPath(runDir, node.id, workspace);
  const prompt = appendSandboxNotice([
    `${RESULT_MATERIALIZATION_PROMPT_HEADER} Do not inspect, implement, verify, or invoke tools.`,
    ...(writesWorkspace(materializationRuntime)
      ? [`Your only job in this single bounded turn is to write the required worker-result JSON object to: ${resultPath}`, "Then return that same JSON object as the final message."]
      : ["Your sandbox is read-only, so write no file: your only job in this single bounded turn is to return the required worker-result JSON object as the final message."]),
  ].join("\n\n"), materializationRuntime);
  let baseline;
  try {
    baseline = captureWorkspaceSnapshot(workspace);
    writeJsonAtomic(`${paths.prompt}.snapshot.json`, baseline);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "result_materialization_snapshot_invalid", message: errorMessage(error) } }, lock);
    return;
  }
  state.phase = "worker";
  state.runtime = materializationRuntime;
  state.error = { code: "result_materialization_pending", message: "awaiting one-turn canonical worker-result materialization" };
  writeNode(runDir, state, lock);
  try {
    const job = startProcess({
      contract, node, state, runtime: materializationRuntime, workspace, prompt, paths, phase: "worker",
      commandOptions: invocationCommandOptions(contract, node, state, materializationRuntime, {
        prompt,
        continuationId,
        mode: "reuse",
      }, runDir, lock, {
        toolPolicy: workerToolPolicy(materializationRuntime, node, workspace),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, materializationRuntime, state, runDir, "worker", "reuse", continuationId);
        invocation.snapshotPath = `${paths.prompt}.snapshot.json`;
        currentJob.resultMaterialization = true;
        currentJob.recoveryBaseline = baseline;
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "worker",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(materializationRuntime),
          prompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
    });
    transition(runDir, state, "running", { phase: "worker", runtime: materializationRuntime }, lock);
    running.set(node.id, job);
  } catch (error) {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "result_materialization_failed", message: errorMessage(error) } }, lock);
  }
}
/**
 * Gate a completed worker: mechanical proofs gate first, the judge arbitrates
 * only judgment items and is skipped when the review mode is `none` or no
 * judgment item exists. A judge protocol re-ask never re-runs the round's
 * mechanical proofs.
 *
 * Returns what it decided rather than acting on it. Calling `applyRejection` or
 * `settleDone` from here made dispatch depend on review policy and on
 * settlement, which is the shape that kept `engine/` a web instead of a stack:
 * every caller of this function already reaches both, and now it is their call.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {unknown} workerResult
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @returns {Promise<JudgeRound>}
 */
export async function startJudge(contract, node, state, runDir, running, workerResult, lock, states, campaignPath) {
  const reaskReason = judgeReaskReason(state);
  const reask = reaskReason !== undefined;
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const { verdict, results } = await deterministicGate(
    node,
    workspace,
    reask,
    gateProofTimeoutMs(node, contract),
    /** @type {import("../contract/index.mjs").VerificationState|null} */ (state.verification),
  );
  state.review = reviewMode(node.gate);
  if (verdict.verdict === "fail") return { kind: "rejected", verdict };
  // `skipWhen` is checked before the ordinary judgment rule so a green-and-small
  // change settles mechanically even when a Definition of Done item carries
  // `judgment: true`. Either condition failing falls through to `judgeRequired`,
  // and a gate whose review mode is `none` is skipped there exactly as before.
  if (judgeSkippedByScope(node, state)) return { kind: "settle", gate: verdict };
  if (!judgeRequired(node)) return { kind: "settle", gate: verdict };
  const runtime = routeRuntimeForState(contract, node, state, "judge");
  const paths = logPaths(runDir, node.id, "judge", state.attempt);
  state.phase = "judge";
  state.runtime = runtime;
  const previousInvocation = state.invocations?.at(-1);
  if (previousInvocation && hasOperationSettlement(runDir, previousInvocation.id)) {
    settleInvocation(runDir, previousInvocation, { nextState: operationNextState(state) });
  }
  try {
    const prompt = `${judgePrompt(node, workerResult, {
      diff: state.scope?.changedPaths,
      verification: state.verification,
      deterministic: results,
      scopeFindings: state.scopeFindings,
      previousAttempt: state.previousAttempt,
    })}${reask ? judgeReaskInstruction(reaskReason) : ""}`;
    const phasePlan = phaseInvocationPlan(contract, node, state, runDir, "judge", prompt);
    // judgePrompt already carries the section when phaseInvocationPlan reuses
    // that candidate; appendPreviousAttempt is a no-op then.
    phasePlan.prompt = appendPreviousAttempt(phasePlan.prompt, state.previousAttempt);
    if (Buffer.byteLength(phasePlan.prompt, "utf8") > 64 * 1024) {
      const error = /** @type {Error & {code: string}} */ (new Error("judge prompt exceeds 65536 bytes"));
      error.code = "judge_prompt_too_large";
      throw error;
    }
    // Captured at the last possible instant before the judge can touch
    // anything, so the settlement pass's comparison proves what the judge
    // itself wrote rather than racing whatever ran just before dispatch. A
    // capture failure must not block dispatch -- the write check is a
    // controller invariant on top of whatever the judge does, not a
    // precondition for running it -- so it degrades to unchecked instead of
    // to a refusal.
    let judgeBaseline;
    try {
      judgeBaseline = captureWorkspaceSnapshot(workspace);
    } catch {
      judgeBaseline = null;
    }
    const job = startProcess({
      contract, node, state, runtime, workspace,
      prompt: phasePlan.prompt,
      paths, phase: "judge",
      commandOptions: invocationCommandOptions(contract, node, state, runtime, phasePlan, runDir, lock, {
        schema: JUDGE_SCHEMA,
        schemaPath: join(runDir, "judge.schema.json"),
      }),
      onInvocation: (invocation, currentJob) => {
        stampInvocation(invocation, contract, node, runtime, state, runDir, "judge", phasePlan.mode, phasePlan.continuationId);
        // Reusing the worker phase's own scratch field: a job is never both a
        // worker and a judge, and this field carries no persisted shape of
        // its own that a judge borrowing it would have to match.
        currentJob.scopeBaseline = judgeBaseline;
        persistInvocation(runDir, state, invocation, currentJob, lock);
        persistInvocationIntent(runDir, invocation, {
          nodeId: node.id,
          role: "judge",
          attempt: state.attempt,
          runtimeFingerprint: fingerprintRuntime(runtime),
          prompt: phasePlan.prompt,
        });
      },
      onInvocationUpdate: (invocation) => persistInvocationUpdate(runDir, state, invocation, lock),
    });
    transition(runDir, state, "running", { phase: "judge", runtime }, lock);
    running.set(node.id, job);
  } catch (error) {
    const invocation = state.invocations?.at(-1);
    if (invocation && hasOperationIntent(runDir, invocation.id) && operationNeedsRecovery(runDir, invocation.id)) {
      settleInvocation(runDir, invocation, {
        status: "failed",
        error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) },
        reason: "provider did not start",
        nextState: operationNextState(state),
      });
    }
    transition(runDir, state, "failed", { phase: "judge", error: { code: /** @type {string} */ (errorCode(error) ?? "spawn_error"), message: errorMessage(error) } }, lock);
  }
  return { kind: "dispatched" };
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {Job} job
 * @param {LockHandle} lock
 */
function persistInvocation(runDir, state, invocation, job, lock) {
  state.invocations = [...(state.invocations ?? []), invocation];
  state.updatedAt = invocation.updatedAt;
  writeNode(runDir, state, lock);
  job.onClose = (closed) => {
    try {
      let continuationId = closed.continuationId ?? null;
      let usage = closed.usage;
      let costUsd = closed.costUsd;
      let envelopeStatus = "closed";
      let structuredResult = null;
      let envelopeResult = null;
      let envelopeError = null;
      try {
        const envelope = normalizeProviderResult(job.runtime, readBoundedTail(job.paths.stdout), job.exitCode, null, { preferStructured: job.phase === "judge" });
        continuationId = envelope.continuationId ?? continuationId;
        usage = envelope.usage;
        costUsd = envelope.costUsd;
        envelopeStatus = envelope.status;
        structuredResult = Boolean(envelope.result);
        envelopeResult = envelope.result ?? null;
        envelopeError = envelope.error ?? null;
      } catch {
        // Unparseable provider envelope: settle with the raw closed invocation instead.
      }
      const completed = { ...closed, continuationId, usage, costUsd };
      state.invocations = (state.invocations ?? []).map((item) => item.id === completed.id ? completed : item);
      state.usage = invocationUsage(state);
      state.costUsd = invocationCost(state);
      state.updatedAt = closed.updatedAt;
      writeNode(runDir, state, lock);
      settleInvocation(runDir, completed, {
        status: envelopeStatus,
        usage,
        costUsd: typeof costUsd === "number" ? costUsd : null,
        structuredResult,
        result: envelopeResult,
        receipts: providerReceipts({ continuationId }),
        error: envelopeError,
        nextState: operationNextState(state),
      });
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
    }
  };
}
/**
 * Persist live provider observations without creating a second invocation
 * record. Continuation identity is authoritative before the provider log is
 * capped or the process is terminated.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {Invocation} invocation
 * @param {LockHandle} lock
 */
function persistInvocationUpdate(runDir, state, invocation, lock) {
  try {
    state.invocations = (state.invocations ?? []).map((item) => item.id === invocation.id ? invocation : item);
    state.updatedAt = invocation.updatedAt;
    writeNode(runDir, state, lock);
  } catch (error) {
    if (!(error instanceof LockLostError)) throw error;
  }
}
