/**
 * `retryDivergentCandidateCommands` is the pure part of the candidate-retry
 * rule: which commands diverge from the attempt's own recorded verification,
 * and how their retried results merge back in. It never runs a real process --
 * `run` is a fake here -- so these cases prove the indexing and the merge
 * without a workspace or a git repository.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { retryDivergentCandidateCommands } from "../../src/engine/verify.mjs";

test("a candidate whose every failure diverges from the attempt is retried once and passes", async () => {
  const attemptEvidence = { commands: [{ argv: ["npm", "test"], passed: true }] };
  const candidate = { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] };
  let calls = 0;
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async (indexes) => {
    calls += 1;
    assert.deepEqual(indexes, [0]);
    return indexes.map(() => ({ argv: ["npm", "test"], passed: true, attempts: [] }));
  });
  assert.equal(calls, 1, "the retry hook ran exactly once");
  assert.equal(result.passed, true);
  assert.deepEqual(result.retried, [0]);
  assert.equal(result.commands[0].passed, true);
});

test("a candidate failure with no passing counterpart in the attempt is not divergent and is left untouched", async () => {
  const attemptEvidence = { commands: [{ argv: ["npm", "test"], passed: false }] };
  const candidate = { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] };
  let calls = 0;
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async (indexes) => {
    calls += 1;
    return indexes.map(() => ({ argv: ["npm", "test"], passed: true, attempts: [] }));
  });
  assert.equal(calls, 0, "a command that also failed for the attempt is a verdict, not divergence");
  assert.equal(result.retried, undefined);
  assert.equal(result, candidate, "the untouched result is returned as-is");
});

test("a divergent argv mismatch at the same position is not treated as the same command", async () => {
  const attemptEvidence = { commands: [{ argv: ["npm", "run", "lint"], passed: true }] };
  const candidate = { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] };
  let calls = 0;
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async () => {
    calls += 1;
    return [];
  });
  assert.equal(calls, 0);
  assert.equal(result, candidate);
});

test("a candidate with one divergent and one non-divergent failure retries nothing", async () => {
  const attemptEvidence = {
    commands: [
      { argv: ["npm", "test"], passed: true },
      { argv: ["npm", "run", "lint"], passed: false },
    ],
  };
  const candidate = {
    passed: false,
    commands: [
      { argv: ["npm", "test"], passed: false, attempts: [] },
      { argv: ["npm", "run", "lint"], passed: false, attempts: [] },
    ],
  };
  let calls = 0;
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async () => {
    calls += 1;
    return [];
  });
  assert.equal(calls, 0, "partial divergence covers only some of the failures, so none are retried");
  assert.equal(result, candidate);
});

test("a candidate with no failing commands is returned untouched without calling the retry hook", async () => {
  const attemptEvidence = { commands: [{ argv: ["npm", "test"], passed: true }] };
  const candidate = { passed: true, commands: [{ argv: ["npm", "test"], passed: true, attempts: [] }] };
  let calls = 0;
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async () => {
    calls += 1;
    return [];
  });
  assert.equal(calls, 0);
  assert.equal(result, candidate);
});

test("the merge keeps command order across a passing, a divergent and a non-retried position", async () => {
  const attemptEvidence = {
    commands: [
      { argv: ["a"], passed: true },
      { argv: ["b"], passed: true },
      { argv: ["c"], passed: true },
    ],
  };
  const candidate = {
    passed: false,
    commands: [
      { argv: ["a"], passed: true, attempts: [] },
      { argv: ["b"], passed: false, attempts: [] },
      { argv: ["c"], passed: false, attempts: [] },
    ],
  };
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async (indexes) => {
    assert.deepEqual(indexes, [1, 2]);
    return indexes.map((index) => ({ argv: candidate.commands[index].argv, passed: true, attempts: [] }));
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.retried, [1, 2]);
  assert.deepEqual(result.commands.map((command) => command.argv), [["a"], ["b"], ["c"]]);
  assert.deepEqual(result.commands.map((command) => command.passed), [true, true, true]);
});

test("a second failure on retry keeps the command failed and the command overall fails", async () => {
  const attemptEvidence = { commands: [{ argv: ["npm", "test"], passed: true }] };
  const candidate = { passed: false, commands: [{ argv: ["npm", "test"], passed: false, attempts: [] }] };
  const result = await retryDivergentCandidateCommands(candidate, attemptEvidence, async (indexes) => (
    indexes.map(() => ({ argv: ["npm", "test"], passed: false, attempts: [] }))
  ));
  assert.equal(result.passed, false);
  assert.deepEqual(result.retried, [0]);
  assert.equal(result.commands[0].passed, false);
});
