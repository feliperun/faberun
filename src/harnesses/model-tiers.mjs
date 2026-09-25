/**
 * The per-model tier table same-vendor review reads (R20). Separate from
 * `catalogue.mjs` because that module imports the engine's runtime discovery,
 * and the tier rule is read by both contract validation and runtime
 * assignment; kept here it has no imports, so neither reader cycles back
 * through the catalogue.
 */

/**
 * Every Anthropic model's tier, in the order of the owner's price list (R20):
 * Sonnet 2 (US$ 2 / 10 per MTok), Opus 3 (5 / 25 and 4 / 20), Fable 4 (10 /
 * 50). Sonnet is cheap enough to work; Opus or Fable is what judges it. A
 * model absent from this table declares no tier and cannot judge in
 * same-vendor mode (`contract/judge-independence.mjs`).
 *
 * @type {Readonly<Record<string, number>>}
 */
export const ANTHROPIC_MODEL_TIERS = Object.freeze({
  "claude-sonnet-5": 2,
  "claude-opus-5": 3,
  "claude-opus-5-5": 3,
  "claude-fable-5": 4,
  "claude-fable-5-1": 4,
});

/**
 * The declared tier of a model reached through a given harness: only an
 * Anthropic model run through the `claude` harness carries one today. `null`
 * covers every other harness and every model this table does not list, which
 * is exactly what `sameVendorTierRefusal` reads as "cannot judge in
 * same-vendor mode".
 *
 * @param {string} harness
 * @param {string} model
 * @returns {number|null}
 */
export function declaredModelTier(harness, model) {
  return harness === "claude" ? ANTHROPIC_MODEL_TIERS[model] ?? null : null;
}
