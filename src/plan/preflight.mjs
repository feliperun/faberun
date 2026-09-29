/**
 * What `faberun plan` decides before it spends anything: the refusals it
 * returns before the first stage is dispatched -- which runtimes a planning run
 * will spend, and what counts as one of them not answering -- and the
 * deterministic checks a plan passes before any semantic review grades it.
 *
 * Both halves live beside the pipeline rather than inside it because asking
 * and checking are their own concerns, and because `pipeline.mjs` sits close
 * to this tree's 800-line ceiling.
 */
import { join } from "node:path";
import { preflightRuntimes } from "../engine/live-preflight.mjs";
import { liveSilenceCause } from "../engine/live-silence.mjs";
import { harnessCapabilities } from "../harnesses/index.mjs";
import { validateContract } from "../contract/index.mjs";
import { assertRuntimeExecutesCommands, validateRuntime } from "../contract/runtime.mjs";
import { effectiveProvider } from "../contract/provider.mjs";
import { SAME_VENDOR_REVIEW_MODE, sameVendorTierRefusal } from "../contract/judge-independence.mjs";
import { assertTimeoutsCoverMeasured, raiseTimeoutsToMeasured } from "./freeze.mjs";
import { assertFilteredProofsNameTheirTest, declareDirectoryGuards } from "./proof-scope.mjs";
import { checkPlanProofs } from "./proof-check.mjs";

/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./pipeline.mjs").AssembledPlan} AssembledPlan */

/**
 * What the deterministic checks need: the measured repository facts the freeze
 * rules read, the cwd and plansDir the contract is assembled against, and the
 * two closures that render the plan the way `freezePlan` will. They are
 * supplied rather than imported because they are the pipeline's own assembly
 * (`pipeline.mjs` imports this module), and taking them as data is what lets
 * `rounds.mjs` — and a test — run the checks with fakes.
 *
 * @typedef {{repoFacts: import("./repo-facts.mjs").RepoFacts, cwd: string, plansDir: string, assembleFrozenNodes: (plan: PlanOutput) => AssembledPlan, frozenContractRaw: (assembly: AssembledPlan) => JsonObject}} PlanCheckContext
 */

/**
 * The two mechanically repairable freeze rules, applied, then the freeze
 * contract itself validated the way `freeze.mjs` and `proof-scope.mjs`
 * validate it: the rules are imported, never restated, so this cannot drift
 * from the freeze it stands in front of.
 *
 * It does not throw. A plan the checks refuse is a diagnostic for the repair
 * loop, not a refusal: the refusal is the pre-dispatch half of this module,
 * and a thrown plan check would spend a round's budget twice — once on the
 * revise that answers a finding, and once on the error that killed it.
 *
 * The failure is returned beside the repaired plan rather than instead of it,
 * so the caller can hand the plan on to a review (or to the freeze) while
 * still recording what the freeze would have said.
 *
 * @param {PlanOutput} plan
 * @param {PlanCheckContext} ctx
 * @returns {{plan: PlanOutput, raised: string[], declared: string[], failure: unknown|null}}
 */
export function freezePreflight(plan, ctx) {
  const timeouts = raiseTimeoutsToMeasured(plan, ctx.repoFacts);
  const guards = declareDirectoryGuards(timeouts.plan, ctx.repoFacts, ctx.cwd);
  const candidate = guards.plan;
  const repaired = { plan: candidate, raised: timeouts.raised, declared: guards.declared };
  try {
    const contract = validateContract(ctx.frozenContractRaw(ctx.assembleFrozenNodes(candidate)), join(ctx.plansDir, "contract.json"));
    assertFilteredProofsNameTheirTest(contract);
    assertTimeoutsCoverMeasured(contract, ctx.repoFacts);
    return { ...repaired, failure: null };
  } catch (error) {
    return { ...repaired, failure: error };
  }
}

/**
 * The complete deterministic check set a plan passes before any semantic
 * review begins: `freezePreflight` plus the plan-wide proof scan, whose two
 * shapes (a name filter that selects no test, a bare grep proving an absence)
 * no reviewer decides better than a local read. The pipeline runs this once on
 * the draft and forwards `findings` into the round loop's own repair budget —
 * the rounds `--review-rounds` already pays for — while the loop runs
 * `freezePreflight` on every candidate it grades, where the repair it drives
 * is the answer to whatever the check refused.
 *
 * @param {PlanOutput} plan
 * @param {PlanCheckContext} ctx
 * @returns {{plan: PlanOutput, raised: string[], declared: string[], findings: PlanFindingOutput[], failure: unknown|null}}
 */
export function checkPlanBeforeReview(plan, ctx) {
  const checks = freezePreflight(plan, ctx);
  return { ...checks, findings: checkPlanProofs(checks.plan, ctx.repoFacts, ctx.cwd) };
}

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
 * In same-vendor mode (`--judge-independence same-vendor`) a shared vendor is
 * admitted exactly as the contract validator admits it: the judge's tier is
 * declared and at or above that of the worker and of every fallback runtime of
 * the same vendor. Measured 2026-09-27: without the mode on `plan`, a
 * single-provider catalogue (Sonnet worker, Opus planner and judge) could not
 * plan at all, though its frozen contract would have validated in the mode.
 *
 * @param {"implementation"|"exploratory"} packageMode
 * @param {"same-vendor"} [judgeIndependence]
 * @returns {void}
 */
export function refuseUnplannableRuntimes(runtimes, runtimeDefaults, packageMode, judgeIndependence) {
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
  const judgeVendor = effectiveProvider(/** @type {import("../contract/provider.mjs").ProviderInput & {vendor?: string}} */ (runtimes[judge]));
  if (judgeVendor === undefined) return;
  const seen = new Set();
  for (let id = /** @type {string|undefined} */ (worker); id && runtimes[id] && !seen.has(id); id = /** @type {string|undefined} */ (runtimes[id].fallback)) {
    seen.add(id);
    const provider = effectiveProvider(/** @type {import("../contract/provider.mjs").ProviderInput & {vendor?: string}} */ (runtimes[id]));
    if (provider !== judgeVendor) continue;
    if (judgeIndependence !== SAME_VENDOR_REVIEW_MODE) {
      throw new Error(`--runtime-defaults judge=${judge} shares vendor ${judgeVendor} with worker ${worker} or its fallback, so no frozen node could route its judge; name a judge of another vendor, or pass --judge-independence same-vendor`);
    }
    const refusal = sameVendorTierRefusal(/** @type {{harness: string, model: string}} */ (runtimes[id]), /** @type {{harness: string, model: string}} */ (runtimes[judge]));
    if (refusal) {
      throw new Error(`--runtime-defaults judge=${judge} shares vendor ${judgeVendor} with ${id === worker ? "worker" : "worker fallback"} ${id} under --judge-independence same-vendor, but ${refusal.message}`);
    }
  }
}
