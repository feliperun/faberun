/**
 * The corpus every arm works on: the ten open requirements the spike-leitura-teto
 * campaign wrote against fork a1117f7 and froze with their acceptance proofs
 * and a hand-made list of relevant files. Reused unchanged, for two reasons:
 * every proof was verified to fail at the fork and to pass when the
 * requirement is met, and a corpus another campaign froze cannot have been
 * tuned to favour one arm of this one.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";

/** @typedef {{id: string, titulo: string, objetivo: string, prova: string, comando: string, escopoEscrita: string[], gabarito: string[]}} Requirement */

const CORPUS = resolve(ROOT, "spike/corpus/requisitos.jsonl");
const KEY = resolve(ROOT, "spike/corpus/gabarito.json");

/** @returns {Requirement[]} */
export function loadCorpus() {
  return readFileSync(CORPUS, "utf8").split("\n").filter((line) => line.trim()).map((line) => /** @type {Requirement} */ (JSON.parse(line)));
}

/**
 * The subset a phase names, in corpus order, or the whole corpus for "all".
 *
 * @param {string} spec comma-separated ids or "all"
 * @returns {Requirement[]}
 */
export function selectRequirements(spec) {
  const all = loadCorpus();
  if (spec === "all") return all;
  const wanted = new Set(spec.split(",").map((id) => id.trim()).filter(Boolean));
  const unknown = [...wanted].filter((id) => !all.some((requirement) => requirement.id === id));
  if (unknown.length) throw new Error(`unknown requirement id(s): ${unknown.join(", ")}`);
  return all.filter((requirement) => wanted.has(requirement.id));
}

/** The frozen key's hash, recorded with every run so a changed corpus is visible. @returns {string} */
export function corpusHash() {
  return String(JSON.parse(readFileSync(KEY, "utf8")).hash);
}
