/**
 * R18: the judge of a gated node is the first eligible entry of a static,
 * ordered list rather than the single strongest cross-vendor candidate
 * `composeAssignments` otherwise ranks. Split out of `runtime-discovery.mjs`
 * and `lifecycle.mjs` -- both already near this repository's 800-line
 * ceiling -- and kept out of `backoff.mjs`, whose `planRoute` is a pure
 * decision this module cannot be: picking an entry reads the durable refusal
 * and usage-window stores.
 */
import { effectiveProvider } from "../contract/provider.mjs";
import { availabilityKey, readRefusal } from "../run/availability.mjs";
import { readUsageWindows, usageAccountOf } from "../run/usage-windows.mjs";
import { getHarness } from "../harnesses/index.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {{id: string, reason: string}} JudgeSkip */
/** @typedef {{chosen: string|null, skipped: JudgeSkip[]}} JudgeListPick */
/** @typedef {{list: string[], chosen: string|null, skipped: JudgeSkip[]}} JudgeListState */

/**
 * A usage window at or above this spend is treated as unavailable for a judge
 * pick, so a node's review does not race the account into a refusal the next
 * call would hit anyway.
 */
export const JUDGE_USAGE_WINDOW_LIMIT_PERCENT = 90;

/**
 * The static judge list a node's assignment reads: the contract's own list
 * wins over the machine default, exactly as `runtimeDefaults.worker` already
 * wins over `config.worker` in `composeAssignments`.
 *
 * @param {{judges?: string[]}} contract
 * @param {{judges?: string[]}|null|undefined} config
 * @returns {string[]|undefined}
 */
export function resolveJudgeList(contract, config) {
  return contract.judges ?? config?.judges ?? undefined;
}

/**
 * Every provider a worker attempt on this node could actually run on: its own
 * canonical provider, plus every hop of its declared fallback chain. A judge
 * of any of these providers cannot independently review whichever one
 * actually ran. Walked directly off `runtime.fallback` rather than through
 * `failover.mjs`'s `synthesizedChain`, so this module does not import a
 * runtime-discovery consumer and risk a cycle back through
 * `run/availability.mjs`.
 *
 * @param {ValidatedContract} contract
 * @param {string} workerId
 * @returns {Set<string|undefined>}
 */
function reachableWorkerProviders(contract, workerId) {
  const providers = new Set([effectiveProvider(contract.runtimes[workerId])]);
  const seen = new Set([workerId]);
  let current = workerId;
  for (;;) {
    const next = contract.runtimes[current]?.fallback;
    if (!next || seen.has(next) || !contract.runtimes[next]) break;
    seen.add(next);
    providers.add(effectiveProvider(contract.runtimes[next]));
    current = next;
  }
  return providers;
}

/**
 * Is this runtime's account inside `JUDGE_USAGE_WINDOW_LIMIT_PERCENT` of a
 * usage window closing? `null` means no window is known -- unknown must not
 * read as over budget, exactly as an absent availability record must not read
 * as exhausted (see `admitsAffinity` in `failover.mjs`).
 *
 * @param {import("../contract/index.mjs").ValidatedRuntime} runtime
 * @param {number} now
 * @returns {import("../harnesses/codex/usage-window.mjs").UsageWindow|null}
 */
function overspentWindow(runtime, now) {
  const account = usageAccountOf(runtime);
  if (!account) return null;
  return readUsageWindows(account, now).find((window) => window.usedPercent > JUDGE_USAGE_WINDOW_LIMIT_PERCENT) ?? null;
}

/**
 * The first eligible entry of an ordered judge list, and why every earlier
 * entry was skipped: already attempted this run, a provider the worker (or
 * its fallback chain) already runs, a recorded refusal, or an account usage
 * window over `JUDGE_USAGE_WINDOW_LIMIT_PERCENT`.
 *
 * @param {ValidatedContract} contract
 * @param {string[]} list
 * @param {string} workerId
 * @param {{attempted?: Iterable<string>, now?: number}} [options]
 * @returns {JudgeListPick}
 */
export function selectListJudge(contract, list, workerId, options = {}) {
  const attempted = new Set(options.attempted ?? []);
  const now = options.now ?? Date.now();
  const workerProviders = reachableWorkerProviders(contract, workerId);
  /** @type {JudgeSkip[]} */
  const skipped = [];
  for (const id of list) {
    if (attempted.has(id)) {
      skipped.push({ id, reason: "already attempted this run" });
      continue;
    }
    const runtime = contract.runtimes[id];
    if (!runtime) {
      skipped.push({ id, reason: "not declared in contract.runtimes" });
      continue;
    }
    const provider = effectiveProvider(runtime);
    if (workerProviders.has(provider)) {
      skipped.push({ id, reason: `same provider as the worker: ${provider}` });
      continue;
    }
    const key = availabilityKey({ harness: runtime.harness, model: runtime.model, executable: getHarness(runtime.harness).executable(runtime) });
    const refusal = readRefusal(key, now);
    if (refusal) {
      skipped.push({ id, reason: `recorded refusal: ${refusal.reason}` });
      continue;
    }
    const window = overspentWindow(runtime, now);
    if (window) {
      skipped.push({ id, reason: `usage window ${window.window} at ${window.usedPercent}%, above ${JUDGE_USAGE_WINDOW_LIMIT_PERCENT}%` });
      continue;
    }
    return { chosen: id, skipped };
  }
  return { chosen: null, skipped };
}

/**
 * The judge-list evidence a node's initial assignment records: the list it
 * read, the entry it chose (or null when every entry was skipped), and why
 * each earlier one was.
 *
 * @param {ValidatedContract} contract
 * @param {string[]} list
 * @param {string} workerId
 * @param {number} [now]
 * @returns {JudgeListState}
 */
export function initialJudgeListState(contract, list, workerId, now = Date.now()) {
  const pick = selectListJudge(contract, list, workerId, { now });
  return { list, chosen: pick.chosen, skipped: pick.skipped };
}

/**
 * The next hop out of a list-driven judge that was just refused: the current
 * choice joins the excluded set (it is the one that just failed), so the same
 * eligibility pass never returns to it -- the hop-by-hop rule. Only an entry
 * that actually ran and then failed belongs in that excluded set; a candidate
 * that was skipped for cause (same provider, a recorded refusal, an overspent
 * window) is re-checked fresh instead, so it keeps its real reason rather than
 * being relabelled "already attempted" on every later hop. A prior hop's own
 * "already attempted this run" entries name exactly the ids that were chosen
 * and failed before this one, so folding those back in carries that set
 * forward without a dedicated field.
 *
 * @param {ValidatedContract} contract
 * @param {JudgeListState} judgeListState
 * @param {string} workerId
 * @param {number} [now]
 * @returns {JudgeListState}
 */
export function nextListJudge(contract, judgeListState, workerId, now = Date.now()) {
  const previouslyChosen = judgeListState.skipped
    .filter((entry) => entry.reason === "already attempted this run")
    .map((entry) => entry.id);
  const attempted = new Set([...previouslyChosen, ...(judgeListState.chosen ? [judgeListState.chosen] : [])]);
  const pick = selectListJudge(contract, judgeListState.list, workerId, { attempted, now });
  return { list: judgeListState.list, chosen: pick.chosen, skipped: [...judgeListState.skipped, ...pick.skipped] };
}

/**
 * Does a judge's next fallback runtime share the vendor of the worker it
 * would be reviewing? Reachability depends on which worker runtime actually
 * ran, which a static contract cannot know, so this is checked at the moment
 * a fallback is about to be taken rather than at contract validation.
 * A list-driven pick already excludes the worker's reachable providers
 * (`selectListJudge`), so this only ever fires for the single declared
 * `runtime.fallback` edge.
 *
 * @param {ValidatedContract} contract
 * @param {string|null|undefined} workerRuntimeId
 * @param {string} nextRuntimeId
 * @returns {{code: string, message: string}|null}
 */
export function judgeFallbackVendorConflict(contract, workerRuntimeId, nextRuntimeId) {
  const workerVendor = workerRuntimeId ? contract.runtimes[workerRuntimeId]?.vendor : undefined;
  const judgeFallbackVendor = contract.runtimes[nextRuntimeId]?.vendor;
  if (!workerVendor || !judgeFallbackVendor || workerVendor !== judgeFallbackVendor) return null;
  return {
    code: "judge_fallback_vendor_conflict",
    message: `judge fallback runtime ${nextRuntimeId} shares vendor ${judgeFallbackVendor} with worker runtime ${workerRuntimeId}`,
  };
}
