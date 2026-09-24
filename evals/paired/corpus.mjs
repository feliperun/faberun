/**
 * One corpus in the shape every arm works on, loaded from
 * `evals/paired/corpus/<id>/corpus.json`. Ported from `spike/arms/corpus.mjs`
 * and reduced to the loader and the two pure rules the report needs:
 * dependency order and the delivery rule (proofs that pass while every guard
 * passes). Why separate: the complex corpus's acceptance is hidden from the
 * arms, so the loader is the only place the checks' kinds are known, and the
 * replay arm must build the same tree the faberun arm does without a fork.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{argv: string[], timeoutSec: number, cwd?: string}} Command */
/** @typedef {{id: string, title: string, objective: string, instructions: string[], readFiles: string[], writeFiles: string[], symbols: string[], dependsOn: string[], decisions: string[], nonGoals: string[], scopeAcknowledged: string[], verification: Command[]}} Requirement */
/**
 * An acceptance check. `proof` fails at the base and passes when the work is
 * done; `guard` passes at the base and must still pass. A check with
 * `restore` runs after the corpus's accepted files are written over the arm's
 * tree; the others run on the tree exactly as the arm left it.
 *
 * @typedef {{id: string, argv: string[], timeoutSec: number, kind: "proof"|"guard", restore?: boolean, cwd?: string}} Acceptance
 */
/** @typedef {{path: string, sha?: string, file?: string, content?: string}} RestoreFile */
/** @typedef {{runs?: number|null, costUsd?: number|null, costPerDeliveredRequirementUsd?: number|null, wallClockMinutes?: number|null, requests?: number|null, proofsPassed?: number|null}} HistoricalArm */
/** @typedef {{label?: string, source?: string, arms?: Record<string, HistoricalArm>}|null} CorpusHistory */
/** @typedef {{schemaVersion?: number, id: string, fork: string|null, npmCi: boolean, visibleProofs: boolean, baseFiles?: Record<string, string>, restore: RestoreFile[], requirements: Requirement[], acceptance: Acceptance[], history: CorpusHistory, hash: string, dir: string}} CorpusSet */

/**
 * One acceptance check's command. A check may carry `argv` verbatim, or name a
 * `script` that lives beside the corpus and an `args` list; the script is
 * resolved to the corpus directory so the shared acceptance runner can spawn
 * it without the corpus JSON holding an absolute machine path. The complex
 * corpus's centralization check is the only `script`: it is the instrument's
 * own program, not a file the arm's tree carries.
 *
 * @param {any} check
 * @param {string} dir corpus directory
 * @returns {string[]}
 */
function acceptanceArgv(check, dir) {
  if (typeof check.script === "string") {
    if (!Array.isArray(check.args)) throw new Error(`acceptance ${check.id} names a script but no args array`);
    return ["node", join(dir, check.script), ...check.args];
  }
  if (!Array.isArray(check.argv) || check.argv.length === 0) throw new Error(`acceptance ${check.id} declares neither argv nor script`);
  return check.argv;
}

/**
 * @param {string} corpusRoot `evals/paired/corpus`
 * @param {string} id corpus directory name
 * @returns {CorpusSet}
 */
export function loadCorpusSet(corpusRoot, id) {
  const dir = join(corpusRoot, id);
  const path = join(dir, "corpus.json");
  const text = readFileSync(path, "utf8");
  const spec = /** @type {any} */ (JSON.parse(text));
  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) throw new Error(`corpus ${id} declares no requirements`);
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) throw new Error(`corpus ${id} declares no acceptance checks`);
  const acceptance = spec.acceptance.map((/** @type {any} */ check) => {
    if (check.kind !== "proof" && check.kind !== "guard") throw new Error(`corpus ${id} check ${check.id} has no kind (proof or guard)`);
    return {
      id: check.id,
      argv: acceptanceArgv(check, dir),
      timeoutSec: check.timeoutSec,
      kind: check.kind,
      ...(check.restore === true ? { restore: true } : {}),
      ...(typeof check.cwd === "string" ? { cwd: check.cwd } : {}),
    };
  });
  return {
    schemaVersion: spec.schemaVersion ?? 1,
    id,
    fork: spec.fork ?? null,
    npmCi: spec.npmCi === true,
    visibleProofs: spec.visibleProofs === true,
    baseFiles: spec.baseFiles ?? {},
    restore: spec.restore ?? [],
    requirements: spec.requirements,
    acceptance,
    history: spec.history ?? null,
    hash: createHash("sha256").update(text).digest("hex"),
    dir,
  };
}

/** The kind of each complex-corpus check, for a corpus file written before checks carried one. */
const KIND_BY_ID = { "src-centralization": "proof", typecheck: "guard", "source-shape": "guard", "resolver-api": "proof" };

/**
 * What a run delivered: the proofs that pass, provided every guard passes. A
 * change that breaks a guard delivers nothing, whatever else it got right; a
 * run that changed nothing passes every guard and no proof, and delivers
 * nothing too.
 *
 * @param {{id: string, passed: boolean, kind?: string}[]} acceptance
 * @returns {{delivered: number, proofs: number, guardsPassed: boolean}}
 */
export function deliveredOf(acceptance) {
  const kindOf = (/** @type {{id: string, kind?: string}} */ check) => check.kind ?? KIND_BY_ID[/** @type {keyof typeof KIND_BY_ID} */ (check.id)] ?? "proof";
  const proofs = acceptance.filter((check) => kindOf(check) === "proof");
  const guardsPassed = acceptance.filter((check) => kindOf(check) === "guard").every((check) => check.passed);
  return { delivered: guardsPassed ? proofs.filter((check) => check.passed).length : 0, proofs: proofs.length, guardsPassed };
}

/**
 * Requirements in an order that satisfies dependsOn, stable within a tier
 * (the session prompt lists them in this order).
 *
 * @param {Requirement[]} requirements
 * @returns {Requirement[]}
 */
export function topologicalOrder(requirements) {
  /** @type {Requirement[]} */
  const ordered = [];
  const placed = new Set();
  let remaining = [...requirements];
  while (remaining.length) {
    const ready = remaining.filter((requirement) => requirement.dependsOn.every((id) => placed.has(id)));
    if (!ready.length) throw new Error(`dependency cycle among ${remaining.map((requirement) => requirement.id).join(", ")}`);
    for (const requirement of ready) { ordered.push(requirement); placed.add(requirement.id); }
    remaining = remaining.filter((requirement) => !placed.has(requirement.id));
  }
  return ordered;
}
