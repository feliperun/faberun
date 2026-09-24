/**
 * Combining paired results that ran as separate processes. R11 runs its
 * repetitions side by side (owner's decision, 2026-09-23), so each process
 * writes its own result; this pools their runs per arm and recomputes the
 * bands and hypotheses with the same functions a single run uses. It is its
 * own module because it reads results rather than running arms, and it is
 * where a run is voided: by label and arm, with the reason written into the
 * combined result, never silently.
 */
import { readFileSync } from "node:fs";
import { armReport, hypothesesFor } from "./analyse.mjs";

/** @typedef {Record<string, any>} JsonObject */

/**
 * @param {{path: string, result: JsonObject}[]} sources
 * @param {{label: string, arm: string, reason: string}[]} [voids]
 * @returns {JsonObject}
 */
export function combinePairedResults(sources, voids = []) {
  if (sources.length < 2) throw new Error("--combine needs at least two paired results");
  for (const { path, result } of sources) {
    if (result.class !== "paired") throw new Error(`${path} is not a paired result`);
  }
  const hashes = new Set(sources.map(({ result }) => result.provenance?.corpusHash));
  if (hashes.size !== 1) throw new Error("--combine refuses results measured over different corpora");
  const isVoided = (/** @type {JsonObject} */ run) => voids.some((entry) => entry.label === run.label && entry.arm === run.arm);
  const runs = sources.flatMap(({ result }) => /** @type {JsonObject[]} */ (result.runs ?? []));
  const kept = runs.filter((run) => !isVoided(run));
  const seed = Number(sources[0].result.provenance?.seed ?? 0);
  const armNames = [...new Set(kept.map((run) => String(run.arm)))].sort();
  const arms = armNames.map((name) => armReport(name, kept.filter((run) => run.arm === name), seed));
  return {
    schemaVersion: 1,
    class: "paired",
    combined: true,
    provenance: {
      class: "paired",
      corpusHash: [...hashes][0],
      sources: sources.map(({ path, result }) => ({
        path,
        label: result.runs?.[0]?.label ?? null,
        commit: result.provenance?.commit ?? null,
        dirtyTree: result.provenance?.dirtyTree ?? null,
        seed: result.provenance?.seed ?? null,
        armsFileHash: result.provenance?.armsFileHash ?? null,
        spendUsd: result.provenance?.spendUsd ?? null,
        voidedSpendUsd: result.provenance?.voidedSpendUsd ?? null,
      })),
      spendUsd: sources.reduce((total, { result }) => total + Number(result.provenance?.spendUsd ?? 0), 0),
      voided: voids.map((entry) => ({ ...entry, runs: runs.filter((run) => run.label === entry.label && run.arm === entry.arm).length })),
    },
    runs: kept,
    arms,
    hypotheses: hypothesesFor(arms),
  };
}

/**
 * `--void <label>:<arm>=<reason>`, repeatable.
 *
 * @param {string[]} values
 * @returns {{label: string, arm: string, reason: string}[]}
 */
export function parseVoids(values) {
  return values.map((value) => {
    const match = /^([^:]+):([A-Z])=(.+)$/u.exec(value);
    if (!match) throw new Error(`--void must be <label>:<arm>=<reason>: ${value}`);
    return { label: match[1], arm: match[2], reason: match[3] };
  });
}

/** @param {string[]} paths @returns {{path: string, result: JsonObject}[]} */
export function readPairedResults(paths) {
  return paths.map((path) => ({ path, result: JSON.parse(readFileSync(path, "utf8")) }));
}
