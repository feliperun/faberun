import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../../src/engine/run-command.mjs";
import { MUTATION_TIME_BUDGET_MS, runMutation } from "../../src/engine/mutation.mjs";

test("mutation catches empty test", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-empty-"));
  writeFileSync(join(cwd, "module.mjs"), "export function same(a, b) {\n  return a === b;\n}\n");
  // A test that calls the code and asserts nothing: it exits zero whatever the
  // mutant does, which is exactly the suite this gate exists to reject.
  writeFileSync(join(cwd, "check.mjs"), "import { same } from './module.mjs';\nsame(1, 1);\n");
  const entry = { argv: [process.execPath, "check.mjs"], mutation: { tier: "high" } };
  const empty = await runVerification([entry], cwd, { writeFiles: ["module.mjs"] });
  assert.equal(empty.passed, false, "a test that asserts nothing cannot kill the mutant");
  writeFileSync(join(cwd, "check.mjs"), "import assert from 'node:assert/strict';\nimport { same } from './module.mjs';\nassert.equal(same(1, 1), true);\nassert.equal(same(1, 2), false);\n");
  const asserting = await runVerification([entry], cwd, { writeFiles: ["module.mjs"] });
  assert.equal(asserting.passed, true, "an asserting test kills the mutant");
});

test("mutation scoped to node", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-scope-"));
  writeFileSync(join(cwd, "in-scope.mjs"), "export const value = 1 === 1;\n");
  writeFileSync(join(cwd, "out-of-scope.mjs"), "export const other = 2 === 2;\n");
  // `check.mjs` itself carries an operator, so an unscoped runner would sample
  // it and the out-of-scope module too; the run count proves it did not.
  writeFileSync(join(cwd, "check.mjs"), "import { appendFileSync } from 'node:fs';\nimport { value } from './in-scope.mjs';\nappendFileSync('runs.log', '1');\nif (value !== true) process.exit(1);\n");
  const result = await runVerification([{ argv: [process.execPath, "check.mjs"], mutation: { tier: "high" } }], cwd, { writeFiles: ["in-scope.mjs"] });
  assert.equal(result.passed, true);
  // One baseline plus exactly one in-scope mutant; an out-of-scope sample would
  // have added a run.
  assert.equal(readFileSync(join(cwd, "runs.log"), "utf8").length, 2);
});

test("the tier fixes the kill fraction", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-tier-"));
  // Two mutants, a suite that kills exactly one: the kill fraction is 1/2, so
  // the tier alone decides the verdict.
  writeFileSync(join(cwd, "half.mjs"), "export const asserted = 1 === 1;\nexport const ignored = 2 === 2;\n");
  writeFileSync(join(cwd, "check.mjs"), "import assert from 'node:assert/strict';\nimport { asserted } from './half.mjs';\nassert.equal(asserted, true);\n");
  const entry = { argv: [process.execPath, "check.mjs"] };
  const high = await runVerification([{ ...entry, mutation: { tier: "high" } }], cwd, { writeFiles: ["half.mjs"] });
  assert.equal(high.passed, false, "high tier demands every sampled mutant die");
  const low = await runVerification([{ ...entry, mutation: { tier: "low" } }], cwd, { writeFiles: ["half.mjs"] });
  assert.equal(low.passed, true, "low tier accepts half the sampled mutants killed");
});

test("mutation duration budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-budget-"));
  const names = [];
  const lines = [];
  for (let index = 0; index < 20; index += 1) {
    names.push(`value${index}`);
    lines.push(`export const value${index} = ${index} === ${index};`);
  }
  writeFileSync(join(cwd, "typical.mjs"), `${lines.join("\n")}\n`);
  // An asserting suite: every sampled mutant dies, so the entry's verdict is
  // about the budget, not about survivors.
  const assertions = names.map((name) => `assert.equal(${name}, true);`).join("\n");
  writeFileSync(join(cwd, "check.mjs"), `import { appendFileSync } from 'node:fs';\nimport assert from 'node:assert/strict';\nimport { ${names.join(", ")} } from './typical.mjs';\nappendFileSync('runs.log', '1');\n${assertions}\n`);
  const result = await runVerification([{ argv: [process.execPath, "check.mjs"], mutation: { tier: "low" } }], cwd, { writeFiles: ["typical.mjs"] });
  assert.equal(result.passed, true);
  // The budget is proved by counting work, not by a clock: one baseline attempt
  // plus at most eight mutants, and every attempt ran the argv exactly once, so
  // the append count must equal the attempt count.
  const attempts = result.commands[0].attempts.length;
  assert.ok(attempts <= 1 + 8, `the runner ran ${attempts - 1} mutants; the budget is 8`);
  assert.equal(readFileSync(join(cwd, "runs.log"), "utf8").length, attempts, "each mutant ran the argv exactly once");
});

test("mutation holds the time budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-mutation-wall-"));
  const lines = [];
  for (let index = 0; index < 20; index += 1) lines.push(`export const value${index} = ${index} === ${index};`);
  writeFileSync(join(cwd, "slow.mjs"), `${lines.join("\n")}\n`);
  // The clock is simulated, not waited on: the executor costs no real time and
  // reports a duration of budget/5 per run, so exactly four mutants fit after
  // the baseline. The constant is a multiple of five (measured: 30_000), which
  // keeps the simulated cost on exact integer arithmetic.
  const attemptMs = MUTATION_TIME_BUDGET_MS / 5;
  const result = await runMutation({ argv: ["suite"], mutation: { tier: "high" } }, cwd, {
    writeFiles: ["slow.mjs"],
    run: async (attempt) => ({
      passed: attempt === 1,
      stdout: "",
      stderr: "",
      error: null,
      exitCode: attempt === 1 ? 0 : 1,
      signal: null,
      timedOut: false,
      durationMs: attemptMs,
    }),
  });
  // One baseline plus the four mutants the budget could afford; the other four
  // were never started, and they still count in the denominator, so a perfect
  // suite that is too slow to sample fails a high-tier gate.
  assert.equal(result.attempts.length, 5);
  assert.equal(result.killed, 4);
  assert.equal(result.total, 8, "mutants the budget could not afford stay in the denominator");
  assert.equal(result.passed, false, "a suite too slow to sample inside the budget cannot sit a high-tier gate");
});
