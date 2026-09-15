import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { colorLevel, glyph, paint, renderBanner, renderUsage, statusToken, useUnicodeGlyphs } from "../../src/cli/brand.mjs";
import { packageVersion } from "../../src/host/package.mjs";

/** @param {string} text @returns {string} */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/gu, "");

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

// The banner reads `update-check.json` under `$FABERUN_HOME`; point it at an
// empty home so the rendered mark never depends on the developer's machine.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "faberun-brand-home-"));

test("colorLevel resolves DESIGN.md's capability order", () => {
  // NO_COLOR is checked first, whatever FORCE_COLOR says.
  assert.equal(colorLevel({ NO_COLOR: "1", FORCE_COLOR: "3" }, true), 0);
  assert.equal(colorLevel({ NO_COLOR: "", FORCE_COLOR: "3" }, true), 0);

  // FORCE_COLOR sets the level even on a non-TTY; empty means truecolor.
  assert.equal(colorLevel({ FORCE_COLOR: "1" }, false), 1);
  assert.equal(colorLevel({ FORCE_COLOR: "2" }, false), 2);
  assert.equal(colorLevel({ FORCE_COLOR: "3" }, false), 3);
  assert.equal(colorLevel({ FORCE_COLOR: "" }, false), 3);

  // Without a force, a pipe and a dumb terminal are monochrome.
  assert.equal(colorLevel({}, false), 0);
  assert.equal(colorLevel({ TERM: "dumb" }, true), 0);

  // A truecolor terminal, then the 256-color fallback.
  assert.equal(colorLevel({ COLORTERM: "truecolor" }, true), 3);
  assert.equal(colorLevel({ COLORTERM: "24bit" }, true), 3);
  assert.equal(colorLevel({ TERM: "xterm" }, true), 2);
});

test("paint emits the palette's 24-bit, 256-color and 16-color sequences", () => {
  assert.ok(paint("faberun", "brand", 3).includes("\u001b[38;2;181;82;42m"), "Terra truecolor");
  assert.ok(paint("x", "progress", 3).includes("\u001b[38;2;217;123;79m"), "Argila truecolor");
  assert.ok(paint("x", "ok", 3).includes("\u001b[38;2;85;107;63m"), "Folha truecolor");

  assert.ok(paint("x", "brand", 2).includes("\u001b[38;5;166m"), "Terra 256-color index");
  assert.ok(paint("x", "brand", 1).includes("\u001b[31m"), "Terra 16-color red");

  // bold for brand/warn/fail, the dim attribute for muted.
  assert.ok(paint("x", "brand", 3).includes("\u001b[1m"));
  assert.ok(paint("x", "warn", 3).includes("\u001b[1m"));
  assert.ok(paint("x", "fail", 3).includes("\u001b[1m"));
  assert.ok(paint("x", "muted", 3).includes("\u001b[2m"));

  // Level 0 returns the text untouched.
  assert.equal(paint("plain", "brand", 0), "plain");
  assert.equal(paint("plain", "muted", 0), "plain");
});

test("statusToken colors the token without changing its bracketed text", () => {
  for (const kind of /** @type {("ok"|"warn"|"fail")[]} */ (["ok", "warn", "fail"])) {
    assert.equal(statusToken(kind, 0), `[${kind}]`);
    const colored = statusToken(kind, 3);
    assert.match(colored, /\[(ok|warn|fail)\]/u);
    assert.equal(stripAnsi(colored), `[${kind}]`, "the bracketed text is the script contract");
  }
});

test("useUnicodeGlyphs and glyph follow the locale, with an ASCII fallback", () => {
  assert.equal(useUnicodeGlyphs({ LANG: "en_US.UTF-8", TERM: "xterm" }), true);
  assert.equal(useUnicodeGlyphs({ LC_ALL: "pt_BR.utf8", TERM: "xterm" }), true);
  assert.equal(useUnicodeGlyphs({ LANG: "en_US.UTF-8", TERM: "dumb" }), false);
  assert.equal(useUnicodeGlyphs({ LANG: "C", TERM: "xterm" }), false);
  assert.equal(glyph("ok", { LANG: "en_US.UTF-8", TERM: "xterm" }), "✓");
  assert.equal(glyph("ok", { LANG: "C", TERM: "xterm" }), "+");
  assert.equal(glyph("fail", { TERM: "dumb" }), "x");
});

test("renderBanner is five lines and reproduces the DESIGN.md drawing", () => {
  // The CLI fills the last line from the running process, so use realistic
  // values (package version, `process.version` without the `v`, the harness
  // binaries on PATH) rather than a short stand-in that flatters the width.
  const options = { version: "0.4.0", nodeVersion: "26.8.1", harnessCount: 5, level: 0, env: { FABERUN_HOME: EMPTY_HOME } };
  const banner = renderBanner(options);
  const lines = banner.replace(/\n$/u, "").split("\n");
  assert.equal(lines.length, 5, "exactly five lines");
  assert.deepEqual(lines, [
    "       .-~~~-.",
    "    .-'  .-.  '-.       faberun",
    "   /    (   )    \\      from intent to running software",
    "   \\     '-'     /",
    "    '-.._____..-'       v0.4.0 · node 26.8.1 · 5 harnesses detected",
  ], "the mark matches the drawing in DESIGN.md");
  // DESIGN.md says "five lines, at most 64 columns", but its own drawing is 67
  // on the fill line. The drawing is the byte-for-byte reference, so this pins
  // its width and records the doc's arithmetic instead of hiding it.
  assert.equal(Math.max(...lines.map((line) => line.length)), 67, "DESIGN.md's own drawing is 67 columns on the fill line");
  assert.match(banner, /faberun/u);
  assert.match(banner, /from intent to running software/u);
  assert.match(banner, /v0\.4\.0/u);

  // The level changes only the escape codes: the visible mark is identical.
  const colored = renderBanner({ ...options, level: 3 });
  assert.equal(stripAnsi(colored), banner);
  assert.notEqual(colored, banner, "level 3 paints the mark");
});

test("renderUsage prints one usage line per verb group", () => {
  const lines = renderUsage().trimEnd().split("\n");
  assert.ok(lines.length > 1, "the usage is no longer a single line");
  for (const line of lines) assert.match(line, /^usage: faberun /u);
  for (const verb of ["run", "preflight", "resume", "supervise", "status", "doctor", "setup", "init", "models", "next", "bulk-read", "contract", "metrics", "campaign", "seat", "skills"]) {
    assert.ok(renderUsage().includes(verb), `usage names ${verb}`);
  }
});

test("the installed entry prints --version as one plain line", () => {
  const result = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `faberun ${packageVersion()}\n`);
  assert.equal(result.stderr, "");
});

test("no arguments prints the usage to stdout with exit 0 and no banner off a TTY", () => {
  const result = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: faberun /u);
  assert.doesNotMatch(result.stdout, /\.-~~~-\./u, "a pipe never receives the banner");
  assert.doesNotMatch(result.stdout, /faberun\n/u, "the banner's wordmark line is absent");
  assert.equal(result.stderr, "");
});

test("an unknown verb prints the usage to stderr with exit 2 and never a banner", () => {
  const result = spawnSync(process.execPath, [BIN, "not-a-verb"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: faberun /u);
  assert.doesNotMatch(result.stderr, /\.-~~~-\./u);
  assert.equal(result.stdout, "");
});
