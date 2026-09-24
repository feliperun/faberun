import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { StochasticBudget } from "../../evals/budget.mjs";

const runtime = { id: "sonnet", model: "claude-sonnet-5" };
const usage = { inputTokens: 1_000, cacheReadInputTokens: 0, outputTokens: 1_000 };

test("a stochastic class stops at its budget", () => {
  assert.throws(
    () => new StochasticBudget({ argv: [] }),
    /--budget-usd/,
    "a stochastic class must not start without an explicit allowance",
  );

  const budget = new StochasticBudget({ argv: ["--budget-usd", "0.05"] });
  const first = budget.startInvocation(runtime, { usage });
  assert.ok(first, "the first estimated invocation fits");
  assert.equal(
    budget.startInvocation(runtime, { estimateUsd: 0.04 }),
    null,
    "a second in-flight estimate is refused before it can cross the allowance",
  );

  const settled = budget.completeInvocation(first, { usage });
  assert.equal(settled.costProvenance, "priced");
  assert.equal(settled.costUsd, 0.012);

  const unknown = budget.startInvocation(runtime, { usage: { inputTokens: 1_000, cacheReadInputTokens: 0 } });
  assert.ok(unknown);
  const fallback = budget.completeInvocation(unknown, { usage: { inputTokens: 1_000, cacheReadInputTokens: 0 } });
  assert.equal(fallback.costUsd, 0.012, "unknown usage uses the highest observed cost for this runtime");
  assert.ok(budget.startInvocation(runtime, { estimateUsd: 0.03 }) === null, "priced plus reserved spend reaches the cap");

  const discarded = budget.startInvocation(runtime, { estimateUsd: 0.01 });
  assert.ok(discarded);
  budget.voidInvocation(discarded);
  assert.equal(budget.result().voidedSpendUsd, 0.012);
  assert.equal(budget.result().voidedInvocations, 1);
  assert.equal(budget.startInvocation(runtime, { estimateUsd: 0.03 }), null, "voided spend remains part of the hard allowance");
});

test("an empty budget value is a usage error and settled spend can overrun", () => {
  assert.throws(() => new StochasticBudget({ argv: ["--budget-usd", ""] }), /needs a value/);
  const budget = new StochasticBudget({ budgetUsd: 0.01 });
  const reservation = budget.startInvocation(runtime, 0.005);
  assert.ok(reservation);
  budget.completeInvocation(reservation, { costUsd: 0.02 });
  assert.equal(budget.result().overrunUsd, 0.01);
  assert.equal(budget.startInvocation(runtime, 0.001), null, "a settled overrun stops later launches");
});

test("the observed runtime price survives a restarted class run", () => {
  const first = new StochasticBudget({ budgetUsd: 1 });
  const priced = first.startInvocation(runtime, { usage });
  assert.ok(priced);
  first.completeInvocation(priced, { usage });

  const restarted = new StochasticBudget({ budgetUsd: 1, highestObservedUsd: first.result().highestObservedUsd });
  const unknown = restarted.startInvocation(runtime, 0.001);
  assert.ok(unknown);
  const settled = restarted.completeInvocation(unknown, { usage: { inputTokens: 1_000, cacheReadInputTokens: 0 } });
  assert.equal(settled.costUsd, 0.012, "the restarted run uses the class ledger's highest observed price");
});
