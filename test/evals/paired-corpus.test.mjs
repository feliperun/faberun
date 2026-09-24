import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { validateCorpora } from "../../evals/paired/validate.mjs";

/**
 * R4's proof: the two measured rounds are real corpus entries, and each one is
 * discriminating — every proof fails on its base tree and every guard passes
 * there, with the base restored from the one fixtures bundle and no model
 * reached. `validateCorpora` restores the bases into a temp directory, so the
 * test writes nothing to the repository.
 */
test("every paired corpus entry fails its proofs and passes its guards at base", () => {
  const result = validateCorpora();
  assert.equal(result.ok, true, `corpus validation failed:\n${result.failures.join("\n")}`);
  assert.ok(result.corpora.length >= 2, `expected the simple and complex rounds, found ${result.corpora.length} corpus entry(ies)`);
  assert.ok(
    result.corpora.some((corpus) => corpus.checks.some((check) => check.kind === "guard")),
    "at least one corpus keeps a guard, so 'passes its guards' is not vacuous everywhere",
  );
  for (const corpus of result.corpora) {
    assert.equal(corpus.proofsFailed, true, `${corpus.id}: every proof must fail on the base tree`);
    assert.equal(corpus.guardsPassed, true, `${corpus.id}: every guard must pass on the base tree`);
    assert.equal(corpus.ok, true, `${corpus.id}: ${corpus.failures.join("; ")}`);
    assert.ok(corpus.checks.some((check) => check.kind === "proof"), `${corpus.id}: a corpus without a proof is not measured`);
  }
});
