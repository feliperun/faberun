import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredEnvironment as claudeDeclared } from "../../src/harnesses/claude/index.mjs";
import { declaredEnvironment as codexDeclared } from "../../src/harnesses/codex/index.mjs";
import { declaredEnvironment as agyDeclared } from "../../src/harnesses/agy/index.mjs";
import { declaredEnvironment as dshDeclared } from "../../src/harnesses/dsh/index.mjs";
import { declaredEnvironment as zcodeDeclared } from "../../src/harnesses/zcode/index.mjs";
import { declaredEnvironment as execJsonlDeclared } from "../../src/harnesses/exec-jsonl/index.mjs";
import { declaredEnvironment as replayDeclared } from "../../src/harnesses/replay/index.mjs";
import { DECLARED_HARNESS_ENVIRONMENTS, MODEL_HARNESS_ORDER } from "../../src/harnesses/catalogue.mjs";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "harnesses");

/**
 * Each adapter's own `declaredEnvironment` export, keyed by the harness id the
 * catalogue keys it under.
 *
 * @type {Map<string, readonly string[]>}
 */
const DECLARATIONS = new Map([
  ["claude", claudeDeclared],
  ["codex", codexDeclared],
  ["agy", agyDeclared],
  ["dsh", dshDeclared],
  ["zcode", zcodeDeclared],
  ["exec-jsonl", execJsonlDeclared],
  ["replay", replayDeclared],
]);

/**
 * The three adapters this node declares, the source files a static read scan
 * covers, the binary override each must name, and the authentication or
 * configuration names each must declare on top of it. `zcode` reads
 * `ZAI_API_KEY` and `ANTHROPIC_AUTH_TOKEN` through a dynamic `process.env[name]`
 * (the name comes from `auth_token.env_key`), which a literal scan cannot see,
 * so both are pinned here.
 *
 * @type {readonly {harness: string, declared: readonly string[], sources: readonly string[], binary: string, required: readonly string[]}[]}
 */
const NEW_ADAPTERS = [
  {
    harness: "zcode",
    declared: zcodeDeclared,
    sources: [join(HARNESS_DIR, "zcode", "index.mjs")],
    binary: "FABERUN_ZCODE_BIN",
    required: ["ANTHROPIC_AUTH_TOKEN", "FABERUN_ZCODE_APP_DIR", "ZAI_API_KEY"],
  },
  {
    harness: "exec-jsonl",
    declared: execJsonlDeclared,
    sources: [join(HARNESS_DIR, "exec-jsonl", "index.mjs")],
    binary: "FABERUN_EXEC_JSONL_BIN",
    required: [],
  },
  {
    harness: "replay",
    declared: replayDeclared,
    sources: [join(HARNESS_DIR, "replay", "index.mjs"), join(HARNESS_DIR, "replay", "bin.mjs")],
    binary: "FABERUN_REPLAY_BIN",
    required: [],
  },
];

/**
 * The base operating-system names R1 always allows, plus the `LC_*` family: an
 * adapter may read one without declaring it, because the environment builder
 * supplies it unconditionally.
 *
 * @type {ReadonlySet<string>}
 */
const BASE_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "COMSPEC",
  "PATHEXT",
]);

/** @param {string} name @returns {boolean} */
function isBaseEnvironment(name) {
  return BASE_ENVIRONMENT.has(name) || name.startsWith("LC_");
}

/**
 * Every environment name a source file reads. A literal `env.NAME` counts only
 * in read position: `env.NAME = ...` is an overlay the adapter builds for its
 * child, not a dependency it reads.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function environmentReads(text) {
  const names = new Set();
  for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu)) names.add(match[1]);
  for (const match of text.matchAll(/process\.env\[["']([^"']+)["']\]/gu)) names.add(match[1]);
  for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b(?!\s*=)/gu)) names.add(match[1]);
  return names;
}

test("the harness catalogue exposes the declared environment of all seven adapters", () => {
  assert.ok(Object.isFrozen(DECLARED_HARNESS_ENVIRONMENTS), "the catalogue declaration is frozen");
  assert.deepEqual(
    Object.keys(DECLARED_HARNESS_ENVIRONMENTS).sort(),
    [...MODEL_HARNESS_ORDER].sort(),
    "the catalogue covers exactly the seven canonical harnesses",
  );
  for (const harness of MODEL_HARNESS_ORDER) {
    const declared = DECLARED_HARNESS_ENVIRONMENTS[harness];
    assert.ok(Array.isArray(declared), `${harness} exposes a declared environment list`);
    assert.equal(declared, DECLARATIONS.get(harness), `${harness} exposes the adapter's own frozen list`);
    assert.ok(Object.isFrozen(declared), `${harness} freezes its declared environment list`);
    assert.ok(declared.length > 0, `${harness} declares at least its binary override`);
  }
});

test("zcode, exec-jsonl and replay declare the environment they read", () => {
  for (const adapter of NEW_ADAPTERS) {
    assert.ok(Array.isArray(adapter.declared), `${adapter.harness} exports a declared environment list`);
    assert.ok(Object.isFrozen(adapter.declared), `${adapter.harness} freezes its declared environment list`);
    assert.deepEqual([...adapter.declared].sort(), [...adapter.declared], `${adapter.harness} declares the names in sorted order`);
    assert.equal(new Set(adapter.declared).size, adapter.declared.length, `${adapter.harness} declares no duplicate names`);
    for (const name of adapter.declared) {
      assert.equal(typeof name, "string", `${adapter.harness} declares a name, not a value`);
      assert.match(name, /^[A-Z][A-Z0-9_]*$/u, `${adapter.harness} declares the env name ${name}`);
    }
    assert.ok(adapter.declared.includes(adapter.binary), `${adapter.harness} declares its binary override ${adapter.binary}`);
    for (const name of adapter.required) {
      assert.ok(adapter.declared.includes(name), `${adapter.harness} declares ${name}`);
    }
    const read = new Set();
    for (const source of adapter.sources) {
      for (const name of environmentReads(readFileSync(source, "utf8"))) {
        if (!isBaseEnvironment(name)) read.add(name);
      }
    }
    for (const name of read) {
      assert.ok(adapter.declared.includes(name), `${adapter.harness} declares ${name}, which it reads from the environment`);
    }
  }
});

test("every declared name is a bare name, never a value", () => {
  for (const adapter of NEW_ADAPTERS) {
    for (const name of adapter.declared) {
      assert.ok(!name.includes("="), `${adapter.harness} declares the bare name ${name}`);
    }
  }
});
