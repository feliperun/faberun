/**
 * The paired class: `node evals/run.mjs --class paired` runs the arms declared
 * in `evals/paired/arms.json` over one `evals/paired/corpus/<id>/`, in an order
 * shuffled by a recorded seed, `--repeat <n>` times, and reports per arm the
 * proofs delivered, the cost per delivered proof, wall clock, requests when
 * the harness measures them, out-of-scope files and the band. Why separate
 * from `evals/run.mjs`: case discovery has no meaning for a class that runs a
 * declared arm set, and `evals/run.mjs` is already at the file ceiling.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { round4 } from "../src/campaign/metrics-evals.mjs";
import { StochasticBudget } from "./budget.mjs";
import { armReport, hypothesesFor, renderPairedReport } from "./paired/analyse.mjs";
import { JUDGE_RUNTIME, loadArms } from "./paired/contract.mjs";
import { loadCorpusSet } from "./paired/corpus.mjs";
import { PAIRED_ARMS_FILE, PAIRED_CORPUS_ROOT, PAIRED_REPO_ROOT, PAIRED_RESULTS, writeJson } from "./paired/lib.mjs";
import { measureArms } from "./paired/measure.mjs";
import { dirtyTree, probeHarnessVersion, resultCommit, runtimeIdentities } from "./paired/provenance.mjs";

/** @typedef {import("./paired/contract.mjs").PairedArm} PairedArm */
/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {{
 *   argv?: string[],
 *   arms?: PairedArm[],
 *   armsFile?: string,
 *   corpus?: string,
 *   corpusRoot?: string,
 *   repeat?: number,
 *   seed?: number,
 *   budgetUsd?: number,
 *   resultDir?: string|null,
 *   assertNoModel?: boolean,
 *   label?: string,
 *   armNames?: string[],
 *   commit?: string|null,
 *   probeVersion?: (runtime: Record<string, unknown>) => Promise<string|null>|string|null,
 *   now?: () => number,
 *   replayRoot?: string,
 * }} [options]
 * @returns {Promise<{report: JsonObject, resultPath: string|null}>}
 */
export async function runPairedClass(options = {}) {
  const now = options.now ?? (() => Date.now());
  const armSet = options.arms === undefined ? loadArms(options.armsFile ?? PAIRED_ARMS_FILE) : { schemaVersion: 1, seed: 20260923, arms: options.arms };
  // `--arms A,B` runs a subset of the declared arms, and `--label` keeps
  // parallel processes of one reading from sharing run ids (R11 runs its
  // repetitions side by side, owner's decision 2026-09-23).
  const arms = options.armNames ? armSet.arms.filter((arm) => /** @type {string[]} */ (options.armNames).includes(arm.name)) : armSet.arms;
  if (options.armNames && arms.length !== options.armNames.length) throw new Error(`unknown arm in --arms: ${options.armNames.filter((name) => !armSet.arms.some((arm) => arm.name === name)).join(", ")}`);
  if (arms.length === 0) throw new Error("the paired class has no arms to run");
  if (options.assertNoModel && arms.some((arm) => arm.runner !== "replay")) {
    throw new Error("--assert-no-model: paired has non-replay arm(s)");
  }
  const seed = options.seed ?? armSet.seed;
  if (!Number.isFinite(seed)) throw new Error("--seed needs a finite number");
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat needs a positive integer");
  const resultDir = options.resultDir === undefined ? PAIRED_RESULTS : options.resultDir;
  // The allowance comes before the corpus: a class that was told to spend
  // money it was not given must refuse before it reads or runs anything.
  const budget = new StochasticBudget({ argv: options.argv ?? [], budgetUsd: options.budgetUsd, highestObservedUsd: priorObservedPrices(resultDir) });
  const corpusRoot = options.corpusRoot ?? PAIRED_CORPUS_ROOT;
  const corpus = loadCorpusSet(corpusRoot, options.corpus ?? "simple");
  const label = options.label ?? "paired";

  const { runs, skipped } = await measureArms({ arms, corpus, budget, seed, repeat, label, replayRoot: options.replayRoot });

  const generatedAt = new Date(now()).toISOString();
  const snapshot = budget.result();
  // One provenance runtime per arm, the arm's own runtime object when it has
  // one and its declared harness/model otherwise, so a session arm and a
  // faberun arm are identified the same way.
  const provenanceRuntimes = arms.map((arm) => {
    const declared = /** @type {Record<string, unknown>} */ (arm.runtime ?? {});
    return {
      ...declared,
      id: typeof arm.runtimeId === "string" ? arm.runtimeId : `arm-${arm.name}`,
      harness: typeof declared.harness === "string" ? declared.harness : (typeof arm.harness === "string" ? arm.harness : null),
      model: typeof declared.model === "string" ? declared.model : (typeof arm.model === "string" ? arm.model : null),
    };
  }).concat(arms.some((arm) => arm.judge === true) ? [{ ...JUDGE_RUNTIME, id: "codex-sol-judge" }] : []);
  const reportArms = arms.map((arm) => armReport(arm.name, runs.filter((run) => run.arm === arm.name), seed));
  const report = {
    schemaVersion: 1,
    class: "paired",
    provenance: {
      class: "paired",
      commit: options.commit === undefined ? resultCommit() : options.commit,
      dirtyTree: dirtyTree(PAIRED_REPO_ROOT),
      seed,
      repeat,
      corpus: corpus.id,
      corpusHash: corpus.hash,
      armsFileHash: hashArmsFile(options.armsFile ?? PAIRED_ARMS_FILE, options.arms === undefined ? null : arms),
      budgetUsd: snapshot.budgetUsd,
      spendUsd: round4(snapshot.spendUsd),
      pricedSpendUsd: round4(snapshot.pricedSpendUsd),
      unknownSpendUsd: round4(snapshot.unknownSpendUsd),
      voidedSpendUsd: round4(snapshot.voidedSpendUsd),
      overrunUsd: round4(snapshot.overrunUsd),
      generatedAt,
      arms: arms.map((arm) => ({ name: arm.name, runner: arm.runner, runtimeId: typeof arm.runtimeId === "string" ? arm.runtimeId : `arm-${arm.name}` })),
      runtimes: await runtimeIdentities(provenanceRuntimes, /** @type {any} */ (options.probeVersion ?? probeHarnessVersion)),
    },
    budget: snapshot,
    skipped,
    runs,
    arms: reportArms,
    hypotheses: hypothesesFor(reportArms),
  };
  let resultPath = null;
  if (resultDir !== null) {
    resultPath = join(resultDir, `paired-${generatedAt.replace(/[:.]/gu, "-")}.json`);
    writeJson(resultPath, report);
  }
  return { report, resultPath };
}

/** @param {string|null} resultDir @returns {Record<string, number>} */
function priorObservedPrices(resultDir) {
  if (!resultDir || !existsSync(resultDir)) return {};
  /** @type {Record<string, number>} */
  const highest = {};
  for (const name of readdirSync(resultDir).filter((entry) => entry.startsWith("paired-") && entry.endsWith(".json"))) {
    try {
      const budget = JSON.parse(readFileSync(join(resultDir, name), "utf8")).budget;
      for (const [runtime, value] of Object.entries(budget?.highestObservedUsd ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) highest[runtime] = Math.max(highest[runtime] ?? 0, value);
      }
    } catch (error) {
      // A partial result cannot seed a price; the next completed result remains authoritative.
      void error;
    }
  }
  return highest;
}

/** @param {string} file @param {PairedArm[]|null} customArms @returns {string} */
function hashArmsFile(file, customArms) {
  const content = customArms === null ? readFileSync(file) : JSON.stringify(customArms);
  return createHash("sha256").update(content).digest("hex");
}


/** @param {JsonObject} report @returns {string} */
export function renderPaired(report) {
  return renderPairedReport(/** @type {any} */ (report));
}
