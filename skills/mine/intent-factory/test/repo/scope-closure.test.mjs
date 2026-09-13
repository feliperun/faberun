import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scopeClosureFindings } from "../../src/repo/scope-closure.mjs";

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
