/**
 * The paired class's band and per-arm report. Ported from `spike/arms/analyse.mjs`
 * and reduced to what R2 needs: for one arm's repetitions, the minimum and
 * maximum always, and a 95% interval by resampling once n is 3 or more, so a
 * one-reading arm still reports its single value as both ends instead of
 * claiming a spread. Why separate: the orchestration writes one run at a time,
 * and the band is a pure function of the runs that is worth testing without a
 * corpus.
 */
import { median } from "./lib.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{min: number|null, max: number|null, median: number|null, n: number, interval95: {lower: number, upper: number}|null}} Band */

/** The number of bootstrap resamples behind a 95% interval; fixed so the recorded seed alone makes a band reproducible. */
const RESAMPLES = 2000;

/** @type {Record<string, string>} */
export const ARM_NAMES = {
  A: "faberun, judge",
  B: "single session",
  C: "session with subagents",
  D: "faberun, proof-only gate",
  E: "faberun, deepseek-flash writer",
  F: "faberun, claude-opus-5 writer",
  G: "faberun, gpt-5.6-sol writer",
  H: "faberun, gpt-5.6-luna writer",
  I: "faberun, gpt-6-astra writer",
  J: "faberun, glm-5.3-flash writer",
};

/** @param {number} seed @returns {() => number} mulberry32, the shuffle's own generator */
function mulberry32(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} text @returns {number} a stable per-metric seed so two arms never share a resample pattern */
function seedOf(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The band of one metric's readings: minimum and maximum always, and a 95%
 * bootstrap percentile interval of the mean when there are at least three
 * readings. Fewer than three is not a spread the mean can be bounded from.
 *
 * @param {(number|null|undefined)[]} values
 * @param {number} seed
 * @returns {Band}
 */
export function bandOf(values, seed) {
  const numbers = /** @type {number[]} */ (values.filter((value) => typeof value === "number" && Number.isFinite(value)));
  if (numbers.length === 0) return { min: null, max: null, median: null, n: 0, interval95: null };
  const sorted = [...numbers].sort((left, right) => left - right);
  /** @type {Band} */
  const band = { min: sorted[0], max: sorted.at(-1) ?? null, median: median(numbers), n: numbers.length, interval95: null };
  if (numbers.length < 3) return band;
  const random = mulberry32(seed);
  /** @type {number[]} */
  const means = [];
  for (let resample = 0; resample < RESAMPLES; resample += 1) {
    let sum = 0;
    for (let index = 0; index < numbers.length; index += 1) sum += numbers[Math.floor(random() * numbers.length)];
    means.push(sum / numbers.length);
  }
  means.sort((left, right) => left - right);
  band.interval95 = { lower: percentile(means, 0.025), upper: percentile(means, 0.975) };
  return band;
}

/** @param {number[]} sorted @param {number} fraction @returns {number} */
function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * The metrics one run yields. Cost per delivered proof is the top metric: a
 * A zero-delivery run keeps its spend and zero in the bands; only an errored
 * run is excluded from measured metrics. The arm-level cost per proof is the
 * honest total spend divided by total delivered proofs, so a failed or empty
 * repetition cannot disappear from the denominator.
 *
 * @param {JsonObject} run
 * @returns {Record<string, number|null>}
 */
export function runIndicators(run) {
  if (run.error !== undefined) {
    return {
      proofsDelivered: null,
      costUsd: null,
      costPerDeliveredProof: null,
      wallClockMs: null,
      requests: null,
      outOfScopeFiles: null,
    };
  }
  const cost = typeof run.costUsd === "number" ? run.costUsd : null;
  const delivered = typeof run.proofsPassed === "number" ? run.proofsPassed : null;
  const outOfScope = run.scope && typeof run.scope === "object" && Array.isArray(/** @type {JsonObject} */ (run.scope).outOfScope)
    ? /** @type {unknown[]} */ (/** @type {JsonObject} */ (run.scope).outOfScope).length
    : null;
  return {
    proofsDelivered: delivered,
    costUsd: cost,
    costPerDeliveredProof: cost !== null && delivered ? cost / delivered : null,
    wallClockMs: typeof run.wallMs === "number" ? run.wallMs : null,
    requests: typeof run.requests === "number" ? run.requests : null,
    outOfScopeFiles: outOfScope,
  };
}

/** The metric names in report order. */
const METRICS = ["proofsDelivered", "costUsd", "costPerDeliveredProof", "wallClockMs", "requests", "outOfScopeFiles"];

/**
 * Aggregate one arm's repetitions into a report row with its band per metric.
 *
 * @param {string} arm
 * @param {JsonObject[]} runs
 * @param {number} seed
 * @returns {Record<string, unknown>}
 */
export function armReport(arm, runs, seed) {
  const indicators = runs.map((run) => runIndicators(run));
  const measuredRuns = runs.filter((run) => run.error === undefined);
  const erroredRuns = runs.length - measuredRuns.length;
  const totalDelivered = measuredRuns.reduce((total, run) => total + (typeof run.proofsPassed === "number" ? run.proofsPassed : 0), 0);
  const measuredCosts = measuredRuns.map((run) => run.costUsd).filter((value) => typeof value === "number");
  const totalCost = measuredCosts.length === measuredRuns.length ? measuredCosts.reduce((total, value) => total + value, 0) : null;
  /** @type {Record<string, Band>} */
  const band = {};
  /** @type {Record<string, number|null>} */
  const medians = {};
  for (const metric of METRICS) {
    const values = indicators.map((entry) => entry[metric]);
    band[metric] = bandOf(values, seed + seedOf(`${arm}:${metric}`));
    medians[metric] = median(/** @type {number[]} */ (values.filter((value) => typeof value === "number")));
  }
  const perRun = runs.map((run, index) => ({
    repetition: run.repetition ?? index + 1,
    error: typeof run.error === "string" ? run.error : null,
    ...indicators[index],
  }));
  return {
    arm,
    runner: runs[0]?.runner ?? null,
    model: runs[0]?.workerModel ?? runs[0]?.model ?? null,
    runs: runs.length,
    measuredRuns: measuredRuns.length,
    erroredRuns,
    deliveredProofs: totalDelivered,
    proofsTotal: runs[0]?.proofsTotal ?? null,
    guardsPassed: runs.length > 0 && runs.every((run) => run.error === undefined && run.guardsPassed === true),
    ...medians,
    costPerDeliveredProof: totalDelivered > 0 && totalCost !== null ? totalCost / totalDelivered : null,
    zeroDeliveryRuns: measuredRuns.filter((run) => run.proofsPassed === 0).length,
    perRun,
    band,
  };
}

/** The four complex-round hypotheses retained from orchestration-arms/STATE.md. */
const HYPOTHESES = [
  { id: "H1", text: "faberun cheaper per delivered proof than one session", metric: "costPerDeliveredProof", reference: "B", candidates: ["A", "D"], lowerIsBetter: true },
  { id: "H2", text: "faberun cheaper than native subagents", metric: "costPerDeliveredProof", reference: "C", candidates: ["A", "D"], lowerIsBetter: true },
  { id: "H3", text: "faberun delivers at least as many proofs", metric: "proofsDelivered", reference: "B", candidates: ["A", "D"], lowerIsBetter: false },
  { id: "H4", text: "faberun finishes in less wall clock than one session", metric: "wallClockMs", reference: "B", candidates: ["A", "D"], lowerIsBetter: true },
];

/**
 * Compare the named arms without pretending overlapping bands resolve a
 * hypothesis. Missing arms or unmeasured metrics remain explicitly unresolved.
 *
 * @param {Record<string, unknown>[]} arms
 * @returns {Record<string, unknown>[]}
 */
export function hypothesesFor(arms) {
  const byArm = new Map(arms.map((arm) => [String(arm.arm), arm]));
  return HYPOTHESES.map((hypothesis) => {
    const pairs = hypothesis.candidates.map((candidate) => {
      const candidateArm = /** @type {any} */ (byArm.get(candidate));
      const referenceArm = /** @type {any} */ (byArm.get(hypothesis.reference));
      // A run that delivered nothing has no per-run cost per proof, so its
      // spend is invisible to the band; for a cost hypothesis it widens that
      // arm's band to unbounded rather than dropping out (review 2).
      const widen = (/** @type {any} */ arm, /** @type {any} */ band) => hypothesis.metric === "costPerDeliveredProof" && arm?.zeroDeliveryRuns > 0 && band ? { ...band, max: Number.POSITIVE_INFINITY } : band;
      const left = widen(candidateArm, candidateArm?.band?.[hypothesis.metric]);
      const right = widen(referenceArm, referenceArm?.band?.[hypothesis.metric]);
      const status = hypothesisStatus(left, right, hypothesis.lowerIsBetter);
      return { candidate, reference: hypothesis.reference, status };
    });
    const statuses = pairs.map((pair) => pair.status);
    const status = statuses.length > 0 && statuses.every((value) => value === statuses[0]) ? statuses[0] : "not resolved";
    return { id: hypothesis.id, hypothesis: hypothesis.text, metric: hypothesis.metric, status, pairs };
  });
}

/** @param {Band|undefined} candidate @param {Band|undefined} reference @param {boolean} lowerIsBetter @returns {string} */
function hypothesisStatus(candidate, reference, lowerIsBetter) {
  if (!candidate || !reference || candidate.min === null || candidate.max === null || reference.min === null || reference.max === null) return "not resolved: insufficient data";
  if (candidate.min <= reference.max && reference.min <= candidate.max) return "not resolved: difference fits inside the band";
  if (lowerIsBetter) return candidate.max < reference.min ? "held" : "refuted";
  return candidate.min >= reference.max ? "held" : "refuted";
}

/**
 * Render the per-arm report as the human-readable table.
 *
 * @param {{arms: Record<string, unknown>[], provenance?: JsonObject}} report
 * @returns {string}
 */
export function renderPairedReport(report) {
  const lines = [`paired class: ${report.arms.length} arm(s)`];
  lines.push("| arm | what | runs | proofs | USD/proof | total USD/proof | wall s | requests | out of scope | band |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of report.arms) {
    const band = /** @type {Record<string, Band>} */ (entry.band);
    const costPerProof = band.costPerDeliveredProof;
    const wall = band.wallClockMs;
    lines.push(`| ${entry.arm} | ${ARM_NAMES[String(entry.arm)] ?? entry.model ?? ""} | ${entry.runs} (${entry.measuredRuns ?? entry.runs} measured, ${entry.erroredRuns ?? 0} errored) | ${renderBand(band.proofsDelivered)} | ${renderBand(costPerProof)}${Number(entry.zeroDeliveryRuns) > 0 ? ` (+${entry.zeroDeliveryRuns} delivered 0)` : ""} | ${typeof entry.costPerDeliveredProof === "number" ? Number(entry.costPerDeliveredProof).toFixed(3) : "none delivered"} | ${renderBand(wall, 1000)} | ${renderBand(band.requests)} | ${renderBand(band.outOfScopeFiles)} | min..max${band.proofsDelivered.interval95 ? " + 95%" : ""} |`);
  }
  if (Array.isArray(/** @type {JsonObject} */ (report).hypotheses)) {
    lines.push("", "hypotheses:");
    for (const hypothesis of /** @type {JsonObject[]} */ (/** @type {JsonObject} */ (report).hypotheses)) {
      lines.push(`${hypothesis.id}: ${hypothesis.hypothesis} — ${hypothesis.status}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** @param {Band} band @param {number} [scale] @returns {string} */
function renderBand(band, scale = 1) {
  if (band.min === null || band.max === null) return "not measured";
  const format = (/** @type {number} */ value) => Number((value / scale).toFixed(3));
  const range = `${format(band.min)}..${format(band.max)}`;
  return band.interval95 ? `${range} [${format(band.interval95.lower)}..${format(band.interval95.upper)}]` : range;
}
