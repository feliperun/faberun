import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readEvalLedgerSources } from "../../evals/ledger.mjs";
import { mergeEvalRunSources, projectEvalIndicators } from "../../evals/metrics.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_PATH = join(REPOSITORY_ROOT, "evals", "baseline.json");

/** @typedef {{campaign: string, ledgerDir: string}} BaselineCampaign */
/** @typedef {{campaigns: BaselineCampaign[], ledgerDirs: string[], [key: string]: unknown}} BaselineProvenance */
/** @typedef {{provenance: BaselineProvenance, indicators: Record<string, unknown>}} Baseline */

/** @param {unknown} value @returns {unknown} */
function roundNumbersToFourPlaces(value) {
  if (typeof value === "number") return Number(value.toFixed(4));
  if (Array.isArray(value)) return value.map(roundNumbersToFourPlaces);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundNumbersToFourPlaces(entry)]));
  }
  return value;
}

/** @param {unknown} value @param {string} [key] @returns {string[]} */
function provenancePathsOf(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((entry) => provenancePathsOf(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, entry]) => provenancePathsOf(entry, childKey));
  }
  return typeof value === "string" && /(dir|path)/iu.test(key) ? [value] : [];
}

test("the baseline recomputes from versioned ledgers", () => {
  const baseline = /** @type {Baseline} */ (JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  const campaigns = baseline.provenance.campaigns;
  assert.deepEqual(campaigns.map((entry) => entry.campaign), [
    "first-target-frictions",
    "campaign-brief",
    "availability-is-verified-not-assumed",
  ]);
  const ledgerDirs = campaigns.map((entry) => entry.ledgerDir);
  assert.deepEqual(baseline.provenance.ledgerDirs, ledgerDirs);
  for (const ledgerDir of provenancePathsOf(baseline.provenance)) assert.equal(isAbsolute(ledgerDir), false, ledgerDir);

  const ledgers = ledgerDirs.map((ledgerDir) => readEvalLedgerSources(join(REPOSITORY_ROOT, ledgerDir)));
  assert.deepEqual(ledgers.flatMap((ledger) => ledger.missingSources), []);
  const recomputed = projectEvalIndicators(mergeEvalRunSources(ledgers));
  assert.deepEqual(roundNumbersToFourPlaces(recomputed), roundNumbersToFourPlaces(baseline.indicators));
});
