/**
 * The judge matrix: `node evals/judge-canary-matrix.mjs [--result-dir <dir>]
 * <result.json>...` reads the versioned judge-canary results, pools each
 * judge's outcomes over every file and repetition it was measured on, and
 * prints one row per worker vendor family over the judges the contract's
 * vendor rule allows, with the best allowed judge marked. It writes the same
 * matrix as `matrix-<timestamp>.json` under `--result-dir` and never invokes a
 * model.
 *
 * Why separate from `evals/judge-canary/class.mjs`: the class owns the
 * model-backed measurement and writes one runtime's result, with the per-file
 * rates already averaged into labels; this module owns reading several of
 * those files, re-pooling their raw outcome counts (R3 requires pooled rates,
 * not an average of per-file rates), applying the vendor rule of
 * `src/contract/index.mjs`, and choosing a winner. It is a pure reader.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { round4 } from "../src/campaign/metrics-evals.mjs";
import { AUTHOR_FAMILIES } from "./judge-canary.mjs";
import { writeJson } from "./paired/lib.mjs";
import { EVALS_ROOT } from "./paths.mjs";

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * The five worker vendor families the product's harnesses talk to, in the order
 * the matrix prints them. `pricing-seed.mjs`'s `zhipuai` is `zhipu` here.
 */
const WORKER_FAMILIES = ["anthropic", "deepseek", "google", "openai", "zhipu"];
/** Where operator runs leave their result files; `--result-dir` overrides it. */
const DEFAULT_RESULT_DIR = join(EVALS_ROOT, "results", "judge-canary");
/** The recall band inside which the cheaper judge wins (R3's 0.05 window). */
const RECALL_COST_WINDOW = 0.05;
/** The refusal `main` exits 2 on and `buildJudgeMatrix` throws. */
const USAGE = "usage: node evals/judge-canary-matrix.mjs [--result-dir <dir>] <result.json>...\n";

/**
 * The raw counts one set of outcomes pools to. The class writes the same fields
 * per label; pooling means recomputing them over the union of outcomes rather
 * than averaging the class's per-file rates.
 *
 * @typedef {object} PooledCounts
 * @property {number} cases
 * @property {number} invocations
 * @property {number} errors
 * @property {number} defectVerdicts
 * @property {number} rejected
 * @property {number} citedRejections
 * @property {number|null} recall
 * @property {number} cleanVerdicts
 * @property {number} cleanRejected
 * @property {number|null} falseAlarmRate
 * @property {number} costUsd
 * @property {number|null} costPerCaseUsd
 * @property {number|null} pricedCostPerVerdictUsd
 * @property {Record<string, {recall: number|null, falseAlarmRate: number|null}>} blocking
 */

/**
 * The severity sets a blocking gate is measured at. A case blocks when its
 * verdict is `fail` and its highest severity is in `failOn` (the rule of
 * `src/engine/review.mjs`); a defect also needs a cited finding. Measured
 * 2026-09-24: a third of the planted defects drew only `minor`, so the two
 * sets give different judges (D9).
 */
const BLOCKING_SETS = { "minor-and-above": ["minor", "major", "critical"], "major-and-above": ["major", "critical"] };

/**
 * @typedef {PooledCounts & {family: string}} FamilyScore
 * @typedef {PooledCounts & {
 *   id: string,
 *   vendor: string,
 *   resultFiles: string[],
 *   repetitions: number,
 *   byAuthorFamily: Record<string, FamilyScore>,
 *   sameFamily: FamilyScore|null,
 * }} JudgeRow
 * @typedef {object} AllowedJudge
 * @property {string} id
 * @property {string} vendor
 * @property {number|null} recall
 * @property {number|null} falseAlarmRate
 * @property {number|null} costPerCaseUsd
 * @property {number} cases
 * @property {boolean} best
 * @typedef {object} FamilyRow
 * @property {string} family
 * @property {AllowedJudge[]} allowed
 * @property {string|null} best
 * @property {string|null} note
 * @typedef {object} JudgeMatrix
 * @property {number} schemaVersion
 * @property {string} generatedAt
 * @property {{resultFiles: string[], corpusHash: string}} inputs
 * @property {JudgeRow[]} judges
 * @property {FamilyRow[]} families
 * @typedef {object} ResultFile
 * @property {string} path
 * @property {string} id
 * @property {string} vendor
 * @property {string} corpusHash
 * @property {JsonObject[]} cases
 */

/**
 * A result the matrix refuses: wrong class, no corpus hash, a corpus hash that
 * disagrees with the others, or a runtime with no vendor. Its own class so
 * `main` can exit 2 on a misuse and 1 on an internal fault.
 */
class ResultRefusal extends Error {
  /**
   * @param {string} path
   * @param {string} detail
   */
  constructor(path, detail) {
    super(`${path}: ${detail}`);
    this.name = "ResultRefusal";
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} value @returns {JsonObject|null} */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {JsonObject} */ (value) : null;
}

/** @param {unknown} value @returns {string|null} */
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read one result file and refuse it by name when it cannot be compared on the
 * same corpus as the others.
 *
 * @param {string} path
 * @returns {ResultFile}
 */
function readResultFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ResultRefusal(path, `cannot read result: ${messageOf(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResultRefusal(path, `is not JSON: ${messageOf(error)}`);
  }
  const result = asObject(parsed);
  if (result === null) throw new ResultRefusal(path, "is not a judge-canary result object");
  if (result.class !== "judge-canary") throw new ResultRefusal(path, `is class ${JSON.stringify(result.class)}, not judge-canary`);
  const provenance = asObject(result.provenance);
  if (provenance === null) throw new ResultRefusal(path, "has no provenance object");
  const corpusHash = asString(provenance.corpusHash);
  if (corpusHash === null) throw new ResultRefusal(path, "has no provenance.corpusHash");
  const runtimes = Array.isArray(provenance.runtimes) ? provenance.runtimes : [];
  const runtime = asObject(runtimes[0]);
  if (runtime === null) throw new ResultRefusal(path, "has no provenance.runtimes entry");
  const id = asString(runtime.id);
  if (id === null) throw new ResultRefusal(path, "has no provenance.runtimes[0].id");
  const vendor = asString(runtime.vendor);
  if (vendor === null) throw new ResultRefusal(path, `runtime ${id} has no provenance vendor`);
  if (!Array.isArray(result.cases)) throw new ResultRefusal(path, "has no cases array");
  return { path, id, vendor, corpusHash, cases: /** @type {JsonObject[]} */ (result.cases) };
}

/** @param {number} part @param {number} whole @returns {number|null} */
function ratio(part, whole) {
  return whole > 0 ? part / whole : null;
}

/** @param {JsonObject} outcome @returns {boolean} */
function isError(outcome) {
  return typeof outcome.error === "string";
}

/**
 * The cost one outcome carries, matching the class: a voided invocation's
 * reservation and a priced invocation's spend both count against the judge.
 *
 * @param {JsonObject} outcome
 * @returns {number}
 */
function costOf(outcome) {
  const spent = typeof outcome.costUsd === "number" ? outcome.costUsd : 0;
  const voided = typeof outcome.voidedUsd === "number" ? outcome.voidedUsd : 0;
  return spent + voided;
}

/**
 * Whether an outcome is a defect. The class writes `kind`; the label is the
 * fallback so a hand-written fixture without it still scores.
 *
 * @param {JsonObject} outcome
 * @returns {string|null}
 */
function kindOf(outcome) {
  if (typeof outcome.kind === "string") return outcome.kind;
  if (typeof outcome.label === "string" && outcome.label.startsWith("defect:")) return outcome.label.slice("defect:".length);
  return null;
}

/**
 * Pool a set of outcomes into counts and rates. An errored outcome sits outside
 * both rates, exactly as the class scores it.
 *
 * @param {JsonObject[]} outcomes
 * @returns {PooledCounts}
 */
function poolOutcomes(outcomes) {
  const verdicts = outcomes.filter((outcome) => !isError(outcome));
  const defects = verdicts.filter((outcome) => kindOf(outcome) !== null);
  const clean = verdicts.filter((outcome) => kindOf(outcome) === null);
  const citedRejections = defects.filter((outcome) => outcome.cited === true).length;
  const cleanRejected = clean.filter((outcome) => outcome.rejected === true).length;
  const invocations = outcomes.length;
  const costUsd = round4(outcomes.reduce((total, outcome) => total + costOf(outcome), 0));
  return {
    cases: new Set(outcomes.map((outcome) => outcome.id)).size,
    invocations,
    errors: invocations - verdicts.length,
    defectVerdicts: defects.length,
    rejected: defects.filter((outcome) => outcome.rejected === true).length,
    citedRejections,
    recall: ratio(citedRejections, defects.length),
    cleanVerdicts: clean.length,
    cleanRejected,
    falseAlarmRate: ratio(cleanRejected, clean.length),
    costUsd,
    costPerCaseUsd: invocations > 0 ? round4(costUsd / invocations) : null,
    // What a verdict really cost: a refused call booked at its estimate is not spend.
    pricedCostPerVerdictUsd: pricedPerVerdict(verdicts),
    blocking: Object.fromEntries(Object.entries(BLOCKING_SETS).map(([name, failOn]) => {
      /** @param {JsonObject} outcome */
      const blocks = (outcome) => outcome.verdict === "fail" && failOn.includes(String(outcome.maxSeverity));
      return [name, {
        recall: ratio(defects.filter((outcome) => blocks(outcome) && outcome.cited === true).length, defects.length),
        falseAlarmRate: ratio(clean.filter(blocks).length, clean.length),
      }];
    })),
  };
}

/** @param {JsonObject[]} verdicts @returns {number|null} */
function pricedPerVerdict(verdicts) {
  const priced = verdicts.filter((outcome) => outcome.costProvenance === "priced" && typeof outcome.costUsd === "number");
  return priced.length > 0 ? round4(priced.reduce((total, outcome) => total + Number(outcome.costUsd), 0) / priced.length) : null;
}

/**
 * How many repetition rounds one file's cases represent: the distinct
 * `repetition` values it recorded, or one when it recorded none. Summing this
 * across a judge's files is what makes "every file and repetition" add up.
 *
 * @param {JsonObject[]} cases
 * @returns {number}
 */
function repetitionCount(cases) {
  if (cases.length === 0) return 0;
  const rounds = new Set();
  for (const entry of cases) if (typeof entry.repetition === "number") rounds.add(entry.repetition);
  return rounds.size > 0 ? rounds.size : 1;
}

/**
 * @param {JsonObject[]} outcomes
 * @returns {Record<string, FamilyScore>}
 */
function poolByAuthorFamily(outcomes) {
  /** @type {Record<string, FamilyScore>} */
  const byFamily = {};
  for (const family of AUTHOR_FAMILIES) {
    byFamily[family] = { family, ...poolOutcomes(outcomes.filter((outcome) => outcome.authorFamily === family)) };
  }
  return byFamily;
}

/**
 * Group the result files by judge runtime id and pool each judge's outcomes.
 *
 * @param {ResultFile[]} files
 * @returns {JudgeRow[]}
 */
function poolJudges(files) {
  /** @type {Map<string, {id: string, vendor: string, resultFiles: string[], outcomes: JsonObject[], repetitions: number}>} */
  const byJudge = new Map();
  for (const file of files) {
    let entry = byJudge.get(file.id);
    if (entry === undefined) {
      entry = { id: file.id, vendor: file.vendor, resultFiles: [], outcomes: [], repetitions: 0 };
      byJudge.set(file.id, entry);
    } else if (entry.vendor !== file.vendor) {
      throw new ResultRefusal(file.path, `runtime ${file.id} vendor ${file.vendor} differs from ${entry.vendor} in ${entry.resultFiles[0]}`);
    }
    entry.resultFiles.push(file.path);
    entry.outcomes.push(...file.cases);
    entry.repetitions += repetitionCount(file.cases);
  }
  return [...byJudge.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => {
      const byAuthorFamily = poolByAuthorFamily(entry.outcomes);
      return {
        id: entry.id,
        vendor: entry.vendor,
        resultFiles: entry.resultFiles,
        repetitions: entry.repetitions,
        ...poolOutcomes(entry.outcomes),
        byAuthorFamily,
        // R20: same-vendor review's own canary reading. `byAuthorFamily`
        // already pools every author family's cases against this judge; a
        // same-family judge (the mode's whole scenario) is this one lookup by
        // the judge's own vendor, read apart from the cross-vendor family
        // rows below rather than folded into them. No provider is called.
        sameFamily: byAuthorFamily[entry.vendor] ?? null,
      };
    });
}

/** @param {number|null} value @returns {number} */
function asCost(value) {
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

/**
 * The order inside the recall window: lowest cost per case, then lowest
 * false-alarm rate, then id. Recall is not looked at here — the caller has
 * already narrowed to the window.
 *
 * @param {JudgeRow} left
 * @param {JudgeRow} right
 * @returns {number}
 */
function compareWithinWindow(left, right) {
  const cost = asCost(left.costPerCaseUsd) - asCost(right.costPerCaseUsd);
  if (cost !== 0) return cost;
  const falseAlarm = asCost(left.falseAlarmRate) - asCost(right.falseAlarmRate);
  if (falseAlarm !== 0) return falseAlarm;
  return left.id.localeCompare(right.id);
}

/**
 * The best allowed judge: highest recall, then the cheapest inside the 0.05
 * recall window, then the lower false-alarm rate, then id. A judge with no
 * measured recall cannot be the highest; if every allowed judge has none, cost
 * decides among them.
 *
 * @param {JudgeRow[]} allowed
 * @returns {JudgeRow|null}
 */
function bestAllowed(allowed) {
  if (allowed.length === 0) return null;
  const measured = allowed.filter((judge) => judge.recall !== null);
  const candidates = measured.length > 0 ? measured : allowed;
  const highest = measured.length > 0 ? Math.max(...measured.map((judge) => /** @type {number} */ (judge.recall))) : null;
  const window = highest === null
    ? candidates
    : candidates.filter((judge) => /** @type {number} */ (judge.recall) >= highest - RECALL_COST_WINDOW);
  return [...window].sort(compareWithinWindow)[0] ?? null;
}

/**
 * Pool every result file and build the matrix: inputs, per-judge rows and
 * per-worker-family rows. Throws `ResultRefusal` (naming the file) on a result
 * that cannot be compared with the rest.
 *
 * @param {string[]} resultFiles
 * @param {{now?: () => number}} [options]
 * @returns {JudgeMatrix}
 */
export function buildJudgeMatrix(resultFiles, options = {}) {
  if (resultFiles.length === 0) throw new ResultRefusal("<none>", "no result files given");
  const files = resultFiles.map(readResultFile);
  const corpusHash = files[0].corpusHash;
  for (const file of files.slice(1)) {
    if (file.corpusHash !== corpusHash) throw new ResultRefusal(file.path, `corpusHash ${file.corpusHash} differs from ${corpusHash}`);
  }
  const judges = poolJudges(files);
  const families = WORKER_FAMILIES.map((family) => {
    const allowed = judges.filter((judge) => judge.vendor !== family);
    const best = bestAllowed(allowed);
    return {
      family,
      allowed: allowed.map((judge) => ({
        id: judge.id,
        vendor: judge.vendor,
        recall: judge.recall,
        falseAlarmRate: judge.falseAlarmRate,
        costPerCaseUsd: judge.costPerCaseUsd,
        cases: judge.cases,
        best: best !== null && judge.id === best.id,
      })),
      best: best === null ? null : best.id,
      note: allowed.length === 0 ? "no allowed judge" : null,
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    inputs: { resultFiles, corpusHash },
    judges,
    families,
  };
}

/** @param {number|null} value @returns {string} */
function formatRate(value) {
  return value === null ? "—" : value.toFixed(3);
}

/** @param {number|null} value @returns {string} */
function formatCost(value) {
  return value === null ? "—" : value.toFixed(4);
}

/**
 * The human-readable matrix: one row per worker family, one column per measured
 * judge, a cell only where the vendor rule allows that judge, and the best
 * allowed cell bold.
 *
 * @param {JudgeMatrix} matrix
 * @returns {string}
 */
export function renderJudgeMatrix(matrix) {
  const lines = [`| worker family | ${matrix.judges.map((judge) => `${judge.id} (${judge.vendor})`).join(" | ")} |`];
  lines.push(`| --- | ${matrix.judges.map(() => "---").join(" | ")} |`);
  for (const row of matrix.families) {
    const allowedById = new Map(row.allowed.map((entry) => [entry.id, entry]));
    const cells = matrix.judges.map((judge) => {
      const entry = allowedById.get(judge.id);
      if (entry === undefined) return "—";
      const text = `${formatRate(entry.recall)} / ${formatRate(entry.falseAlarmRate)} / ${formatCost(entry.costPerCaseUsd)}`;
      return entry.best ? `**${text}**` : text;
    });
    const label = row.note === null ? row.family : `${row.family} (${row.note})`;
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  lines.push("", "same-family review (R20): recall / false-alarm rate / cost per case, cases authored by the judge's own vendor");
  for (const judge of matrix.judges) {
    const same = judge.sameFamily;
    const reading = same === null || same.cases === 0
      ? "no same-family cases"
      : `${formatRate(same.recall)} / ${formatRate(same.falseAlarmRate)} / ${formatCost(same.costPerCaseUsd)} (${same.cases} cases)`;
    lines.push(`- ${judge.id} (${judge.vendor}): ${reading}`);
  }
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{resultDir: string, files: string[]}}
 */
function parseArgv(argv) {
  let resultDir = DEFAULT_RESULT_DIR;
  /** @type {string[]} */
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--result-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--result-dir needs a directory");
      resultDir = value;
      index += 1;
    } else if (arg.startsWith("--result-dir=")) {
      const value = arg.slice("--result-dir=".length);
      if (value.length === 0) throw new Error("--result-dir needs a directory");
      resultDir = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error("no result files given");
  return { resultDir, files };
}

/**
 * Run the command. Returns the process exit code instead of calling
 * `process.exit`, so a test can hold the whole command in-process: 0 on
 * success, 2 on a refused result or a bad invocation, 1 on anything else.
 *
 * @param {string[]} argv
 * @param {{out?: (text: string) => void, err?: (text: string) => void, now?: () => number}} [io]
 * @returns {number}
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const now = io.now ?? (() => Date.now());
  /** @type {{resultDir: string, files: string[]}} */
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    err(`judge-matrix: ${messageOf(error)}\n${USAGE}`);
    return 2;
  }
  try {
    const at = now();
    const matrix = buildJudgeMatrix(parsed.files, { now: () => at });
    const outputPath = join(parsed.resultDir, `matrix-${new Date(at).toISOString().replace(/[:.]/gu, "-")}.json`);
    writeJson(outputPath, matrix);
    out(`${renderJudgeMatrix(matrix)}\n`);
    err(`judge-matrix: wrote ${outputPath}\n`);
    return 0;
  } catch (error) {
    err(`judge-matrix: ${messageOf(error)}\n`);
    return error instanceof ResultRefusal ? 2 : 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
