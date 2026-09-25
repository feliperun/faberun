/**
 * The ask `faberun plan` makes before its first stage.
 *
 * It lives beside the pipeline rather than inside it because asking is its own
 * concern -- which runtimes a planning run will spend, and what counts as one
 * of them not answering -- and because `pipeline.mjs` sits 45 lines from this
 * tree's 800-line ceiling.
 */
import { preflightRuntimes } from "../engine/live-preflight.mjs";
import { liveSilenceCause } from "../engine/live-silence.mjs";
import { harnessCapabilities } from "../harnesses/index.mjs";
import { assertRuntimeExecutesCommands, validateRuntime } from "../contract/runtime.mjs";
import { effectiveProvider } from "../contract/provider.mjs";

/**
 * The runtimes a planning run will spend, asked once before its first stage.
 *
 * Planning routes two roles across nine stages and does not reach them at the
 * same time: the planner is spent at `draft`, the reviewer not until `review`.
 * Every stage does launch through `runContract`, so the dispatch gate asks --
 * but it asks that stage's own contract, and a planning contract carries no
 * gate (`plan/template.mjs` builds them with `gate: false`), so
 * `reachableRuntimes` never counts the judge role: it only adds one when a
 * node's gate is enabled. The reviewer is therefore reached only as the
 * *worker* of a later stage's contract, which is why a reviewer that never
 * answers used to surface after the draft had already been bought. Naming both
 * runtimes directly is the only ask that reaches them before anything is
 * spent.
 *
 * Phase 2's verdict store makes this free at the stage boundary: what is
 * recorded here is what each stage's own gate reuses instead of asking again.
 *
 * @param {Record<string, Record<string, unknown>>} runtimes the catalogue as the pipeline carries it, validated here per entry
 * @param {{worker?: string, judge?: string}} runtimeDefaults
 * @param {string} cwd
 * @returns {Promise<import("../harnesses/index.mjs").ProbeResult[]>}
 */
export async function askPlanningRuntimes(runtimes, runtimeDefaults, cwd) {
  /** @type {string[]} */
  const ids = [];
  for (const id of [runtimeDefaults.worker, runtimeDefaults.judge]) {
    if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  const entries = ids.flatMap((id) => {
    const raw = runtimes[id];
    // A default naming a runtime the catalogue does not carry is the
    // catalogue loader's refusal to make, not this one's.
    if (raw === undefined) return [];
    const runtime = validateRuntime(id, raw);
    return [{ runtime: { ...runtime, id, capabilities: harnessCapabilities(runtime) } }];
  });
  return entries.length === 0 ? [] : preflightRuntimes(entries, { cwd });
}

/**
 * Refuse before the first stage when a runtime said nothing at all.
 *
 * The rule is the dispatch gate's own, imported rather than restated:
 * `liveSilenceCause` decides what silence is, so planning and dispatch cannot
 * drift into disagreeing about whether an answer was an answer. Silence
 * blocks; any verdict a provider returned -- a quota refusal included -- is an
 * answer, and the run proceeds onto whatever the contract declares.
 *
 * @param {import("../harnesses/index.mjs").ProbeResult[]} checks
 * @param {string} cwd
 * @returns {void}
 */
export function refusePlanningSilence(checks, cwd) {
  const silent = checks.flatMap((check) => {
    const cause = liveSilenceCause(check);
    return cause === null ? [] : [`runtime ${check.id ?? check.harness} did not answer: ${cause}`];
  });
  if (silent.length === 0) return;
  throw Object.assign(
    new Error(`env_preflight_failed: ${silent.join(" · ")} · planning stays resumable: fix the environment and plan again in ${cwd}`),
    { code: "env_preflight_failed" },
  );
}

/**
 * Refuse, before anything is spent, a runtime choice no frozen contract could
 * carry. Both halves were measured on 2026-09-24 in `choose-the-judges` R5,
 * where each surfaced only at freeze, after four rounds: a worker whose
 * permission mode cannot run commands cannot carry an implementation node's
 * verification (US$ 7.64 and an hour, contested), and a judge that shares the
 * worker's vendor, or the vendor of any runtime its fallback reaches, is
 * refused by the vendor rule on every frozen node (`runtime_routing_unmet` in
 * all four rounds). The pipeline's defaults name both roles, so both are
 * decidable here.
 *
 * @param {Record<string, Record<string, unknown>>} runtimes
 * @param {{worker?: string, judge?: string}} runtimeDefaults
 * @param {"implementation"|"exploratory"} packageMode
 * @returns {void}
 */
export function refuseUnplannableRuntimes(runtimes, runtimeDefaults, packageMode) {
  const worker = runtimeDefaults.worker;
  if (!worker || !runtimes[worker]) return;
  if (packageMode === "implementation") {
    try {
      assertRuntimeExecutesCommands(/** @type {any} */ (runtimes), worker, 0, "every implementation node", "worker runtime");
    } catch (error) {
      throw new Error(`--runtime-defaults worker=${worker} cannot run the verification an implementation plan carries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const judge = runtimeDefaults.judge;
  if (!judge || !runtimes[judge]) return;
  /** @type {Set<string>} */
  const vendors = new Set();
  const seen = new Set();
  for (let id = /** @type {string|undefined} */ (worker); id && runtimes[id] && !seen.has(id); id = /** @type {string|undefined} */ (runtimes[id].fallback)) {
    seen.add(id);
    const provider = effectiveProvider(/** @type {import("../contract/provider.mjs").ProviderInput & {vendor?: string}} */ (runtimes[id]));
    if (provider !== undefined) vendors.add(provider);
  }
  const judgeVendor = effectiveProvider(/** @type {import("../contract/provider.mjs").ProviderInput & {vendor?: string}} */ (runtimes[judge]));
  if (judgeVendor !== undefined && vendors.has(judgeVendor)) {
    throw new Error(`--runtime-defaults judge=${judge} shares vendor ${judgeVendor} with worker ${worker} or its fallback, so no frozen node could route its judge; name a judge of another vendor`);
  }
}
