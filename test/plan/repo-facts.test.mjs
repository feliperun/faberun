import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectRepoFacts, measureRequirements } from "../../src/plan/repo-facts.mjs";

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
 * A temp git repository holding exactly the given files, every one committed
 * so `git ls-files` reports it. Detection is a property of the tracked tree,
 * so each ecosystem fixture is a real repository rather than a bare directory.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function manifestRepo(files) {
  const directory = mkdtempSync(join(tmpdir(), "repo-facts-manifests-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  return directory;
}

/**
 * A measurer that fails the test if anything is ever run through it. A
 * repository with no measurable Node candidate must never reach the probe:
 * detection of another ecosystem's command is manifest inspection, not
 * execution.
 *
 * @returns {{now: () => number, run: typeof import("node:child_process").spawnSync}}
 */
function neverMeasure() {
  return {
    now: () => 0,
    run: /** @type {any} */ ((/** @type {string} */ file, /** @type {unknown[]} */ ...args) => {
      throw new Error(`detection executed a command: ${[file, ...args].join(" ")}`);
    }),
  };
}

/**
 * A fake measurer whose `run` advances a shared clock by a duration keyed on
 * the full command line, so `now()` — called once before and once after each
 * `run()` inside `timeVerificationCommands` — reports a deterministic elapsed
 * span without spawning anything real.
 *
 * A `measure` command reaches the same `run` as a one-argument spawn (`shell:
 * true` passes the whole line as the file), distinguished here by the second
 * argument not being an argv array; those calls return the canned result
 * keyed on the command line instead of a timing.
 *
 * @param {Record<string, number>} durationsMs
 * @param {Record<string, {status?: number|null, stdout?: string, stderr?: string}>} [commandResults]
 * @returns {{now: () => number, run: typeof import("node:child_process").spawnSync}}
 */
function fakeMeasure(durationsMs, commandResults = {}) {
  let clock = 0;
  return {
    now: () => clock,
    run: /** @type {any} */ ((/** @type {string} */ file, /** @type {unknown[]} */ ...rest) => {
      const args = /** @type {string[]|null} */ (Array.isArray(rest[0]) ? rest[0] : null);
      if (args === null) {
        const canned = commandResults[file] ?? {};
        return { status: canned.status ?? 0, signal: null, stdout: canned.stdout ?? "", stderr: canned.stderr ?? "" };
      }
      const key = [file, ...args].join(" ");
      clock += durationsMs[key] ?? 1_000;
      return { status: 0, signal: null };
    }),
  };
}

/**
 * A SpecRequirement-shaped fixture: `measureRequirements` reads only the id
 * and the measure proof off it.
 *
 * @param {string|null} id
 * @param {import("../../src/plan/spec.mjs").SpecProof|null} measure
 * @returns {import("../../src/plan/spec.mjs").SpecRequirement}
 */
function requirement(id, measure) {
  return { id, title: id ?? "untitled", statement: null, proof: null, measure, constraints: null, unknownBulletKeys: [], line: 1 };
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
    assert.equal(candidate.manifest, "package.json", `manifest for ${key} names package.json`);
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

test("repo facts say what they are about to measure and each command as it finishes", () => {
  const directory = fixtureRepo();
  /** @type {Parameters<import("../../src/plan/repo-facts.mjs").RepoFactsProgress>[0][]} */
  const events = [];
  collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS), onProgress: (event) => events.push(event) });

  // The list first, so a reader watching a stage that ran for minutes knows
  // what is still outstanding, then one event per command as it lands.
  assert.deepEqual(events[0], {
    kind: "commands",
    commands: [["node", "--test", "test/other"], ["node", "--test", "test/plan"], ["npm", "run", "check"], ["npm", "run", "typecheck"]],
  });
  assert.deepEqual(events.slice(1), [
    { kind: "measured", argv: ["node", "--test", "test/other"], measuredMs: 1_000, index: 1, total: 4 },
    { kind: "measured", argv: ["node", "--test", "test/plan"], measuredMs: 2_000, index: 2, total: 4 },
    { kind: "measured", argv: ["npm", "run", "check"], measuredMs: 5_000, index: 3, total: 4 },
    { kind: "measured", argv: ["npm", "run", "typecheck"], measuredMs: 3_000, index: 4, total: 4 },
  ]);
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

test("collectRepoFacts records a command measure and skips requirements without one", () => {
  const directory = fixtureRepo();
  const facts = collectRepoFacts(directory, {
    measure: fakeMeasure(DURATIONS, { "grep -c TODO src/plan/repo-facts.mjs": { status: 0, stdout: "2\n" } }),
    requirements: [
      requirement("R1", { kind: "command", ref: "grep -c TODO src/plan/repo-facts.mjs" }),
      requirement("R2", null),
    ],
  });
  assert.deepEqual(facts.requirementMeasurements, [
    { requirementId: "R1", command: "grep -c TODO src/plan/repo-facts.mjs", output: "2\n", exitCode: 0, truncated: false },
  ]);
});

test("a failing measure is recorded with its exit code, not thrown", () => {
  const directory = mkdtempSync(join(tmpdir(), "measure-requirements-"));
  const measurements = measureRequirements(
    directory,
    [requirement("R1", { kind: "command", ref: "grep -c ABSENT src/plan/repo-facts.mjs" })],
    fakeMeasure(DURATIONS, { "grep -c ABSENT src/plan/repo-facts.mjs": { status: 1 } }),
  );
  assert.deepEqual(measurements, [
    { requirementId: "R1", command: "grep -c ABSENT src/plan/repo-facts.mjs", output: "", exitCode: 1, truncated: false },
  ]);
});

test("measure output beyond 4096 bytes is cut to the cap and marked truncated", () => {
  const directory = mkdtempSync(join(tmpdir(), "measure-requirements-"));
  const measurements = measureRequirements(
    directory,
    [requirement("R1", { kind: "command", ref: "cat big.txt" })],
    fakeMeasure(DURATIONS, { "cat big.txt": { status: 0, stdout: "a".repeat(3000), stderr: "b".repeat(3000) } }),
  );
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].truncated, true);
  assert.equal(measurements[0].output, `${"a".repeat(3000)}${"b".repeat(1096)}`);
  assert.equal(Buffer.byteLength(measurements[0].output), 4096);
});

test("a requirement without a measure, or with a non-command kind, contributes nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "measure-requirements-"));
  const measurements = measureRequirements(
    directory,
    [
      requirement("R1", null),
      requirement("R2", { kind: "path", ref: "src/plan" }),
      requirement("R3", { kind: "judgment" }),
    ],
    fakeMeasure(DURATIONS),
  );
  assert.deepEqual(measurements, []);
});

test("repo facts find verification commands outside node", () => {
  const directory = manifestRepo({
    "pyproject.toml": "[project]\nname = \"fixture\"\n",
    "go.mod": "module example.test/fixture\n",
    "Cargo.toml": "[package]\nname = \"fixture\"\n",
    "build.zig": "pub fn build(b: *std.Build) void {}\n",
    "Makefile": ".PHONY: test\ntest:\n\tnode --test\n",
  });
  const facts = collectRepoFacts(directory, { measure: neverMeasure() });
  assert.deepEqual(facts.detectedVerificationCandidates, [
    { argv: ["pytest"], manifest: "pyproject.toml", measuredMs: null, eligible: true },
    { argv: ["go", "test", "./..."], manifest: "go.mod", measuredMs: null, eligible: true },
    { argv: ["cargo", "test"], manifest: "Cargo.toml", measuredMs: null, eligible: true },
    { argv: ["zig", "build", "test"], manifest: "build.zig", measuredMs: null, eligible: true },
    { argv: ["make", "test"], manifest: "Makefile", measuredMs: null, eligible: true },
  ]);
  assert.deepEqual(facts.verificationCandidates, [], "no Node candidate is measured in this repository");
  assert.deepEqual(
    collectRepoFacts(directory, { measure: neverMeasure() }),
    facts,
    "two calls at the same head produce identical detection",
  );
});

test("repo facts find verification commands outside node beside the package.json manifest", () => {
  const directory = manifestRepo({
    "package.json": JSON.stringify({ name: "fixture", scripts: { check: "tsc", typecheck: "tsc --noEmit" } }),
    "go.mod": "module example.test/fixture\n",
  });
  const facts = collectRepoFacts(directory, { measure: fakeMeasure(DURATIONS) });
  assert.deepEqual(facts.verificationCandidates, [
    { argv: ["npm", "run", "check"], manifest: "package.json", measuredMs: DURATIONS["npm run check"], eligible: true },
    { argv: ["npm", "run", "typecheck"], manifest: "package.json", measuredMs: DURATIONS["npm run typecheck"], eligible: true },
  ]);
  assert.deepEqual(facts.detectedVerificationCandidates, [
    { argv: ["go", "test", "./..."], manifest: "go.mod", measuredMs: null, eligible: true },
  ]);
  assert.equal(facts.detectedVerificationCandidates?.[0]?.measuredMs, null, "the detected command was never timed");
});

test("repo facts find verification commands outside node: pytest.ini stands in for pyproject.toml", () => {
  const directory = manifestRepo({ "pytest.ini": "[pytest]\n" });
  const facts = collectRepoFacts(directory, { measure: neverMeasure() });
  assert.deepEqual(facts.detectedVerificationCandidates, [{ argv: ["pytest"], manifest: "pytest.ini", measuredMs: null, eligible: true }]);
});

test("repo facts find verification commands outside node: pyproject.toml wins when both pytest manifests exist", () => {
  const directory = manifestRepo({ "pyproject.toml": "[project]\n", "pytest.ini": "[pytest]\n" });
  const facts = collectRepoFacts(directory, { measure: neverMeasure() });
  assert.deepEqual(facts.detectedVerificationCandidates, [{ argv: ["pytest"], manifest: "pyproject.toml", measuredMs: null, eligible: true }]);
});

test("repo facts find verification commands outside node: a Makefile without a test target adds no candidate", () => {
  for (const makefile of [
    "all:\n\tnode --test\n",
    "test := 1\nbuild:\n\tgo build\n",
    ".PHONY: test\nall:\n\tgo build\n",
  ]) {
    const directory = manifestRepo({ Makefile: makefile });
    const facts = collectRepoFacts(directory, { measure: neverMeasure() });
    assert.deepEqual(facts.detectedVerificationCandidates, [], `no make candidate is found for:\n${makefile}`);
  }
});
