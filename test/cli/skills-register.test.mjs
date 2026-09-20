import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));
const CHECKOUT_SKILL = fileURLToPath(new URL("../../skills/faberun", import.meta.url));

/**
 * A throwaway `HOME` (the three skills directories named by the measured
 * conventions) and a `PATH` holding fake harness binaries. The PATH is
 * deliberately narrow so the real machine's harnesses never leak into the set.
 *
 * @param {{harnesses?: string[], dirs?: string[]}} [options]
 * @returns {{home: string, env: Record<string, string|undefined>}}
 */
function fixture(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "skills-register-home-"));
  const bin = mkdtempSync(join(tmpdir(), "skills-register-bin-"));
  for (const dir of options.dirs ?? [".claude/skills", ".codex/skills", ".agents/skills"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  for (const harness of options.harnesses ?? ["claude", "codex"]) {
    const path = join(bin, harness);
    writeFileSync(path, `#!${process.execPath}\nconsole.log("fake ${harness} 1.0.0");\n`);
    chmodSync(path, 0o755);
  }
  // The system directories are POSIX names and the separator is the platform's:
  // a PATH joined with `:` on Windows is one entry that names nothing, which
  // reports every harness uninstalled rather than testing the registration.
  const path = [bin, ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(delimiter);
  return { home, env: { ...process.env, HOME: home, PATH: path } };
}

/**
 * The `~`-prefixed path the human lines carry, as a regular expression source.
 * The separator is the platform's, so the line reads `~\.claude\skills` on
 * Windows and `~/.claude/skills` everywhere else.
 *
 * @param {...string} segments
 * @returns {string}
 */
function homePath(...segments) {
  return ["~", ...segments].join(sep).replace(/[.\\]/gu, "\\$&");
}

/**
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function register(args, env) {
  const result = spawnSync(process.execPath, [BIN, "skills", "register", ...args], { env, encoding: "utf8" });
  return {
    status: /** @type {number|null} */ (result.status),
    stdout: /** @type {string} */ (result.stdout),
    stderr: /** @type {string} */ (result.stderr),
  };
}

test("register --json links faberun into claude, codex and the shared agents directory", () => {
  const { home, env } = fixture();
  const result = register(["--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{harness: string, dir: string, action: string}[]} */ (JSON.parse(result.stdout));
  assert.deepEqual(
    payload.filter((entry) => entry.action === "linked").map((entry) => entry.harness).sort(),
    ["agents", "claude", "codex"],
  );
  for (const dir of [".claude/skills", ".codex/skills", ".agents/skills"]) {
    const link = join(home, dir, "faberun");
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${dir}/faberun is a symlink`);
    assert.equal(realpathSync(link), realpathSync(CHECKOUT_SKILL), `${dir}/faberun resolves to this checkout`);
  }
});

test("a second register reports unchanged", () => {
  const { env } = fixture();
  assert.equal(register([], env).status, 0);
  const second = register([], env);
  assert.equal(second.status, 0, second.stderr);
  for (const harness of ["claude", "codex", "agents"]) {
    assert.match(second.stdout, new RegExp(`\\[ok\\] ${harness} · ${homePath(`.${harness}`, "skills", "faberun")} · unchanged`, "u"));
  }
});

test("a real directory in the way is refused without --force and replaced with it", () => {
  const { home, env } = fixture();
  const blocker = join(home, ".claude", "skills", "faberun");
  mkdirSync(blocker);
  writeFileSync(join(blocker, "SKILL.md"), "mine\n");

  const refused = register(["--harness", "claude", "--json"], env);
  assert.equal(refused.status, 0, refused.stderr);
  const first = /** @type {{action: string}[]} */ (JSON.parse(refused.stdout))[0];
  assert.equal(first.action, "skipped");
  assert.equal(readFileSync(join(blocker, "SKILL.md"), "utf8"), "mine\n", "the real directory is untouched");

  const forced = register(["--harness", "claude", "--force", "--json"], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(/** @type {{action: string}[]} */ (JSON.parse(forced.stdout))[0].action, "linked");
  assert.equal(lstatSync(blocker).isSymbolicLink(), true);
  assert.equal(realpathSync(blocker), realpathSync(CHECKOUT_SKILL));
});

test("--copy lays down a real skill tree", () => {
  const { home, env } = fixture();
  const result = register(["--harness", "claude", "--copy", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(/** @type {{action: string}[]} */ (JSON.parse(result.stdout))[0].action, "copied");
  const tree = join(home, ".claude", "skills", "faberun");
  assert.equal(lstatSync(tree).isSymbolicLink(), false, "the copy is a real directory");
  // `\r?`: what is asserted is that the copy carries the real SKILL.md, and a
  // checkout under git's default `core.autocrlf=true` on Windows — GitHub's
  // runner is one — hands it over with CRLF.
  assert.match(readFileSync(join(tree, "SKILL.md"), "utf8"), /^---\r?\nname: faberun/u);
});

test("a missing skills directory is a warn line, not an error", () => {
  const { home, env } = fixture({ harnesses: ["agy"], dirs: [] });
  const result = register(["--harness", "agy"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`\\[warn\\] agy · no skills directory \\(${homePath(".gemini", "config", "skills")}\\)`, "u"));
  assert.equal(existsSync(join(home, ".gemini", "config", "skills", "faberun")), false);
});

test("--harness limits the set", () => {
  const { env } = fixture();
  const result = register(["--harness", "claude", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{harness: string}[]} */ (JSON.parse(result.stdout));
  assert.deepEqual(payload.map((entry) => entry.harness), ["claude"]);
});

test("an unknown harness is a usage error", () => {
  const { env } = fixture();
  const result = register(["--harness", "nope"], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no harness named "nope"/u);
});
