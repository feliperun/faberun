import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crossNodeScopeFindings, scopeClosureFindings } from "../../src/repo/scope-closure.mjs";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";

/**
 * The scope-closure detectors against a throwaway repository. Each test builds
 * the one relationship it names, so the detector under test is the only one
 * that can fire.
 */

/**
 * @param {Record<string, string>} files repository-relative path to content
 * @returns {string} the repository root
 */
function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "runner-scope-closure-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} packet
 * @returns {import("../../src/repo/scope-closure.mjs").ScopeClosureFinding[]}
 */
function findings(root, packet) {
  return scopeClosureFindings(
    /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (
      /** @type {unknown} */ (
        { id: "build", type: "backend", taskPacket: { mode: "execution", symbols: [], readFiles: [], decisions: [], nonGoals: [], verification: [], ...packet } }
      )
    ),
    0,
    root,
  );
}

test("scope closure catches the reverse import", () => {
  const root = repository({
    "src/written.mjs": "export function writtenThing() {}\n",
    "src/importer.mjs": 'import { writtenThing } from "./written.mjs";\nwrittenThing();\n',
  });
  const found = findings(root, { writeFiles: ["src/written.mjs"], symbols: ["writtenThing"] });
  assert.deepEqual(
    found.map((finding) => [finding.path, finding.detector]),
    [["src/importer.mjs", "imports"]],
  );
  assert.match(found[0].reason, /imports src\/written\.mjs/u);
});

test("scope closure catches the symbol mention", () => {
  const root = repository({
    "src/written.mjs": "export function writtenThing() {}\n",
    "src/mentioner.mjs": "export function helper() { return writtenThing; }\n",
  });
  const found = findings(root, { writeFiles: ["src/written.mjs"], symbols: ["writtenThing"] });
  assert.deepEqual(
    found.map((finding) => [finding.path, finding.detector]),
    [["src/mentioner.mjs", "symbols"]],
  );
});

test("scope closure catches the directory globber", () => {
  const root = repository({
    "skills/mine/bulk-read/SKILL.md": "# bulk-read\n",
    "bin/installer.mjs": [
      'import { readdirSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));',
      'const SKILLS_DIR = join(SKILLS_ROOT, "mine");',
      "readdirSync(SKILLS_DIR);",
      "",
    ].join("\n"),
    "test/installer.test.mjs": [
      'import { spawnSync } from "node:child_process";',
      'import { fileURLToPath } from "node:url";',
      'const BIN = fileURLToPath(new URL("../bin/installer.mjs", import.meta.url));',
      "spawnSync(process.execPath, [BIN]);",
      "",
    ].join("\n"),
  });
  const found = findings(root, { writeFiles: ["skills/mine/bulk-read/SKILL.md"], symbols: ["unused"] });
  assert.deepEqual(
    found.map((finding) => [finding.path, finding.detector]),
    [["test/installer.test.mjs", "directory"]],
  );
  assert.match(found[0].reason, /enumerates skills\/mine/u);
});

test("scope closure accepts an acknowledged path", () => {
  const root = repository({
    "src/written.mjs": "export function writtenThing() {}\n",
    "src/importer.mjs": 'import { writtenThing } from "./written.mjs";\nwrittenThing();\n',
  });
  const found = findings(root, {
    writeFiles: ["src/written.mjs"],
    symbols: ["writtenThing"],
    scopeAcknowledged: ["src/importer.mjs"],
  });
  assert.deepEqual(found, []);
});

/**
 * The seat-switch shape: one node owns the test, the other owns the module the
 * test runs. Neither packet is wrong alone -- the pair is impossible, because
 * the module's node must change a test its packet withholds. Both nodes share
 * the phase and are ordered, so the module's extension lands after the test
 * that pins the surface it extends.
 */

const INITIAL_CLI = [
  'import { pathToFileURL } from "node:url";',
  "",
  'const COMMANDS = ["init"];',
  "",
  "export function renderUsage() {",
  '  return `usage: cli ${COMMANDS.map((command) => `<${command}>`).join(" ")}`;',
  "}",
  "",
  "if (import.meta.url === pathToFileURL(process.argv[1]).href) {",
  "  process.stdout.write(renderUsage());",
  "}",
  "",
].join("\n");

// seat-switch's required extension adds one command, and that alone changes the
// usage line the seat-lifecycle test pinned.
const EXTENDED_CLI = INITIAL_CLI.replace('["init"]', '["init", "switch"]');

const USAGE_ASSERTION_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { spawnSync } from "node:child_process";',
  'import { fileURLToPath } from "node:url";',
  "",
  'const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));',
  "",
  'test("usage line names every command", () => {',
  '  const result = spawnSync(process.execPath, [CLI], { encoding: "utf8" });',
  '  assert.equal(result.stdout, "usage: cli <init>");',
  "});",
  "",
].join("\n");

/**
 * Run the fixture's own test file in its repository under a clean test
 * environment. The outer `node --test` marks its worker with `NODE_TEST_CONTEXT`,
 * and a nested runner that inherits the marker emits the worker protocol instead
 * of running the file and would always report success.
 *
 * @param {string} root
 * @returns {number} the nested test runner's exit status
 */
function runFixtureTest(root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return spawnSync(process.execPath, ["--test", "test/cli/cli.test.mjs"], { cwd: root, env, encoding: "utf8" }).status ?? 1;
}

/**
 * @param {{id: string, phase: string, dependsOn?: string[], readFiles: string[], writeFiles: string[], scopeAcknowledged?: string[]}} spec
 * @returns {import("../../src/contract/index.mjs").ValidatedNode}
 */
function crossNode(spec) {
  return /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (/** @type {unknown} */ ({
    id: spec.id,
    type: "backend",
    phase: spec.phase,
    dependsOn: spec.dependsOn ?? [],
    taskPacket: {
      mode: "execution", objective: spec.id, instructions: [], readFiles: spec.readFiles,
      writeFiles: spec.writeFiles, symbols: [], scopeAcknowledged: spec.scopeAcknowledged ?? [],
      decisions: [], nonGoals: [], verification: [],
    },
  }));
}

test("scope closure catches the cross node trap", () => {
  const root = repository({
    "src/cli.mjs": INITIAL_CLI,
    "test/cli/cli.test.mjs": USAGE_ASSERTION_TEST,
  });

  // The fixture is the trap, not a paraphrase of it: the test pins the exact
  // usage line, it passes against the CLI seat-lifecycle found, and it fails
  // the moment seat-switch extends the CLI by one command. The extension only
  // changes the usage line the test asserts, so the withheld test is what makes
  // the pair impossible rather than a stylistic preference.
  assert.equal(runFixtureTest(root), 0);
  writeFileSync(join(root, "src/cli.mjs"), EXTENDED_CLI);
  assert.notEqual(runFixtureTest(root), 0);

  const nodes = [
    crossNode({ id: "seat-lifecycle", phase: "seat", readFiles: ["src/cli.mjs"], writeFiles: ["test/cli/cli.test.mjs"] }),
    crossNode({ id: "seat-switch", phase: "seat", dependsOn: ["seat-lifecycle"], readFiles: ["test/cli/cli.test.mjs"], writeFiles: ["src/cli.mjs"] }),
  ];
  const found = crossNodeScopeFindings(nodes, root);
  assert.deepEqual(
    found.map((finding) => [finding.path, finding.detector, finding.nodeId]),
    [["test/cli/cli.test.mjs", "cross-node", "seat-switch"]],
  );
  assert.match(found[0].reason, /src\/cli\.mjs/u);
  // The withheld test is a write obligation; reading it does not repair it, so
  // neither packet read alone triggers the pair detector.
  assert.deepEqual(crossNodeScopeFindings([nodes[0]], root), []);
  assert.deepEqual(crossNodeScopeFindings([nodes[1]], root), []);

  const contract = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    id: "seat-switch-cross-node",
    campaignId: "cross-node",
    goal: "reproduce the seat-switch trap",
    cwd: ".",
    runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { harness: "codex", model: "test", executable: "/nonexistent/codex" } },
    nodes: [
      { id: "seat-lifecycle", type: "backend", phase: "seat", gate: false, taskPacket: {
        mode: "execution", objective: "write the usage assertion", instructions: ["write test"],
        readFiles: ["src/cli.mjs"], writeFiles: ["test/cli/cli.test.mjs"], symbols: [],
        decisions: [], nonGoals: [], verification: [],
      } },
      { id: "seat-switch", type: "backend", phase: "seat", dependsOn: ["seat-lifecycle"], gate: false, taskPacket: {
        mode: "execution", objective: "extend the cli entry point", instructions: ["extend cli"],
        readFiles: ["test/cli/cli.test.mjs"], writeFiles: ["src/cli.mjs"], symbols: [],
        decisions: [], nonGoals: [], verification: [],
      } },
    ],
  };
  const path = join(root, "contract.json");
  writeFileSync(path, JSON.stringify(contract));
  assert.throws(() => validateContract(contract, path), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /scope does not close/u);
    assert.match(error.message, /nodes\[1\] \(seat-switch\)/u);
    assert.match(error.message, /test\/cli\/cli\.test\.mjs/u);
    assert.match(error.message, /cross-node/u);
    return true;
  });
});
