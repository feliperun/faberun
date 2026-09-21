/**
 * The two corpora every arm works on, in one shape.
 *
 * `simple`: the ten open requirements the spike-leitura-teto campaign froze
 * against fork a1117f7, each independent, each with a proof the arms may see.
 * `complex`: a real phase of a real campaign, `1c-run-path-resolver` of
 * state-location-and-routing-economics, taken from its recorded contract:
 * four dependent nodes, a resolver whose exports three other nodes consume,
 * 26 files of src/ migrated, and as acceptance the test the phase actually
 * landed plus a centralization check, typecheck and the regression suites the
 * phase itself verified against. The acceptance is hidden from the arms; what
 * they get is the packets the real nodes got, word for word, plus one line
 * naming the resolver API the acceptance imports, so an arm that chose other
 * names would not fail for that alone.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";

/** @typedef {{argv: string[], timeoutSec: number}} Command */
/** @typedef {{id: string, title: string, objective: string, instructions: string[], readFiles: string[], writeFiles: string[], symbols: string[], dependsOn: string[], decisions: string[], nonGoals: string[], scopeAcknowledged: string[], verification: Command[]}} Requirement */
/** @typedef {{id: string, argv: string[], timeoutSec: number, kind: "proof"|"guard", restore?: boolean}} Acceptance a proof fails at the base and passes when the work is done; a guard passes at the base and must still pass. A check with `restore` runs after the corpus's acceptance files are written over the arm's tree; the others run on the tree exactly as the arm left it */
/** @typedef {{path: string, sha?: string, file?: string}} RestoreFile */
/** @typedef {{kind: "simple"|"complex", fork: string, npmCi: boolean, visibleProofs: boolean, restore: RestoreFile[], requirements: Requirement[], acceptance: Acceptance[], hash: string}} CorpusSet */

const NODE = process.execPath;
const TSC = [NODE, "node_modules/typescript/bin/tsc"];
const SIMPLE_FORK = "a1117f7";
/** The commit the 1c phase's landed tests are taken from: its own integrated head. */
export const COMPLEX_INTEGRATED = "054dd4c";
const CENTRALIZATION_CHECK = resolve(ROOT, "spike/arms/checks/centralization.mjs");

/**
 * @param {"simple"|"complex"} kind
 * @param {string} [selection] comma-separated requirement ids for the simple corpus, or "all"
 * @returns {CorpusSet}
 */
export function loadCorpusSet(kind, selection = "all") {
  if (kind === "simple") return simpleCorpus(selection);
  if (kind === "complex") return complexCorpus();
  throw new Error(`unknown corpus ${kind}`);
}

/** @param {string} selection @returns {CorpusSet} */
function simpleCorpus(selection) {
  const all = readFileSync(resolve(ROOT, "spike/corpus/requisitos.jsonl"), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const wanted = selection === "all" ? null : new Set(selection.split(",").map((id) => id.trim()).filter(Boolean));
  if (wanted) {
    const unknown = [...wanted].filter((id) => !all.some((requirement) => requirement.id === id));
    if (unknown.length) throw new Error(`unknown requirement id(s): ${unknown.join(", ")}`);
  }
  const chosen = wanted ? all.filter((requirement) => wanted.has(requirement.id)) : all;
  const key = JSON.parse(readFileSync(resolve(ROOT, "spike/corpus/gabarito.json"), "utf8"));
  return {
    kind: "simple",
    fork: SIMPLE_FORK,
    npmCi: false,
    visibleProofs: true,
    restore: chosen.map((requirement) => ({ path: requirement.prova, file: resolve(ROOT, requirement.prova) })),
    requirements: chosen.map((requirement) => ({
      id: requirement.id,
      title: requirement.titulo,
      objective: requirement.titulo,
      instructions: [
        requirement.objetivo,
        "Never edit or delete anything under spike/corpus/provas/: those are the acceptance proofs, and the controller runs them after you report.",
        "Return the worker result as the only JSON object of your final message.",
      ],
      readFiles: [...new Set([...requirement.gabarito, requirement.prova])],
      writeFiles: requirement.escopoEscrita,
      symbols: [],
      dependsOn: [],
      decisions: [],
      nonGoals: ["Do not change files outside the write scope."],
      scopeAcknowledged: [],
      verification: [{ argv: [NODE, "--test", requirement.prova], timeoutSec: 180 }],
    })),
    acceptance: chosen.map((requirement) => ({ id: requirement.id, argv: [NODE, "--test", requirement.prova], timeoutSec: 180, kind: /** @type {const} */ ("proof"), restore: true })),
    hash: String(key.hash),
  };
}

/**
 * The resolver API the landed acceptance test imports. Stated to every arm as
 * the last instruction of the resolver node, because the real packet named
 * only the three genuinely new symbols and let the export list follow the
 * call sites; an arm that named a builder differently would fail the
 * acceptance for a naming choice, not for the work.
 */
const RESOLVER_API = "The acceptance test the driver runs after this phase imports these exact names from src/run/paths.mjs, so export them with these signatures and results: RUNS_DIR_NAME (the string \".runs\"); runsRoot(cwd) = join(cwd, \".runs\"); runDirectory(cwd, runId) = join(cwd, \".runs\", runId); campaignsRoot(cwd) = join(cwd, \".runs\", \"campaigns\"); campaignTree(cwd, campaignId) = join(cwd, \".runs\", \"campaigns\", campaignId); attemptWorktreePath(runDir, runId, nodeId, attempt) = join(dirname(runDir), \"worktrees\", runId, `${nodeId}.${attempt}`); candidateWorktreePath(runDir, runId) = join(dirname(runDir), \"worktrees\", runId, \".candidate\"). A relative cwd resolves relatively, exactly as the call sites do today.";

/**
 * Per-node verification, trimmed from the recorded contract's whole-directory
 * suites (test/engine/ alone runs 19 minutes) to the suites that prove each
 * node: the run suite and typecheck for the resolver, typecheck plus run and
 * repo suites for the two migrations, the ratchet's own files for the guard.
 *
 * @type {Record<string, Command[]>}
 */
const COMPLEX_VERIFICATION = {
  "one-module-owns-the-run-paths": [{ argv: [NODE, "--test", "test/run/"], timeoutSec: 300 }, { argv: TSC, timeoutSec: 300 }],
  "engine-and-campaign-callers-use-the-resolver": [{ argv: TSC, timeoutSec: 300 }, { argv: [NODE, "--test", "test/run/", "test/repo/"], timeoutSec: 600 }],
  "cli-repo-and-surface-callers-use-the-resolver": [{ argv: TSC, timeoutSec: 300 }, { argv: [NODE, "--test", "test/run/", "test/repo/"], timeoutSec: 600 }],
  "the-centralization-guard-only-falls": [{ argv: [NODE, "--test", "test/repo/source-shape.test.mjs", "test/run/paths.test.mjs"], timeoutSec: 300 }, { argv: TSC, timeoutSec: 300 }],
};

/** @returns {CorpusSet} */
function complexCorpus() {
  const text = readFileSync(resolve(ROOT, "spike/corpus-complex/nodes.json"), "utf8");
  const spec = JSON.parse(text);
  const requirements = spec.nodes.map((/** @type {any} */ node) => {
    const verification = COMPLEX_VERIFICATION[node.id];
    if (!verification) throw new Error(`no trimmed verification for node ${node.id}`);
    return {
      id: node.id,
      title: node.id.replace(/-/gu, " "),
      objective: node.taskPacket.objective,
      instructions: [...node.taskPacket.instructions, ...(node.id === "one-module-owns-the-run-paths" ? [RESOLVER_API] : [])],
      readFiles: node.taskPacket.readFiles ?? [],
      writeFiles: node.taskPacket.writeFiles ?? [],
      symbols: node.taskPacket.symbols ?? [],
      dependsOn: node.dependsOn ?? [],
      decisions: node.taskPacket.decisions ?? [],
      nonGoals: node.taskPacket.nonGoals ?? [],
      scopeAcknowledged: node.taskPacket.scopeAcknowledged ?? [],
      verification,
    };
  });
  return {
    kind: "complex",
    fork: String(spec.base).slice(0, 7),
    npmCi: true,
    visibleProofs: false,
    restore: [{ path: "test/run/paths.test.mjs", sha: COMPLEX_INTEGRATED }],
    requirements,
    // The regression suites run on the tree as the arm left it, its own tests
    // included: measured 2026-09-20, arm C wrote an exact-count ratchet over
    // test/ and the landed paths test, written over the arm's own before the
    // suites ran, moved the count by three and failed a check the arm had
    // passed. Only the landed test itself runs after the restore.
    // Two proofs fail at the base and pass at the landing; two guards pass at
    // the base and must still pass. Measured 2026-09-20: a writer that refused
    // the packet and changed nothing passed both guards, so counting guards
    // as delivery would have credited a run that delivered nothing.
    acceptance: [
      { id: "src-centralization", argv: [NODE, CENTRALIZATION_CHECK, "."], timeoutSec: 60, kind: /** @type {const} */ ("proof") },
      { id: "typecheck", argv: TSC, timeoutSec: 300, kind: /** @type {const} */ ("guard") },
      { id: "regression", argv: [NODE, "--test", "test/run/", "test/repo/", "test/cli/", "test/campaign/"], timeoutSec: 1500, kind: /** @type {const} */ ("guard") },
      { id: "resolver-api", argv: [NODE, "--test", "test/run/paths.test.mjs"], timeoutSec: 180, kind: /** @type {const} */ ("proof"), restore: true },
    ],
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

/** The kind of each complex-corpus check, for ledger lines written before checks carried one. */
const KIND_BY_ID = { "src-centralization": "proof", typecheck: "guard", regression: "guard", "resolver-api": "proof" };

/**
 * What a run delivered: the proofs that pass, provided every guard passes. A
 * change that breaks the typecheck or a regression suite delivers nothing,
 * whatever else it got right; a run that changed nothing passes every guard
 * and no proof, and delivers nothing too. A simple-corpus check is a proof.
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
