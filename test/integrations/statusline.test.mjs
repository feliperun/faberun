import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runsRoot } from "../../src/run/paths.mjs";

const scriptPath = fileURLToPath(new URL("../../integrations/claude-code/statusline.sh", import.meta.url));

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function makePointer(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-a",
    campaignId: "hb",
    state: "attention",
    checkpoints: { done: 3, total: 7 },
    activeNode: "node-a",
    runtime: "codex",
    elapsedSec: 185,
    costUsd: 4.2,
    needsYou: 2,
    attention: "waiting on the gate",
    generatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Write the pointer exactly like the bounded writer does: compact, one line.
 *
 * @param {string} directory
 * @param {Record<string, unknown>} [overrides]
 * @returns {string}
 */
function writePointer(directory, overrides = {}) {
  const runsDir = runsRoot(directory);
  mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, "status.json");
  writeFileSync(path, `${JSON.stringify(makePointer(overrides))}\n`);
  return path;
}

/**
 * Build the restricted PATH fixture: only the binaries the no-jq fallback
 * path uses, no jq and no date.
 *
 * @returns {{ binDir: string, env: NodeJS.ProcessEnv }}
 */
function restrictedEnv() {
  const binDir = mkdtempSync(join(tmpdir(), "if-statusline-bin-"));
  /** @type {[string, string[]][]} */
  const candidates = [
    ["sh", ["/bin/sh"]],
    ["sed", ["/usr/bin/sed", "/bin/sed"]],
    ["grep", ["/usr/bin/grep", "/bin/grep"]],
    ["wc", ["/usr/bin/wc", "/bin/wc"]],
    ["head", ["/usr/bin/head", "/bin/head"]],
    ["tr", ["/usr/bin/tr", "/bin/tr"]],
    ["cat", ["/bin/cat", "/usr/bin/cat"]],
  ];
  for (const [name, sources] of candidates) {
    const source = sources.find((path) => existsSync(path));
    assert.ok(source !== undefined, `no ${name} binary found`);
    symlinkSync(source, join(binDir, name));
  }
  return { binDir, env: { PATH: binDir } };
}

/**
 * Run the status-line script with a fixture session JSON for `directory`.
 *
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, unknown>} [session] extra session-JSON fields
 * @returns {string} stdout
 */
function render(directory, env, session = {}) {
  const result = spawnSync(scriptPath, [], {
    input: JSON.stringify({ cwd: directory, workspace: { current_dir: directory }, ...session }),
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** @param {string} stdout @returns {string} */
function singleLine(stdout) {
  assert.equal(stdout.endsWith("\n"), true, "exactly one line plus newline");
  const line = stdout.slice(0, -1);
  assert.equal(line.includes("\n"), false, "no embedded newline");
  return line;
}

test("statusline renders run id, state, active node, elapsed, cost and needs-you count", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-render-"));
  writePointer(directory);
  const line = singleLine(render(directory));
  assert.equal(line, "run-a · attention · node-a 3m05s · $4.2 · needs you: 2");
});

test("statusline degrades to the same line without jq", () => {
  const { binDir, env } = restrictedEnv();
  assert.equal(existsSync(join(binDir, "jq")), false, "jq must be absent from the degrade PATH");
  assert.equal(existsSync(join(binDir, "date")), false, "date must be absent from the degrade PATH");
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-nojq-"));
  writePointer(directory);
  const line = singleLine(render(directory, env));
  assert.equal(line, "run-a · attention · node-a 3m05s · $4.2 · needs you: 2");
});

test("statusline renders an idle run with no active node and no needs-you", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-idle-"));
  writePointer(directory, { state: "done", activeNode: null, runtime: null, elapsedSec: null, needsYou: 0, attention: null });
  assert.equal(singleLine(render(directory)), "run-a · done · - - · $4.2 · needs you: 0");
});

test("statusline formats elapsed seconds, minutes and hours", () => {
  for (const [elapsedSec, expected] of [[45, "45s"], [125, "2m05s"], [3725, "1h02m"]]) {
    const directory = mkdtempSync(join(tmpdir(), "if-statusline-elapsed-"));
    writePointer(directory, { elapsedSec });
    const line = singleLine(render(directory));
    assert.ok(line.includes(`node-a ${expected} ·`), `${line} expected elapsed ${expected}`);
  }
});

test("statusline renders a dash for a missing cost", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-nocost-"));
  writePointer(directory, { costUsd: null });
  const line = singleLine(render(directory));
  assert.ok(line.includes("· - · needs you:"), line);
});

test("statusline prints an empty line without a run, with no external tool required", () => {
  const withoutRuns = mkdtempSync(join(tmpdir(), "if-statusline-none-"));
  assert.equal(render(withoutRuns), "\n");

  const brokenDir = mkdtempSync(join(tmpdir(), "if-statusline-broken-"));
  mkdirSync(runsRoot(brokenDir), { recursive: true });
  writeFileSync(join(runsRoot(brokenDir), "status.json"), "not json at all\n");
  assert.equal(render(brokenDir), "\n");
});

test("statusline degrades silently on a pointer larger than the 1 KiB cap, with and without jq", () => {
  const { env } = restrictedEnv();
  for (const runnerEnv of [undefined, env]) {
    const directory = mkdtempSync(join(tmpdir(), "if-statusline-oversize-"));
    const path = writePointer(directory);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}${" ".repeat(2048)}`);
    assert.equal(render(directory, runnerEnv), "\n");
  }
});

test("seat allowance warning", () => {
  const directory = mkdtempSync(join(tmpdir(), "if-statusline-allowance-"));
  writePointer(directory);
  const base = "run-a · attention · node-a 3m05s · $4.2 · needs you: 2";
  /** @param {number} used @returns {Record<string, unknown>} */
  const rate = (used) => ({ rate_limits: { five_hour: { used_percentage: used, resets_at: 1_800_000_000 } } });

  const high = singleLine(render(directory, undefined, rate(91.5)));
  assert.ok(high.startsWith(base), `the run segment stays intact: ${high}`);
  assert.match(high, /\[warn\]/u, "above the threshold the line warns");
  assert.match(high, /91\.5%/u, "the warning reports the used percentage");
  assert.match(high, /85%/u, "the warning names the threshold");
  assert.match(high, /seat switch --harness/u, "the warning names the switch command");

  assert.equal(singleLine(render(directory, undefined, rate(84.9))), base, "below the threshold nothing is appended");
  assert.equal(singleLine(render(directory)), base, "no rate signal, no warning");

  // The nested field is not jq-only: the fallback reaches it too.
  const { binDir, env } = restrictedEnv();
  assert.equal(existsSync(join(binDir, "jq")), false, "jq must be absent from the degrade PATH");
  const noJq = singleLine(render(directory, env, rate(91.5)));
  assert.ok(noJq.startsWith(base), `the run segment stays intact: ${noJq}`);
  assert.match(noJq, /\[warn\]/u, "the no-jq fallback still warns above the threshold");
  assert.match(noJq, /seat switch --harness/u, "the no-jq fallback names the switch command");
  assert.equal(singleLine(render(directory, env, rate(84.9))), base, "the no-jq fallback stays quiet below the threshold");
});
