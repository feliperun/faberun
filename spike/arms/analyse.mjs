/**
 * The analysis: one indicator report per run, the arm medians, the noise
 * band from arm A's own repetitions, and each pairwise comparison judged
 * against that band with the product's own evals machinery -- a delta inside
 * the band is "not measured", never a result. Writes the reports under
 * spike/arms/resultados/reports/ and renders analysis.md beside them.
 *
 *   node spike/arms/analyse.mjs --label pilot
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareEvalReports, noiseBandOf, renderEvalComparisonReport } from "../../evals/metrics.mjs";
import { LEDGER, REPORTS, RESULTS, isMeasuredRun, median, readJsonl, writeJson } from "./lib.mjs";

/** @typedef {{value: number|null, direction: "down"|"up"|"informative", count: number}} Indicator */

const ARM_NAMES = { A: "faberun, judge", B: "single session", C: "session with subagents", D: "faberun, proof-only gate" };

/**
 * The indicators one run yields. Cost per delivered requirement is the top
 * metric: a cheap run that delivers nothing is not economy.
 *
 * @param {any} run
 * @returns {Record<string, Indicator>}
 */
export function runIndicators(run) {
  const cost = typeof run.costUsd === "number" ? run.costUsd : null;
  const delivered = typeof run.proofsPassed === "number" ? run.proofsPassed : null;
  const one = (/** @type {number|null} */ value, /** @type {Indicator["direction"]} */ direction) => ({ value: value === null || !Number.isFinite(value) ? null : Number(value.toFixed(4)), direction, count: value === null ? 0 : 1 });
  return {
    costPerDeliveredRequirementUsd: one(cost !== null && delivered ? cost / delivered : null, "down"),
    costUsd: one(cost, "down"),
    proofsPassed: one(delivered, "up"),
    wallClockMinutes: one(typeof run.wallMs === "number" ? run.wallMs / 60000 : null, "down"),
    requests: one(typeof run.requests === "number" ? run.requests : null, "down"),
    contextMaxKTokens: one(typeof run.contextMax === "number" ? run.contextMax / 1000 : null, "down"),
    outOfScopeFiles: one(Array.isArray(run.scope?.outOfScope) ? run.scope.outOfScope.length : null, "down"),
  };
}

/**
 * @param {Record<string, Indicator>[]} reports
 * @returns {Record<string, Indicator>}
 */
export function medianReport(reports) {
  /** @type {Record<string, Indicator>} */
  const out = {};
  for (const name of Object.keys(reports[0] ?? {})) {
    const values = reports.map((report) => report[name]?.value).filter((value) => typeof value === "number");
    out[name] = { value: median(/** @type {number[]} */ (values)), direction: reports[0][name].direction, count: values.length };
  }
  return out;
}

/** @param {string} label @returns {string} the rendered analysis */
export function analyse(label) {
  const runs = readJsonl(LEDGER).filter((run) => run.label === label && isMeasuredRun(run));
  const byArm = /** @type {Record<string, any[]>} */ ({});
  for (const run of runs) (byArm[run.arm] ??= []).push(run);
  const lines = [`# orchestration-arms · ${label}`, ""];
  lines.push(`Runs in the ledger: ${runs.length}${Object.keys(byArm).map((arm) => ` · ${arm} ${byArm[arm].length}`).join("")}. Requirements per run: ${runs[0]?.requirementIds?.length ?? "?"}.`, "");

  /** @type {Record<string, Record<string, Indicator>>} */
  const medians = {};
  for (const [arm, armRuns] of Object.entries(byArm)) {
    const reports = armRuns.map((run) => runIndicators(run));
    armRuns.forEach((run, index) => writeJson(join(REPORTS, `${label}-${arm}-r${run.repetition}.json`), { schemaVersion: 1, provenance: { label, arm, repetition: run.repetition, finalSha: run.finalSha }, indicators: reports[index] }));
    medians[arm] = medianReport(reports);
    writeJson(join(REPORTS, `${label}-${arm}-median.json`), { schemaVersion: 1, provenance: { label, arm, runs: armRuns.length }, indicators: medians[arm] });
  }

  lines.push("## Per run", "", "| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of [...runs].sort((left, right) => left.arm.localeCompare(right.arm) || left.repetition - right.repetition)) {
    const ind = runIndicators(run);
    const notes = [run.arm === "C" ? `${run.agentCalls} Agent calls` : null, run.resultSubtype && run.resultSubtype !== "success" ? run.resultSubtype : null, run.exitCode ? `exit ${run.exitCode}` : null, run.scope?.proofsEdited?.length ? `proofs edited: ${run.scope.proofsEdited.length}` : null].filter(Boolean).join("; ");
    const judge = typeof run.judgeCostUsd === "number" && run.judgeCostUsd > 0 ? `judge ${fmt(run.judgeCostUsd)}` : null;
    lines.push(`| ${run.arm} | ${run.repetition} | ${run.proofsPassed}/${run.requirementIds.length} | ${fmt(ind.costUsd.value)} | ${fmt(ind.costPerDeliveredRequirementUsd.value)} | ${fmt(ind.wallClockMinutes.value, 1)} | ${run.requests} | ${fmt(ind.contextMaxKTokens.value, 0)} | ${ind.outOfScopeFiles.value ?? "?"} | ${[judge, notes].filter(Boolean).join("; ")} |`);
  }
  lines.push("");

  lines.push("## Arm medians", "", "| indicator | direction | " + Object.keys(medians).map((arm) => `${arm} (${ARM_NAMES[/** @type {"A"|"B"|"C"|"D"} */ (arm)]})`).join(" | ") + " |", "| --- | --- | " + Object.keys(medians).map(() => "---").join(" | ") + " |");
  const first = Object.values(medians)[0] ?? {};
  for (const name of Object.keys(first)) {
    lines.push(`| ${name} | ${first[name].direction} | ${Object.keys(medians).map((arm) => `${fmt(medians[arm][name].value)} (n=${medians[arm][name].count})`).join(" | ")} |`);
  }
  lines.push("");

  const aReports = (byArm.A ?? []).map((run) => runIndicators(run));
  const band = aReports.length >= 2 ? noiseBandOf(aReports) : null;
  writeJson(join(REPORTS, `${label}-band.json`), { schemaVersion: 1, repetitions: aReports.length, indicators: band ?? {} });
  lines.push("## Noise band (arm A repeated on the same corpus)", "");
  if (!band) {
    lines.push(`Not measured: arm A has ${aReports.length} run(s) under this label and a band needs at least two. Every comparison below is therefore a single reading, not a result; repeat before concluding.`, "");
  } else {
    lines.push("| indicator | band ± | median | n |", "| --- | --- | --- | --- |");
    for (const [name, entry] of Object.entries(band)) lines.push(`| ${name} | ${entry.band === null ? "not measured" : fmt(entry.band)} | ${fmt(entry.median)} | ${entry.n} |`);
    lines.push("");
  }

  lines.push("## Comparisons (before = first arm, after = second)", "");
  for (const [left, right] of [["A", "B"], ["A", "C"], ["B", "C"], ["D", "B"], ["D", "C"], ["A", "D"]]) {
    if (!medians[left] || !medians[right]) continue;
    lines.push(`### ${left} (${ARM_NAMES[/** @type {"A"|"B"|"C"|"D"} */ (left)]}) → ${right} (${ARM_NAMES[/** @type {"A"|"B"|"C"|"D"} */ (right)]})`, "", "```");
    lines.push(renderEvalComparisonReport(compareEvalReports(medians[left], medians[right], band ?? undefined)).trimEnd());
    lines.push("```", "");
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(RESULTS, `analysis-${label}.md`), text);
  return text;
}

/** @param {number|null|undefined} value @param {number} [digits] @returns {string} */
function fmt(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

const args = process.argv.slice(2);
const labelIndex = args.indexOf("--label");
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("analyse.mjs")) {
  const label = labelIndex >= 0 ? String(args[labelIndex + 1]) : "smoke";
  process.stdout.write(analyse(label));
}
