import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderUsage } from "../../src/cli/brand.mjs";

/**
 * The command surface the documentation promises and the one the CLI carries
 * must be the same set.
 *
 * Measured 2026-09-13: they were not. `supervise` was in the README's feature
 * paragraph, its quickstart, its command table and in the managed signal block
 * this factory writes into every target repository's `AGENTS.md` — and the CLI
 * had no branch for it. `contract prune` was advertised as the way to continue
 * a partly finished run, and `cli/contract.mjs` carried only `validate`. Both
 * were found by an operator typing them, which is the expensive way.
 *
 * The check is deliberately dumb: names in backticks in the README's command
 * table, against the dispatch branches and option keys of `cli.mjs`. It cannot
 * prove a flag works; it proves nobody can advertise a verb that is not there.
 */

const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
const cliSource = readFileSync(fileURLToPath(new URL("../../src/cli.mjs", import.meta.url)), "utf8");
const contractCliSource = readFileSync(fileURLToPath(new URL("../../src/cli/contract.mjs", import.meta.url)), "utf8");

/** The verbs that take a subcommand, and the module whose operation table declares them. */
const SUBCOMMAND_SOURCES = {
  contract: contractCliSource,
  campaign: readFileSync(fileURLToPath(new URL("../../src/cli/campaign.mjs", import.meta.url)), "utf8"),
  seat: readFileSync(fileURLToPath(new URL("../../src/cli/seat.mjs", import.meta.url)), "utf8"),
};

/** @param {string} source @returns {string[]} */
function declaredOperations(source) {
  const declared = /const OPERATION_OPTIONS = \{([\s\S]*?)\n\};/u.exec(source);
  assert.ok(declared, "operations must still be declared in one table");
  return [...declared[1].matchAll(/^ {2}"?([a-z-]+)"?:/gmu)].map(([, name]) => name);
}

/** Verbs the README's faberun command table names, first word of each code span. */
function documentedCommands() {
  const table = /\| Goal \| Command \|([\s\S]*?)\n\n/u.exec(readme);
  assert.ok(table, "the README must still carry the faberun command table");
  /** @type {Set<string>} */
  const commands = new Set();
  for (const [, span] of table[1].matchAll(/`([^`]+)`/gu)) {
    const words = span.trim().split(/\s+/u);
    const first = words[0];
    if (!/^[a-z][a-z-]*$/u.test(first)) continue;
    // A verb that takes a subcommand is only as real as the subcommand: the
    // README advertised `contract prune` while `contract` itself existed and
    // carried only `validate`, so matching the first word alone saw nothing
    // wrong.
    const second = words[1];
    commands.add(Object.hasOwn(SUBCOMMAND_SOURCES, first) && /^[a-z][a-z-]*$/u.test(second ?? "")
      ? `${first} ${second}`
      : first);
  }
  return commands;
}

/** Verbs `cli.mjs` actually dispatches, plus the subcommands of `contract`. */
function implementedCommands() {
  /** @type {Set<string>} */
  const commands = new Set();
  for (const [, name] of cliSource.matchAll(/command === "([a-z-]+)"/gu)) commands.add(name);
  const options = /const COMMAND_OPTIONS = \{([\s\S]*?)\n\};/u.exec(cliSource);
  assert.ok(options, "COMMAND_OPTIONS must still be the CLI's option table");
  for (const [, name] of options[1].matchAll(/^ {2}"?([a-z-]+)"?:/gmu)) commands.add(name);
  for (const [, name] of cliSource.matchAll(/argv\[0\] === "([a-z-]+)"/gu)) commands.add(name);
  for (const [verb, source] of Object.entries(SUBCOMMAND_SOURCES)) {
    for (const operation of declaredOperations(source)) commands.add(`${verb} ${operation}`);
  }
  return commands;
}

test("every command the README advertises exists in the CLI", () => {
  const implemented = implementedCommands();
  const missing = [...documentedCommands()].filter((command) => !implemented.has(command));
  assert.deepEqual(missing, [], `the README names ${missing.join(", ")}, which the CLI does not dispatch`);
});

test("every command the CLI dispatches appears in its own usage string", () => {
  // The usage text lives in `cli/brand.mjs` as `renderUsage()`, which is what
  // `src/cli.mjs` prints for help and for a usage error. Reading the renderer
  // rather than a copy in the dispatcher is the point of this guard: a copy
  // can advertise a verb the CLI never prints.
  const usage = renderUsage();
  const missing = [...implementedCommands()]
    .filter((command) => !command.includes(" "))
    .filter((command) => !usage.includes(command));
  assert.deepEqual(missing, [], `${missing.join(", ")} is dispatched but absent from the usage string`);
});

test("the contract subcommand table and its usage line agree", () => {
  const operations = declaredOperations(contractCliSource);
  assert.ok(operations.length > 0, "contract must carry at least one operation");
  const usage = /usage: faberun contract ([^\\]*)/u.exec(contractCliSource);
  assert.ok(usage, "contract must print its own usage line");
  for (const operation of operations) {
    assert.ok(usage[1].includes(operation), `contract ${operation} is dispatched but absent from its usage line`);
  }
});
