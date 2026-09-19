import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { RUNS_DIR_NAME, runsRoot } from "../../src/run/paths.mjs";

const scriptPath = fileURLToPath(new URL("../../integrations/claude-code/statusline.sh", import.meta.url));

/**
 * A fresh, empty directory standing in for a repository, realpath-resolved:
 * the project registry keys on it, since $TMPDIR itself is a symlink on
 * macOS (`/var` -> `/private/var`), and the script under test reads its own
 * `cwd` from the session JSON verbatim, with no normalization of its own.
 *
 * @param {string} prefix
 * @returns {string}
 */
function repoDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

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
 * Write the pointer exactly like the bounded writer does — compact, one
 * line, at the runs root the resolver answers. A repository that has never
 * run resolves fresh, so this lands on the home side and registers the
 * project in the index the status-line script reads.
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
 * Point `FABERUN_HOME` at a fresh temporary directory for the duration of
 * `run`, so no test registers a repository in, or reads a pointer from, the
 * operator's real home.
 *
 * @param {(home: string) => void} run
 * @returns {string} the temporary home
 */
function withTemporaryHome(run) {
  const home = mkdtempSync(join(tmpdir(), "if-statusline-home-"));
  const previous = process.env.FABERUN_HOME;
  process.env.FABERUN_HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_HOME;
    else process.env.FABERUN_HOME = previous;
  }
  return home;
}

/**
 * Build the restricted PATH fixture: only the binaries the no-jq fallback
 * path uses, no jq and no date. Everything else in the environment passes
 * through, so the FABERUN_HOME the test installed reaches the script.
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
  return { binDir, env: { ...process.env, PATH: binDir } };
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

test("statusline renders the pointer at the home-side runs root the resolver answers", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-render-");
    const path = writePointer(directory);
    assert.equal(path.includes(`${sep}projects${sep}`), true, "the pointer lives under the home's project registry, not the repository");
    assert.equal(existsSync(join(directory, RUNS_DIR_NAME, "status.json")), false, "nothing is written in-tree");
    const line = singleLine(render(directory));
    assert.equal(line, "run-a · attention · node-a 3m05s · $4.2 · needs you: 2");
  });
});

test("statusline resolves the project through the registry with and without jq", () => {
  withTemporaryHome(() => {
    // Inside the temporary home, so the restricted env captures FABERUN_HOME.
    const { binDir, env } = restrictedEnv();
    assert.equal(existsSync(join(binDir, "jq")), false, "jq must be absent from the degrade PATH");
    assert.equal(existsSync(join(binDir, "date")), false, "date must be absent from the degrade PATH");
    const withJq = repoDir("if-statusline-nojq-");
    writePointer(withJq);
    assert.equal(singleLine(render(withJq)), "run-a · attention · node-a 3m05s · $4.2 · needs you: 2");
    const withoutJq = repoDir("if-statusline-nojq-2-");
    writePointer(withoutJq);
    assert.equal(singleLine(render(withoutJq, env)), "run-a · attention · node-a 3m05s · $4.2 · needs you: 2", "the no-jq fallback reads the same registry the jq path does");
  });
});

test("statusline still reads a repository whose runs never moved to the home", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-legacy-");
    // The pre-migration layout: the pointer in-tree, the project never
    // registered, the index absent. R7 keeps this reading side alive for one
    // version.
    mkdirSync(join(directory, RUNS_DIR_NAME), { recursive: true });
    writeFileSync(join(directory, RUNS_DIR_NAME, "status.json"), `${JSON.stringify(makePointer())}\n`);
    const line = singleLine(render(directory));
    assert.equal(line, "run-a · attention · node-a 3m05s · $4.2 · needs you: 2");
  });
});

test("statusline prefers the home side when both layouts hold a pointer, like the resolver", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-both-");
    writePointer(directory, { runId: "home-run" });
    mkdirSync(join(directory, RUNS_DIR_NAME), { recursive: true });
    writeFileSync(join(directory, RUNS_DIR_NAME, "status.json"), `${JSON.stringify(makePointer({ runId: "legacy-run" }))}\n`);
    assert.match(singleLine(render(directory)), /^home-run ·/u, "the home copy is authoritative once it exists");
  });
});

test("statusline renders an idle run with no active node and no needs-you", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-idle-");
    writePointer(directory, { state: "done", activeNode: null, runtime: null, elapsedSec: null, needsYou: 0, attention: null });
    assert.equal(singleLine(render(directory)), "run-a · done · - - · $4.2 · needs you: 0");
  });
});

test("statusline formats elapsed seconds, minutes and hours", () => {
  withTemporaryHome(() => {
    for (const [elapsedSec, expected] of [[45, "45s"], [125, "2m05s"], [3725, "1h02m"]]) {
      const directory = repoDir("if-statusline-elapsed-");
      writePointer(directory, { elapsedSec });
      const line = singleLine(render(directory));
      assert.ok(line.includes(`node-a ${expected} ·`), `${line} expected elapsed ${expected}`);
    }
  });
});

test("statusline renders a dash for a missing cost", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-nocost-");
    writePointer(directory, { costUsd: null });
    const line = singleLine(render(directory));
    assert.ok(line.includes("· - · needs you:"), line);
  });
});

test("statusline prints an empty line without a run, with no external tool required", () => {
  withTemporaryHome(() => {
    const withoutRuns = repoDir("if-statusline-none-");
    assert.equal(render(withoutRuns), "\n");

    const brokenDir = repoDir("if-statusline-broken-");
    mkdirSync(runsRoot(brokenDir), { recursive: true });
    writeFileSync(join(runsRoot(brokenDir), "status.json"), "not json at all\n");
    assert.equal(render(brokenDir), "\n");
  });
});

test("statusline degrades silently on a pointer larger than the 1 KiB cap, with and without jq", () => {
  withTemporaryHome(() => {
    const { env } = restrictedEnv();
    for (const runnerEnv of [undefined, env]) {
      const directory = repoDir("if-statusline-oversize-");
      const path = writePointer(directory);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, `${original}${" ".repeat(2048)}`);
      assert.equal(render(directory, runnerEnv), "\n");
    }
  });
});

test("seat allowance warning", () => {
  withTemporaryHome(() => {
    const directory = repoDir("if-statusline-allowance-");
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
});
