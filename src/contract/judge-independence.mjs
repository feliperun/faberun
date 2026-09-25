/**
 * Validation for the `judgeIndependence` contract field (R20): the opt-in
 * that lets a same-vendor judge review a node an operator with a single
 * provider could otherwise never gate. Split from `contract/index.mjs`,
 * mirroring `judges.mjs` (R18), because the tier comparison and its refusal
 * belong with the field that turns them on, not scattered through the
 * vendor-conflict check that calls them.
 */
import { declaredModelTier } from "../harnesses/catalogue.mjs";

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
