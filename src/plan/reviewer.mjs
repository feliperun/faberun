/**
 * R19: the planner's own ordered reviewer list, kept separate from R18's
 * judge list (`src/engine/judge-list.mjs`) even when an operator names the
 * same runtime in both. The frozen contract's judge is chosen at run time,
 * per node, from the judge list; the plan's own `review`/`spec-review` stage
 * is chosen once per stage, from this list, by `firstEligibleReviewer` alone
 * -- no cross-vendor rule runs here, because a plan reviewer grades a
 * planning artefact rather than a worker's node (D11), so vendor
 * independence from a worker is not the property this list protects.
 *
 * Lives beside the pipeline rather than inside `judge-list.mjs` so the two
 * lists cannot accidentally converge on one resolver: `judge-list.mjs` reads
 * `contract.judges`/`config.judges`, this module reads `reviewers` from the
 * CLI and `config.reviewers`, and neither import the other.
 */
import { validateRuntime } from "../contract/runtime.mjs";
import { getHarness } from "../harnesses/index.mjs";
import { availabilityKey, readRefusal } from "../run/availability.mjs";
import { modelOf } from "./pipeline-shape.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {{runtimeId: string, model: string}} ReviewerProvenance */

/**
 * The reviewer list a plan pipeline reads: `--reviewers` wins over the
 * machine default, exactly as `resolveJudgeList` (R18) prefers a contract's
 * own list over the machine's.
 *
 * @param {{reviewers?: string[]}} options
 * @param {{reviewers?: string[]}|null|undefined} config
 * @returns {string[]|undefined}
 */
export function resolveReviewerList(options, config) {
  return options.reviewers ?? config?.reviewers ?? undefined;
}

/**
 * The first eligible entry of an ordered reviewer list: declared in the
 * runtimes catalogue and carrying no recorded refusal. Unlike `selectListJudge`
 * (R18), this never excludes a candidate for sharing the worker's provider --
 * a plan reviewer is not judging the worker that authored the plan, so that
 * independence rule does not apply here (D11).
 *
 * @param {string[]} list
 * @param {Record<string, JsonObject>} runtimes
 * @param {number} [now]
 * @returns {string|null}
 */
export function firstEligibleReviewer(list, runtimes, now = Date.now()) {
  for (const id of list) {
    const raw = runtimes[id];
    if (raw === undefined) continue;
    /** @type {import("../contract/index.mjs").ValidatedRuntime} */
    let runtime;
    try {
      runtime = validateRuntime(id, raw);
    } catch {
      continue;
    }
    const key = availabilityKey({ harness: runtime.harness, model: runtime.model, executable: getHarness(runtime.harness).executable(runtime) });
    if (readRefusal(key, now)) continue;
    return id;
  }
  return null;
}

/**
 * The reviewer fact a frozen plan's provenance records: the first eligible
 * entry of the list at the moment of freezing, and its model. An empty or
 * exhausted list records an empty runtime id, exactly as an unset
 * `runtimeDefaults.judge` did before R19 -- freezing never refuses on this
 * alone, since a plan with no reviewer configured is legitimate.
 *
 * @param {string[]|undefined} reviewers
 * @param {Record<string, JsonObject>} runtimes
 * @param {number} [now]
 * @returns {ReviewerProvenance}
 */
export function reviewerProvenanceOf(reviewers, runtimes, now = Date.now()) {
  const id = firstEligibleReviewer(reviewers ?? [], runtimes, now);
  return { runtimeId: id ?? "", model: modelOf(runtimes, id ?? undefined) };
}
