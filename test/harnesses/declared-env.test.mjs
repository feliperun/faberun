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
 * The seven adapters this regression covers, in the catalogue's canonical
 * order. Each entry names the adapter's own frozen `declaredEnvironment`
 * export, the source files whose environment reads the static scan covers, the
 * binary override the adapter reads for itself, and the authentication or
 * configuration names the adapter must declare beyond that override.
 *
 * `codex/usage-window.mjs` is scanned because `codexHome()` reads `CODEX_HOME`
 * there. `zcode` reads `ZAI_API_KEY` and `ANTHROPIC_AUTH_TOKEN` through a
 * dynamic `process.env[name]` (the name comes from `auth_token.env_key`), which
 * a literal scan cannot see, so both are pinned here as required.
 *
 * @type {readonly {
 *   harness: string,
 *   declared: readonly string[],
 *   sources: readonly string[],
 *   binary: string,
 *   required: readonly string[],
 * }[]}
 */
const ADAPTERS = [
  {
    harness: "claude",
    declared: claudeDeclared,
    sources: [join(HARNESS_DIR, "claude", "index.mjs")],
    binary: "FABERUN_CLAUDE_BIN",
    required: ["ANTHROPIC_API_KEY"],
  },
  {
    harness: "codex",
    declared: codexDeclared,
    sources: [join(HARNESS_DIR, "codex", "index.mjs"), join(HARNESS_DIR, "codex", "usage-window.mjs")],
    binary: "FABERUN_CODEX_BIN",
    required: ["CODEX_HOME", "OPENAI_API_KEY"],
  },
  {
    harness: "agy",
    declared: agyDeclared,
    sources: [join(HARNESS_DIR, "agy", "index.mjs")],
    binary: "FABERUN_AGY_BIN",
    required: [],
  },
  {
    harness: "dsh",
    declared: dshDeclared,
    sources: [join(HARNESS_DIR, "dsh", "index.mjs")],
    binary: "FABERUN_DSH_BIN",
    required: ["DEEPSEEK_API_KEY"],
  },
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
 * adapter may read one without declaring it, because the worker environment
 * builder supplies it unconditionally.
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

/**
 * @param {string} name
 * @returns {boolean}
 */
function isBaseEnvironment(name) {
  return BASE_ENVIRONMENT.has(name) || name.startsWith("LC_");
}

/**
 * Every environment name a source file reads, by its literal form:
 * `process.env.NAME`, `process.env["NAME"]` and `env.NAME` in read position.
 * `env.NAME = value` is an overlay the adapter builds for its child, not a
 * dependency it reads, so assignments are excluded.
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

test("every harness adapter declares the environment it reads", () => {
  // The catalogue is the single surface that exposes the seven declarations to
  // the worker environment builder, so a name missing from it is a name the
  // child process never receives.
  assert.ok(Object.isFrozen(DECLARED_HARNESS_ENVIRONMENTS), "the catalogue declaration is frozen");
  assert.deepEqual(
    Object.keys(DECLARED_HARNESS_ENVIRONMENTS),
    [...MODEL_HARNESS_ORDER],
    "the catalogue covers exactly the seven canonical harnesses, in order",
  );
  assert.deepEqual(
    ADAPTERS.map((adapter) => adapter.harness),
    [...MODEL_HARNESS_ORDER],
    "the regression covers all seven adapters the catalogue exposes",
  );

  for (const adapter of ADAPTERS) {
    const { harness, declared, binary, required } = adapter;

    // Every adapter exports one frozen, sorted, duplicate-free list of bare
    // uppercase names, and the catalogue carries that same list.
    assert.ok(Array.isArray(declared), `${harness} exports a declared environment list`);
    assert.ok(Object.isFrozen(declared), `${harness} freezes its declared environment list`);
    assert.deepEqual([...declared].sort(), [...declared], `${harness} declares the names in sorted order`);
    assert.equal(new Set(declared).size, declared.length, `${harness} declares no duplicate names`);
    for (const name of declared) {
      assert.equal(typeof name, "string", `${harness} declares a name, not a value`);
      assert.match(name, /^[A-Z][A-Z0-9_]*$/u, `${harness} declares the bare env name ${name}`);
    }
    assert.equal(DECLARED_HARNESS_ENVIRONMENTS[harness], declared, `${harness} exposes the adapter's own frozen list`);

    // The override the adapter reads to locate its own binary, and the
    // authentication or configuration names it must declare on top of it.
    assert.ok(declared.includes(binary), `${harness} declares its binary override ${binary}`);
    for (const name of required) {
      assert.ok(declared.includes(name), `${harness} declares ${name}, which it needs to authenticate or configure`);
    }

    // Static read scan: every environment name the adapter's own source reads
    // must be declared, or be a base name the builder always supplies.
    const read = new Set();
    for (const source of adapter.sources) {
      const text = readFileSync(source, "utf8");
      assert.ok(text.length > 0, `${harness} source ${source} is not empty`);
      for (const name of environmentReads(text)) read.add(name);
    }
    assert.ok(
      read.has(binary),
      `${harness} reads its binary override ${binary} in ${adapter.sources.join(", ")}, so the scan reached the adapter`,
    );
    for (const name of read) {
      assert.ok(
        declared.includes(name) || isBaseEnvironment(name),
        `${harness} declares ${name}, which it reads from the environment`,
      );
    }
  }
});
