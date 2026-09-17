/**
 * The judge branch of `finalizeClosedJobs`, and the workspace comparison its
 * fail-closed write check depends on. Split out of `lifecycle.mjs` for the
 * same reason `engine/settle.mjs` was: `lifecycle.mjs` and
 * `test/engine/judge.test.mjs` both sit on the 800-line ceiling
 * `test/repo/source-shape.test.mjs` enforces.
 *
 * `settleJudgeRound` runs only after `lifecycle.mjs` has already called
 * `judgeWorkspaceWriteViolation` and found nothing: the check has to run
 * before any branch here (a failed provider, a bounded re-dispatch, or a
 * verdict) can adopt or launder a judge's own write, so it cannot live inside
 * this function without reintroducing the escape it closes.
 *
 * `clearTierExhaustion` and `handleProviderExhaustion` are `lifecycle.mjs`'s
 * own -- importing them back from there would recreate the exact
 * `lifecycle.mjs` <-> `review.mjs` cycle `test/repo/source-shape.test.mjs`
 * once caught and `AGENTS.md` records as fixed, so the caller passes them in
 * instead.
 */
import { judgeReaskOutstanding } from "./judge-gate.mjs";
import { judgeVerdictEvidence } from "../contract/review-modes.mjs";
import {
  JUDGE_MAX_FAILURES,
  applyJudgeProtocolFailure,
  applyJudgeResult,
  applyJudgeRound,
  settleUnavailableJudge,
} from "./review.mjs";
import { networkTransition } from "./backoff.mjs";
import { startJudge } from "./dispatch.mjs";
import { writeNode } from "./state.mjs";
import { compareWorkspaceSnapshot } from "../repo/workspace.mjs";
import { errorCode, errorMessage, excerpt } from "../util.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./process.mjs").Job} Job */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {ProviderEnvelope & {costProvenance?: "priced"}} PricedEnvelope */

/**
 * Whether a closed judge job wrote into its own workspace, or a workspace
 * comparison error that means the same thing: either is a violation, never
 * silence. `compareWorkspaceSnapshot` throws `snapshot_ignore_changed` when
 * the judge edits an ignore source, `snapshot_symlink_escape` when it creates
 * a symlink out of the tree, and `snapshot_too_large` when it adds enough
 * entries -- all ordinary judge writes that must fail closed exactly like the
 * worker path (`engine/scope.mjs`'s `checkWorkerScope`), never vanish into a
 * "no writes" result. `job.scopeBaseline` is null only when the capture at
 * dispatch time itself failed -- `startJudge` degrades to unchecked rather
 * than refuse to run the judge at all -- and that is the one case with
 * nothing to compare, not a violation.
 *
 * @param {Job} job
 * @returns {{message: string}|null}
 */
export function judgeWorkspaceWriteViolation(job) {
  const baseline = job.scopeBaseline;
  if (!baseline) return null;
  try {
    const { unexpectedPaths } = compareWorkspaceSnapshot(/** @type {import("../repo/workspace.mjs").WorkspaceSnapshot} */ (baseline), job.cwd);
    if (!unexpectedPaths.length) return null;
    return { message: excerpt(`judge wrote into its own workspace (${unexpectedPaths.length}): ${unexpectedPaths.slice(0, 8).join(", ")}`) ?? "judge wrote into its own workspace" };
  } catch (error) {
    return { message: excerpt(`judge workspace comparison failed (${errorCode(error) ?? "scope_snapshot_invalid"}): ${errorMessage(error)}`) ?? "judge workspace comparison failed" };
  }
}

/**
 * Settle a closed judge invocation whose write check already passed: a
 * provider that failed outright gets one bounded re-dispatch, then review-mode
 * settlement; anything else that is not exactly one usable verdict (none at
 * all, several of them, an unparseable one, a stream cut off before its
 * terminal envelope, or a phase killed on its wall clock) takes the same
 * bounded re-ask; a clean verdict is applied.
 *
 * @param {ValidatedContract} contract
 * @param {Job} job
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {LockHandle} lock
 * @param {Map<string, NodeSnapshot>} states
 * @param {string} campaignPath
 * @param {PricedEnvelope} envelope
 * @param {{clearTierExhaustion: (state: NodeSnapshot) => void, handleProviderExhaustion: typeof import("./lifecycle.mjs").handleProviderExhaustion}} hooks
 *   `lifecycle.mjs`'s own tier-exhaustion clear and provider-exhaustion router, passed in rather than imported back.
 * @returns {Promise<void>}
 */
export async function settleJudgeRound(contract, job, state, runDir, running, lock, states, campaignPath, envelope, { clearTierExhaustion, handleProviderExhaustion }) {
  const node = job.node;
  // A judge provider that failed outright (its turn died, its tool host was
  // gone) is a provider failure, never a verdict: the gate cannot adopt a
  // result the judge could not ground in inspection. Re-dispatch the judge
  // once on the same routing, then settle by review mode so a judge failure
  // is surfaced, never silently settled. A stream that never reached its
  // terminal envelope is a protocol defect instead and takes the bounded
  // re-ask below.
  if (envelope.status === "failed" && envelope.error?.code !== "incomplete_stream") {
    // A judge that lost its socket is not an unavailable judge. It buys the
    // same bounded network waits a worker does, on the runtime it already
    // warmed, and spends none of the one re-dispatch counted below.
    const network = networkTransition(contract, node, state, "judge", envelope, job.exitCode);
    if (network && handleProviderExhaustion(contract, runDir, node, state, "judge", envelope, job.runtime.id, lock, states, campaignPath, network)) return;
    clearTierExhaustion(state);
    // The provider died on the bounded re-ask itself, so the one permitted
    // re-ask is spent: settle by review mode here rather than dispatch a
    // third judge invocation behind a fresh failure count.
    if (judgeReaskOutstanding(state)) {
      await applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, envelope.error?.message ?? "judge provider failed");
      return;
    }
    state.judgeFailures = (state.judgeFailures ?? 0) + 1;
    if (state.judgeFailures < JUDGE_MAX_FAILURES) {
      writeNode(runDir, state, lock);
      await applyJudgeRound(await startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath),
        contract, node, state, runDir, running, lock, states, campaignPath, state.result);
      return;
    }
    await settleUnavailableJudge(contract, node, state, runDir, lock, states, campaignPath, envelope.error?.message ?? "judge provider failed");
    return;
  }
  // Whatever else this invocation produced, it is not exactly one usable
  // verdict: no verdict at all, several of them in separate agent messages,
  // an unparseable one, a stream cut off before its terminal envelope, or a
  // phase killed on its wall clock. One bounded re-ask, then the review mode
  // decides — advisory completes, blocking enters attention with the work
  // preserved so a retry in place can re-judge it.
  const evidence = judgeVerdictEvidence(envelope);
  if (!evidence.ok) {
    const network = networkTransition(contract, node, state, "judge", envelope, job.exitCode);
    if (network && handleProviderExhaustion(contract, runDir, node, state, "judge", envelope, job.runtime.id, lock, states, campaignPath, network)) return;
    clearTierExhaustion(state);
    await applyJudgeProtocolFailure(contract, node, state, runDir, running, lock, states, campaignPath, evidence.reason);
    return;
  }
  clearTierExhaustion(state);
  await applyJudgeResult(contract, node, state, evidence.result, runDir, lock, running, states, campaignPath);
}
