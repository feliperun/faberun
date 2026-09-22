/**
 * What each role spent, and how much of that is a receipt rather than an
 * estimate.
 *
 * It sits apart from the renderers because both of them need it and neither
 * owns it: a per-node reading of the same ledger is how the closing artifacts
 * stopped crediting a node's whole cost to whichever runtime was dispatched
 * last (measured 2026-09-21 over seven nodes), and one home is what keeps the
 * two surfaces from answering the question differently again.
 */
import { compactCost, compactTokens, finite } from "../util.mjs";

/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {"priced"|"partial"|"unpriced"|"none"} CostProvenance */
/** @typedef {{costUsd: number|null, costProvenance: CostProvenance, inputTokens: number, outputTokens: number, cacheReadInputTokens: number, pricedInvocations: number, unpricedInvocations: number}} RoleUsage */
/** @typedef {{costUsd: number|null, status: "known"|"estimated"|"ambiguous"}} CostProjection */

/**
 * Per-role usage from the invocation ledger, with provenance for whether the
 * cost total is honest: `priced` (all invocations costed), `partial`/`unpriced`
 * (some/none costed, so `costUsd` stays null rather than understating), or
 * `none` (no invocation). Token totals are always carried.
 *
 * @param {NodeSnapshot[]} nodes
 * @returns {{worker: RoleUsage, judge: RoleUsage}}
 */
export function roleUsage(nodes) {
  /** @type {Record<"worker"|"judge", {total: number, priced: number, unpriced: number, inputTokens: number, outputTokens: number, cacheReadInputTokens: number}>} */
  const roles = {
    worker: { total: 0, priced: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    judge: { total: 0, priced: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
  for (const node of nodes) {
    for (const invocation of node.invocations ?? []) {
      if (invocation.role !== "worker" && invocation.role !== "judge") continue;
      const bucket = roles[invocation.role];
      const cost = finite(invocation.costUsd);
      if (cost === null) bucket.unpriced += 1;
      else {
        bucket.priced += 1;
        bucket.total += cost;
      }
      bucket.inputTokens += finite(invocation.usage?.inputTokens) ?? 0;
      bucket.outputTokens += finite(invocation.usage?.outputTokens) ?? 0;
      bucket.cacheReadInputTokens += finite(invocation.usage?.cacheReadInputTokens) ?? 0;
    }
  }
  return { worker: summarizeRole(roles.worker), judge: summarizeRole(roles.judge) };
}

/**
 * @param {{total: number, priced: number, unpriced: number, inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} bucket
 * @returns {RoleUsage}
 */
function summarizeRole(bucket) {
  const costProvenance = bucket.priced > 0
    ? (bucket.unpriced > 0 ? "partial" : "priced")
    : (bucket.unpriced > 0 ? "unpriced" : "none");
  return {
    costUsd: costProvenance === "priced" ? bucket.total : null,
    costProvenance,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadInputTokens: bucket.cacheReadInputTokens,
    pricedInvocations: bucket.priced,
    unpricedInvocations: bucket.unpriced,
  };
}

/**
 * Per-role cost, summed from the invocation ledger alone. Kept for the closing
 * artifacts, which render only the dollar cell; `roleUsage` carries the
 * provenance that cell cannot express.
 *
 * @param {NodeSnapshot[]} nodes
 * @returns {{worker: number|null, judge: number|null}}
 */
export function roleCosts(nodes) {
  const roles = roleUsage(nodes);
  return { worker: roles.worker.costUsd, judge: roles.judge.costUsd };
}

/**
 * A role's cell in a totals line: the dollar total when every invocation is
 * priced, `unpriced` with the token totals it did record when any invocation
 * has no cost, and `-` only when the role has no invocation at all. An
 * unpriced role reads as real work instead of vanishing into a dash.
 *
 * @param {RoleUsage} role
 * @returns {string}
 */
export function formatRole(role) {
  if (role.costUsd !== null) return compactCost(role.costUsd);
  if (role.costProvenance === "none") return "-";
  return `unpriced (in ${compactTokens(role.inputTokens)} · out ${compactTokens(role.outputTokens)} · cache ${compactTokens(role.cacheReadInputTokens)})`;
}

/**
 * Project cost only from durable snapshot evidence. Invocation costs are
 * provider-reported; a standalone node total has no provider attribution and
 * remains an estimate. Missing or mismatched evidence is ambiguous.
 *
 * @param {NodeSnapshot} node
 * @returns {CostProjection}
 */
export function costProjection(node) {
  const nodeCost = finite(node.costUsd);
  const invocations = Array.isArray(node.invocations) ? node.invocations : [];
  const invocationCosts = invocations.map((invocation) => finite(invocation.costUsd));

  if (invocations.length > 0) {
    if (!invocationCosts.every((cost) => cost !== null)) return { costUsd: null, status: "ambiguous" };
    const reportedCost = invocationCosts.reduce((total, cost) => total + /** @type {number} */ (cost), 0);
    if (nodeCost !== null && !sameCost(nodeCost, reportedCost)) return { costUsd: null, status: "ambiguous" };
    return { costUsd: nodeCost ?? reportedCost, status: "known" };
  }

  if (nodeCost !== null) return { costUsd: nodeCost, status: "estimated" };
  return { costUsd: null, status: "ambiguous" };
}

/** @param {CostProjection[]} costs @returns {CostProjection} */
export function aggregateCostProjection(costs) {
  if (costs.length === 0 || costs.some((cost) => cost.status === "ambiguous")) {
    return { costUsd: null, status: "ambiguous" };
  }
  const costUsd = costs.every((cost) => typeof cost.costUsd === "number")
    ? costs.reduce((total, cost) => total + /** @type {number} */ (cost.costUsd), 0)
    : null;
  return {
    costUsd,
    status: costs.some((cost) => cost.status === "estimated") ? "estimated" : "known",
  };
}

/** @param {number} left @param {number} right @returns {boolean} */
function sameCost(left, right) {
  return Math.abs(left - right) <= 1e-9;
}


/** @param {CostProjection} projection @returns {string} */
export function formatCost(projection) {
  return `${compactCost(projection.costUsd)} (${projection.status})`;
}
