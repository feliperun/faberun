import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJudgeMatrix, main, renderJudgeMatrix } from "../../evals/judge-canary-matrix.mjs";

/**
 * The judge matrix scores fixture result objects on disk, never a provider and
 * never the checked-in results: a judge cannot be measured here, only pooled.
 */

/** @param {string} dir @param {string} name @param {object} value @returns {string} */
function writeResult(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/**
 * One stored outcome, shaped as `evals/judge-canary/class.mjs` writes it.
 *
 * @param {string} id
 * @param {{label?: string, authorFamily?: string, rejected?: boolean, cited?: boolean, costUsd?: number, repetition?: number}} [fields]
 * @returns {Record<string, any>}
 */
function outcomeOf(id, fields = {}) {
  const label = fields.label ?? "clean";
  const defect = label.startsWith("defect:");
  return {
    id,
    label,
    kind: defect ? label.slice("defect:".length) : null,
    authorFamily: fields.authorFamily ?? "anthropic",
    repetition: fields.repetition ?? 1,
    verdict: fields.rejected ? "fail" : "pass",
    maxSeverity: fields.rejected ? "major" : "none",
    rejected: fields.rejected === true,
    cited: fields.cited === true,
    costUsd: fields.costUsd ?? 0.01,
  };
}

/** @param {string} prefix @param {number} count @param {number} cited @param {number} costUsd @returns {object[]} */
function defects(prefix, count, cited, costUsd) {
  return Array.from({ length: count }, (_, index) => outcomeOf(`${prefix}-defect-${index}`, {
    label: "defect:requirement-half-done",
    rejected: index < cited,
    cited: index < cited,
    costUsd,
  }));
}

/** @param {string} prefix @param {number} count @param {number} rejected @param {number} costUsd @returns {object[]} */
function cleans(prefix, count, rejected, costUsd) {
  return Array.from({ length: count }, (_, index) => outcomeOf(`${prefix}-clean-${index}`, {
    label: "clean",
    rejected: index < rejected,
    cited: index < rejected,
    costUsd,
  }));
}

/** @param {string} id @param {string} vendor @param {string} corpusHash @param {object[]} cases @returns {Record<string, any>} */
function resultFixture(id, vendor, corpusHash, cases) {
  return {
    schemaVersion: 1,
    class: "judge-canary",
    provenance: {
      class: "judge-canary",
      corpusHash,
      repeat: 1,
      runtimes: [{ id, vendor, harness: "replay", model: id }],
    },
    cases,
  };
}

test("the canary report says which judges may judge each worker vendor", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-matrix-"));
  try {
    const corpus = "corpus-1";
    // alpha: recall 0.90, false alarm 0.20, $0.50/case.
    const alpha = writeResult(dir, "alpha.json", resultFixture("judge-alpha", "openai", corpus, [...defects("alpha", 20, 18, 0.5), ...cleans("alpha", 5, 1, 0.5)]));
    // beta: two files; pooled recall 0.85, false alarm 0, $0.05/case. Per-file
    // rates are 1.00 and 0.82, so an average would read 0.91.
    const beta1 = writeResult(dir, "beta-1.json", resultFixture("judge-beta", "deepseek", corpus, [...defects("beta1", 3, 3, 0.05), ...cleans("beta1", 1, 0, 0.05)]));
    const beta2 = writeResult(dir, "beta-2.json", resultFixture("judge-beta", "deepseek", corpus, [...defects("beta2", 17, 14, 0.05), ...cleans("beta2", 4, 0, 0.05)]));
    // gamma: recall 0.80 (outside alpha's 0.05 window), false alarm 0, $0.01/case.
    const gamma = writeResult(dir, "gamma.json", resultFixture("judge-gamma", "google", corpus, [...defects("gamma", 20, 16, 0.01), ...cleans("gamma", 5, 0, 0.01)]));
    // epsilon and zeta: identical recall 0.85, $0.05/case and false alarm 0.40;
    // only the id separates them.
    const epsilon = writeResult(dir, "epsilon.json", resultFixture("judge-epsilon", "zhipu", corpus, [...defects("epsilon", 20, 17, 0.05), ...cleans("epsilon", 5, 2, 0.05)]));
    const zeta = writeResult(dir, "zeta.json", resultFixture("judge-zeta", "zhipu", corpus, [...defects("zeta", 20, 17, 0.05), ...cleans("zeta", 5, 2, 0.05)]));
    // delta: recall 0.70, false alarm 0, $0.02/case.
    const delta = writeResult(dir, "delta.json", resultFixture("judge-delta", "anthropic", corpus, [...defects("delta", 20, 14, 0.02), ...cleans("delta", 5, 0, 0.02)]));
    const inputs = [alpha, beta1, beta2, gamma, epsilon, zeta, delta];

    const matrix = buildJudgeMatrix(inputs);
    const markdown = renderJudgeMatrix(matrix);
    assert.match(markdown, /^\| worker family \|/);
    assert.match(markdown, /\*\*0\.850 \/ 0\.000 \/ 0\.0500\*\*/, "the best allowed judge is bold");
    const byId = new Map(matrix.judges.map((judge) => [judge.id, judge]));
    assert.deepEqual(
      [...byId.keys()],
      ["judge-alpha", "judge-beta", "judge-delta", "judge-epsilon", "judge-gamma", "judge-zeta"],
      "one pooled row per measured judge, ordered by id",
    );

    // The vendor rule: a family may use every measured judge but one of its own vendor.
    const allowed = new Map(matrix.families.map((row) => [row.family, row.allowed.map((entry) => entry.id)]));
    assert.deepEqual(allowed.get("anthropic"), ["judge-alpha", "judge-beta", "judge-epsilon", "judge-gamma", "judge-zeta"]);
    assert.deepEqual(allowed.get("deepseek"), ["judge-alpha", "judge-delta", "judge-epsilon", "judge-gamma", "judge-zeta"]);
    assert.deepEqual(allowed.get("google"), ["judge-alpha", "judge-beta", "judge-delta", "judge-epsilon", "judge-zeta"]);
    assert.deepEqual(allowed.get("openai"), ["judge-beta", "judge-delta", "judge-epsilon", "judge-gamma", "judge-zeta"]);
    assert.deepEqual(allowed.get("zhipu"), ["judge-alpha", "judge-beta", "judge-delta", "judge-gamma"]);
    assert.deepEqual(matrix.families.map((row) => row.family), ["anthropic", "deepseek", "google", "openai", "zhipu"]);

    // The best-judge rule. gamma is the cheapest of all but 0.10 behind the
    // best recall, so the 0.05 window keeps it out for anthropic; epsilon wins
    // deepseek on cost inside the window, and zeta only loses on id.
    const best = new Map(matrix.families.map((row) => [row.family, row.best]));
    assert.equal(best.get("anthropic"), "judge-beta");
    assert.equal(best.get("deepseek"), "judge-epsilon");
    assert.equal(best.get("google"), "judge-beta");
    assert.equal(best.get("openai"), "judge-gamma");
    assert.equal(best.get("zhipu"), "judge-beta");
    const anthropic = matrix.families.find((row) => row.family === "anthropic");
    assert.ok(anthropic);
    assert.deepEqual(anthropic.allowed.filter((entry) => entry.best).map((entry) => entry.id), ["judge-beta"]);
    assert.equal(anthropic.allowed.find((entry) => entry.id === "judge-gamma")?.best, false);

    // Pooling: beta's two files give 17/20 and cost per case from the pooled
    // spend, not (1.00 + 0.8235) / 2.
    const beta = byId.get("judge-beta");
    assert.ok(beta);
    assert.deepEqual(beta.resultFiles, [beta1, beta2]);
    assert.equal(beta.repetitions, 2);
    assert.equal(beta.cases, 25);
    assert.equal(beta.invocations, 25);
    assert.equal(beta.recall, 0.85);
    assert.equal(beta.falseAlarmRate, 0);
    assert.equal(beta.costPerCaseUsd, 0.05);
    assert.equal(beta.byAuthorFamily.anthropic.recall, 0.85);
    assert.equal(beta.byAuthorFamily.openai.recall, null);

    // R20: same-family reading. beta is a deepseek judge but every case here
    // is authored by anthropic (the fixture default), so beta's own-family
    // slice is empty; delta is anthropic and every one of its cases is too, so
    // its same-family reading equals its pooled score exactly.
    assert.deepEqual(beta.sameFamily, beta.byAuthorFamily.deepseek);
    assert.equal(beta.sameFamily.cases, 0);
    const deltaJudge = byId.get("judge-delta");
    assert.ok(deltaJudge);
    assert.equal(deltaJudge.sameFamily?.cases, 25);
    assert.equal(deltaJudge.sameFamily?.recall, 0.7);
    assert.match(markdown, /same-family review \(R20\)/);
    assert.match(markdown, /judge-beta \(deepseek\): no same-family cases/);
    assert.match(markdown, /judge-delta \(anthropic\): 0\.700 \/ 0\.000 \/ 0\.0200 \(25 cases\)/);

    // Mixed corpus hashes are refused, naming the file that disagrees.
    const mixedA = writeResult(dir, "mixed-a.json", resultFixture("judge-alpha", "openai", "corpus-a", [outcomeOf("mixed-a-clean")]));
    const mixedB = writeResult(dir, "mixed-b.json", resultFixture("judge-alpha", "openai", "corpus-b", [outcomeOf("mixed-b-clean")]));
    /** @type {string[]} */
    const refusal = [];
    const code = main(["--result-dir", dir, mixedA, mixedB], { out: () => {}, err: (text) => refusal.push(text), now: () => 0 });
    assert.equal(code, 2, "a mixed-corpus input is a misuse");
    assert.match(refusal.join(""), /mixed-b\.json/);
    assert.match(refusal.join(""), /corpusHash/);

    // The command writes the matrix and marks the best cell on stdout.
    const outDir = join(dir, "out");
    /** @type {string[]} */
    const stdout = [];
    const ok = main(["--result-dir", outDir, ...inputs], { out: (text) => stdout.push(text), err: () => {}, now: () => Date.parse("2026-09-24T04:28:33.732Z") });
    assert.equal(ok, 0);
    const written = readdirSync(outDir).filter((name) => name.startsWith("matrix-"));
    assert.equal(written.length, 1);
    assert.equal(written[0], "matrix-2026-09-24T04-28-33-732Z.json");
    const output = /** @type {any} */ (JSON.parse(readFileSync(join(outDir, written[0]), "utf8")));
    assert.equal(output.inputs.corpusHash, corpus);
    assert.deepEqual(output.families.map((/** @type {any} */ row) => row.family), ["anthropic", "deepseek", "google", "openai", "zhipu"]);
    assert.match(stdout.join(""), /\*\*0\.850 \/ 0\.000 \/ 0\.0500\*\*/, "the best allowed judge is bold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker family with no measured judge outside its vendor says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-matrix-empty-"));
  try {
    const only = writeResult(dir, "zhipu-only.json", resultFixture("judge-zhipu", "zhipu", "corpus-z", [...defects("z", 10, 5, 0.01), ...cleans("z", 5, 0, 0.01)]));
    const matrix = buildJudgeMatrix([only]);
    const zhipu = matrix.families.find((row) => row.family === "zhipu");
    assert.deepEqual(zhipu?.allowed, []);
    assert.equal(zhipu?.best, null);
    assert.equal(zhipu?.note, "no allowed judge");
    for (const family of ["anthropic", "deepseek", "google", "openai"]) {
      const row = matrix.families.find((entry) => entry.family === family);
      assert.deepEqual(row?.allowed.map((entry) => entry.id), ["judge-zhipu"]);
      assert.equal(row?.best, "judge-zhipu");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the matrix refuses a result it cannot compare", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-matrix-refuse-"));
  try {
    const fixture = resultFixture("judge-a", "openai", "hash", [outcomeOf("clean")]);
    /** @type {Array<[string, Record<string, any>]>} */
    const cases = [
      ["wrong-class.json", { ...fixture, class: "paired" }],
      ["no-hash.json", { ...fixture, provenance: { ...fixture.provenance, corpusHash: undefined } }],
      ["no-vendor.json", { ...fixture, provenance: { ...fixture.provenance, runtimes: [{ id: "judge-a", harness: "replay" }] } }],
    ];
    for (const [name, value] of cases) {
      const path = writeResult(dir, name, value);
      assert.throws(() => buildJudgeMatrix([path]), new RegExp(name.replace(".", "\\.")), `${name} is refused by name`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Measured 2026-09-24: a third of the planted defects drew only minor
// findings, so a judge's blocking recall depends on the gate's failOn (D9).
test("the matrix reports blocking recall and false alarms with and without minor in failOn", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-matrix-blocking-"));
  try {
    const minor = (/** @type {string} */ id, /** @type {string} */ label) => ({ ...outcomeOf(id, { label, rejected: true, cited: true }), maxSeverity: "minor" });
    const cases = [
      ...defects("a", 2, 2, 0.01),
      minor("a-defect-minor", "defect:test-weakened"),
      minor("a-clean-minor", "clean"),
      ...cleans("a", 1, 0, 0.01),
      { ...outcomeOf("a-refused", { label: "clean" }), error: "provider refused", costUsd: 5, costProvenance: "observed-fallback" },
    ].map((entry) => ({ costProvenance: "priced", ...entry }));
    const matrix = buildJudgeMatrix([writeResult(dir, "a.json", resultFixture("judge-a", "openai", "h", cases))]);
    const judge = /** @type {any} */ (matrix.judges[0]);
    assert.deepEqual(judge.blocking["minor-and-above"], { recall: 1, falseAlarmRate: 0.5 });
    assert.deepEqual(judge.blocking["major-and-above"], { recall: 2 / 3, falseAlarmRate: 0 }, "a minor-only rejection passes a major gate");
    assert.equal(judge.pricedCostPerVerdictUsd, 0.01, "a refused call booked at its estimate is not a verdict's cost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
