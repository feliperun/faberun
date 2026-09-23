import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pricingSeedAge, seedPricing } from "../../src/engine/pricing-seed.mjs";

// The vendored JSON is data this test also owns: assert the shape and the
// age arithmetic, never a hardcoded rate, so a future re-vendor cannot
// silently invalidate the suite.

test("seedPricing returns the vendored rate shape for a known model", () => {
  const rate = seedPricing("claude-opus-5");
  assert.ok(rate, "claude-opus-5 must be vendored");
  assert.equal(typeof rate.inputPerMTok, "number");
  assert.equal(typeof rate.outputPerMTok, "number");
});

test("seedPricing is undefined for an unknown or absent model", () => {
  assert.equal(seedPricing("not-a-vendored-model"), undefined);
  assert.equal(seedPricing(null), undefined);
  assert.equal(seedPricing(undefined), undefined);
});

test("pricingSeedAge reports the freshly vendored seed as current", () => {
  const age = pricingSeedAge(new Date());
  assert.ok(age.ageDays >= 0);
  assert.equal(age.stale, false);
});

test("pricingSeedAge marks a seed roughly 200 days past its fetchedAt stale", () => {
  const { fetchedAt } = pricingSeedAge(new Date());
  const age = pricingSeedAge(new Date(Date.parse(fetchedAt) + 200 * 86_400_000));
  assert.equal(age.ageDays, 200);
  assert.equal(age.stale, true);
});
