import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readUserConfig, writeUserConfig } from "../../src/host/config.mjs";
import { configPath, faberunHome } from "../../src/host/home.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../../src/engine/runtime-discovery.mjs";
import { setupCommand } from "../../src/cli/setup.mjs";
import { withEmptyPath } from "../helpers.mjs";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

const READY = { available: true, exhaustedUntil: null, reason: "ready" };

/** @typedef {import("../../src/engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */

/** @returns {string} a fresh, empty `$FABERUN_HOME` */
function home() {
  return mkdtempSync(join(tmpdir(), "faberun-setup-"));
}

/** @returns {Record<string, RuntimeAvailability>} every catalogue runtime ready */
function allAvailable() {
  return Object.fromEntries(Object.keys(DISCOVERY_RUNTIME_DEFINITIONS).map((id) => [id, READY]));
}

/**
 * @param {string} reason
 * @returns {Record<string, RuntimeAvailability>}
 */
function allUnavailable(reason) {
  return Object.fromEntries(Object.keys(DISCOVERY_RUNTIME_DEFINITIONS).map((id) => [id, { available: false, exhaustedUntil: null, reason }]));
}

/** @returns {{write: (text: string) => void, read: () => string}} */
function capture() {
  let text = "";
  return { write: (chunk) => { text += String(chunk); }, read: () => text };
}

/** @type {import("../../src/host/config.mjs").UserConfig} */
const SAMPLE = {
  schemaVersion: 1,
  harnesses: ["dsh", "claude"],
  worker: "dsh-deepseek",
  judge: "claude-sonnet",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

test("writeUserConfig and readUserConfig round trip through FABERUN_HOME", () => {
  const directory = home();
  const env = { FABERUN_HOME: directory };
  writeUserConfig(env, SAMPLE);
  assert.deepEqual(readUserConfig(env), SAMPLE);
  assert.equal(existsSync(configPath(faberunHome(env))), true, "the config lands at configPath(faberunHome(env))");
  assert.equal(readUserConfig({ FABERUN_HOME: join(directory, "absent") }), null, "an absent file is simply null");
});

test("a malformed config is reported once and treated as absent", () => {
  const directory = home();
  const env = { FABERUN_HOME: directory };
  writeFileSync(configPath(directory), "{ not json\n");
  const original = process.stderr.write;
  let captured = "";
  /** @param {string|Uint8Array} chunk @returns {boolean} */
  const spy = (chunk) => { captured += String(chunk); return true; };
  process.stderr.write = /** @type {any} */ (spy);
  try {
    assert.equal(readUserConfig(env), null);
    assert.equal(readUserConfig(env), null, "a second read still ignores it");
  } finally {
    process.stderr.write = original;
  }
  const lines = captured.trim().split("\n");
  assert.equal(lines.length, 1, "the malformed file is reported once, not per read");
  assert.match(lines[0], /^\[warn\] config · .*config\.json is not valid; ignoring it$/u);
});

test("setup --yes writes the cheapest worker and a cross-vendor judge", async () => {
  const env = { FABERUN_HOME: home() };
  const out = capture();
  const err = capture();
  const code = await setupCommand({
    yes: true,
    env,
    discover: async () => allAvailable(),
    isTTY: false,
    stdout: out.write,
    stderr: err.write,
  });
  assert.equal(code, 0, err.read());
  const config = readUserConfig(env);
  assert.ok(config, "setup wrote a config");
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.harnesses, ["dsh", "zcode", "agy", "codex", "claude"]);
  assert.equal(config.worker, "dsh-deepseek", "the cheapest tier-1 runtime is the worker");
  assert.ok(config.worker && config.judge);
  assert.notEqual(
    DISCOVERY_RUNTIME_DEFINITIONS[config.judge].vendor,
    DISCOVERY_RUNTIME_DEFINITIONS[config.worker].vendor,
    "the judge comes from another vendor",
  );
  assert.match(out.read(), /\[ok\] config · .*config\.json/u);
  assert.match(out.read(), /next · faberun init in a repository · faberun doctor/u);
});

test("setup exits 1 and names the judge problem when only one vendor is available", async () => {
  const env = { FABERUN_HOME: home() };
  const out = capture();
  const err = capture();
  const code = await setupCommand({
    yes: true,
    env,
    discover: async () => ({ "dsh-deepseek": READY }),
    isTTY: false,
    stdout: out.write,
    stderr: err.write,
  });
  assert.equal(code, 1);
  assert.match(out.read() + err.read(), /judge/u);
  assert.match(out.read() + err.read(), /different vendor/u);
  assert.equal(readUserConfig(env), null, "no config is written when the judge cannot be composed");
});

test("setup exits 1 with the install hint when no runtime is available", async () => {
  const env = { FABERUN_HOME: home() };
  const out = capture();
  const err = capture();
  const code = await setupCommand({
    yes: true,
    env,
    discover: async () => allUnavailable("not_found"),
    isTTY: false,
    stdout: out.write,
    stderr: err.write,
  });
  assert.equal(code, 1);
  assert.match(out.read() + err.read(), /\[fail\] harnesses · none available · install one of: claude, codex, agy, dsh, zcode/u);
  assert.equal(readUserConfig(env), null);
});

test("setup takes --harnesses, --worker and --judge verbatim", async () => {
  const env = { FABERUN_HOME: home() };
  const out = capture();
  const err = capture();
  const code = await setupCommand({
    harnesses: "dsh,claude",
    worker: "dsh-deepseek",
    judge: "claude-sonnet",
    env,
    discover: async () => allAvailable(),
    isTTY: false,
    stdout: out.write,
    stderr: err.write,
  });
  assert.equal(code, 0, err.read());
  const config = readUserConfig(env);
  assert.ok(config, "setup wrote a config");
  assert.deepEqual(config.harnesses, ["dsh", "claude"]);
  assert.equal(config.worker, "dsh-deepseek");
  assert.equal(config.judge, "claude-sonnet");
});

test("setup refuses a same-vendor judge once and then accepts a valid one", async () => {
  const env = { FABERUN_HOME: home() };
  const out = capture();
  const err = capture();
  const judgeAnswers = ["codex-gpt", "claude-sonnet"];
  /** @type {string[]} */
  const questions = [];
  /** @param {string} question @returns {Promise<string>} */
  const ask = async (question) => {
    questions.push(question);
    if (question.startsWith("Enable which harnesses?")) return "";
    if (question.startsWith("Default worker runtime?")) return "codex-gpt";
    if (question.startsWith("Default judge runtime?")) return judgeAnswers.shift() ?? "";
    throw new Error(`unexpected question: ${question}`);
  };
  const code = await setupCommand({
    env,
    discover: async () => allAvailable(),
    ask,
    isTTY: true,
    stdout: out.write,
    stderr: err.write,
  });
  assert.equal(code, 0, err.read());
  assert.equal(questions.filter((question) => question.startsWith("Default judge runtime?")).length, 2, "the judge is asked again once");
  assert.equal((err.read().match(/the judge must come from a different vendor than the worker/gu) ?? []).length, 1, "refused exactly once");
  const config = readUserConfig(env);
  assert.ok(config, "setup wrote a config");
  assert.equal(config.judge, "claude-sonnet");
});

test("setup --yes --json exits 1 on a host with no harness", async () => {
  const result = await withEmptyPath(() => spawnSync(process.execPath, [BIN, "setup", "--yes", "--json"], { encoding: "utf8" }));
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.config, null);
});
