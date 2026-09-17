import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectRepoFacts } from "../../src/plan/repo-facts.mjs";

/**
 * @returns {string} a temp git repository with a package.json, two src
 *   modules, and two test directories (one whose test file covers a src
 *   module, one whose test file covers nothing).
 */
function fixtureRepo() {
  const directory = mkdtempSync(join(tmpdir(), "repo-facts-fixture-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { check: "node --check src/*.mjs", typecheck: "tsc", test: "node --test test/*/*.test.mjs" },
  }, null, 2));
  mkdirSync(join(directory, "src", "plan"), { recursive: true });
  writeFileSync(join(directory, "src", "plan", "repo-facts.mjs"), "export const owner = true;\n");
  mkdirSync(join(directory, "test", "plan"), { recursive: true });
  writeFileSync(join(directory, "test", "plan", "repo-facts.test.mjs"), "// covers src/plan/repo-facts.mjs\n");
  mkdirSync(join(directory, "test", "other"), { recursive: true });
  writeFileSync(join(directory, "test", "other", "nope.test.mjs"), "// covers nothing\n");
  writeFileSync(join(directory, "test", "helpers.mjs"), "// not a *.test.mjs file, never a candidate or a test file entry\n");
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  return directory;
}

/**
 * A fake measurer whose `run` advances a shared clock by a duration keyed on
 * the full command line, so `now()` — called once before and once after each
 * `run()` inside `timeVerificationCommands` — reports a deterministic elapsed
 * span without spawning anything real.
 *
 * @param {Record<string, number>} durationsMs
 * @returns {{now: () => number, run: typeof import("node:child_process").spawnSync}}
 */
function fakeMeasure(durationsMs) {
  let clock = 0;
  return {
    now: () => clock,
    run: /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args) => {
      const key = [file, ...args].join(" ");
      clock += durationsMs[key] ?? 1_000;
      return { status: 0, signal: null };
    }),
  };
}

/** @type {Record<string, number>} */
const DURATIONS = {
  "node --test test/other": 1_000,
  "node --test test/plan": 2_000,
  "npm run check": 5_000,
  "npm run typecheck": 3_000,
};

test("collectRepoFacts emits a deterministic JSON inventory built with no model", () => {
  const directory = fixtureRepo();
  const head = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const facts = collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS) });

  assert.equal(facts.formatVersion, 1);
  assert.equal(facts.gitHead, head);
  assert.equal(facts.truncated, false);
  assert.deepEqual(facts.paths, [...facts.paths].sort(), "paths are sorted");
  assert.ok(facts.paths.includes("package.json"));
  assert.ok(facts.paths.includes("test/plan/repo-facts.test.mjs"));
  assert.deepEqual(facts.scripts, { check: "node --check src/*.mjs", typecheck: "tsc", test: "node --test test/*/*.test.mjs" });

  assert.deepEqual(
    facts.verificationCandidates.map((candidate) => candidate.argv),
    [
      ["node", "--test", "test/other"],
      ["node", "--test", "test/plan"],
      ["npm", "run", "check"],
      ["npm", "run", "typecheck"],
    ],
  );
  for (const candidate of facts.verificationCandidates) {
    const key = candidate.argv.join(" ");
    assert.equal(candidate.measuredMs, DURATIONS[key], `measuredMs for ${key} came from the injected measurer, not an estimate`);
    assert.equal(candidate.eligible, true);
  }

  assert.deepEqual(
    facts.testFiles.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "test/other/nope.test.mjs", covers: null },
      { path: "test/plan/repo-facts.test.mjs", covers: "src/plan/repo-facts.mjs" },
    ],
  );
});

test("a candidate above the 600000ms ceiling is eligible false", () => {
  const directory = fixtureRepo();
  const facts = collectRepoFacts(directory, {
    measure: fakeMeasure({ ...DURATIONS, "node --test test/plan": 644_000 }),
  });
  const slow = facts.verificationCandidates.find((candidate) => candidate.argv.join(" ") === "node --test test/plan");
  assert.equal(slow?.measuredMs, 644_000);
  assert.equal(slow?.eligible, false);
  const fast = facts.verificationCandidates.find((candidate) => candidate.argv.join(" ") === "node --test test/other");
  assert.equal(fast?.eligible, true);
});

test("two calls at the same HEAD are deep-equal", () => {
  const directory = fixtureRepo();
  const first = collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS) });
  const second = collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS) });
  assert.deepEqual(first, second);
});

test("the paths cap sets truncated and bounds the returned paths array", () => {
  const directory = fixtureRepo();
  const facts = collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS), maxPaths: 2 });
  assert.equal(facts.truncated, true);
  assert.equal(facts.paths.length, 2);
});
