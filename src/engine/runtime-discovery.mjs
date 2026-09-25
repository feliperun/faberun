import { normalizeProviderAvailability, probeRuntime } from "../harnesses/index.mjs";
import { effectiveProvider } from "../contract/provider.mjs";

// Availability normalization belongs to the adapter registry, which is where
// each provider's own exhaustion, balance, and authentication wording is
// already classified. Re-exported here so discovery callers keep one import
// site; a second copy of these two functions is how they drift apart.
export { exhaustedUntilOf, normalizeProviderAvailability } from "../harnesses/index.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {{harness?: string, model?: string, vendor: string, tier?: number|string, costRank?: number, [key: string]: unknown}} RuntimeLike */
/** @typedef {{runtimes: Record<string, RuntimeLike>, runtimeDefaults?: {worker?: string, judge?: string}, nodes?: {id: string, runtime?: string, gate: {enabled: boolean, runtime?: string}}[]}} RuntimeContract */
/**
 * One runtime's catalogue record: what the harness de facto reported, and
 * when. An unobservable datum is null -- never zero and never full allowance,
 * so a runtime that reports nothing cannot look rested -- and an absent key on
 * a record that predates the field reads as null at every reader. An
 * observation older than its own window reads as unknown (`isRuntimeAvailable`).
 * @typedef {{available: boolean, exhaustedUntil: string|null, reason: string, observedAt?: string|null, window?: string|null, remaining?: number|null}} RuntimeAvailability
 */
/** @typedef {{harness: string, model: string, vendor: string, tier: number, costRank: number, config?: Record<string, unknown>}} DiscoveryRuntime */
/** @typedef {{id: string, runtime: RuntimeLike, order: number}} RuntimeCandidate */
/** @typedef {import("../host/config.mjs").UserConfig} UserConfig */
/** @typedef {{id: string, gate: {enabled: boolean, runtime?: string}}} ComposeOptionsNode */
/** @typedef {{config?: UserConfig|null, onWarning?: (message: string) => void, listJudge?: (node: ComposeOptionsNode, workerId: string, workerProvider: string|undefined) => string|undefined}} ComposeOptions */

/**
 * Candidates used when a contract omits its runtime catalogue. The catalogue
 * only names harnesses; availability still comes from the installed binary.
 *
 * Every id is `<harness>-<model>`, saying out loud what the fields already
 * say: `harness` is the harness that runs the turn, `model` is what that
 * harness asks, and the two vary independently — DeepSeek answers through the
 * `dsh` harness, GLM through `zcode`. An id naming only one half (the bare
 * `glm` this catalogue used to carry, which was at once a model family, a
 * vendor, and an adapter name) hides which harness a recorded run used. The
 * separator is a dash because `contract.mjs` admits no `:` in an id.
 *
 * Declaration order is the tie-break `composeAssignments` applies inside a
 * tier, so the cheap harnesses lead: the first available tier-1 entry works
 * and the strongest available entry of another vendor judges.
 *
 * @type {Readonly<Record<string, DiscoveryRuntime>>}
 */
export const DISCOVERY_RUNTIME_DEFINITIONS = Object.freeze({
  // `dsh` defaults no vendor and no provider route, so both are declared here
  // or nothing can build a command from this entry.
  "dsh-deepseek": {
    harness: "dsh",
    model: "deepseek-flash",
    vendor: "deepseek",
    config: { provider: "deepseek-official", "api_key.env_key": "DEEPSEEK_API_KEY" },
    tier: 1,
    costRank: 1,
  },
  // The flash tier, not the unsuffixed pro: measured 2026-09-24 in the judge
  // canary, glm-5.3 recalled 0.79 against glm-5.3-flash's 0.85 at about nine
  // times the price, which the owner confirmed matches the public benchmarks.
  "zcode-glm": {
    harness: "zcode",
    model: "glm-5.3-flash",
    vendor: "zhipu",
    config: { "auth_token.env_key": "ZAI_API_KEY" },
    tier: 1,
    costRank: 1,
  },
  "agy-gemini": { harness: "agy", model: "gemini-3.8-flash-low", vendor: "google", tier: 1, costRank: 1 },
  // Three codex rows, because the harness declares three models and an
  // account is entitled to only some of them: measured 2026-09-21 on the
  // owner's ChatGPT account, plain `gpt-5.6` answers HTTP 400 while
  // `gpt-5.6-sol` answers normally. One row meant `setup` could offer only the
  // model that account cannot use, and the operator's only way out was to hand
  // every contract its own catalogue through `--runtimes`. Declaration order is
  // unchanged, so the composed default is still `codex-gpt`: which of the three
  // an account can reach is not something this file can know, and the live
  // preflight is what reports it per id.
  "codex-gpt": { harness: "codex", model: "gpt-5.6", vendor: "openai", tier: 2, costRank: 2 },
  "codex-sol": { harness: "codex", model: "gpt-5.6-sol", vendor: "openai", tier: 2, costRank: 2 },
  "codex-luna": { harness: "codex", model: "gpt-5.6-luna", vendor: "openai", tier: 2, costRank: 2 },
  "claude-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", tier: 2, costRank: 2 },
});

/**
 * Discover runtime binaries without sending a model prompt. Tests can pass
 * recorded responses so no network call is needed.
 *
 * @param {Record<string, import("../harnesses/index.mjs").HarnessRuntime>} runtimes
 * @param {{cwd?: string, responses?: Record<string, unknown>, exitCodes?: Record<string, number|null>, signals?: Record<string, string|null>}} [options]
 * @returns {Promise<Record<string, RuntimeAvailability>>}
 */
export async function discoverRuntimes(runtimes, options = {}) {
  const entries = await Promise.all(Object.entries(runtimes).map(async ([id, runtime]) => {
    const response = options.responses?.[id];
    if (response !== undefined) {
      return [id, normalizeProviderAvailability(runtime, response, options.exitCodes?.[id] ?? 0, options.signals?.[id] ?? null)];
    }
    const probe = await probeRuntime(runtime, { cwd: options.cwd });
    return [id, probe.availability ?? (probe.ok
      ? { available: true, exhaustedUntil: null, reason: "ready" }
      : { available: false, exhaustedUntil: null, reason: probe.detail ?? "provider_unavailable" })];
  }));
  return Object.fromEntries(entries);
}

/**
 * The available candidates in declaration order — the unit both
 * `composeAssignments` and `setup`'s defaults select from.
 *
 * @param {Record<string, RuntimeLike>} runtimes
 * @param {Record<string, RuntimeAvailability>} [availability]
 * @returns {RuntimeCandidate[]}
 */
export function availableCandidates(runtimes, availability = {}) {
  return Object.entries(runtimes)
    .filter(([id]) => isRuntimeAvailable(availability[id]))
    .map(([id, runtime], order) => ({ id, runtime, order }));
}

/**
 * Compose only omitted assignments. Explicit node and default declarations are
 * copied exactly; callers persist the returned pair in run state.
 *
 * An optional `options.config` narrows the candidate set to the harnesses the
 * operator enabled and prefers its named worker and judge. An empty narrowed
 * set falls back to the unrestricted candidates and is reported through
 * `options.onWarning`; config never overrides an explicit node, gate or
 * runtime-default declaration, and the cross-vendor judge rule still applies.
 *
 * `options.listJudge` (R18) is asked for an omitted judge before the single
 * `config.judge` preference and the strongest-candidate default: it is the
 * caller's own ordered-list selection (`engine/judge-list.mjs`), kept out of
 * this module so a list pick's refusal- and usage-window reads never import a
 * `run/` consumer of this very function back into a cycle. Returning
 * `undefined` -- an omitted list, or one every entry of which was skipped --
 * falls through to the candidates below exactly as if it had not been asked.
 *
 * @param {RuntimeContract} contract
 * @param {Record<string, RuntimeAvailability>} availability
 * @param {ComposeOptions} [options]
 * @returns {Record<string, {worker: string, judge: string}>}
 */
export function composeAssignments(contract, availability = {}, options = {}) {
  const allCandidates = availableCandidates(contract.runtimes, availability);
  const config = options.config ?? null;
  let candidates = allCandidates;
  if (config && Array.isArray(config.harnesses)) {
    const enabled = new Set(config.harnesses);
    const restricted = allCandidates.filter(({ runtime }) => typeof runtime.harness === "string" && enabled.has(runtime.harness));
    if (restricted.length) candidates = restricted;
    else if (allCandidates.length) options.onWarning?.(`config harnesses · none of ${config.harnesses.join(", ")} is available · using all available runtimes`);
  }
  /** @type {Record<string, {worker: string, judge: string}>} */
  const assignments = {};
  for (const node of contract.nodes ?? []) {
    const workerOmitted = node.runtime === undefined && contract.runtimeDefaults?.worker === undefined;
    const preferredWorker = workerOmitted ? candidateById(candidates, config?.worker) : undefined;
    const worker = node.runtime ?? contract.runtimeDefaults?.worker ?? preferredWorker?.id ?? cheapest(candidates)?.id;
    if (!worker || !contract.runtimes[worker]) throw new Error(`runtime_assignment_worker_unavailable: no available worker runtime for node ${node.id}`);
    const workerRuntime = contract.runtimes[worker];
    const judgeOmitted = node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined;
    const preferredJudge = judgeOmitted ? candidateById(candidates, config?.judge) : undefined;
    const workerProvider = effectiveProvider(workerRuntime);
    const judge = node.gate.runtime ?? contract.runtimeDefaults?.judge
      ?? (judgeOmitted ? options.listJudge?.(node, worker, workerProvider) : undefined)
      ?? (preferredJudge && effectiveProvider(preferredJudge.runtime) !== workerProvider ? preferredJudge.id : undefined)
      ?? strongest(candidates, workerProvider)?.id;
    if (node.gate.enabled && (!judge || !contract.runtimes[judge])) {
      throw new Error(`runtime_assignment_judge_unavailable: no available cross-vendor judge for node ${node.id} and worker ${worker}`);
    }
    const judgeRuntime = judge ? contract.runtimes[judge] : undefined;
    if (node.gate.enabled && workerRuntime && judgeRuntime && effectiveProvider(judgeRuntime) === workerProvider) {
      throw new Error(`runtime_assignment_judge_unavailable: no available cross-vendor judge for node ${node.id} and worker ${worker}`);
    }
    assignments[node.id] = { worker, judge: judge ?? worker };
  }
  return assignments;
}

/**
 * @param {RuntimeCandidate[]} candidates
 * @param {string|undefined} id
 * @returns {RuntimeCandidate|undefined}
 */
function candidateById(candidates, id) {
  return id === undefined ? undefined : candidates.find((candidate) => candidate.id === id);
}

/**
 * Select an unattempted, available runtime in the current tier. Judge
 * candidates remain admissible only when their vendor differs from the worker
 * runtime that actually ran the node.
 *
 * @param {RuntimeContract} contract
 * @param {{assignments?: {worker?: string, judge?: string}, availability?: Record<string, RuntimeAvailability>}} stateRouting
 * @param {"worker"|"judge"} role
 * @param {string} current
 * @param {Iterable<string>} attempted
 * @returns {string|null}
 */
export function nextSameTierRuntime(contract, stateRouting, role, current, attempted) {
  const currentRuntime = contract.runtimes[current];
  if (!currentRuntime) return null;
  const workerId = stateRouting.assignments?.worker;
  const workerProvider = workerId && contract.runtimes[workerId] ? effectiveProvider(contract.runtimes[workerId]) : null;
  const used = new Set(attempted);
  return Object.entries(contract.runtimes)
    .filter(([id, runtime]) => id !== current && !used.has(id) && sameTier(runtime, currentRuntime))
    .filter(([id]) => isRuntimeAvailable(stateRouting.availability?.[id]))
    .filter(([, runtime]) => role !== "judge" || effectiveProvider(runtime) !== workerProvider)
    .sort((left, right) => runtimeOrder(left[1]) - runtimeOrder(right[1]))
    .map(([id]) => id)
    .at(0) ?? null;
}

/** @param {RuntimeLike} left @param {RuntimeLike} right @returns {boolean} */
function sameTier(left, right) {
  return left.tier !== undefined || right.tier !== undefined
    ? left.tier === right.tier
    : (left.costRank ?? Number.MAX_SAFE_INTEGER) === (right.costRank ?? Number.MAX_SAFE_INTEGER);
}

/** @param {RuntimeLike} runtime @returns {number} */
function runtimeOrder(runtime) {
  return runtime.costRank ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The cheapest available candidate: lowest tier, then lowest cost rank, then
 * declaration order. Exported so `setup` suggests the same default rather than
 * keeping a second ranking in step with this one.
 *
 * @param {RuntimeCandidate[]} candidates
 * @returns {RuntimeCandidate|null}
 */
export function cheapest(candidates) {
  return [...candidates].sort((left, right) => tierOrder(left.runtime) - tierOrder(right.runtime)
    || runtimeOrder(left.runtime) - runtimeOrder(right.runtime)
    || left.order - right.order).at(0) ?? null;
}

/**
 * The strongest available candidate of a vendor other than `vendor`: highest
 * tier, then highest cost rank, then declaration order. Exported alongside
 * `cheapest` for `setup`'s cross-vendor judge default.
 *
 * @param {RuntimeCandidate[]} candidates
 * @param {string|undefined} vendor
 * @returns {RuntimeCandidate|null}
 */
export function strongest(candidates, vendor) {
  return [...candidates].filter(({ runtime }) => effectiveProvider(runtime) !== vendor)
    .sort((left, right) => tierOrder(right.runtime) - tierOrder(left.runtime)
      || runtimeOrder(right.runtime) - runtimeOrder(left.runtime)
      || left.order - right.order).at(0) ?? null;
}

/** @param {RuntimeLike} runtime @returns {number} */
function tierOrder(runtime) {
  return typeof runtime.tier === "number" ? runtime.tier : runtime.costRank ?? Number.MAX_SAFE_INTEGER;
}

/**
 * How long a recorded live-preflight verdict stays fresh, in seconds. This is
 * the hello's own clock and is never derived from the quota windows below: a
 * spend allowance expires when the provider resets it, a hello expires
 * because whatever it proved -- a working credential, a spawning binary, a
 * model that answers -- has stopped holding. Measured 2026-09-22: the ask
 * costs about 18s for four runtimes in parallel, so every launch that reuses
 * instead of asking saves about that. The window bets that a provider which
 * answered still answers for the next quarter hour -- long enough to cover a
 * burst of relaunches and retries, short enough that whatever died in
 * between is bought again within fifteen minutes.
 */
const PREFLIGHT_FRESH_SEC = 15 * 60;

/** The window label a persisted live-preflight verdict carries. */
export const PREFLIGHT_WINDOW = "preflight";

/**
 * Span in seconds of every window label a catalogue or stored record may
 * carry. `five_hour` and `seven_day` are claude's rate-limit labels (measured
 * 2026-09-17, the `rate_limit_event` line recorded in
 * `src/harnesses/protocol.mjs`); `preflight` is the hello's own clock, whose
 * duration and reasoning live in `PREFLIGHT_FRESH_SEC` above -- the two kinds
 * of window expire for different reasons and are never one clock. A label
 * missing here cannot prove staleness, so its observation never self-expires.
 *
 * @type {Readonly<Record<string, number>>}
 */
const AVAILABILITY_WINDOW_SEC = Object.freeze({ five_hour: 5 * 3600, seven_day: 7 * 86400, [PREFLIGHT_WINDOW]: PREFLIGHT_FRESH_SEC });

/**
 * May a runtime be admitted on this catalogue record? Exhaustion is waited
 * out on `exhaustedUntil`; an observation older than its own window reads as
 * unknown and admits nothing, because unknown must not look rested. This is
 * the one home of the rule: plan routing and engine composition both read it,
 * as does the verdict store's reuse decision in `run/availability.mjs`, so
 * the null and staleness semantics cannot drift between readers. The
 * parameter is typed on the fields the rule reads, not on the full record --
 * the plan's table copy names no `reason`.
 *
 * @param {{available: boolean, exhaustedUntil: string|null, observedAt?: string|null, window?: string|null, [key: string]: unknown}|undefined} availability
 * @param {number} [now] epoch milliseconds; defaults to the current clock
 * @returns {boolean}
 */
export function isRuntimeAvailable(availability, now = Date.now()) {
  if (!availability) return false;
  const rested = availability.available === true
    ? !availability.exhaustedUntil || Date.parse(availability.exhaustedUntil) <= now
    : Boolean(availability.exhaustedUntil && Date.parse(availability.exhaustedUntil) <= now);
  if (!rested) return false;
  const windowSec = availability.window === undefined || availability.window === null
    ? undefined
    : AVAILABILITY_WINDOW_SEC[availability.window];
  if (windowSec === undefined || availability.observedAt === undefined || availability.observedAt === null) return true;
  const observedAt = Date.parse(availability.observedAt);
  return !Number.isNaN(observedAt) && observedAt + windowSec * 1000 >= now;
}

