/**
 * The judge-canary class: `node evals/run.mjs --class judge-canary --runtime
 * <id> --budget-usd <n> [--repeat <k>]` asks one judge runtime every sealed
 * case through the product's own judge path and scores it by defect kind —
 * recall on each planted defect kind, false alarm on the clean controls, and
 * cost per case — into `evals/results/judge-canary/<date>-<runtime>.json`, or
 * `<date>-<runtime>-<n>.json` when that run's name is already taken. An
 * invocation that errored or returned an unparseable verdict is counted per
 * label as an error, outside both rates.
 * Why separate from `judge-canary.mjs`: that module owns the corpus format and
 * its verifier, this owns the model-backed measurement and the budget, and the
 * class entry point must run with a replay judge and no provider.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { round4 } from "../../src/campaign/metrics-evals.mjs";
import { uncitedRejection } from "../../src/engine/judge-gate.mjs";
import { parseJudge } from "../../src/engine/prompts.mjs";
import { StochasticBudget } from "../budget.mjs";
import { CANARY_KINDS, discoverCanaryCaseIds, loadCanaryCase, materializeJudgeWorkspace } from "../judge-canary.mjs";
import { EVALS_ROOT } from "../paths.mjs";
import { seededShuffle, writeJson } from "../paired/lib.mjs";
import { dirtyTree, probeHarnessVersion, resultCommit, runtimeIdentities } from "../paired/provenance.mjs";
import { canaryJudgeNode, canaryJudgePrompt, harnessJudge } from "./judge.mjs";

/** @typedef {import("../judge-canary.mjs").CanaryArtifact} CanaryArtifact */
/** @typedef {Record<string, unknown>} JsonObject */
/**
 * A judge stand-in the class may be handed instead of a harness. It returns
 * the raw verdict string, or the same `{result, usage, costUsd}` shape
 * `askHarnessJudge` returns.
 *
 * @typedef {(input: {runtime: JsonObject, artifact: CanaryArtifact, prompt: string, workspace: string|null}) => Promise<string|{result: string, usage?: JsonObject, costUsd?: number|null}>|string|{result: string, usage?: JsonObject, costUsd?: number|null}} CanaryJudge
 */

/** Where a real operator run's result files land. A test passes its own temporary directory. */
const JUDGE_CANARY_RESULTS = join(EVALS_ROOT, "results", "judge-canary");
/** The judge runtime registry, beside this module. */
const JUDGE_RUNTIME_FILE = join(EVALS_ROOT, "judge-canary", "runtimes.json");
/** The corpus's own default shuffle seed, recorded so a case order is reproducible. */
const DEFAULT_SEED = 20260923;
/** A judge invocation with no declared estimate reserves this much; an unknown cost is never zero. */
const DEFAULT_ESTIMATE_USD = 0.5;

/**
 * The declared judge runtimes, keyed by the id `--runtime` names.
 *
 * @param {string} [file]
 * @returns {{schemaVersion: number, seed: number, runtimes: JsonObject[]}}
 */
function loadJudgeRuntimes(file = JUDGE_RUNTIME_FILE) {
  const spec = /** @type {any} */ (JSON.parse(readFileSync(file, "utf8")));
  if (!Array.isArray(spec.runtimes) || spec.runtimes.length === 0) throw new Error(`${file} declares no judge runtimes`);
  return { schemaVersion: spec.schemaVersion ?? 1, seed: Number(spec.seed ?? DEFAULT_SEED), runtimes: spec.runtimes };
}

/**
 * @param {JsonObject} runtime
 * @returns {number}
 */
function estimateOf(runtime) {
  return typeof runtime.estimateUsd === "number" && Number.isFinite(runtime.estimateUsd) && runtime.estimateUsd > 0
    ? runtime.estimateUsd
    : DEFAULT_ESTIMATE_USD;
}

/**
 * @param {string|{result: string, usage?: JsonObject, costUsd?: number|null}} raw
 * @returns {{result: string, usage?: JsonObject, costUsd?: number|null}}
 */
function normalizeJudgeResult(raw) {
  return typeof raw === "string" ? { result: raw } : raw;
}

/** @param {number} part @param {number} whole @returns {number|null} */
function ratio(part, whole) {
  return whole > 0 ? part / whole : null;
}

/**
 * Run the judge canary over the sealed corpus under a hard budget. The
 * signature is an object so a test can run the whole class with a replay judge
 * and a throwaway result directory.
 *
 * @param {{
 *   argv?: string[],
 *   caseIds?: string[],
 *   runtime?: JsonObject,
 *   runtimeId?: string,
 *   runtimesFile?: string,
 *   repeat?: number,
 *   seed?: number,
 *   budgetUsd?: number,
 *   resultDir?: string|null,
 *   judge?: CanaryJudge,
 *   probeVersion?: (runtime: JsonObject) => Promise<string|null>|string|null,
 *   workRoot?: string,
 *   assertNoModel?: boolean,
 *   now?: () => number,
 * }} [options]
 * @returns {Promise<{report: JsonObject, resultPath: string|null}>}
 */
export async function runJudgeCanaryClass(options = {}) {
  const now = options.now ?? (() => Date.now());
  const caseIds = options.caseIds ?? discoverCanaryCaseIds();
  if (caseIds.length === 0) throw new Error("the judge canary corpus is empty: build it with `node evals/judge-canary.mjs` first");
  const runtimeSet = options.runtime === undefined ? loadJudgeRuntimes(options.runtimesFile) : null;
  const runtime = options.runtime ?? runtimeSet?.runtimes.find((entry) => entry.id === options.runtimeId);
  if (!runtime) {
    const known = runtimeSet ? runtimeSet.runtimes.map((entry) => entry.id).join(", ") : "";
    throw new Error(options.runtimeId === undefined
      ? `--class judge-canary needs --runtime <id> (known: ${known})`
      : `unknown judge runtime: ${options.runtimeId} (known: ${known})`);
  }
  if (options.assertNoModel && runtime.harness !== "replay") throw new Error("--assert-no-model: judge-canary has a non-replay runtime");
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat needs a positive integer");
  const seed = options.seed ?? runtimeSet?.seed ?? DEFAULT_SEED;
  if (!Number.isFinite(seed)) throw new Error("--seed needs a finite number");
  // The allowance comes before the corpus is read or any case is asked.
  const budget = new StochasticBudget({ argv: options.argv ?? [], budgetUsd: options.budgetUsd });
  const judge = /** @type {CanaryJudge} */ (options.judge ?? harnessJudge(runtime));
  const usesHarness = options.judge === undefined;

  const artifacts = seededShuffle(caseIds.map(loadCanaryCase), seed + repeat);
  /** @type {JsonObject[]} */
  const outcomes = [];
  /** @type {JsonObject[]} */
  const skipped = [];
  let exhausted = false;
  for (let repetition = 1; repetition <= repeat && !exhausted; repetition += 1) {
    for (const artifact of artifacts) {
      const reservation = budget.startInvocation(runtime, estimateOf(runtime));
      if (reservation === null) {
        skipped.push({ id: artifact.id, label: artifact.label, repetition, reason: "budget" });
        exhausted = true;
        break;
      }
      /** @type {string|null} */
      let workspace = null;
      try {
        if (usesHarness) workspace = materializeJudgeWorkspace(artifact, options.workRoot ?? tmpdir());
        const raw = await judge({ runtime, artifact, prompt: canaryJudgePrompt(artifact), workspace });
        const normalized = normalizeJudgeResult(raw);
        const settled = budget.completeInvocation(reservation, { usage: normalized.usage, costUsd: normalized.costUsd ?? null });
        let verdict;
        try {
          verdict = parseJudge(normalized.result);
        } catch (error) {
          outcomes.push(outcomeOf(artifact, repetition, { error: `unparseable verdict: ${messageOf(error)}`, costUsd: settled.costUsd, costProvenance: settled.costProvenance }));
          continue;
        }
        const node = canaryJudgeNode(artifact);
        outcomes.push(outcomeOf(artifact, repetition, {
          verdict: verdict.verdict,
          maxSeverity: verdict.maxSeverity,
          rejected: verdict.verdict === "fail",
          cited: verdict.verdict === "fail" && !uncitedRejection(verdict, /** @type {any} */ (node)),
          costUsd: settled.costUsd,
          costProvenance: settled.costProvenance,
        }));
      } catch (error) {
        const voidedUsd = budget.inFlight.has(reservation) ? budget.voidInvocation(reservation) : 0;
        outcomes.push(outcomeOf(artifact, repetition, { error: messageOf(error), voidedUsd }));
      } finally {
        if (workspace) rmSync(workspace, { recursive: true, force: true });
      }
    }
  }

  const snapshot = budget.result();
  const generatedAt = new Date(now()).toISOString();
  const report = {
    schemaVersion: 1,
    class: "judge-canary",
    provenance: {
      class: "judge-canary",
      commit: resultCommit(),
      // The corpus bytes a result was scored on, which the commit alone does
      // not pin once the working tree is dirty (review 2, 2026-09-24).
      dirtyTree: dirtyTree(),
      corpusHash: canaryManifestHash(),
      builderVersion: canaryBuilderVersion(),
      seed,
      repeat,
      budgetUsd: snapshot.budgetUsd,
      pricedSpendUsd: round4(snapshot.pricedSpendUsd),
      voidedSpendUsd: round4(snapshot.voidedSpendUsd),
      generatedAt,
      runtimes: await runtimeIdentities([runtime], /** @type {any} */ (options.probeVersion ?? probeHarnessVersion)),
    },
    budget: snapshot,
    skipped,
    byLabel: scoreByLabel(outcomes),
    overall: scoreOverall(outcomes),
    cases: outcomes,
  };
  const resultDir = options.resultDir === undefined ? JUDGE_CANARY_RESULTS : options.resultDir;
  let resultPath = null;
  if (resultDir !== null) {
    const runtimeName = typeof runtime.id === "string" ? runtime.id : "runtime";
    resultPath = freeResultPath(resultDir, `${generatedAt.slice(0, 10)}-${runtimeName}`);
    writeJson(resultPath, report);
  }
  return { report, resultPath };
}

/**
 * The first result path no earlier run holds: `<stem>.json`, then
 * `<stem>-2.json`, and so on. Review finding 11: two runs of one runtime on one
 * day wrote the same file, and the second erased the first run's recorded spend.
 *
 * @param {string} dir
 * @param {string} stem
 * @returns {string}
 */
function freeResultPath(dir, stem) {
  let path = join(dir, `${stem}.json`);
  for (let index = 2; existsSync(path); index += 1) path = join(dir, `${stem}-${index}.json`);
  return path;
}

/**
 * @param {CanaryArtifact} artifact
 * @param {number} repetition
 * @param {JsonObject} fields
 * @returns {JsonObject}
 */
function outcomeOf(artifact, repetition, fields) {
  return {
    id: artifact.id,
    label: artifact.label,
    kind: artifact.label.startsWith("defect:") ? artifact.label.slice("defect:".length) : null,
    repetition,
    ...fields,
  };
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {JsonObject[]} outcomes
 * @returns {Record<string, JsonObject>}
 */
function scoreByLabel(outcomes) {
  /** @type {Record<string, JsonObject>} */
  const byLabel = {};
  for (const label of ["clean", ...CANARY_KINDS.map((kind) => `defect:${kind}`)]) {
    const entries = outcomes.filter((outcome) => outcome.label === label);
    const invocations = entries.length;
    const verdicts = entries.filter((outcome) => !isError(outcome)).length;
    const rejected = entries.filter((outcome) => outcome.rejected === true).length;
    const citedRejections = entries.filter((outcome) => outcome.cited === true).length;
    const spendUsd = round4(entries.reduce((total, outcome) => total + costOf(outcome), 0));
    const clean = label === "clean";
    byLabel[label] = {
      label,
      cases: new Set(entries.map((outcome) => outcome.id)).size,
      invocations,
      verdicts,
      errors: invocations - verdicts,
      rejected,
      citedRejections,
      recall: clean ? null : ratio(citedRejections, verdicts),
      falseAlarmRate: clean ? ratio(rejected, verdicts) : null,
      costUsd: spendUsd,
      costPerCaseUsd: invocations > 0 ? round4(spendUsd / invocations) : null,
    };
  }
  return byLabel;
}

/**
 * @param {JsonObject[]} outcomes
 * @returns {JsonObject}
 */
function scoreOverall(outcomes) {
  const verdicts = outcomes.filter((outcome) => !isError(outcome));
  const defects = verdicts.filter((outcome) => outcome.kind !== null);
  const clean = verdicts.filter((outcome) => outcome.kind === null);
  const invocations = outcomes.length;
  const spendUsd = round4(outcomes.reduce((total, outcome) => total + costOf(outcome), 0));
  return {
    cases: new Set(outcomes.map((outcome) => outcome.id)).size,
    invocations,
    errors: invocations - verdicts.length,
    defectInvocations: outcomes.filter((outcome) => outcome.kind !== null).length,
    cleanInvocations: outcomes.filter((outcome) => outcome.kind === null).length,
    defectVerdicts: defects.length,
    cleanVerdicts: clean.length,
    recall: ratio(defects.filter((outcome) => outcome.cited === true).length, defects.length),
    falseAlarmRate: ratio(clean.filter((outcome) => outcome.rejected === true).length, clean.length),
    costUsd: spendUsd,
    costPerCaseUsd: invocations > 0 ? round4(spendUsd / invocations) : null,
  };
}

/**
 * An invocation that threw or returned a verdict `parseJudge` refuses. It is
 * neither a pass nor a rejection, so it sits outside both rates: counted as
 * "did not reject", review finding 4 measured, it made a flaky judge's false
 * alarm rate look better than a working one's.
 *
 * @param {JsonObject} outcome
 * @returns {boolean}
 */
function isError(outcome) {
  return typeof outcome.error === "string";
}

/** @param {JsonObject} outcome @returns {number} */
function costOf(outcome) {
  const spent = typeof outcome.costUsd === "number" ? outcome.costUsd : 0;
  const voided = typeof outcome.voidedUsd === "number" ? outcome.voidedUsd : 0;
  return spent + voided;
}

/**
 * Render the class report as the human-readable table.
 *
 * @param {JsonObject} report
 * @returns {string}
 */
export function renderJudgeCanary(report) {
  const provenance = /** @type {JsonObject} */ (report.provenance);
  const runtimes = /** @type {JsonObject[]} */ (provenance.runtimes);
  const byLabel = /** @type {Record<string, JsonObject>} */ (report.byLabel);
  const overall = /** @type {JsonObject} */ (report.overall);
  const lines = [`judge-canary class: ${runtimes.map((entry) => entry.id).join(", ")} · ${overall.cases} case(s) × ${provenance.repeat}`];
  lines.push("| label | cases | verdicts | errors | rejected | recall | false alarm | USD/case |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [label, entry] of Object.entries(byLabel)) {
    const recall = entry.recall === null ? "—" : Number(entry.recall).toFixed(3);
    const falseAlarm = entry.falseAlarmRate === null ? "—" : Number(entry.falseAlarmRate).toFixed(3);
    lines.push(`| ${label} | ${entry.cases} | ${entry.verdicts} | ${entry.errors} | ${entry.rejected} | ${recall} | ${falseAlarm} | ${entry.costPerCaseUsd ?? "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** @returns {string|null} the sha256 of the canary manifest, the corpus's index of every case */
function canaryManifestHash() {
  const path = join(EVALS_ROOT, "judge-canary", "manifest.json");
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** @returns {number|null} the builder version the manifest records */
function canaryBuilderVersion() {
  const path = join(EVALS_ROOT, "judge-canary", "manifest.json");
  if (!existsSync(path)) return null;
  const version = JSON.parse(readFileSync(path, "utf8")).builderVersion;
  return typeof version === "number" ? version : null;
}
