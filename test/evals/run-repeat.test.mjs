import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { repeatCase } from "../../evals/run.mjs";

test("--repeat folds n runs of a case: ok only when every run is, failures carry their ordinal, passes are counted", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return { id: "D01", title: "t", proves: "p", ok: calls !== 2, failures: calls === 2 ? ["node build: status done != failed"] : [] };
  };
  const folded = await repeatCase(flaky, 3);
  assert.equal(calls, 3, "runs are sequential and all n happen");
  assert.deepEqual(folded, { id: "D01", title: "t", proves: "p", ok: false, failures: ["[run 2/3] node build: status done != failed"], repeats: 3, passes: 2 });
  const steady = await repeatCase(async () => ({ id: "D01", title: "t", proves: "p", ok: true, failures: [] }), 2);
  assert.deepEqual(steady, { id: "D01", title: "t", proves: "p", ok: true, failures: [], repeats: 2, passes: 2 });
  const single = await repeatCase(async () => ({ id: "D01", title: "t", proves: "p", ok: false, failures: ["x"] }), 1);
  assert.deepEqual(single.failures, ["x"], "a single run keeps its failures unprefixed");
});
