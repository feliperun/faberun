/**
 * The canonical provider a runtime actually talks to, as opposed to its
 * free-text `vendor` label. Split from runtime.mjs because both the contract
 * validator and every worker-against-judge vendor comparison across `plan/`,
 * `engine/`, `harnesses/` and `cli/` need it, and none of those layers should
 * import the runtime schema validator just to reach it.
 */
import { DEFAULT_HARNESS_VENDORS } from "../harnesses/index.mjs";

/** @typedef {{harness?: string, model?: string, config?: Record<string, unknown>}} ProviderInput */

/**
 * The five canonical providers a runtime can derive to. A runtime whose
 * harness names no default and whose model matches no family below derives
 * none of these — `replay` and `exec-jsonl` never do, since either stands in
 * for whatever the recording or the exec'd binary actually is.
 *
 * @type {ReadonlyArray<"openai"|"anthropic"|"zhipu"|"deepseek"|"google">}
 */
const CANONICAL_PROVIDERS = Object.freeze(["openai", "anthropic", "zhipu", "deepseek", "google"]);

/**
 * Model-id family prefixes, checked before the harness default so an
 * `agy` runtime reselling `claude-sonnet-4-6` derives `anthropic`, not `agy`'s
 * own default of `google`.
 *
 * @type {ReadonlyArray<{pattern: RegExp, provider: string}>}
 */
const MODEL_FAMILY_PROVIDERS = Object.freeze([
  { pattern: /^claude-|^opus\b|^sonnet\b|^fable\b|^haiku\b/iu, provider: "anthropic" },
  { pattern: /^gpt-|^o\d/iu, provider: "openai" },
  { pattern: /^gemini-/iu, provider: "google" },
  { pattern: /^glm-/iu, provider: "zhipu" },
  { pattern: /^deepseek-/iu, provider: "deepseek" },
]);

/**
 * The harnesses whose runtime always stands in for an arbitrary provider: the
 * recording (`replay`) or the exec'd binary (`exec-jsonl`) decide, never this
 * module.
 */
const NO_CANONICAL_PROVIDER_HARNESSES = new Set(["replay", "exec-jsonl"]);

/**
 * The provider a runtime declares a route to, read from the config key its
 * own harness uses for that: codex's `config.model_provider` (for example
 * `deepseek`) and dsh's `config.provider` (`deepseek-official` names
 * `deepseek`). A route naming none of the five canonical providers is not a
 * route this function recognizes, so derivation falls through to the model's
 * family and then the harness default.
 *
 * @param {ProviderInput} runtime
 * @returns {string|null}
 */
function routedProvider(runtime) {
  const config = runtime.config;
  if (!config || typeof config !== "object") return null;
  const route = runtime.harness === "codex"
    ? config.model_provider
    : runtime.harness === "dsh"
      ? config.provider
      : undefined;
  if (typeof route !== "string" || route.length === 0) return null;
  const lowered = route.toLowerCase();
  return CANONICAL_PROVIDERS.find((provider) => lowered.includes(provider)) ?? null;
}

/**
 * The provider a runtime actually talks to, derived in order from (1) the
 * route it declares to another provider, (2) its model id's family, and (3)
 * its harness's own default. `null` means none of the three named one — the
 * two test harnesses always land here, and any other harness does too when
 * its model matches no known family and its harness names no default.
 *
 * @param {ProviderInput} runtime
 * @returns {string|null}
 */
export function canonicalProvider(runtime) {
  if (!runtime || typeof runtime.harness !== "string") return null;
  if (NO_CANONICAL_PROVIDER_HARNESSES.has(runtime.harness)) return null;
  const routed = routedProvider(runtime);
  if (routed) return routed;
  const model = typeof runtime.model === "string" ? runtime.model : "";
  const family = MODEL_FAMILY_PROVIDERS.find((entry) => entry.pattern.test(model));
  if (family) return family.provider;
  return /** @type {Record<string, string>} */ (DEFAULT_HARNESS_VENDORS)[runtime.harness] ?? null;
}

/**
 * The provider identity a worker-against-judge comparison actually compares:
 * the canonical provider when one is derivable, the declared `vendor`
 * otherwise. Every routing and failover site that used to compare `.vendor`
 * directly compares this instead, so a contradicting label (R18) cannot
 * survive `validateRuntime` and reach one of them, and a runtime that
 * bypasses validation (a raw fixture, a discovery-catalogue definition) still
 * compares consistently rather than by accident.
 *
 * @param {ProviderInput & {vendor?: string}} runtime
 * @returns {string|undefined}
 */
export function effectiveProvider(runtime) {
  return canonicalProvider(runtime) ?? runtime.vendor;
}
