import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The command surface the manual promises and the one the CLI carries must be
 * the same set, in both directions.
 *
 * Measured 2026-09-13: they were not. `supervise` was in the README's feature
 * paragraph, its quickstart, its command table and in the managed signal block
 * this factory writes into every target repository's `AGENTS.md` — and the CLI
 * had no branch for it. `contract prune` was advertised as the way to continue
 * a partly finished run, and `cli/contract.mjs` carried only `validate`. Both
 * were found by an operator typing them, which is the expensive way.
 *
 * The check is deliberately dumb: option keys and dispatch branches in
 * `src/cli.mjs` and each verb module's `OPERATION_OPTIONS`, against the
 * `## faberun <verb>` and `### faberun <verb> <operation>` headings of
 * `docs/COMMANDS.md`. It cannot prove a flag works; it proves nobody can
 * document a verb or operation that is not there, or carry one that nobody can
 * read about.
 */

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const cliSource = read("../../src/cli.mjs");
const manual = read("../../docs/COMMANDS.md");

/**
 * Verbs whose operations live in their own module, and the source that declares
 * them. `supervise campaign` has no module of its own: `cli.mjs` routes it into
 * the campaign table, so it is added to the surface by name.
 */
const OPERATION_SOURCES = {
  campaign: read("../../src/cli/campaign.mjs"),
  seat: read("../../src/cli/seat.mjs"),
  contract: read("../../src/cli/contract.mjs"),
  skills: read("../../src/cli/skills.mjs"),
  spec: read("../../src/cli/spec.mjs"),
};

/**
 * The double-quoted keys of one option table, in declaration order. Anchored on
 * exactly two leading spaces so a nested per-flag entry is never mistaken for
 * an operation or a verb.
 *
 * @param {string} source
 * @returns {string[]}
 */
function optionKeys(source) {
  const table = /const (?:COMMAND|OPERATION)_OPTIONS = \{([\s\S]*?)\n\};/u.exec(source);
  assert.ok(table, "option tables must stay declared in one literal");
  return [...table[1].matchAll(/^ {2}"?([a-z-]+)"?:/gmu)].map(([, name]) => name);
}

/**
 * The verbs and operations the CLI dispatches: `COMMAND_OPTIONS` keys, the four
 * verbs dispatched before that table, every `OPERATION_OPTIONS` key of each of
 * those verb modules, and `supervise campaign`.
 *
 * @returns {{verbs: Set<string>, operations: Set<string>}}
 */
function cliSurface() {
  const verbs = new Set(optionKeys(cliSource));
  for (const verb of ["campaign", "seat", "contract", "skills", "spec"]) verbs.add(verb);
  const operations = new Set();
  for (const [verb, source] of Object.entries(OPERATION_SOURCES)) {
    for (const operation of optionKeys(source)) operations.add(`${verb} ${operation}`);
  }
  operations.add("supervise campaign");
  return { verbs, operations };
}

/**
 * The verbs and operations `docs/COMMANDS.md` names. A `##` heading is a verb;
 * a `###` heading is a verb followed by one operation.
 *
 * @returns {{verbs: Set<string>, operations: Set<string>}}
 */
function documentedSurface() {
  const verbs = new Set();
  const operations = new Set();
  for (const [, verb] of manual.matchAll(/^## faberun ([a-z][a-z-]*)$/gmu)) verbs.add(verb);
  for (const [, verb, operation] of manual.matchAll(/^### faberun ([a-z][a-z-]*) ([a-z][a-z-]*)$/gmu)) {
    operations.add(`${verb} ${operation}`);
  }
  return { verbs, operations };
}

/** @param {Set<string>} left @param {Set<string>} right @returns {string[]} */
const difference = (left, right) => [...left].filter((name) => !right.has(name)).sort();

test("every CLI verb and operation has a manual heading", () => {
  const cli = cliSurface();
  const documented = documentedSurface();
  assert.deepEqual(
    difference(cli.verbs, documented.verbs),
    [],
    `the CLI dispatches ${difference(cli.verbs, documented.verbs).join(", ")}, which docs/COMMANDS.md does not name`,
  );
  assert.deepEqual(
    difference(cli.operations, documented.operations),
    [],
    `the CLI dispatches ${difference(cli.operations, documented.operations).join(", ")}, which docs/COMMANDS.md does not name`,
  );
});

test("every manual heading names a real CLI verb or operation", () => {
  const cli = cliSurface();
  const documented = documentedSurface();
  assert.deepEqual(
    difference(documented.verbs, cli.verbs),
    [],
    `docs/COMMANDS.md names ${difference(documented.verbs, cli.verbs).join(", ")}, which the CLI does not dispatch`,
  );
  assert.deepEqual(
    difference(documented.operations, cli.operations),
    [],
    `docs/COMMANDS.md names ${difference(documented.operations, cli.operations).join(", ")}, which the CLI does not dispatch`,
  );
});
