import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeImportGraph } from "../../src/repo/scope-closure.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

/**
 * The rules `AGENTS.md` states about the shape of this source tree, enforced.
 *
 * Every one of these was a real defect first: a 3,888-line file doing nine jobs,
 * two modules importing each other through the CLI, `errorCode` defined eight
 * times in five behaviours, and a barrel that gave every symbol two homes. The
 * point of the file is that none of them can come back quietly.
 *
 * The tree is read once, at module scope, and every gate reads that snapshot.
 */

const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(REPO_DIR, "src");

/** Directories the repository-wide walk must never descend into. */
const SKIPPED = new Set([".git", RUNS_DIR_NAME, "node_modules"]);

/** No file in this repository may exceed this. A longer file is doing a second job. */
const LINE_CEILING = 800;

/**
 * Runtime import cycles allowed by name. Empty, and it stays empty: the entry
 * that used to be here (`engine/lifecycle.mjs` <-> `engine/review.mjs`) was
 * settlement living in `lifecycle.mjs` while `review.mjs` called it, and it is
 * gone now that `engine/settle.mjs` owns `settleDone` and the rejection paths.
 *
 * @type {string[][]}
 */
const ALLOWED_CYCLES = [];

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of every `.mjs` file below `dir`
 */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) found.push(...walk(path));
    } else if (entry.isFile() && path.endsWith(".mjs")) found.push(path);
  }
  return found;
}

/** Every `.mjs` in the repository, read once. `src/` is a subset of it. */
const FILES = walk(REPO_DIR).map((path) => ({
  path,
  label: relative(REPO_DIR, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const SRC_FILES = FILES.filter((file) => file.path.startsWith(SRC_DIR + sep));
const TEST_FILES = FILES.filter((file) => file.path.startsWith(join(REPO_DIR, "test") + sep));
const EVALS_FILES = FILES.filter((file) => file.path.startsWith(join(REPO_DIR, "evals") + sep));

test(`no file in the repository exceeds ${LINE_CEILING} lines`, () => {
  const oversized = FILES
    .map((file) => ({ path: file.label, lines: file.text.split("\n").length }))
    .filter((file) => file.lines > LINE_CEILING)
    .sort((left, right) => right.lines - left.lines);
  assert.deepEqual(
    oversized,
    [],
    `over the ${LINE_CEILING}-line ceiling:\n${oversized.map((f) => `  ${f.lines}  ${f.path}`).join("\n")}\n` +
      "Find the second job the file is doing and give it a module. Do not raise the ceiling.",
  );
});

test("no file in the repository contains a NUL byte", () => {
  // measured 2026-09-20: src/util.mjs carried one since 2026-09-11, a control
  // byte typed literally inside excerpt()'s regex class. `file` called the
  // module `data`, grep skipped it as binary, and an agent's Read tool refused
  // it -- a central module unreadable to every tool but node itself.
  const binary = FILES.filter((file) => file.text.includes("\u0000")).map((file) => file.label);
  assert.deepEqual(binary, [], `NUL byte in:\n${binary.map((label) => `  ${label}`).join("\n")}\nWrite control characters as escapes.`);
});

test("src/ has no runtime import cycle beyond the ones allowed by name", () => {
  const graph = runtimeImportGraph(SRC_DIR);
  /** @type {Set<string>} */
  const cycles = new Set();
  // Two-colour DFS over one shared colouring: grey is "on the current path", so
  // reaching a grey node is a cycle and reaching a black one is already done.
  /** @type {Map<string, "grey"|"black">} */
  const colour = new Map();
  /** @param {string} node @param {string[]} path */
  const visit = (node, path) => {
    colour.set(node, "grey");
    for (const next of graph.get(node) ?? []) {
      if (colour.get(next) === "grey") cycles.add(path.slice(path.indexOf(next)).sort().join(" <-> "));
      else if (!colour.has(next)) visit(next, [...path, next]);
    }
    colour.set(node, "black");
  };
  for (const node of graph.keys()) if (!colour.has(node)) visit(node, [node]);

  const allowed = new Set(ALLOWED_CYCLES.map((members) => [...members].sort().join(" <-> ")));
  assert.deepEqual(
    [...cycles].filter((cycle) => !allowed.has(cycle)).sort(),
    [],
    "new runtime import cycle in src/. The shared thing usually wants to be a third module.",
  );
  assert.deepEqual(
    [...allowed].filter((cycle) => !cycles.has(cycle)),
    [],
    "ALLOWED_CYCLES names a cycle that no longer exists -- delete the entry, the list only shrinks.",
  );
});

/**
 * Every top-level definition in `src/`: its module, its name, whether it is
 * exported, and its body normalized for comparison.
 *
 * A definition ends at the next line that closes at column 0. That is this
 * codebase's formatting invariant and it is the reason this does not count
 * brackets: a `{` inside a regex character class (`/^[\[{]/u` in
 * `harnesses/protocol.mjs`) made a bracket-counting version record a 7-line
 * function as spanning 453, hiding everything after it from these gates.
 *
 * @returns {{module: string, name: string, exported: boolean, body: string}[]}
 */
function srcDefinitions() {
  const found = [];
  for (const file of SRC_FILES) {
    const module = relative(SRC_DIR, file.path).split(sep).join("/");
    const lines = file.text.split("\n");
    for (const [index, line] of lines.entries()) {
      const match = /^(export\s+)?(?:async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (!match) continue;
      let end = index;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        end = scan;
        if (/^[}\])]/u.test(lines[scan])) break;
        if (/^\S/u.test(lines[scan])) { end = scan - 1; break; }
      }
      if (/;\s*$/u.test(line) && !/[{[(]\s*$/u.test(line)) end = index;
      found.push({
        module,
        name: match[2],
        exported: Boolean(match[1]),
        // the declaration line has its name stripped: a copy that was renamed
        // is still a copy, and that is how `compactCost` survived in `cli.mjs`
        // as `formatCost` through a name-keyed version of this check
        body: lines.slice(index, end + 1)
          .map((text) => text.trim())
          .join("\n")
          .replace(/^export /u, "")
          .replace(/^((?:async )?(?:function|class|const|let) )[A-Za-z_$][\w$]*/u, "$1"),
      });
    }
  }
  return found;
}

const DEFINITIONS = srcDefinitions();

test("no top-level body is defined twice in src/", () => {
  // Keyed on the body, never on the name. Keying on the name first is how a
  // byte-identical copy of `compactCost` survived in `cli.mjs` under the name
  // `formatCost`: the eight `errorCode` copies were only caught because they
  // happened to share a name.
  /** @type {Map<string, {name: string, module: string}[]>} */
  const byBody = new Map();
  for (const definition of DEFINITIONS) {
    // one-liners and trivial bodies collide by accident, not by duplication
    if (definition.body.split("\n").length < 3) continue;
    byBody.set(definition.body, [...(byBody.get(definition.body) ?? []), definition]);
  }
  const duplicated = [];
  for (const entries of byBody.values()) {
    const modules = [...new Set(entries.map((entry) => entry.module))];
    if (modules.length < 2) continue;
    const names = [...new Set(entries.map((entry) => entry.name))];
    duplicated.push(`${names.join("/")}: ${modules.sort().join(", ")}`);
  }
  assert.deepEqual(
    duplicated.sort(),
    [],
    `the same body in two modules:\n${duplicated.map((line) => `  ${line}`).join("\n")}\n` +
      "Give it one home and import it.",
  );
});

test("no name is exported from two src/ modules", () => {
  // A module-private helper may share a name -- a standalone spawned program
  // with its own `fail` or `usage` is idiomatic and nobody can import it by
  // mistake. Two *exported* ones is the hazard: this tree had two `stableJson`s
  // (a comparator and a pretty-printer) and two `requireText`s, one of which
  // read a file.
  //
  // `harness` is exempt and is the interface, not a collision: every adapter
  // under `harnesses/*/` exports it, which is what makes the registry uniform.
  const exempt = new Set(["harness", "driver", "default"]);
  /** @type {Map<string, Set<string>>} */
  const homes = new Map();
  for (const definition of DEFINITIONS) {
    if (!definition.exported || exempt.has(definition.name)) continue;
    homes.set(definition.name, (homes.get(definition.name) ?? new Set()).add(definition.module));
  }
  const collisions = [...homes.entries()]
    .filter(([, modules]) => modules.size > 1)
    .map(([name, modules]) => `${name}: ${[...modules].sort().join(", ")}`)
    .sort();
  assert.deepEqual(
    collisions,
    [],
    `one name exported from two modules:\n${collisions.map((line) => `  ${line}`).join("\n")}\n` +
      "Either they are the same function (give it one home) or they are not (rename one for what it does).",
  );
});

test("no src/ module is a barrel", () => {
  // A module that re-exports and defines nothing of its own gives every symbol
  // it forwards a second home.
  const barrels = SRC_FILES
    .filter((file) => /^export\s*\{[^}]*\}\s*from\s*"/mu.test(file.text))
    .filter((file) => !/^export\s+(?:async\s+function|function|const|let|class)\s/mu.test(file.text))
    .map((file) => file.label);
  assert.deepEqual(barrels, [], `barrel module(s): ${barrels.join(", ")}`);
});

/**
 * R1's centralization ratchet, completed (state-location-and-routing-economics,
 * phase 1g): one file per tree is allowed to spell the runs directory literal,
 * everything else calls the resolver. "Spelled" here means the exact
 * double-quoted token, the same measurement every run-path-resolver migration
 * node used to find and rewrite its call sites; a mention inside a longer
 * string, a regex, a template literal or a comment (a human-facing message, a
 * doc comment, a gitignore-parsing pattern) is not what those nodes migrated
 * and is not what any of the three tests below hold.
 *
 * `src/` already held this shape at zero exceptions beyond its resolver,
 * `src/run/paths.mjs`. `test/` cannot hold the same shape honestly: four
 * files beyond its own resolver test still spell the literal, each for a
 * reason measured 2026-09-18, and hiding that behind a single number (a
 * ceiling) is what this phase's four migration nodes leave behind and this
 * node replaces. Each is named below instead, with its reason, in
 * `TEST_RUNS_LITERAL_ALLOWED` -- the same shape `SYNC_GIT_EXEMPTIONS` already
 * uses for named call sites rather than whole files. A file appears there for
 * one of three reasons, and no fourth kind has been found in this tree:
 *
 * - `test/run/paths.test.mjs` (11): the resolver's own test. It pins what
 *   `src/run/paths.mjs` produces, so it cannot call that resolver to build
 *   its own expectation -- that would only assert the function equals itself.
 * - `test/contract/verification.test.mjs` (1): a skip-path or directory-name
 *   list -- a name being iterated or excluded, never a path some code joined
 *   together. (`test/repo/brand.test.mjs` held this exception too, for its
 *   `SKIPPED_NAMES` list, until it moved to `git ls-files` and stopped
 *   spelling the literal at all -- the entry was deleted rather than lowered,
 *   per the drift rule below.)
 * - `test/cli/init.test.mjs` (1): the text of a `.gitignore` line, matched to
 *   confirm the runs directory is ignored -- text comparison, not a path
 *   composition.
 * - `test/harnesses/replay-run.test.mjs` (3) and `test/repo/integration.test.mjs`
 *   (2): the attempt-local result sidecar every real worker writes inside the
 *   attempt worktree. R3 requires this sidecar to stay exactly where the
 *   protocol puts it, so these call sites build that path by hand on purpose
 *   rather than through a resolver that would otherwise be free to move it.
 *
 * `evals/` never had a legitimate reason to spell it and now spells it
 * nowhere, so it asserts the empty list outright, with no allowlist at all.
 *
 * What none of this covers: `integrations/claude-code/statusline.sh` composes
 * its pointer path (`"$repo/.runs/status.json"`) by hand, in shell, to read
 * the same pointer this tree's `.mjs` resolver writes. This walker only reads
 * `.mjs` files (see `walk` above), so that script's own literal is outside
 * every one of these three tests' reach -- a future reader should not
 * mistake "the tree holds this invariant" for "every file that could spell
 * the runs directory does".
 */
const RUNS_LITERAL = new RegExp(`"${RUNS_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "gu");
const RESOLVER_MODULE = "src/run/paths.mjs";

test("only src/run/paths.mjs spells the runs directory literal in src/", () => {
  const offenders = SRC_FILES
    .filter((file) => file.label !== RESOLVER_MODULE)
    .map((file) => ({ label: file.label, count: [...file.text.matchAll(RUNS_LITERAL)].length }))
    .filter((file) => file.count > 0)
    .sort((left, right) => right.count - left.count);
  assert.deepEqual(
    offenders,
    [],
    `spells the runs directory literal directly instead of calling the resolver:\n${offenders.map((f) => `  ${f.count}  ${f.label}`).join("\n")}\n` +
      `Call ${RESOLVER_MODULE}'s resolver (runsRoot, runDirectory, campaignsRoot, campaignTree, or its RUNS_DIR_NAME export) instead of spelling it.`,
  );
});

/** `test/`'s own resolver test: excluded from the allowlist below the same way `RESOLVER_MODULE` is excluded from the `src/` check above, with no count pinned on it either. */
const TEST_RESOLVER_TEST_MODULE = "test/run/paths.test.mjs";

/**
 * Every other `test/` file with a standing reason to spell the runs
 * directory literal, named and counted so drift in either direction is
 * caught: a new, unnamed spelling anywhere fails the offender check below,
 * and a named count that no longer matches what the file measures -- because
 * it fell (partial migration) or rose (a second, unnamed spelling joined the
 * first) -- fails the drift check. Measured 2026-09-18.
 *
 * @type {{file: string, count: number, reason: string}[]}
 */
const TEST_RUNS_LITERAL_ALLOWED = [
  { file: "test/contract/verification.test.mjs", count: 1, reason: "a fabricated runtime-debris directory-name list, not a path composition" },
  { file: "test/harnesses/replay-run.test.mjs", count: 3, reason: "the attempt-local result sidecar R3 keeps inside the attempt worktree; it must not migrate with the rest" },
  { file: "test/cli/init.test.mjs", count: 1, reason: "matches the text of a .gitignore line, not a filesystem path" },
  { file: "test/repo/integration.test.mjs", count: 2, reason: "the attempt-local result sidecar again, in a fixture where `repo` stands in for the attempt worktree" },
];

test("only test/run/paths.test.mjs and a named, reasoned allowlist spell the runs directory literal in test/", () => {
  const counts = new Map(TEST_FILES.map((file) => [file.label, [...file.text.matchAll(RUNS_LITERAL)].length]));
  const allowed = new Map(TEST_RUNS_LITERAL_ALLOWED.map((entry) => [entry.file, entry]));
  const offenders = [...counts.entries()]
    .filter(([label, count]) => label !== TEST_RESOLVER_TEST_MODULE && count > 0 && !allowed.has(label))
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count);
  assert.deepEqual(
    offenders,
    [],
    `spells the runs directory literal with no named reason:\n${offenders.map((f) => `  ${f.count}  ${f.label}`).join("\n")}\n` +
      "Call src/run/paths.mjs's resolver instead of spelling it, or add a named, reasoned entry to TEST_RUNS_LITERAL_ALLOWED.",
  );
  const drifted = TEST_RUNS_LITERAL_ALLOWED
    .map((entry) => ({ ...entry, measured: counts.get(entry.file) ?? 0 }))
    .filter((entry) => entry.measured !== entry.count);
  assert.deepEqual(
    drifted.map((entry) => `${entry.file}: allowed ${entry.count}, measured ${entry.measured}`),
    [],
    "an allowlist entry's count no longer matches the file -- measure it again; if it fell to 0 the reason is gone, so migrate the call site and delete the entry instead of lowering it",
  );
});

test("evals/ never spells the runs directory literal", () => {
  const offenders = EVALS_FILES
    .map((file) => ({ label: file.label, count: [...file.text.matchAll(RUNS_LITERAL)].length }))
    .filter((file) => file.count > 0)
    .sort((left, right) => right.count - left.count);
  assert.deepEqual(
    offenders,
    [],
    `spells the runs directory literal in evals/:\n${offenders.map((f) => `  ${f.count}  ${f.label}`).join("\n")}\n` +
      "Call src/run/paths.mjs's resolver instead of spelling it.",
  );
});

/**
 * Empty `catch {}` blocks in `src/`, as measured. The target is zero; this is a
 * ratchet on the way there, and it is `<=` so the number only falls.
 *
 * It moved here from `test/ci-policy.test.mjs`, which walked this same tree
 * with a second copy of the walker and carried a ceiling of 32 against an
 * actual count of 28 -- four free slots for new ones.
 */
const EMPTY_CATCH_CEILING = 0;

test(`empty catch blocks in src/ never exceed ${EMPTY_CATCH_CEILING}`, () => {
  const offenders = SRC_FILES
    .map((file) => ({ label: file.label, count: (file.text.match(/catch\s*\{\s*\}/gu) ?? []).length }))
    .filter((file) => file.count > 0)
    .sort((left, right) => right.count - left.count);
  const total = offenders.reduce((sum, file) => sum + file.count, 0);
  assert.ok(
    total <= EMPTY_CATCH_CEILING,
    `${total} empty catch block(s), ceiling ${EMPTY_CATCH_CEILING}:\n` +
      offenders.map((f) => `  ${f.count}  ${f.label}`).join("\n"),
  );
  assert.equal(
    total,
    EMPTY_CATCH_CEILING,
    `the count fell to ${total}; lower EMPTY_CATCH_CEILING to match so it cannot drift back up.`,
  );
});

/**
 * Every synchronous git spawn under `src/` must go through `boundedGitSync`,
 * the one wrapper that supplies a timeout (phase 5a). A raw `execFileSync` or
 * `spawnSync` of git can block forever on a held `.git/index.lock`, and that
 * wait is on the controller's critical path.
 *
 * The exemptions below are named call sites, not whole files: a new unbounded
 * git call anywhere, including inside an exempt file, changes the matched set
 * and fails the test. Most are read-only probes that cannot take `index.lock`;
 * `campaign/chain.mjs` and the throwaway-repo `git init` are outside this
 * packet's write scope, and they are named here so the gap is visible rather
 * than silent.
 */
const SYNC_GIT_SPAWN = /(?:execFileSync|spawnSync)\s*\(\s*["'`]git/u;

/** @type {{file: string, match: string, reason: string}[]} */
const SYNC_GIT_EXEMPTIONS = [
  { file: "src/repo/worktree.mjs", match: "spawnSync(\"git\", gitArguments(args), {", reason: "the boundedGitSync wrapper itself" },
  { file: "src/repo/workspace.mjs", match: "\"rev-parse\", \"--git-path\"", reason: "read-only path probe; cannot take index.lock" },
  { file: "src/repo/workspace.mjs", match: "execFileSync(\"git\", gitArguments(args), {", reason: "read-only ls-files index read; cannot take index.lock" },
  { file: "src/repo/declared-paths.mjs", match: "\"ls-files\", \"--cached\", \"--error-unmatch\"", reason: "read-only index probe" },
  { file: "src/repo/declared-paths.mjs", match: "execFileSync(\"git\", gitArguments(args), { encoding: \"buffer\"", reason: "read-only ls-files index read" },
  { file: "src/repo/declared-paths.mjs", match: "[\"init\", \"-q\", temporaryWorktree]", reason: "throwaway temp repo, never the run's index" },
  { file: "src/repo/declared-paths.mjs", match: "execFileSync(\"git\", gitArguments(args), { stdio: [\"ignore\", \"ignore\", \"ignore\"] });", reason: "read-only check-ignore probes" },
  { file: "src/repo/declared-paths.mjs", match: "args.toSpliced(-3, 1, \"--quiet\")", reason: "read-only check-ignore probe" },
  { file: "src/campaign/chain.mjs", match: "\"rev-parse\", ref", reason: "read-only ref probe" },
  { file: "src/campaign/chain.mjs", match: "\"worktree\", \"add\", \"--detach\"", reason: "outside this packet's write scope" },
  { file: "src/campaign/chain.mjs", match: "\"worktree\", \"remove\", \"--force\", worktree", reason: "outside this packet's write scope" },
];

test("every synchronous git spawn in src/ is bounded or a named exemption", () => {
  const calls = SRC_FILES.flatMap((file) => file.text.split("\n").flatMap((line, index) => {
    const text = line.trim();
    if (text.startsWith("*") || text.startsWith("//")) return [];
    return SYNC_GIT_SPAWN.test(text) ? [{ file: file.label, line: index + 1, text }] : [];
  }));
  const exempt = (/** @type {{file: string, text: string}} */ call) =>
    SYNC_GIT_EXEMPTIONS.some((entry) => entry.file === call.file && call.text.includes(entry.match));
  const unbounded = calls.filter((call) => !exempt(call));
  assert.deepEqual(
    unbounded.map((call) => `${call.file}:${call.line}  ${call.text}`),
    [],
    "route every synchronous git spawn through boundedGitSync, or name the call site as an exemption with its reason",
  );
  const stale = SYNC_GIT_EXEMPTIONS.filter((entry) => !calls.some((call) => call.file === entry.file && call.text.includes(entry.match)));
  assert.deepEqual(
    stale.map((entry) => `${entry.file}  ${entry.match}  (${entry.reason})`),
    [],
    "an exemption names a git call that no longer exists -- delete it so it cannot cover a future one",
  );
});

/**
 * Modules with no leading block comment, ratcheted down. `AGENTS.md` asks a
 * header to say what the module owns and *why it is separate* -- the reader can
 * see what the functions do. 30 of 84 predate the rule; the number only falls.
 */
const HEADERLESS_CEILING = 30;

test(`src/ modules without a header never exceed ${HEADERLESS_CEILING}`, () => {
  const headerless = SRC_FILES.filter((file) => !file.text.startsWith("/**")).map((file) => file.label);
  assert.ok(
    headerless.length <= HEADERLESS_CEILING,
    `${headerless.length} module(s) with no header, ceiling ${HEADERLESS_CEILING}:\n` +
      headerless.map((label) => `  ${label}`).join("\n"),
  );
  assert.equal(
    headerless.length,
    HEADERLESS_CEILING,
    `the count fell to ${headerless.length}; lower HEADERLESS_CEILING to match so it cannot drift back up.`,
  );
});

/**
 * Wall-clock tolerance in tests, the class that only fails on someone else's
 * machine. Two shapes, and they are not equally dangerous.
 *
 * An *upper* bound on a measured duration -- `assert.ok(elapsed < 500)` -- is
 * a claim about how fast the machine is, and a loaded laptop or a cold CI box
 * falsifies it. This repo has had that bug (heartbeat tolerance) and has none
 * of it now, so the count is asserted at zero with equality: the first one to
 * come back fails here rather than in someone's CI.
 *
 * A *blocking wait* is weaker: `await new Promise(r => setTimeout(r, 1100))`
 * is correct on any machine, it just costs 1.1s of suite every run. It is
 * ratcheted, not banned -- `run/lock.test.mjs` waits out a real lock TTL, and
 * there is no honest way to prove expiry without letting time pass.
 *
 * A lower bound (`assert.ok(elapsed >= 180)`) is deliberately not counted: it
 * proves a delay happened, and a slower machine only makes it more true.
 *
 * Comment lines are skipped, which this file learned the hard way: the first
 * run of this gate failed on the example two paragraphs above.
 */
const WALL_CLOCK_UPPER_BOUND = /assert\b[^\n]*?(?:elapsed|duration|took|Date\.now\(\)\s*-|performance\.now\(\)\s*-)[^\n]*?<=?\s*\d{2,}/iu;
const BLOCKING_WAIT = /(?:setTimeout\(\s*(?:resolve|res)\b[^,\n]*,\s*|await\s+(?:delay|sleep)\(\s*)(\d{4,})\b/gu;
const BLOCKING_WAIT_CEILING = 1;

test("no test bounds a measured duration from above", () => {
  const offenders = TEST_FILES.flatMap((file) =>
    file.text.split("\n")
      .map((line, index) => ({ label: file.label, line: index + 1, text: line.trim() }))
      .filter((line) => !line.text.startsWith("*") && !line.text.startsWith("//") && WALL_CLOCK_UPPER_BOUND.test(line.text)),
  );
  assert.deepEqual(
    offenders.map((o) => `${o.label}:${o.line}  ${o.text}`),
    [],
    "an upper bound on a measured duration asserts how fast this machine is, not what the code does",
  );
});

/**
 * The third shape, and the one that actually shipped a flake. A deadline
 * computed as `Date.now() + N` at the top of a test, then raced against work
 * the test goes on to do, is a bet that the machine finishes that work inside
 * N. `replay.test.mjs` bet 3s against a worker process spawn; alone it won,
 * under the full parallel suite it lost, and the run took the failover branch
 * instead of the reset branch it was asserting.
 *
 * It is not caught by the two gates above: there is no upper bound in an
 * assertion and no blocking wait. The honest fix is to start the window where
 * the work ends -- the replay binary now resolves `resetAt: "+3000"` when it
 * emits -- and the ratchet keeps the remaining three from growing.
 */
const FUTURE_DEADLINE = /Date\.now\(\)\s*\+\s*([0-9_]+)/gu;
const FUTURE_DEADLINE_MS = 60_000;
const FUTURE_DEADLINE_CEILING = 3;

test(`tests racing a deadline under ${FUTURE_DEADLINE_MS}ms never exceed ${FUTURE_DEADLINE_CEILING}`, () => {
  const raced = TEST_FILES.flatMap((file) =>
    file.text.split("\n").flatMap((line, index) => {
      const text = line.trim();
      if (text.startsWith("*") || text.startsWith("//")) return [];
      return [...text.matchAll(FUTURE_DEADLINE)]
        .filter((match) => Number(match[1].replaceAll("_", "")) < FUTURE_DEADLINE_MS)
        .map((match) => `${file.label}:${index + 1}  ${match[0]}`);
    }),
  );
  assert.ok(
    raced.length <= FUTURE_DEADLINE_CEILING,
    `${raced.length} test deadline(s) under ${FUTURE_DEADLINE_MS}ms, ceiling ${FUTURE_DEADLINE_CEILING}:\n` +
      raced.map((entry) => `  ${entry}`).join("\n"),
  );
  assert.equal(
    raced.length,
    FUTURE_DEADLINE_CEILING,
    `the count fell to ${raced.length}; lower FUTURE_DEADLINE_CEILING to match so it cannot drift back up.`,
  );
});

test(`tests blocking on wall-clock time never exceed ${BLOCKING_WAIT_CEILING}`, () => {
  const waits = TEST_FILES.flatMap((file) =>
    [...file.text.matchAll(BLOCKING_WAIT)].map((match) => `${file.label}  ${match[0]}`),
  );
  assert.ok(
    waits.length <= BLOCKING_WAIT_CEILING,
    `${waits.length} blocking wait(s) of 1s or more, ceiling ${BLOCKING_WAIT_CEILING}:\n` +
      waits.map((wait) => `  ${wait}`).join("\n"),
  );
  assert.equal(
    waits.length,
    BLOCKING_WAIT_CEILING,
    `the count fell to ${waits.length}; lower BLOCKING_WAIT_CEILING to match so it cannot drift back up.`,
  );
});

/**
 * A sub-second `timeoutSec` or `stallTimeoutSec` is a bet that a provider
 * spawn fits inside it. `done-when 1 and 4` (0.7s wall clock, 0.4s stall)
 * lost that bet under parallel load on the owner's macOS (RM-056), because the healthy retry has to fit inside the same budget the
 * hung attempt exhausts. A budget under one second is allowed only in a test
 * named here, and the reason says why nothing healthy has to fit inside it.
 * A leading literal counts, so `0.7 * SPAWN_WAIT_FACTOR` is 0.7 on POSIX.
 */
const SUB_SECOND_BUDGET = /\b(?:stallTimeoutSec|timeoutSec)["']?\s*:\s*(\d+(?:\.\d+)?|\.\d+)/gu;
const TEST_TITLE = /\btest\(\s*(["'`])((?:(?!\1).)*)\1/gu;
const EXPIRES_ON_PURPOSE = "the budget is what the test expires; no healthy invocation has to fit inside it";
const UNIT_CLOCK = "detectStalls is driven by ageProgress, not by a spawned provider racing the budget";
/** @type {Map<string, string>} test title -> why a sub-second budget is safe there */
const SUB_SECOND_ALLOWED = new Map([
  ["finalVerification accepts the verification-command schema and rejects unknown shapes", "0 is the invalid value being rejected"],
  ["done-when 7: a runtime's stallTimeoutSec is validated, falls back to the contract, and gives zcode a concrete value that stalls it", "0 is the invalid value being rejected"],
  ["verification reports timeout and nonzero exit", EXPIRES_ON_PURPOSE],
  ["a probe whose version check hangs past its timeout is unknown", EXPIRES_ON_PURPOSE],
  ["marks a silent provider stalled", EXPIRES_ON_PURPOSE],
  ["enforces the wall-clock cap even while output changes", EXPIRES_ON_PURPOSE],
  ["done-when 3: the seal is committed before the kill, so a provider's dying deletion cannot erase it", EXPIRES_ON_PURPOSE],
  ["done-when 1: a child that escapes the group and holds the pipe settles from the timer with timedOut", EXPIRES_ON_PURPOSE],
  ["done-when 3: a timed-out command leaves no surviving member of its process group", EXPIRES_ON_PURPOSE],
  ["stall supervision uses the latest persisted timeout override", EXPIRES_ON_PURPOSE],
  ["the pre-termination hook runs before terminateProcess, and a no-op is the default", EXPIRES_ON_PURPOSE],
  ["stall supervision kills a runtime whose harness declares streamed output once it goes quiet past stallTimeoutSec", EXPIRES_ON_PURPOSE],
  ["stall supervision never kills a runtime whose harness declares no streamed output; it is bounded by timeoutSec instead", "the stall budget is the one the test proves is ignored"],
  ["done-when 5: a tool event resets the stall clock even though no workspace file was written", UNIT_CLOCK],
  ["done-when 6: after a tool event, silence longer than the runtime threshold still stalls", UNIT_CLOCK],
  ["a turn still transmitting is not stalled, even when it closes no turn and calls no tool", UNIT_CLOCK],
  ["a turn that stops transmitting still stalls, so the bytes rule is not an amnesty", UNIT_CLOCK],
  ["done-when 7b: a fresh write inside the provider log dir resets zcode's stall clock, and a silent log stalls it", UNIT_CLOCK],
]);

test("no test gives a contract a budget under one second", () => {
  const offenders = TEST_FILES.flatMap((file) => {
    const titles = [...file.text.matchAll(TEST_TITLE)];
    return [...file.text.matchAll(SUB_SECOND_BUDGET)]
      .filter((match) => Number(match[1]) < 1)
      .map((match) => ({ file: file.label, budget: match[0], title: titles.filter((title) => (title.index ?? 0) < (match.index ?? 0)).at(-1)?.[2] ?? "(module scope)" }))
      .filter((entry) => !SUB_SECOND_ALLOWED.has(entry.title));
  });
  assert.deepEqual(
    offenders.map((entry) => `${entry.file}  ${entry.title}  ${entry.budget}`),
    [],
    "a sub-second budget races a provider spawn; wait for an event, or name the test in SUB_SECOND_ALLOWED with the reason",
  );
  const titles = new Set(TEST_FILES.flatMap((file) => [...file.text.matchAll(TEST_TITLE)].map((match) => match[2])));
  assert.deepEqual([...SUB_SECOND_ALLOWED.keys()].filter((title) => !titles.has(title)), [], "an allowed title no test carries is a stale entry");
});

/**
 * Every test file scopes FABERUN_HOME itself, as its first import. The
 * runner-level `--import ./test/scoped-home.mjs` only exists under `npm test`,
 * and measured 2026-09-23 three other callers ran this tree's tests without
 * it -- the planner's repo facts (`node --test test/<dir>`), `spec validate
 * --run-proofs`, and an operator's bare `node --test <file>` -- leaving
 * clean-closure, spoken-closure and ledger-equivalence campaigns in the
 * operator's real ~/.faberun. A file that isolates itself is safe under any
 * runner.
 */
const SCOPED_HOME_IMPORT = /^import\s+["'](?:\.\.?\/)+scoped-home\.mjs["'];?\s*$/u;

test("every test file scopes its home before it imports anything", () => {
  const unscoped = TEST_FILES
    .filter((file) => file.label.endsWith(".test.mjs"))
    .filter((file) => {
      const first = file.text.split("\n").find((line) => /^import\b/u.test(line));
      return !first || !SCOPED_HOME_IMPORT.test(first.trim());
    })
    .map((file) => file.label);
  assert.deepEqual(unscoped, [], "the first import of every test file must be its scoped-home module");
});

/**
 * FABERUN_HOME writes under test/, ratcheted to temp-scoped shapes only.
 *
 * The node that authored this rule expected one owner file; its first run
 * measured 26 write sites across 19 test files besides test/scoped-home.mjs,
 * all the same two idioms: point the home at a fresh mkdtemp under tmpdir(),
 * or restore a value previously saved from FABERUN_HOME itself. Migrating
 * those files is a campaign of its own, so the rule holds the tree to the
 * effect the scoped home exists for: no test file can point a process's
 * state at the operator's real home. Every assignment must bind FABERUN_HOME
 * to an expression rooted at tmpdir(), directly or through a variable so
 * bound (or saved from FABERUN_HOME) earlier in the same file; every delete
 * must be the guarded restore (`if (previous === undefined) delete ...`). A
 * bare delete -- which silently drops a test back onto the real home -- or
 * any homedir-rooted or literal path fails here. The whole-suite effect is
 * measured where the suite runs, in .github/workflows/ci.yml: a CI runner
 * starts with no ~/.faberun, so if one exists after npm test, a test escaped
 * these shapes. Measured 2026-09-21: ~/.faberun/projects held 394 records,
 * of which test/contract/derived-fields.test.mjs alone wrote 27, 29 and 36
 * on three consecutive days, after the same leak had already been fixed
 * twice one file at a time -- both fixes import-shaped, which is how a file
 * imports a helper literally named helpers.mjs and scopes nothing. And the
 * rule is worthless if the runner stops loading the scope at all, so the
 * last assertion pins the `--import` in package.json's test script.
 */
const FABERUN_HOME_WRITE = /process\s*\.\s*env\s*(?:(?:\?\.\s*|\.\s*)FABERUN_HOME\s*(?:[-+*\/%&|^]|\?\??)?=(?!=)|(?:\?\.\s*)?\[\s*["'`]FABERUN_HOME["'`]\s*\]\s*(?:[-+*\/%&|^]|\?\??)?=(?!=))|\bdelete\s+process\s*\.\s*env\s*(?:(?:\?\.\s*|\.\s*)FABERUN_HOME|(?:\?\.\s*)?\[\s*["'`]FABERUN_HOME["'`]\s*\])/u;

/** A variable binding whose right-hand side makes the variable safe to point FABERUN_HOME at. */
const FABERUN_HOME_SAVE = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/u;

test("every FABERUN_HOME write under test/ is temp-scoped or a restore", () => {
  const offenders = TEST_FILES.flatMap((file) => {
    const numbered = file.text
      .split("\n")
      .map((line, index) => ({ text: line.trim(), line: index + 1 }))
      .filter((entry) => !entry.text.startsWith("*") && !entry.text.startsWith("//"));
    // variables bound to a temp dir or to a saved copy of the home itself
    /** @type {Set<string>} */
    const saved = new Set();
    for (const entry of numbered) {
      const save = FABERUN_HOME_SAVE.exec(entry.text);
      if (save && (save[2].includes("tmpdir()") || save[2] === "process.env.FABERUN_HOME")) {
        saved.add(save[1]);
      }
    }
    return numbered.flatMap(({ text, line }) => {
      if (!FABERUN_HOME_WRITE.test(text)) return [];
      if (/\bdelete\s+process/u.test(text)) {
        // dropping the variable sends state resolution to the real home, so
        // only the restore guard (`previous === undefined`) may carry it
        return /===\s*undefined/u.test(text) ? [] : [`${file.label}:${line}  ${text}`];
      }
      const rhs = text.slice(text.lastIndexOf("=") + 1).trim().replace(/;$/u, "").trim();
      const safe = rhs.includes("tmpdir()") || rhs === "process.env.FABERUN_HOME" || saved.has(rhs);
      return safe ? [] : [`${file.label}:${line}  ${text}`];
    });
  });
  assert.deepEqual(
    offenders,
    [],
    `points FABERUN_HOME at the real home, at a bare delete, or at an untracked value:\n${offenders.join("\n")}\n` +
      "Point it at mkdtempSync(join(tmpdir(), ...)) or restore a saved copy; the runner's --import (test/scoped-home.mjs) is the suite's owner.",
  );
});

test("package.json's test script still preloads test/scoped-home.mjs", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8"));
  assert.match(
    pkg.scripts.test,
    /--import\s+\.\/test\/scoped-home\.mjs/u,
    "the static rule above is worthless if the runner stops loading the scope: node --test preloads nothing on its own",
  );
});

test("package.json's test script still preloads test/git-env.mjs", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8"));
  assert.match(
    pkg.scripts.test,
    /--import\s+\.\/test\/git-env\.mjs/u,
    "a fixture repository takes the machine's global git config without it, and a file that imports no helper takes it unnoticed",
  );
});
