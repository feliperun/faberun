import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostLayoutFindings } from "../host-layout-guard.mjs";

const TEST_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Directories the recursive walk must never descend into. */
const SKIPPED = new Set([".git", "node_modules"]);

/** This guard's own file, and this test file, name themselves in their own examples. */
const FILE_EXEMPT = new Set(["host-layout-guard.mjs", "host-layout.test.mjs"]);

/** @param {string} dir @returns {string[]} absolute paths of every `.mjs` file below `dir` */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) found.push(...walk(path));
    } else if (entry.isFile() && path.endsWith(".mjs") && !FILE_EXEMPT.has(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

test("no test file assumes a host-specific PATH, version manager, platform branch, or fixture shebang", () => {
  const findings = walk(TEST_DIR).flatMap((path) => {
    const label = relative(TEST_DIR, path).split(sep).join("/");
    return hostLayoutFindings(readFileSync(path, "utf8"), label);
  });
  assert.deepEqual(
    findings,
    [],
    `host-layout assumption(s):\n${findings.map((f) => `  ${f.fileName}:${f.line}  [${f.rule}]  ${f.text}`).join("\n")}`,
  );
});

test("flags a PATH rebuilt from an absolute system directory, not one built from a variable", () => {
  const source = `
    process.env.PATH = "/usr/bin:/opt/homebrew/bin";
    process.env.PATH = someDirectory;
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs").filter((f) => f.rule === "path-from-system-directory");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("flags asdf, nvm and .tool-versions wherever they appear, in code, a string, or a comment", () => {
  const source = `
    // asdf and nvm are both mentioned here, in a comment
    const message = "nvm is not installed";
    const managers = [asdf, nvm];
    readFileSync(".tool-versions");
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs").filter((f) => f.rule === "version-manager-reference");
  assert.deepEqual(findings.map((f) => f.line), [2, 2, 3, 4, 4, 5]);
});

test("guard-exempt: host-layout silences a version-manager reference on the marker's own line", () => {
  const source = `
    // guard-exempt: host-layout the installer documents the asdf fallback path
    const managers = [asdf, nvm];
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs");
  assert.deepEqual(findings, []);
});

test("flags process.platform only when it shares a line with an assert call", () => {
  const source = `
    const platform = process.platform;
    assert.equal(process.platform, "darwin");
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs").filter((f) => f.rule === "platform-in-assertion");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

test("flags a fixture shebang that resolves node through PATH, on raw text inside a string", () => {
  const source = `
    writeFileSync(path, "#!/usr/bin/env node\\nconsole.log('hi');\\n");
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs").filter((f) => f.rule === "fixture-shebang");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
});

test("guard-exempt: host-layout with a reason silences the finding on its line and the next", () => {
  const source = `
    // guard-exempt: host-layout a documented, reviewed exception
    process.env.PATH = "/usr/bin";
  `;
  assert.deepEqual(hostLayoutFindings(source, "synthetic.mjs"), []);
});

test("guard-exempt: host-layout with no reason is itself a finding, and does not silence the line below it", () => {
  const source = `
    // guard-exempt: host-layout
    process.env.PATH = "/usr/bin";
  `;
  const findings = hostLayoutFindings(source, "synthetic.mjs");
  assert.deepEqual(findings.map((f) => f.rule), ["guard-exempt-missing-reason", "path-from-system-directory"]);
  assert.deepEqual(findings.map((f) => f.line), [2, 3]);
});
