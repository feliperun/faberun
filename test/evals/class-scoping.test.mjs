import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { casesOfClass } from "../../evals/run.mjs";

const RUN = fileURLToPath(new URL("../../evals/run.mjs", import.meta.url));

/** @param {string[]} args */
const spawnRun = (args) => spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8" });

/** @param {Record<string, unknown>[]} specs */
const loadedOf = (specs) => specs.map((spec) => ({ spec }));

const CONTRACT_CASE = { id: "contract-case", contract: {} };
const COMMAND_CASE = { id: "command-case", command: {} };

test("casesOfClass scopes the deterministic class to the contract-driven cases", () => {
  const loaded = loadedOf([COMMAND_CASE, CONTRACT_CASE, { id: "second-contract", contract: {} }]);
  assert.deepEqual(
    casesOfClass(loaded, "deterministic").map((entry) => entry.spec.id),
    ["contract-case", "second-contract"],
  );
});

test("casesOfClass scopes the planner class to the command-driven cases", () => {
  const loaded = loadedOf([CONTRACT_CASE, COMMAND_CASE]);
  assert.deepEqual(
    casesOfClass(loaded, "planner").map((entry) => entry.spec.id),
    ["command-case"],
  );
});

test("a class whose kind has no cases is an error, not a green empty pass", () => {
  assert.throws(() => casesOfClass(loadedOf([CONTRACT_CASE]), "planner"), /selected no cases/);
});

test("the CLI rejects an unknown class before discovering any case", () => {
  const result = spawnRun(["--class", "stochastic"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown --class/);
});

test("the CLI rejects --class together with --case", () => {
  const result = spawnRun(["--class", "deterministic", "--case", "no-such-case"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not both/);
});
