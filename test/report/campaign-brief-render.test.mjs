import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CampaignBriefRenderError,
  renderCampaignBriefHtml,
} from "../../src/report/campaign-brief-html.mjs";

/**
 * The renderer is an external CLI. Every case here runs a controlled executable
 * fixture written to a temp directory, never a network download and never the
 * operator's `mdhtml`. The fixture's `--version` and each subcommand are steered
 * by the environment, so success and every named failure are covered with no
 * conditional skip.
 */

const FIXTURE_SOURCE = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const fail = process.env.FIXTURE_FAIL ?? "";

function failIf(name) {
  if (fail === name) {
    process.stderr.write("mdhtml: E-TEST-01: " + name + " failed by fixture\n");
    process.exit(1);
  }
}

function option(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (command === "--version" || command === "version") {
  failIf("version");
  process.stdout.write((process.env.FIXTURE_VERSION ?? "mdhtml 1.1.3") + "\n");
  process.exit(0);
}

if (command === "build") {
  failIf("build");
  const input = args[1];
  const output = option("-o");
  if (!input || !output) {
    process.stderr.write("mdhtml: E-CLI-05: build requires <in.md> and -o\n");
    process.exit(2);
  }
  const source = readFileSync(input, "utf8");
  let theme = "";
  const themeLine = /^theme:\s*(.+)$/m.exec(source);
  if (themeLine) {
    const themeName = themeLine[1].trim().replace(/^"|"$/g, "");
    const themePath = join(dirname(resolve(input)), themeName);
    if (existsSync(themePath)) theme = readFileSync(themePath, "utf8");
  }
  const visible = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = "<!doctype html>\n<html lang=\"en\" data-mdhtml-preset=\"faberun\">\n<head><meta charset=\"utf-8\"><title>fixture</title>\n<style id=\"mdhtml-user\">" + theme + "</style>\n</head>\n<body><main>" + visible + "</main>\n<script type=\"application/octet-stream\" id=\"mdhtml-source\">" + Buffer.from(source, "utf8").toString("base64") + "</script>\n</body>\n</html>\n";
  writeFileSync(output, html);
  process.exit(0);
}

if (command === "check") {
  failIf("check");
  const requests = process.env.FIXTURE_CHECK_REQUESTS ?? "0";
  process.stdout.write("mdhtml: I-CLI-02: portable: true; requests: " + requests + "; content: 1 bytes; runtime: 1 bytes; fonts: 0 bytes; images: 0 bytes\n");
  process.exit(0);
}

if (command === "extract") {
  failIf("extract");
  const input = args[1];
  const output = option("-o");
  const html = readFileSync(input, "utf8");
  const match = /<script[^>]*id="mdhtml-source"[^>]*>([^<]*)<\/script>/.exec(html);
  if (!match) {
    process.stderr.write("mdhtml: E-CLI-03: source missing\n");
    process.exit(1);
  }
  const source = Buffer.from(match[1].trim(), "base64").toString("utf8");
  if (output) writeFileSync(output, source);
  else process.stdout.write(source);
  process.exit(0);
}

process.stderr.write("mdhtml: E-CLI-05: unknown command " + command + "\n");
process.exit(2);
`;

const EXAMPLE_MARKDOWN = [
  "# Campaign brief — campaign-brief",
  "",
  "## Decision",
  "",
  "- State: **ready for human review**",
  "",
  "## Coverage matrix",
  "",
  "| Requirement | Frozen nodes | Declared proof or verification | State |",
  "| --- | --- | --- | --- |",
  "| `R6` | `render` | command: npm run check:campaign-brief-render | covered |",
  "",
  "## Estimate",
  "",
  "- Cost: $1–$2 from 6 comparable samples",
  "",
].join("\n");

/** @returns {{dir: string, outputPath: string}} */
function outputSpace() {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-render-"));
  return { dir, outputPath: join(dir, "campaign-brief.md.html") };
}

/**
 * Write the executable fixture. On POSIX it is a shebang script with the
 * executable bit; on Windows a `.cmd` shim runs the same script through the
 * current Node binary.
 *
 * @returns {string}
 */
function fixtureBin() {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-mdhtml-"));
  const script = join(dir, "mdhtml-fixture.mjs");
  // The shebang resolves the running interpreter, never `node` on PATH.
  writeFileSync(script, `#!${process.execPath}\n${FIXTURE_SOURCE}`);
  if (process.platform === "win32") {
    const shim = join(dir, "mdhtml-fixture.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  chmodSync(script, 0o755);
  return script;
}

/**
 * @param {string} key
 * @param {string} value
 * @param {() => void} body
 * @returns {void}
 */
function withEnv(key, value, body) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/**
 * @param {string} code
 * @returns {(error: unknown) => boolean}
 */
function isNamedFailure(code) {
  return (error) => error instanceof CampaignBriefRenderError && error.code === code;
}

/**
 * @param {string} markdown
 * @param {import("../../src/report/campaign-brief-html.mjs").RenderCampaignBriefHtmlOptions} options
 * @returns {import("../../src/report/campaign-brief-html.mjs").RenderCampaignBriefHtmlResult}
 */
function render(markdown, options) {
  return renderCampaignBriefHtml(markdown, { title: "Campaign brief", ...options });
}

test("renders a self-contained themed copy and preserves the brief source", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  const result = render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath });
  assert.equal(result.version, "1.1.3");
  assert.equal(result.outputPath, outputPath);
  assert.ok(existsSync(outputPath), "the rendered copy exists");
  const html = readFileSync(outputPath, "utf8");
  for (const marker of ["#f4e9d8", "#1f1f1f", "#b5522a", "#93aa70", "ui-sans-serif", "ui-monospace"]) {
    assert.ok(html.toLowerCase().includes(marker), `theme marker ${marker}`);
  }
  for (const fact of ["ready for human review", "R6", "covered", "$1–$2"]) {
    assert.ok(html.includes(fact), `rendered review fact ${fact}`);
  }
  assert.doesNotMatch(html, /https?:\/\//iu, "the copy makes no network request");
});

test("accepts at least 1.1.3 within major version 1 and nothing else", () => {
  for (const good of ["1.1.3", "1.1.4", "1.2.0", "1.99.0"]) {
    const bin = fixtureBin();
    const { outputPath } = outputSpace();
    withEnv("FIXTURE_VERSION", `mdhtml ${good}`, () => {
      assert.equal(render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }).version, good);
    });
  }
  for (const bad of ["1.1.2", "1.0.0", "2.0.0", "0.9.9"]) {
    const bin = fixtureBin();
    const { outputPath } = outputSpace();
    withEnv("FIXTURE_VERSION", `mdhtml ${bad}`, () => {
      assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_INCOMPATIBLE"));
    });
  }
});

test("renders with a later 1.x renderer", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  withEnv("FIXTURE_VERSION", "mdhtml 1.4.0", () => {
    const result = render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath });
    assert.equal(result.version, "1.4.0");
  });
  assert.ok(existsSync(outputPath));
});

test("names an older renderer as incompatible and writes no HTML", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  withEnv("FIXTURE_VERSION", "mdhtml 1.1.2", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_INCOMPATIBLE"));
  });
  assert.equal(existsSync(outputPath), false);
});

test("names an absent renderer and writes no HTML", () => {
  const { outputPath } = outputSpace();
  const missing = join(mkdtempSync(join(tmpdir(), "campaign-brief-missing-")), "mdhtml");
  assert.equal(existsSync(missing), false);
  assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: missing, outputPath }), isNamedFailure("MDHTML_UNAVAILABLE"));
  assert.equal(existsSync(outputPath), false);
});

test("names a failing build and writes no HTML", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  withEnv("FIXTURE_FAIL", "build", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_BUILD_FAILED"));
  });
  assert.equal(existsSync(outputPath), false);
});

test("names a failing portability check", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  withEnv("FIXTURE_CHECK_REQUESTS", "1", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_CHECK_FAILED"));
  });
  assert.equal(existsSync(outputPath), false);
});

test("names a source that the rendered copy does not carry", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  withEnv("FIXTURE_FAIL", "extract", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_SOURCE_MISMATCH"));
  });
  assert.equal(existsSync(outputPath), false);
});

test("removes a prior HTML copy when a rebuild fails", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  writeFileSync(outputPath, "<!doctype html><html>stale copy</html>\n");
  withEnv("FIXTURE_FAIL", "check", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_CHECK_FAILED"));
  });
  assert.equal(existsSync(outputPath), false, "the stale copy is gone");
});

test("leaves the Markdown untouched when rendering fails", () => {
  const bin = fixtureBin();
  const { dir, outputPath } = outputSpace();
  const markdownPath = join(dir, "campaign-brief.md");
  writeFileSync(markdownPath, EXAMPLE_MARKDOWN, "utf8");
  withEnv("FIXTURE_FAIL", "build", () => {
    assert.throws(() => render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }), isNamedFailure("MDHTML_BUILD_FAILED"));
  });
  assert.equal(readFileSync(markdownPath, "utf8"), EXAMPLE_MARKDOWN);
});

test("the committed manifest is the pinned, checksummed mdhtml release", () => {
  const release = JSON.parse(readFileSync(new URL("../../src/report/mdhtml-release.json", import.meta.url), "utf8"));
  assert.equal(release.schema, "faberun/mdhtml-release/1");
  assert.equal(release.repo, "feliperun/md.html");
  assert.equal(release.tag, "v1.1.3");
  assert.equal(release.version, "1.1.3");
  assert.equal(release.major, 1);
  assert.equal(release.minimumVersion, "1.1.3");
  assert.deepEqual(Object.keys(release.assets).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64-gnu",
    "linux-x64-musl",
    "windows-x64",
  ]);
  for (const [key, asset] of Object.entries(release.assets)) {
    assert.equal(asset.file, `mdhtml-1.1.3-${key}.tar.gz`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u, `${key} checksum`);
  }
});

test("the theme uses the DESIGN.md palette, contrast tints and system typography", () => {
  const bin = fixtureBin();
  const { outputPath } = outputSpace();
  const lower = render(EXAMPLE_MARKDOWN, { mdhtmlBin: bin, outputPath }).html.toLowerCase();
  for (const hex of ["#f4e9d8", "#1f1f1f", "#b5522a", "#d97b4f", "#556b3f", "#e0875f", "#ecab86", "#93aa70"]) {
    assert.ok(lower.includes(hex), `palette ${hex}`);
  }
  assert.match(lower, /ui-sans-serif/u);
  assert.match(lower, /ui-monospace/u);
  assert.doesNotMatch(lower, /@import|https?:\/\//iu);
});

test("the renderer suite declares every case unconditionally", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /test\([^)]*,\s*\{\s*skip/u);
});
