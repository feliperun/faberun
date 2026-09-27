import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readUserConfig, writeUserConfig } from "../../src/host/config.mjs";
import { configPath, faberunHome } from "../../src/host/home.mjs";
import {
  installSettingsEntry,
  knownInstallSites,
  readInstallRegistry,
  removeRecordedSettingsEntries,
} from "../../src/host/install-registry.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../../src/engine/runtime-discovery.mjs";
import { mergeExistingConfig, setupCommand } from "../../src/cli/setup.mjs";
import { homeEnv, withEmptyPath } from "../helpers.mjs";
import { writeExecutable } from "../write-executable.mjs";

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
    skill: false,
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
    skill: false,
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
    skill: false,
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
    skill: false,
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
    skill: false,
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

/**
 * A throwaway HOME with the claude and codex skills directories and fake
 * harness binaries on a narrow PATH, so discovery and registration are
 * deterministic and never touch the developer's real harnesses.
 *
 * @returns {{home: string, env: Record<string, string|undefined>}}
 */
function registerableHome() {
  const home = mkdtempSync(join(tmpdir(), "setup-register-"));
  const bin = mkdtempSync(join(tmpdir(), "setup-register-bin-"));
  for (const dir of [".claude/skills", ".codex/skills"]) mkdirSync(join(home, dir), { recursive: true });
  // Stand-ins the host can actually spawn, on the PATH spelled the way this
  // host spells one: a fixture written with a shebang and joined with ":" is
  // two assumptions no Windows machine holds.
  for (const harness of ["claude", "codex"]) {
    writeExecutable(join(bin, harness), `console.log("fake ${harness} 1.0.0");\n`);
  }
  return { home, env: { ...process.env, ...homeEnv(home), FABERUN_HOME: home, PATH: [bin, ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) } };
}

test("mergeExistingConfig keeps only what discovery still reports available", () => {
  const availability = allAvailable();
  availability["zcode-glm"] = { available: false, exhaustedUntil: null, reason: "not_found" };
  assert.deepEqual(mergeExistingConfig(null, availability), { harnesses: [], worker: "", judge: "", judges: [], reviewers: [] });
  assert.deepEqual(
    mergeExistingConfig({ schemaVersion: 1, harnesses: ["dsh", "claude"], worker: "dsh-deepseek", judge: "claude-sonnet", judges: ["claude-sonnet"], reviewers: ["claude-sonnet"], updatedAt: "2026-09-15T00:00:00.000Z" }, availability),
    { harnesses: ["dsh", "claude"], worker: "dsh-deepseek", judge: "claude-sonnet", judges: ["claude-sonnet"], reviewers: ["claude-sonnet"] },
    "a still-available choice is kept as-is, the R18 judges list and R19 reviewers list included",
  );
  assert.deepEqual(
    mergeExistingConfig({ schemaVersion: 1, harnesses: ["dsh", "zcode"], worker: "zcode-glm", judge: "claude-sonnet", updatedAt: "2026-09-15T00:00:00.000Z" }, availability),
    { harnesses: ["dsh"], worker: "", judge: "claude-sonnet", judges: [], reviewers: [] },
    "a harness or worker discovery cannot find is dropped, not kept blindly",
  );
});

test("setup --yes with an existing config keeps its worker and judge and narrows harnesses to what discovery still finds", async () => {
  const env = { FABERUN_HOME: home() };
  writeUserConfig(env, SAMPLE);
  const code = await setupCommand({
    skill: false,
    yes: true,
    env,
    discover: async () => allAvailable(),
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  const config = readUserConfig(env);
  assert.ok(config, "setup wrote a config");
  assert.deepEqual(config.harnesses, SAMPLE.harnesses, "the recorded harnesses are kept rather than widened to every available one");
  assert.equal(config.worker, SAMPLE.worker);
  assert.equal(config.judge, SAMPLE.judge);
});

test("setup --yes drops a recorded harness that is no longer available", async () => {
  const env = { FABERUN_HOME: home() };
  writeUserConfig(env, { ...SAMPLE, harnesses: ["dsh", "claude", "zcode"] });
  const availability = allAvailable();
  availability["zcode-glm"] = { available: false, exhaustedUntil: null, reason: "not_found" };
  const code = await setupCommand({
    skill: false,
    yes: true,
    env,
    discover: async () => availability,
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  const config = readUserConfig(env);
  assert.ok(config);
  assert.deepEqual(config.harnesses, ["dsh", "claude"], "zcode is dropped since discovery no longer reports it");
});

test("setup --yes --judge overrides a recorded judge", async () => {
  const env = { FABERUN_HOME: home() };
  writeUserConfig(env, SAMPLE);
  const code = await setupCommand({
    skill: false,
    yes: true,
    judge: "codex-gpt",
    env,
    discover: async () => allAvailable(),
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  const config = readUserConfig(env);
  assert.ok(config);
  assert.equal(config.worker, SAMPLE.worker, "the recorded worker is still kept");
  assert.equal(config.judge, "codex-gpt", "the explicit --judge wins over the recorded one");
});

test("setup --yes writes today's defaults on a fresh home with no existing config", async () => {
  const env = { FABERUN_HOME: home() };
  const code = await setupCommand({
    skill: false,
    yes: true,
    env,
    discover: async () => allAvailable(),
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  const config = readUserConfig(env);
  assert.ok(config);
  assert.deepEqual(config.harnesses, ["dsh", "zcode", "agy", "codex", "claude"]);
  assert.equal(config.worker, "dsh-deepseek");
});

test("setup --yes registers the skill and --no-skill skips it", () => {
  const args = ["setup", "--yes", "--harnesses", "codex,claude", "--worker", "codex-gpt", "--judge", "claude-sonnet"];

  const registered = registerableHome();
  const done = spawnSync(process.execPath, [BIN, ...args], { env: registered.env, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(join(registered.home, ".claude", "skills", "faberun", "SKILL.md")), "claude receives the skill");
  assert.ok(existsSync(join(registered.home, ".codex", "skills", "faberun", "SKILL.md")), "codex receives the skill");

  const skipped = registerableHome();
  const noSkill = spawnSync(process.execPath, [BIN, ...args, "--no-skill"], { env: skipped.env, encoding: "utf8" });
  assert.equal(noSkill.status, 0, noSkill.stderr);
  assert.equal(existsSync(join(skipped.home, ".claude", "skills", "faberun")), false, "--no-skill registers nothing");
  assert.equal(existsSync(join(skipped.home, ".codex", "skills", "faberun")), false, "--no-skill registers nothing");
});

test("the known install-site manifest names the status-line settings file and the hook destinations", () => {
  const directory = home();
  const sites = knownInstallSites(directory);
  assert.deepEqual(sites.settings, [{ harness: "claude", path: join(directory, ".claude", "settings.json"), key: "statusLine" }]);
  assert.deepEqual(
    sites.hooks.filter((site) => site.path === join(directory, ".claude", "settings.json")).map((site) => site.key),
    ["hooks"],
    "the settings file that carries hooks is a known hook destination",
  );
  assert.equal(sites.hooks.some((site) => site.path === join(directory, ".claude", "hooks")), true, "the hook script directory is a known hook destination");
});

test("installing a status-line entry records the exact settings file and only that entry", () => {
  const directory = home();
  const env = { FABERUN_HOME: directory, HOME: directory };
  const settingsPath = join(directory, ".claude", "settings.json");
  mkdirSync(join(directory, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ permissions: { allow: ["Bash(git status)"] } })}\n`);
  const value = { type: "command", command: "sh ~/.faberun/current/integrations/claude-code/statusline.sh" };

  installSettingsEntry(env, {
    kind: "statusline",
    path: settingsPath,
    root: join(directory, ".claude"),
    harness: "claude",
    pointer: "/statusLine",
    value,
  });

  const recorded = readInstallRegistry(env).entries.find((entry) => entry.kind === "statusline");
  assert.ok(recorded, "the status-line install is recorded");
  assert.equal(recorded.path, settingsPath, "the exact settings file is recorded");
  assert.equal(recorded.root, join(directory, ".claude"));
  assert.deepEqual(recorded.entries, [{ pointer: "/statusLine", value }]);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).statusLine, value, "the entry was written into the settings file");

  const cleaned = removeRecordedSettingsEntries(JSON.parse(readFileSync(settingsPath, "utf8")), recorded.entries);
  assert.equal(Object.hasOwn(/** @type {Record<string, unknown>} */ (cleaned), "statusLine"), false, "the recorded entry is removed");
  assert.deepEqual(
    /** @type {Record<string, unknown>} */ (cleaned).permissions,
    { allow: ["Bash(git status)"] },
    "the neighbouring settings entry survives",
  );
});

test("a recorded hook entry is removed without disturbing a neighbouring hook", () => {
  const directory = home();
  const env = { FABERUN_HOME: directory, HOME: directory };
  const settingsPath = join(directory, ".claude", "settings.json");
  mkdirSync(join(directory, ".claude"), { recursive: true });
  const neighbour = { matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/neighbour.mjs" }] };
  writeFileSync(settingsPath, `${JSON.stringify({ hooks: { PreToolUse: [neighbour] } })}\n`);
  const added = { matcher: "Write", hooks: [{ type: "command", command: "node ~/.faberun/current/src/host/tool-policy-hook.mjs" }] };

  installSettingsEntry(env, {
    kind: "hook",
    path: settingsPath,
    root: join(directory, ".claude"),
    harness: "claude",
    pointer: "/hooks/PreToolUse/1",
    value: added,
  });

  const recorded = readInstallRegistry(env).entries.find((entry) => entry.kind === "hook");
  assert.ok(recorded, "the hook install is recorded");
  assert.deepEqual(recorded.entries, [{ pointer: "/hooks/PreToolUse/1", value: added }]);
  const cleaned = /** @type {{hooks: {PreToolUse: unknown[]}}} */ (removeRecordedSettingsEntries(JSON.parse(readFileSync(settingsPath, "utf8")), recorded.entries));
  assert.deepEqual(cleaned.hooks.PreToolUse, [neighbour], "only faberun's hook is removed");
});

test("setup records the config and the skills it registers in the home registry", () => {
  const { home: directory, env } = registerableHome();
  const done = spawnSync(process.execPath, [BIN, "setup", "--yes", "--harnesses", "codex,claude", "--worker", "codex-gpt", "--judge", "claude-sonnet"], {
    env,
    encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  const entries = readInstallRegistry(env).entries;
  assert.ok(
    entries.some((entry) => entry.kind === "config" && entry.path === configPath(directory)),
    "the config setup wrote is recorded",
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "skill").map((entry) => entry.path).sort(),
    [join(directory, ".claude", "skills", "faberun"), join(directory, ".codex", "skills", "faberun")].sort(),
    "both registered skills are recorded",
  );
});

