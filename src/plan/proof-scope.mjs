/**
 * Proof and scope coherence decided when a plan freezes, before any worker
 * attempt is spent on a node that cannot pass: a name-filtered node:test proof
 * must name the file its test lives in (AP1 of safe-to-hand-to-a-friend), and
 * a node that creates a file in a directory a test enumerates by name must be
 * allowed to edit that test (AP2). Separate from `freeze.mjs` because both
 * read the target repository's test sources, which the freeze's contract and
 * timeout checks never do, and from `proof-check.mjs` because that stage only
 * raises findings for a review round, while these run on the frozen shape.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shellWords } from "../util.mjs";

/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

/** `node` options whose value is the next argument, so it is not a path. */
export const NODE_VALUE_OPTIONS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout"]);

const NAME_FILTER_FLAGS = ["--test-name-pattern", "--test-skip-pattern"];

/** A test title in a `test(…)`/`it(…)`/`describe(…)` call, any of the three JS quotes. */
const TEST_TITLE = /\b(?:test|it|describe)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gu;

/**
 * The name filters and path arguments of a `node --test` command, or null
 * when the command is not one.
 *
 * @param {string[]} argv
 * @returns {{nameFilters: Array<{flag: string, value: string}>, paths: string[]}|null}
 */
export function nodeTestShape(argv) {
  if (argv[0] !== "node" || !argv.includes("--test")) return null;
  /** @type {Array<{flag: string, value: string}>} */
  const nameFilters = [];
  /** @type {string[]} */
  const paths = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const inline = NAME_FILTER_FLAGS.find((flag) => token.startsWith(`${flag}=`));
    if (inline) nameFilters.push({ flag: inline, value: token.slice(inline.length + 1) });
    else if (NAME_FILTER_FLAGS.includes(token)) nameFilters.push({ flag: token, value: argv[index + 1] ?? "" });
    if (NODE_VALUE_OPTIONS.has(token)) index += 1;
    else if (!token.startsWith("-")) paths.push(token);
  }
  return { nameFilters, paths };
}

/**
 * Refuse a contract with a name-filtered `node --test` proof that cannot
 * select the test it names. Checked on every Definition of Done command proof
 * and every packet verification command. Measured 2026-09-26 on node v26.8.1:
 * with no path, `node --test` runs every test file in the tree, and every
 * file the filter selects nothing in prints its own zero plan, so a proof
 * with no file both costs the whole suite and reads as having measured
 * nothing. A named file that some node writes is accepted as the test to be
 * written; a named file nobody writes must already hold a test the pattern
 * selects.
 *
 * @param {ValidatedContract} contract
 * @returns {void}
 */
export function assertFilteredProofsNameTheirTest(contract) {
  const written = new Set(contract.nodes.flatMap((node) => node.taskPacket.writeFiles));
  /** @type {string[]} */
  const problems = [];
  for (const node of contract.nodes) {
    const commands = [
      ...(node.definitionOfDone ?? []).flatMap((item) => (item.proof?.kind === "command" ? [{ argv: shellWords(item.proof.ref), cwd: contract.cwd }] : [])),
      ...(node.taskPacket.verification ?? []).map((command) => ({ argv: command.argv, cwd: resolve(contract.cwd, command.cwd ?? ".") })),
    ];
    for (const { argv, cwd } of commands) {
      const shape = nodeTestShape(argv);
      if (!shape || shape.nameFilters.length === 0) continue;
      const shown = argv.join(" ");
      if (shape.paths.length === 0) {
        problems.push(`${node.id}: "${shown}" filters node:test by name but names no test file; with no path node --test runs every test file in the tree and each file the filter selects nothing in prints a zero plan. Name the file that holds the test, as in node --test --test-name-pattern="<title>" test/<file>.test.mjs`);
        continue;
      }
      const namePattern = shape.nameFilters.find(({ flag }) => flag === "--test-name-pattern")?.value;
      if (namePattern === undefined) continue;
      for (const path of shape.paths) {
        const absolute = resolve(cwd, path);
        if (written.has(path) || !existsSync(absolute) || !statSync(absolute).isFile()) continue;
        if (!fileHasMatchingTest(absolute, namePattern)) {
          problems.push(`${node.id}: "${shown}" selects no test in ${path}: no test title there matches --test-name-pattern "${namePattern}", and no node writes ${path}`);
        }
      }
    }
  }
  if (problems.length) throw new TypeError(`name-filtered proofs cannot select their test: ${problems.join("; ")}`);
}

/**
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
function fileHasMatchingTest(path, pattern) {
  /** @type {RegExp} */
  let regex;
  try {
    regex = new RegExp(pattern, "u");
  } catch {
    // node --test would reject the pattern too; nothing it names can match.
    return false;
  }
  return [...readFileSync(path, "utf8").matchAll(TEST_TITLE)].some((match) => regex.test(match[2]));
}

/**
 * Declare, in the writeFiles of every node that creates a file in a
 * directory, each test that enumerates that directory by name — a test whose
 * source names the directory and every entry it holds today. Such a test
 * cannot pass once the directory gains an entry unless it is edited too, and
 * the gate refuses an edit to a file a proof cites that the node did not
 * declare. Measured 2026-09-26 (AP2 of safe-to-hand-to-a-friend): the node
 * adding skills/faberun/references/local-env.md failed on
 * test/docs/docs-diet.test.mjs, which lists references/ exactly. The repair
 * has one answer, so it is applied rather than raised; each one is returned
 * with its reason so the caller can print it. A directory with fewer than two
 * entries is skipped: naming one file is not evidence of an exact listing.
 *
 * @param {PlanOutput} plan
 * @param {{testFiles: Array<{path: string}>}} repoFacts
 * @param {string} cwd
 * @returns {{plan: PlanOutput, declared: string[]}}
 */
export function declareDirectoryGuards(plan, repoFacts, cwd) {
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @param {string} path @returns {string} */
  const sourceOf = (path) => {
    if (!sources.has(path)) {
      /** @type {string} */
      let text = "";
      try {
        text = readFileSync(join(cwd, path), "utf8");
      } catch {
        // A listed test file that is gone enumerates nothing.
      }
      sources.set(path, text);
    }
    return /** @type {string} */ (sources.get(path));
  };
  /** @type {string[]} */
  const declared = [];
  const nodes = plan.nodes.map((node) => {
    const added = new Set();
    for (const path of node.writeFiles) {
      if (existsSync(join(cwd, path))) continue;
      const directory = dirname(path);
      if (directory === "." || !existsSync(join(cwd, directory))) continue;
      const entries = readdirSync(join(cwd, directory));
      if (entries.length < 2) continue;
      for (const { path: testPath } of repoFacts.testFiles) {
        if (node.writeFiles.includes(testPath) || added.has(testPath)) continue;
        const source = sourceOf(testPath);
        if (!source.includes(directory) && !source.includes(directory.slice(directory.lastIndexOf("/") + 1) + "/")) continue;
        if (!entries.every((entry) => source.includes(`'${entry}'`) || source.includes(`"${entry}"`) || source.includes(`\`${entry}\``))) continue;
        added.add(testPath);
        declared.push(`${node.id}: declared ${testPath} in writeFiles: it lists every entry of ${directory}/ by name, and this node creates ${path} there`);
      }
    }
    if (added.size === 0) return node;
    return {
      ...node,
      readFiles: node.readFiles.filter((path) => !added.has(path)),
      scopeAcknowledged: node.scopeAcknowledged.filter((path) => !added.has(path)),
      writeFiles: [...node.writeFiles, ...added],
    };
  });
  return { plan: declared.length ? { ...plan, nodes } : plan, declared };
}
