import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredEnvironment as claudeDeclared } from "../../src/harnesses/claude/index.mjs";
import { declaredEnvironment as codexDeclared } from "../../src/harnesses/codex/index.mjs";
import { declaredEnvironment as agyDeclared } from "../../src/harnesses/agy/index.mjs";
import { declaredEnvironment as dshDeclared } from "../../src/harnesses/dsh/index.mjs";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "harnesses");

/**
 * The adapters this phase declares, the `declaredEnvironment` each exports, the
 * source files a static read scan covers, and the authentication or
 * configuration names each adapter must declare beyond the binary override it
 * reads for itself. `codex/usage-window.mjs` is scanned because `codexHome()`
 * reads `CODEX_HOME` from it.
 *
 * @type {readonly {harness: string, declared: readonly string[], sources: readonly string[], required: readonly string[]}[]}
 */
const ADAPTERS = [
  {
    harness: "claude",
    declared: claudeDeclared,
    sources: [join(HARNESS_DIR, "claude", "index.mjs")],
    required: ["ANTHROPIC_API_KEY"],
  },
  {
    harness: "codex",
    declared: codexDeclared,
    sources: [join(HARNESS_DIR, "codex", "index.mjs"), join(HARNESS_DIR, "codex", "usage-window.mjs")],
    required: ["CODEX_HOME", "OPENAI_API_KEY"],
  },
  {
    harness: "agy",
    declared: agyDeclared,
    sources: [join(HARNESS_DIR, "agy", "index.mjs")],
    required: [],
  },
  {
    harness: "dsh",
    declared: dshDeclared,
    sources: [join(HARNESS_DIR, "dsh", "index.mjs")],
    required: ["DEEPSEEK_API_KEY"],
  },
];

/** Every `process.env.<NAME>`, `process.env["<NAME>"]` and `env.<NAME>` literal in a source file. */
function environmentReads(text) {
  const names = new Set();
  for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu)) names.add(match[1]);
  for (const match of text.matchAll(/process\.env\[["']([^"']+)["']\]/gu)) names.add(match[1]);
  for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/gu)) names.add(match[1]);
  return names;
}

test("every harness adapter declares the environment it reads", () => {
  for (const adapter of ADAPTERS) {
    assert.ok(Array.isArray(adapter.declared), `${adapter.harness} exports a declared environment list`);
    assert.ok(Object.isFrozen(adapter.declared), `${adapter.harness} freezes its declared environment list`);
    assert.deepEqual([...adapter.declared].sort(), [...adapter.declared], `${adapter.harness} declares the names in sorted order`);
    assert.equal(new Set(adapter.declared).size, adapter.declared.length, `${adapter.harness} declares no duplicate names`);
    for (const name of adapter.declared) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/u, `${adapter.harness} declares the env name ${name}`);
    }
    const binary = `FABERUN_${adapter.harness.toUpperCase()}_BIN`;
    assert.ok(adapter.declared.includes(binary), `${adapter.harness} declares its binary override ${binary}`);
    for (const name of adapter.required) {
      assert.ok(adapter.declared.includes(name), `${adapter.harness} declares ${name}`);
    }
    const read = new Set();
    for (const source of adapter.sources) {
      for (const name of environmentReads(readFileSync(source, "utf8"))) read.add(name);
    }
    for (const name of read) {
      assert.ok(adapter.declared.includes(name), `${adapter.harness} declares ${name}, which it reads from the environment`);
    }
  }
});

test("the declared environment names are never values", () => {
  for (const adapter of ADAPTERS) {
    for (const name of adapter.declared) {
      assert.equal(typeof name, "string", `${adapter.harness} declares a name, not a value`);
      assert.ok(!name.includes("="), `${adapter.harness} declares the bare name ${name}`);
    }
  }
});
