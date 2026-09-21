/**
 * How a node ends: accepted and integrated, rejected, or parked for attention.
 *
 * These are the settlement primitives, and they are their own module because
 * both the control loop and the review policy call them -- `settleDone`'s
 * `onVerificationFailure` callback rejects the candidate, and `review.mjs`
 * settles a node whose judge passed. Leaving them in `engine/lifecycle.mjs`
 * made those two import each other, which was the last runtime import cycle in
 * `src/` and the one the allowlist used to name.
 *
 * `settleDone` is the only place a node becomes `done`, and it does it through
 * the integration transaction: the journal and the conditional ref update
 * belong to `repo/integrate.mjs`, and the callbacks here own node state alone.
 */
import { candidateOnlyFailures, resetPhaseRouting, verificationFailureVerdict } from "./judge-gate.mjs";
import { retryPrompt } from "./prompts.mjs";
import { renderPreviousAttemptSection } from "./retry.mjs";
import { startWorker } from "./dispatch.mjs";
import { ensureTerminalEvent, transition, writeNode } from "./state.mjs";
import { verificationFailureWithScope } from "../contract/scope-findings.mjs";
import { alreadyNotified, notifyQueueFor } from "./notify-queue.mjs";

import {
  attemptWorkspace,
  removeWorktree,
  sealAttempt,
} from "../repo/worktree.mjs";
import { attemptWorktreePath } from "../run/paths.mjs";
import { basename } from "node:path";
import { boundedUtf8, errorCode, errorMessage } from "../util.mjs";
import { campaignIdOf } from "../campaign/record.mjs";
import { integrateAttempt } from "../repo/integrate.mjs";
import { verifyCandidateWorkspace } from "./verify.mjs";

/** @typedef {import("../repo/integrate.mjs").IntegrationResult} IntegrationResult */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("./prompts.mjs").JudgeVerdict} JudgeVerdict */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */

/**
 * Settle one worker-generation rejection: bounded revision when one remains,
 * otherwise terminal exhausted/failed. The revision budget is the node's
 * (`gate.maxRevisions`, default 1) whether or not the gate reviews: a red
 * deterministic verification earns the same fresh attempt with the failure in
 * front of the worker that a judge rejection does. Measured 2026-09-20 in the
 * orchestration-arms campaign: with the budget behind `gate.enabled`, a node
 * under `gate: false` died on one timing test that flaked under load, and its
 * dependant with it, while the judged twin of the same node got its retry.
 * @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} verdict @param {{code: string, label: string, phase?: "worker"|"judge", message?: string, forceFresh?: boolean}} options */
export function applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, options) {
  const { code, label, phase = "worker", message = verdict.summary, forceFresh = true } = options;
  state.gate = verdict;
  if (state.revisions < (node.gate.maxRevisions ?? 1)) {
    resetPhaseRouting(state);
    state.revisions += 1;
    // The fresh-session decision travels with the node, not just this call:
    // the `running === null` branch below hands the retry to the scheduler,
    // whose own `startWorker` call carries no policy and would otherwise
    // rediscover the prior compatible continuation from the persisted ledger.
    // `startWorker` consumes and clears it, so it governs one dispatch only.
    state.sessionPolicy = forceFresh ? { forceFresh: true } : null;
    process.stdout.write(`[${label}] ${node.id} retry · ${verdict.summary}\n`);
    // The retry is a fresh session when the decision says so, so the evidence
    // it needs has to travel in the prompt, not the transcript. Rendering the
    // bounded `## Previous attempt` section here means both the immediate
    // dispatch below and a later scheduler dispatch (the `running` is null
    // path) carry it.
    state.previousAttempt = renderPreviousAttemptSection(state) ?? state.previousAttempt;
    // A revision is a new attempt, and a new attempt is a dispatch: it starts
    // here only against a slot the run actually has free. `running` is the
    // scheduler's own map, with this node's own closed job already out of it,
    // so `running.size` is exactly what the dispatch loop's own
    // `maxParallel - running.size` will read. A settlement that dispatched
    // regardless is how run state-location-and-routing-economics-13 ran two
    // workers under `maxParallel: 1` on 2026-09-21, and two of that day's
    // three OOM kills happened with more running than the contract declared.
    if (running && running.size < contract.maxParallel) {
      // Dispatching here owns the increment, because `startWorker` expects the
      // attempt number it is about to run under.
      state.attempt += 1;
      startWorker(contract, node, state, runDir, running, retryPrompt(node, verdict), lock, states, campaignPath, { forceFresh });
      return;
    }
    // Handing the node back to the scheduler instead -- because there is no
    // loop to hand it to (recovery, resume), or because the run is full and
    // the scheduler is the one place that knows when it stops being full. Its
    // dispatch increments on the way out, so incrementing here too spent two
    // attempt numbers on one retry. Observed 2026-09-13 on a resume after a
    // killed controller — a node that ran twice reported attempt 3, with no
    // `…2.*` logs and a `worktree.previousAttempt` naming an attempt that
    // never existed.
    transition(runDir, state, "pending", { phase: "worker", error: null }, lock);
    return;
  }
  transition(runDir, state, node.gate.enabled ? "exhausted" : "failed", {
    phase,
    gate: verdict,
    error: { code, message },
  }, lock);
}
/** Deterministic verification failure settles through the shared rejection path. The verdict carries this attempt's unexpected paths, so a red attempt reports them whether it stops here or starts its revision (TECH-SPEC lean, rule 1). @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {Map<string, Job>|null} running @param {LockHandle} lock @param {Map<string, NodeSnapshot>} states @param {string} campaignPath @param {JudgeVerdict} [verdict] */
export function applyVerificationFailure(contract, node, state, runDir, running, lock, states, campaignPath, verdict = verificationFailureWithScope(verificationFailureVerdict(contract, state), state.scope)) {
  applyRejection(contract, node, state, runDir, running, lock, states, campaignPath, verdict, { code: "verification_failed", label: "verification" });
}

/**
 * The bounded operator-facing note when the integration candidate needed
 * `verifyCandidateWorkspace`'s one retry to agree with the attempt. The node
 * snapshot schema has no free-text `note` field of its own; `gate.summary` is
 * the one it already carries that `statusNote` (report/render.mjs) surfaces,
 * so a retried acceptance folds its note there instead of failing on an
 * unknown field the next time the state is written.
 *
 * @param {unknown} candidateEvidence
 * @returns {string|null}
 */
function candidateRetryNote(candidateEvidence) {
  const record = /** @type {{retried?: unknown, commands?: Array<{argv?: string[]}>}} */ (candidateEvidence ?? {});
  const indexes = Array.isArray(record.retried) ? record.retried : [];
  if (!indexes.length) return null;
  const argvList = indexes.map((index) => (record.commands?.[/** @type {number} */ (index)]?.argv ?? []).join(" ")).join(", ");
  return boundedUtf8(`candidate verification retried: ${argvList}`, 256);
}
/**
 * @param {import("../contract/index.mjs").GateResult|null|undefined} gate
 * @param {string} note
 * @returns {import("../contract/index.mjs").GateResult}
 */
function withCandidateRetryNote(gate, note) {
  if (!gate) return { verdict: "pass", maxSeverity: "none", summary: note, findings: [] };
  return { ...gate, summary: boundedUtf8(`${gate.summary} · ${note}`, 4 * 1024) };
}
/**
 * Seal the current attempt, verify its candidate in a detached worktree, and
 * only then perform the single done-state transition. The integration module
 * owns the journal and conditional ref update; this callback owns node state.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {Partial<NodeSnapshot>} [patch]
 * @returns {Promise<import("../repo/integrate.mjs").IntegrationResult|null|undefined>}
 */
export async function settleDone(contract, node, state, runDir, lock, states, campaignPath, patch = {}) {
  const workspace = attemptWorkspace(state);
  if (!workspace || !state.worktree?.branch || !state.worktree.baseSha) {
    transition(runDir, state, "failed", {
      phase: "complete",
      error: { code: "attempt_worktree_missing", message: "completed attempt has no isolated worktree" },
    }, lock);
    return;
  }
  let sealed;
  try {
    sealed = sealAttempt({
      repo: contract.cwd,
      path: workspace,
      baseSha: state.worktree.baseSha,
      runId: contract.id,
      nodeId: node.id,
      attempt: state.attempt,
    });
    state.worktree = { ...state.worktree, commit: sealed.sha, status: "ready" };
    writeNode(runDir, state, lock);
  } catch (error) {
    transition(runDir, state, "failed", {
      phase: "complete",
      error: { code: errorCode(error) ?? "attempt_seal_failed", message: errorMessage(error) },
    }, lock);
    return;
  }
  const result = await integrateAttempt({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    nodeId: node.id,
    attempt: state.attempt,
    attemptSha: sealed.sha,
    branch: state.worktree.branch,
    verificationEvidence: state.verification,
    verifyCandidate: (candidateWorkspace) => verifyCandidateWorkspace(contract, node, state, runDir, candidateWorkspace, lock),
    onAccepted: async (transaction) => {
      const acceptedPath = state.worktree?.path ?? attemptWorktreePath(runDir, contract.id, node.id, transaction.attempt);
      if (state.attempt === transaction.attempt && state.status !== "done") {
        const retryNote = candidateRetryNote(/** @type {{verificationEvidence?: {candidate?: unknown}}} */ (transaction).verificationEvidence?.candidate);
        transition(runDir, state, "done", {
          ...patch,
          // The engine carries the node's inherited requirement ids back with
          // the accepted result; the worker never declares them.
          ...(node.requirementIds?.length ? { requirementIds: node.requirementIds } : {}),
          ...(retryNote ? { gate: withCandidateRetryNote(/** @type {import("../contract/index.mjs").GateResult|null|undefined} */ (patch.gate ?? state.gate), retryNote) } : {}),
          integratedHead: transaction.candidateSha,
          worktree: { ...(state.worktree ?? {}), status: "removed", commit: transaction.attemptSha, baseSha: transaction.previousRunRefTip },
        }, lock);
      }
      if (state.attempt === transaction.attempt) ensureTerminalEvent(runDir, state, lock);
      removeWorktree(contract.cwd, acceptedPath);
    },
    onVerificationFailure: async (transaction) => {
      const verdict = verificationFailureWithScope(verificationFailureVerdict(contract, state), state.scope);
      verdict.summary = "integrated candidate verification failed";
      const divergent = candidateOnlyFailures(state.verification, transaction.candidateEvidence);
      verdict.findings = [...(verdict.findings ?? []), {
        severity: "critical",
        description: divergent.length
          ? `the integration worktree failed a verification the attempt passed (${boundedUtf8(divergent.join("; "), 512)}): the two worktrees disagree about the environment, not about the work`
          : "the sealed candidate did not pass the node verification in its integration worktree",
        evidence: boundedUtf8(JSON.stringify(transaction.candidateEvidence ?? {}), 4 * 1024),
      }];
      applyRejection(contract, node, state, runDir, null, lock, states, campaignPath, verdict, {
        code: "verification_failed",
        label: "candidate-verification",
      });
    },
    onConflict: async (transaction) => {
      const paths = transaction.conflictingPaths?.length ? transaction.conflictingPaths.join(", ") : "unknown paths";
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_conflict", message: `integration conflict in: ${paths}` },
      }, lock);
      if (campaignPath) await raiseNodeAttention(campaignPath, runDir, state, "integration_conflict");
    },
    onConcurrentMove: async (transaction) => {
      transition(runDir, state, "blocked", {
        phase: "complete",
        error: { code: "integration_concurrent_move", message: `run ref moved from ${transaction.previousRunRefTip} to ${transaction.currentRunRefTip ?? "unknown"}` },
      }, lock);
      if (campaignPath) await raiseNodeAttention(campaignPath, runDir, state, "integration_concurrent_move");
    },
  });
  return result;
}
/**
 * Surface a node attention state through the run's notify queue.
 * @param {string} campaignPath
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {string} code
 */
export async function raiseNodeAttention(campaignPath, runDir, state, code) {
  const runId = basename(runDir);
  const dedupeKey = `attention:${runId}:${state.id}:${code}`;
  if (alreadyNotified(runDir, dedupeKey)) return;
  await notifyQueueFor(runDir).enqueue({
    type: "attention",
    campaignId: campaignIdOf(campaignPath),
    runId,
    nodeId: state.id,
    errorCode: code,
    dedupeKey,
  });
}
