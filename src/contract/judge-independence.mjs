/**
 * Validation for the `judgeIndependence` contract field (R20): the opt-in
 * that lets a same-vendor judge review a node an operator with a single
 * provider could otherwise never gate. Split from `contract/index.mjs`,
 * mirroring `judges.mjs` (R18), because the tier comparison and its refusal
 * belong with the field that turns them on, not scattered through the
 * vendor-conflict check that calls them.
 */
import { declaredModelTier } from "../harnesses/model-tiers.mjs";

/** The only value `judgeIndependence` accepts, on the contract or the machine config. */
export const SAME_VENDOR_REVIEW_MODE = "same-vendor";

/** The label every human-facing surface uses to mark a node reviewed under the mode. */
export const SAME_PROVIDER_REVIEW_LABEL = "same-provider review";

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {"same-vendor"|undefined}
 */
export function validateJudgeIndependence(value, label) {
  if (value === undefined) return undefined;
  if (value !== SAME_VENDOR_REVIEW_MODE) throw new TypeError(`${label} must be "${SAME_VENDOR_REVIEW_MODE}"`);
  return value;
}

/**
 * Same-vendor mode's own admissibility rule for a worker/judge pair that
 * share a vendor: a judge model absent from the declared tier table can never
 * judge in this mode, and a judge tier below the worker's is refused, naming
 * both. `null` means the pair is admissible.
 *
 * @param {{harness: string, model: string}} workerRuntime
 * @param {{harness: string, model: string}} judgeRuntime
 * @returns {{code: string, message: string}|null}
 */
export function sameVendorTierRefusal(workerRuntime, judgeRuntime) {
  const judgeTier = declaredModelTier(judgeRuntime.harness, judgeRuntime.model);
  if (judgeTier === null) {
    return {
      code: "same_vendor_judge_no_tier",
      message: `judge model ${judgeRuntime.model} declares no tier and cannot judge in same-vendor mode`,
    };
  }
  const workerTier = declaredModelTier(workerRuntime.harness, workerRuntime.model);
  if (workerTier !== null && judgeTier < workerTier) {
    return {
      code: "same_vendor_judge_tier_too_low",
      message: `judge tier ${judgeTier} (${judgeRuntime.model}) is below worker tier ${workerTier} (${workerRuntime.model})`,
    };
  }
  return null;
}

/**
 * Whether a worker runtime that actually ran and a judge runtime that
 * actually ran are a same-provider pairing: the mode is opted in and the two
 * share a vendor. Contract validation already refused every reachable
 * worker/judge pairing (primary or fallback) that fails the tier rule, so
 * this is a plain vendor comparison at dispatch time, not a second
 * enforcement of it.
 *
 * @param {{judgeIndependence?: string}} contract
 * @param {{vendor?: string}|null|undefined} workerRuntime
 * @param {{vendor?: string}|null|undefined} judgeRuntime
 * @returns {boolean}
 */
export function isSameProviderReviewPair(contract, workerRuntime, judgeRuntime) {
  if (contract.judgeIndependence !== SAME_VENDOR_REVIEW_MODE) return false;
  const workerVendor = workerRuntime?.vendor;
  const judgeVendor = judgeRuntime?.vendor;
  return Boolean(workerVendor) && workerVendor === judgeVendor;
}

/**
 * Whether `workerRuntimeId` or its one declared fallback hop could share
 * `judgeVendor`: the structural "this pairing might land same-provider"
 * fact a plan-time surface (the Campaign Brief) can read before any node has
 * run, mirroring the one-hop rule `engine/failover.mjs` enforces at dispatch.
 * A run-time surface reading a completed node's snapshot should prefer the
 * dynamic fact instead (`isSameProviderReviewPair` against the runtime that
 * actually ran).
 *
 * @param {Record<string, {vendor?: string, fallback?: string}>} runtimes
 * @param {string} workerRuntimeId
 * @param {string|null|undefined} judgeVendor
 * @returns {boolean}
 */
export function sharesVendorThroughFallback(runtimes, workerRuntimeId, judgeVendor) {
  if (!judgeVendor) return false;
  const seen = new Set([workerRuntimeId]);
  let currentId = workerRuntimeId;
  while (currentId !== undefined) {
    if (runtimes[currentId]?.vendor === judgeVendor) return true;
    const nextId = runtimes[currentId]?.fallback;
    if (nextId === undefined || seen.has(nextId)) break;
    seen.add(nextId);
    currentId = nextId;
  }
  return false;
}

/**
 * A gated node whose worker and judge share a vendor cannot produce an
 * independent review -- the same vendor grading its own output is not a
 * gate, so this is rejected outright unless `judgeIndependence` opts the
 * contract into same-vendor mode, in which case a judge tier at or above the
 * worker's admits the pair and marks the node `sameProviderReview` for every
 * human-facing surface to read back. The worker's declared fallback chain is
 * checked the same way, since it is statically known which runtime a worker
 * failover lands on; the symmetric case -- the judge's own fallback landing
 * on the worker's vendor -- depends on which worker runtime actually ran and
 * is refused at execution instead (node.mjs, `judge_fallback_vendor_conflict`).
 *
 * Mutates and returns `nodes` in place; called once per `validateContract`.
 *
 * @param {{gate: {enabled: boolean, runtime?: string}, runtime?: string, sameProviderReview: boolean}[]} nodes
 * @param {Record<string, {vendor?: string, fallback?: string, harness: string, model: string}>} runtimes
 * @param {{worker?: string, judge?: string}} defaults
 * @param {"same-vendor"|undefined} judgeIndependence
 * @returns {{gate: {enabled: boolean, runtime?: string}, runtime?: string, sameProviderReview: boolean}[]}
 */
export function markSameProviderReviewNodes(nodes, runtimes, defaults, judgeIndependence) {
  for (const [index, node] of nodes.entries()) {
    if (!node.gate.enabled) continue;
    const workerRuntimeId = node.runtime ?? defaults.worker;
    const judgeRuntimeId = node.gate.runtime ?? defaults.judge;
    if (!workerRuntimeId || !judgeRuntimeId) continue;
    const workerRuntime = runtimes[workerRuntimeId];
    const judgeRuntime = runtimes[judgeRuntimeId];
    const workerVendor = workerRuntime.vendor;
    const judgeVendor = judgeRuntime.vendor;
    if (workerVendor === judgeVendor) {
      if (judgeIndependence !== SAME_VENDOR_REVIEW_MODE) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} and judge runtime ${judgeRuntimeId} share vendor ${workerVendor}`);
      }
      const refusal = sameVendorTierRefusal(workerRuntime, judgeRuntime);
      if (refusal) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} and judge runtime ${judgeRuntimeId} share vendor ${workerVendor}: ${refusal.message}`);
      }
      nodes[index] = { ...node, sameProviderReview: true };
    }
    const seenFallbacks = new Set([workerRuntimeId]);
    let fallbackId = runtimes[workerRuntimeId].fallback;
    while (fallbackId !== undefined) {
      if (seenFallbacks.has(fallbackId)) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback chain cycles back to ${fallbackId}`);
      }
      seenFallbacks.add(fallbackId);
      const fallbackVendor = runtimes[fallbackId].vendor;
      if (fallbackVendor === judgeVendor) {
        if (judgeIndependence !== SAME_VENDOR_REVIEW_MODE) {
          throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback runtime ${fallbackId} and judge runtime ${judgeRuntimeId} share vendor ${fallbackVendor}`);
        }
        const fallbackRefusal = sameVendorTierRefusal(runtimes[fallbackId], judgeRuntime);
        if (fallbackRefusal) {
          throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback runtime ${fallbackId} and judge runtime ${judgeRuntimeId} share vendor ${fallbackVendor}: ${fallbackRefusal.message}`);
        }
        // The fallback is only reachable if it actually runs, but the tier
        // rule above already admitted it -- so the node is marked here too,
        // not only when the primary matches (the plan-time "could this land
        // same-provider" fact every human-facing surface reads back).
        nodes[index] = { ...nodes[index], sameProviderReview: true };
      }
      fallbackId = runtimes[fallbackId].fallback;
    }
  }
  return nodes;
}
