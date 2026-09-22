import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, validateSpec } from "../../src/plan/spec.mjs";
import { runtimeImportGraph } from "../../src/repo/scope-closure.mjs";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/**
 * A minimal structured spec, valid against every rule the validator checks.
 *
 * @param {string} baseline
 * @returns {string}
 */
const VALID_SPEC = (baseline) => `---
id: feature-42
title: "Deliver feature 42"
version: 1.0.0
status: draft
date: 2026-09-17
owner: Test Owner
target: feliperun/faberun
baseline: ${baseline}
---

# Deliver feature 42

## Intent

Ship feature 42.

## Requirements

### R1. Feature 42 works

- **statement:** feature 42 behaves as described.
- **proof:** \`command: node --test test/feature.test.mjs\`

## Non-goals

- Anything outside feature 42.

## Success criteria

| Metric | Baseline | Target |
| --- | --- | --- |
| Coverage | 0 | 100 |
`;

/**
 * A throwaway git repository whose HEAD commit sha is known, so `baseline`
 * resolution and `target`/origin matching can be exercised without touching
 * this repository's own history.
 *
 * @returns {{dir: string, head: string}}
 */
function initFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "spec-validate-"));
  /** @param {string[]} args @returns {string} */
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["-c", "user.email=test@example.test", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "root"]);
  git(["remote", "add", "origin", "git@github.com:feliperun/faberun.git"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  return { dir, head };
}

test("parseSpec reads front matter, sections and requirements", () => {
  const { head } = initFixtureRepo();
  const parsed = parseSpec(VALID_SPEC(head));
  assert.equal(parsed.frontMatter?.id, "feature-42");
  assert.equal(parsed.frontMatter?.title, "Deliver feature 42");
  assert.ok(parsed.sections.has("intent"));
  assert.ok(parsed.sections.has("non-goals"));
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.requirements[0].id, "R1");
  assert.deepEqual(parsed.requirements[0].proof, { kind: "command", ref: 'node --test test/feature.test.mjs' });
});

test("parseSpec reads measure as the same proof shape, or null without one", () => {
  const text = `## Requirements

### R1. Counted before drafting

- **statement:** the planner measures this instead of inferring it.
- **proof:** \`command: node --test test/plan/spec.test.mjs\`
- **measure:** \`command: grep -rn "TODO" src | wc -l\`

### R2. Nothing to measure

- **statement:** no fact precedes the draft here.
- **proof:** \`command: node --test test/plan/spec.test.mjs\`
`;
  const parsed = parseSpec(text);
  assert.deepEqual(parsed.requirements[0].measure, { kind: "command", ref: 'grep -rn "TODO" src | wc -l' });
  assert.equal(parsed.requirements[1].measure, null);
});

test("spec validate invokes no model", () => {
  const graph = runtimeImportGraph(SRC_DIR);
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {string[]} */
  const queue = ["plan/spec.mjs"];
  while (queue.length) {
    const path = queue.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    for (const dependency of graph.get(path) ?? []) queue.push(dependency);
  }
  for (const path of visited) {
    assert.ok(!path.startsWith(`harnesses${sep}`) && !path.startsWith("harnesses/"), `plan/spec.mjs reaches ${path}, under harnesses/`);
    assert.ok(!path.startsWith(`engine${sep}`) && !path.startsWith("engine/"), `plan/spec.mjs reaches ${path}, under engine/`);
  }

  const { head, dir } = initFixtureRepo();
  /** @type {Record<string, string|undefined>} */
  const savedEnv = {};
  for (const name of ["FABERUN_CLAUDE_BIN", "FABERUN_CODEX_BIN", "FABERUN_AGY_BIN", "FABERUN_DSH_BIN", "FABERUN_ZCODE_BIN"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const result = validateSpec(VALID_SPEC(head), { cwd: dir });
    assert.equal(result.class, "structured");
    assert.equal(result.ok, true);
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("legacy documents are accepted and named", () => {
  const result = validateSpec("# An old campaign proposal\n\nNo front matter here.\n");
  assert.equal(result.class, "legacy");
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule, "legacy-document");
});

test("spec validate rejects", async (t) => {
  const { head, dir } = initFixtureRepo();

  await t.test("requirement without a stable id", () => {
    const text = VALID_SPEC(head).replace("### R1. Feature 42 works", "### Feature 42 works");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true, "advisory by default");
    assert.ok(result.findings.some((finding) => finding.rule === "requirement-missing-id" && finding.severity === "advisory"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false, "blocking under --strict-traceability");
    assert.ok(strict.findings.some((finding) => finding.rule === "requirement-missing-id" && finding.severity === "blocking"));
  });

  await t.test("requirement without proof", () => {
    const text = VALID_SPEC(head).replace(/- \*\*proof:\*\* .*\n/u, "");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.findings.some((finding) => finding.rule === "requirement-missing-proof"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false);
  });

  await t.test("missing Non-goals section", () => {
    const text = VALID_SPEC(head).replace(/## Non-goals\n\n- Anything outside feature 42\.\n\n/u, "");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.findings.some((finding) => finding.rule === "missing-non-goals"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false);
  });

  await t.test("Success criteria row without a Baseline value", () => {
    const text = VALID_SPEC(head).replace("| Coverage | 0 | 100 |", "| Coverage | | 100 |");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.findings.some((finding) => finding.rule === "success-criteria-missing-baseline"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false);
  });

  await t.test("baseline that does not resolve to a commit", () => {
    const text = VALID_SPEC("0000000000000000000000000000000000000000");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.findings.some((finding) => finding.rule === "baseline-unresolved"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false);
  });

  await t.test("target that does not match the origin remote", () => {
    const text = VALID_SPEC(head).replace("target: feliperun/faberun", "target: someone-else/unrelated");
    const result = validateSpec(text, { cwd: dir });
    assert.equal(result.ok, true);
    assert.ok(result.findings.some((finding) => finding.rule === "target-unresolved"));
    const strict = validateSpec(text, { cwd: dir, strict: true });
    assert.equal(strict.ok, false);
  });
});

test("faberun spec validate and scaffold through the CLI", () => {
  const { head, dir } = initFixtureRepo();
  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, VALID_SPEC(head));
  const validated = spawnSync(process.execPath, [CLI_PATH, "spec", "validate", specPath, "--json"], { encoding: "utf8", cwd: dir });
  assert.equal(validated.status, 0, validated.stderr);
  const payload = JSON.parse(validated.stdout);
  assert.equal(payload.class, "structured");
  assert.equal(payload.ok, true);

  const scaffoldPath = join(dir, "SCAFFOLD.md");
  const scaffolded = spawnSync(process.execPath, [CLI_PATH, "spec", "scaffold", scaffoldPath, "--id", "feature-99"], { encoding: "utf8", cwd: dir });
  assert.equal(scaffolded.status, 0, scaffolded.stderr);
  const written = readFileSync(scaffoldPath, "utf8");
  assert.match(written, /id: feature-99/u);

  const refused = spawnSync(process.execPath, [CLI_PATH, "spec", "scaffold", scaffoldPath], { encoding: "utf8", cwd: dir });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to overwrite/u);
});

// `spec validate` checked that a requirement had a proof written down, never
// that the proof passes, so a proof anchored to a form the artifact no longer
// has read as covered. Measured 2026-09-22: two requirements of one campaign's
// spec named a proof neither could satisfy, `--strict-traceability` reported
// nothing, and `campaign.json` marked both `covered`.
test("--run-proofs runs a requirement's proof, and its absence still only checks the proof exists", () => {
  const { head, dir } = initFixtureRepo();
  const failing = VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`command: node -e \"process.exit(3)\"`",
  );

  const unchecked = validateSpec(failing, { cwd: dir });
  assert.equal(unchecked.ok, true, "a proof that is merely present still validates when nothing runs it");
  assert.ok(!unchecked.findings.some((finding) => finding.rule === "requirement-proof-failed"));

  const run = validateSpec(failing, { cwd: dir, runProofs: true });
  assert.equal(run.ok, false, "a spec whose proof fails is not ok once the proof is run");
  const failures = run.findings.filter((finding) => finding.rule === "requirement-proof-failed");
  assert.equal(failures.length, 1, JSON.stringify(run.findings));
  assert.equal(failures[0].severity, "blocking", "a proof that does not pass is never advisory");
  assert.match(failures[0].message, /requirement R1's proof does not pass \(command: /u);
  assert.match(failures[0].message, /exit 3/u);
});

test("--run-proofs passes a proof that passes, and reports a path proof by existence", () => {
  const { head, dir } = initFixtureRepo();
  const passing = VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`command: node -e \"\"`",
  );
  assert.equal(validateSpec(passing, { cwd: dir, runProofs: true }).ok, true);

  const missingPath = VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`path: docs/never-written.md`",
  );
  const missing = validateSpec(missingPath, { cwd: dir, runProofs: true });
  assert.equal(missing.ok, false);
  assert.match(
    missing.findings.find((finding) => finding.rule === "requirement-proof-failed")?.message ?? "",
    /\(path: docs\/never-written\.md\): no such path/u,
  );

  writeFileSync(join(dir, "PRESENT.md"), "here\n");
  const presentPath = VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`path: PRESENT.md`",
  );
  assert.equal(validateSpec(presentPath, { cwd: dir, runProofs: true }).ok, true);
});

test("a judgment proof is left unattempted rather than reported as passing", () => {
  const { head, dir } = initFixtureRepo();
  const judged = VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`judgment: a reviewer agrees the shape is right`",
  );
  const result = validateSpec(judged, { cwd: dir, runProofs: true });
  assert.ok(!result.findings.some((finding) => finding.rule === "requirement-proof-failed"), JSON.stringify(result.findings));
});

test("faberun spec validate --run-proofs fails the command a proof-less check passes", () => {
  const { head, dir } = initFixtureRepo();
  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, VALID_SPEC(head).replace(
    "`command: node --test test/feature.test.mjs`",
    "`command: node -e \"process.exit(3)\"`",
  ));

  const quiet = spawnSync(process.execPath, [CLI_PATH, "spec", "validate", specPath, "--json"], { encoding: "utf8", cwd: dir });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(JSON.parse(quiet.stdout).ok, true);

  const run = spawnSync(process.execPath, [CLI_PATH, "spec", "validate", specPath, "--run-proofs"], { encoding: "utf8", cwd: dir });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /\[blocking\] requirement-proof-failed: requirement R1's proof does not pass/u);
});
