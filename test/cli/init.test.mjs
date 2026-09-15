import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeGit } from "../helpers.mjs";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return {
    status: /** @type {number|null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

/**
 * @param {string} directory
 * @returns {string}
 */
function freshRepo(directory) {
  writeFileSync(join(directory, "README.md"), "# fixture\n");
  initializeGit(directory);
  return directory;
}

/**
 * The `gitignore` lines that mean `.runs` is ignored.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function runsLines(directory) {
  return readFileSync(join(directory, ".gitignore"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line === ".runs/" || line === ".runs");
}

test("init --yes ignores .runs, installs the skill, and skips the agent kit", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-yes-")));
  const result = run(["init", "--yes"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(runsLines(cwd), [".runs/"]);
  assert.match(result.stdout, /\[ok\] \.runs ignored · .*\.gitignore/u);
  assert.ok(existsSync(join(cwd, ".claude", "skills", "faberun", "SKILL.md")), "the faberun skill is installed");
  assert.ok(!existsSync(join(cwd, "AGENTS.md")), "the agent kit is optional and stays uninstalled");
  assert.match(result.stdout, /next · faberun doctor --cwd .* · faberun campaign init <id>/u);
});

test("a second init --yes is idempotent", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-idempotent-")));
  assert.equal(run(["init", "--yes"], cwd).status, 0);
  const second = run(["init", "--yes"], cwd);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(runsLines(cwd).length, 1, "exactly one .runs/ line");
  assert.match(second.stdout, /skipped faberun · exists, use --force/u);
});

test("--no-skill --yes installs nothing under .claude", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-no-skill-")));
  const result = run(["init", "--no-skill", "--yes"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(cwd, ".claude")), "no .claude directory is created");
  assert.deepEqual(runsLines(cwd), [".runs/"]);
});

test("--agentkit --greenfield --yes lays down AGENTS.md, docs and the CLAUDE.md symlink", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-agentkit-")));
  const result = run(["init", "--agentkit", "--greenfield", "--yes"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(cwd, "AGENTS.md")));
  assert.ok(existsSync(join(cwd, "docs", "VISION.md")));
  assert.ok(existsSync(join(cwd, "CLAUDE.md")));
  assert.equal(realpathSync(join(cwd, "CLAUDE.md")), realpathSync(join(cwd, "AGENTS.md")), "CLAUDE.md is the AGENTS.md symlink");
});

test("--json installs silently and reports the four facts", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-json-")));
  const result = run(["init", "--json", "--yes"], cwd);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, { cwd: realpathSync(cwd), runsIgnored: true, skillInstalled: true, agentkit: false });
  assert.ok(existsSync(join(cwd, ".claude", "skills", "faberun", "SKILL.md")));
});

test("--cwd prepares the given repository instead of the process cwd", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-cwd-")));
  const elsewhere = mkdtempSync(join(tmpdir(), "init-elsewhere-"));
  const result = run(["init", "--cwd", cwd, "--yes"], elsewhere);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(runsLines(cwd), [".runs/"]);
  assert.ok(existsSync(join(cwd, ".claude", "skills", "faberun", "SKILL.md")));
  assert.ok(!existsSync(join(elsewhere, ".claude")));
});

test("a non-git directory exits 1", () => {
  const cwd = mkdtempSync(join(tmpdir(), "init-not-git-"));
  const result = run(["init", "--yes"], cwd);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[fail\] git · .* is not a git work tree/u);
  assert.ok(!existsSync(join(cwd, ".gitignore")), "nothing is written before the git check passes");
});

test("--greenfield with --stable is a usage error", () => {
  const cwd = freshRepo(mkdtempSync(join(tmpdir(), "init-conflicting-")));
  const result = run(["init", "--greenfield", "--stable", "--yes"], cwd);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: faberun init /u);
  assert.ok(!existsSync(join(cwd, ".gitignore")), "the contradiction is refused before anything is written");
});
