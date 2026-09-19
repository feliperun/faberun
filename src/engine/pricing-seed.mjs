/**
 * The vendored price snapshot every invocation is priced against when its
 * runtime declares no rates of its own: models.dev's published first-party
 * rates for the five vendors this product's harnesses talk to (anthropic,
 * deepseek, google, openai, zhipuai), filtered at vendor time.
 *
 * A dated snapshot, not a live query, by design: the live per-invocation spend
 * surfaces that motivated the idea were investigated and closed (DeepSeek
 * exposes only an account-wide balance scalar, Zhipu publishes no billing
 * endpoint at all, Google Cloud Billing exposes a budget cap without a
 * pre-configured BigQuery export), so the owner's decision was to vendor
 * models.dev and always compute cost from these rates and the token counts.
 * Update it only by re-vendoring, never by fetching at run time.
 *
 * The lookup keys by model id alone: at vendor time (2026-09-19) these five
 * providers carried zero colliding model ids, so no vendor or harness
 * disambiguation is needed for exactly this set. A model with a documented
 * higher-context tier (e.g. openai's gpt-5.6-sol above 200k tokens) is
 * recorded at its base-tier rate only -- a known, unmeasured simplification,
 * not a bug; tiers are deliberately not modelled.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @typedef {import("./process.mjs").RuntimePricing} RuntimePricing */

/** @type {{fetchedAt: string, source: string, providers: string[], models: Record<string, RuntimePricing>}} */
const SEED = JSON.parse(readFileSync(fileURLToPath(new URL("./pricing-seed.json", import.meta.url)), "utf8"));

const DAY_MS = 86_400_000;

/**
 * The vendored rate for one model id, or undefined when the seed does not
 * know it -- an unknown model keeps its cost unknown rather than unpriced.
 *
 * @param {string|null|undefined} model
 * @returns {RuntimePricing|undefined}
 */
export function seedPricing(model) {
  if (typeof model !== "string") return undefined;
  return SEED.models[model];
}

/**
 * How old the vendored snapshot is, in whole days, and whether it is stale.
 *
 * @param {Date} [now]
 * @returns {{fetchedAt: string, ageDays: number, stale: boolean}}
 */
export function pricingSeedAge(now = new Date()) {
  const ageDays = Math.floor((now.getTime() - Date.parse(SEED.fetchedAt)) / DAY_MS);
  // The 90-day staleness threshold is a first guess, not a measurement (2026-09-19).
  return { fetchedAt: SEED.fetchedAt, ageDays, stale: ageDays > 90 };
}
