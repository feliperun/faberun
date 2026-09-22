import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnv } from "../helpers.mjs";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} [extraEnv]
 */
function run(args, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, "skills", ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: /** @type {number | null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

test("install puts the catalogue under .claude/skills", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-install-"));
  const result = run(["install"], cwd);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["faberun", "init-agentkit"]) {
    assert.ok(existsSync(join(cwd, ".claude", "skills", name, "SKILL.md")), `${name} missing`);
  }
  assert.match(result.stdout, /installed faberun/);
  assert.match(result.stdout, /installed init-agentkit/);
  assert.match(result.stdout, /2 installed · 0 skipped/);
});

test("install copies only the named skill", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-named-"));
  const result = run(["install", "init-agentkit"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cwd, ".claude", "skills", "init-agentkit", "SKILL.md")));
  assert.ok(!existsSync(join(cwd, ".claude", "skills", "faberun")));
});

test("a second install skips, and --force replaces", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skills-force-"));
  const skillDir = join(cwd, ".claude", "skills", "init-agentkit");
  run(["install", "init-agentkit"], cwd);
  writeFileSync(join(skillDir, "SKILL.md"), "local edit\n");
  const kept = run(["install", "init-agentkit"], cwd);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /skipped init-agentkit · exists, use --force/);
  assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), "local edit\n");
  const forced = run(["install", "init-agentkit", "--force"], cwd);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), /^---\nname: init-agentkit/);
});

test("list names every catalogue skill", () => {
  const result = run(["list"], tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^faberun$/mu);
  assert.match(result.stdout, /^init-agentkit$/mu);
});

test("--global installs into the home skills directory", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const result = run(["install", "init-agentkit", "--global"], tmpdir(), homeEnv(home));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(home, ".claude", "skills", "init-agentkit", "SKILL.md")));
});

test("an unknown skill is a usage error", () => {
  const result = run(["install", "does-not-exist"], tmpdir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no skill named "does-not-exist"/);
  assert.match(result.stderr, /faberun skills list/);
});
