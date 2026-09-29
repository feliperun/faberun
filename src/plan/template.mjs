/**
 * Planning contract templates: the one-node `mode: "discovery"` contracts a
 * plan pipeline runs outside the control session — draft, review, revise (a
 * draft carrying the reviewer's findings), spec authoring, and spec review.
 * Separate from freeze.mjs (which turns an already-built plan into a
 * validated contract on disk) because this module never touches the
 * filesystem or a model: it only assembles the JSON object `validateContract`
 * accepts, from exactly the inputs each role may see. The reviewer's packet
 * is the enforced case: it carries the spec, the repository facts and the
 * artefact under review, never the author's packet, transcript or summary.
 *
 * The plan output validator also owns requirement traceability: a plan
 * declares, per phase, the requirement ids it satisfies, the node ids it
 * assigns, and its one-sentence deliverable. A planned node belongs to exactly
 * one declaration, so a missing, duplicate, or unknown node assignment is a
 * refusal. A legacy declaration that names no requirements and no nodes is
 * still reported as a finding, never a silent pass. freeze.mjs imports the
 * same phase check for the frozen plan record.
 *
 * It also validates the two contract-level suites a plan may author of its own
 * (RM-107): `sharedVerification` and `finalVerification`, the same schema the
 * contract carries, so the phase's repository-wide proof is planned rather
 * than left to an operator remembering `--verification`.
 */
import { assertObject, positiveInteger, rejectUnknown, requireId, requireString, requireStringArray } from "../contract/assert.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../contract/index.mjs";
import { validateDefinitionOfDone } from "../contract/definition-of-done.mjs";
import { validateFinalVerification, validateSharedVerification } from "../contract/final-verification.mjs";
import { validateVerificationCommands } from "../contract/verification.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {"draft"|"review"|"revise"|"spec-author"|"spec-review"} PlanningKind */
/** @typedef {"low"|"standard"|"high"} RiskTier */
/** @typedef {{campaignId: string, phase: string, n: number, goal?: string, cwd?: string, runtimes: Record<string, JsonObject>, runtimeDefaults: {worker?: string, judge?: string}, reviewerId?: string, specPath?: string, repoFactsPath?: string, cataloguePath?: string, packageMode?: import("./sizing.mjs").PackageMode, planPath?: string, findingsPath?: string, notesPath?: string, revisePatch?: boolean}} PlanningContractInputs */
/** @typedef {{id: string, objective: string, taskKind: string, riskTier: RiskTier, dependsOn: string[], readFiles: string[], writeFiles: string[], scopeAcknowledged: string[], definitionOfDone: import("../contract/definition-of-done.mjs").DefinitionOfDoneItem[], verification: import("../contract/verification.mjs").VerificationCommand[], expectedTurns?: number}} PlanOutputNode */
/** @typedef {{nodes: PlanOutputNode[], phases?: PlanPhase[], sharedVerification?: import("../contract/verification.mjs").VerificationCommand[], finalVerification?: import("../contract/verification.mjs").VerificationCommand[], findings?: PlanFindingOutput[], justification?: string}} PlanOutput */
/** @typedef {{id: string, requirementIds: string[], nodeIds?: string[], deliverable: string}} PlanPhase */
/** @typedef {{id: string, severity: "critical"|"major"|"minor", nodeId: string, text: string}} PlanFindingOutput */

/** The taskKind catalogue a draft or revise classifies against. */
export const TASK_KINDS = Object.freeze(["docs", "implement", "test", "refactor", "infra", "judge"]);

/** The risk tiers a draft or revise classifies against. */
export const RISK_TIERS = Object.freeze(["low", "standard", "high"]);

/**
 * The file name the planner stages the catalogue under, beside the spec and
 * the repository facts it already stages.
 *
 * This used to be `src/plan/template.mjs` -- this module's own repo-relative
 * path -- so that a closed-context worker had a real, always-present file to
 * read for the authoritative list. It is always present in *this* repository.
 * A planning contract's `readFiles` resolve against the target repository, and
 * every other repository refuses the contract with `readFiles[2] does not
 * exist: src/plan/template.mjs`, which made `faberun plan` able to plan only
 * faberun. The catalogue is data, so it is written out like the other inputs
 * instead of being pointed at across repository boundaries.
 */
export const TASK_KIND_CATALOGUE_FILE = "task-kinds.md";

/**
 * The catalogue document itself, rendered from the two exported lists so the
 * file a worker reads and the values `validatePlanOutput` accepts cannot
 * drift apart.
 *
 * @returns {string}
 */
export function renderTaskKindCatalogue() {
  return [
    "# taskKind and riskTier catalogue",
    "",
    "Written by `faberun plan` for this stage. These are the only values a plan may use;",
    "any other value is rejected when the plan is validated.",
    "",
    "## taskKind",
    "",
    ...TASK_KINDS.map((kind) => `- ${kind}`),
    "",
    "## riskTier",
    "",
    ...RISK_TIERS.map((tier) => `- ${tier}`),
    "",
  ].join("\n");
}

/**
 * Which of the caller's runtime inputs resolves this contract's single node.
 * A draft or revise is authored by the worker role, read off
 * `runtimeDefaults.worker`; a review or spec-review is graded by the
 * reviewer role, read off `inputs.reviewerId` instead (R19) -- the planner's
 * own ordered reviewer list (`reviewer.mjs`), never `runtimeDefaults.judge`,
 * which is R18's judge-list default for the frozen contract's nodes and
 * shares nothing with this one. There is no gate on this single-node
 * contract, so the role only decides which runtime id the node itself
 * carries.
 *
 * @type {Record<PlanningKind, "worker"|"reviewer">}
 */
const KIND_ROLE = Object.freeze({
  draft: "worker",
  revise: "worker",
  "spec-author": "worker",
  review: "reviewer",
  "spec-review": "reviewer",
});

/** @type {Record<PlanningKind, string[]>} */
const REQUIRED_INPUTS = Object.freeze({
  draft: ["specPath", "repoFactsPath", "cataloguePath"],
  revise: ["specPath", "repoFactsPath", "cataloguePath", "findingsPath", "planPath"],
  review: ["specPath", "repoFactsPath", "planPath"],
  "spec-author": ["notesPath"],
  "spec-review": ["specPath"],
});

// The nested shapes are spelled from DefinitionOfDoneItem
// (contract/definition-of-done.mjs) and VerificationCommand
// (contract/verification.mjs), never from prose: observed 2026-09-20, bare
// field names made a worker guess — a DoD item with no id, a `command` string
// where argv belongs — and the guess failed validatePlanOutput only after the
// run had already succeeded. The id charset is requireId's
// (contract/assert.mjs) verbatim, because an id that is present but invalid
// fails that same validator just as late.
const PLAN_NODE_SHAPE = '{id, objective, taskKind, riskTier, dependsOn, readFiles, writeFiles, scopeAcknowledged, definitionOfDone: [{id, text, proof?: {kind: "command"|"path"|"verification", ref}, judgment?: true, reason?: string}], verification: [{argv: [string], cwd?, timeoutSec?, repeat?, env?, mutation?: {threshold}}], expectedTurns?}';
const PLAN_PHASE_SHAPE = '[{id, requirementIds: [string], nodeIds: [string], deliverable}]';
const PLAN_SUITE_SHAPE = '[{argv: [string], cwd?, timeoutSec?, repeat?, env?, mutation?: {threshold}}]';
const ID_CHARSET_RULE = 'every id in it (node, phase, node assignment, and definitionOfDone item) must match [A-Za-z0-9._-]+ and never be exactly "." or ".."';
const PLAN_OUTPUT_SHAPE = `{nodes: [${PLAN_NODE_SHAPE}], phases?: ${PLAN_PHASE_SHAPE}, sharedVerification?: ${PLAN_SUITE_SHAPE}, finalVerification?: ${PLAN_SUITE_SHAPE}, justification?}; ${ID_CHARSET_RULE}`;
/**
 * What a revise writes instead of the plan again (RM-110). Every node this
 * names is a complete node, because the plan it patches is in the reviser's
 * readFiles and the patch says only what changes: the node shape is
 * `PLAN_NODE_SHAPE`, one home for both strings so they cannot drift.
 */
const REVISE_PATCH_SHAPE = `{nodes?: [${PLAN_NODE_SHAPE}], removedNodeIds?: [string], phases?: ${PLAN_PHASE_SHAPE}, sharedVerification?: ${PLAN_SUITE_SHAPE}, finalVerification?: ${PLAN_SUITE_SHAPE}, justification?}; ${ID_CHARSET_RULE}`;
/**
 * The size guidance every draft and revise carries. measured 2026-09-20 over
 * stored runs: median 49 provider requests per worker turn; cost per turn
 * nearly independent of the write set; 14.5 minutes of verification, judge
 * and integration per node outside its worker turn; an attempt is cut at
 * 150 requests.
 */
const SIZING_INSTRUCTION = "Size nodes to 4 to 6 write files where the work allows, and give every node an expectedTurns: the provider requests one worker needs to finish it end to end (measured median 49 for 4 to 6 files). A smaller node pays the same orientation and about 15 minutes of verification, judge and integration for less delivered work; a node you expect past 150 requests must be split, because a run cuts an attempt there.";
/**
 * The exploratory counterpart to the sizing guidance above: sizing by what a
 * node reads, because that is what exploratory work is paid for. An audit
 * node writes one findings file whatever surface it covers, so the write-set
 * sentence would size every node in such a package identically and wrongly --
 * which is why the audit of 2026-09-22 was written by hand as 50 KB of JSON
 * instead of planned.
 */
const EXPLORATORY_SIZING_INSTRUCTION = "Size nodes by what each must read and by risk, never by what it writes: one write file is the normal shape for a finding, a review or an audit. Give every node an expectedTurns (the provider requests one worker needs end to end), keep the read volume of the nodes within the same order of each other so one does not cost several times its siblings, and split a node you expect past 150 requests, because a run cuts an attempt there.";
const FINDINGS_SHAPE = "[{id, severity, nodeId, text}]";

/**
 * The two shapes a revise can be asked for, swapped by `instructionsFor`.
 * Which one is in force is decided by `inputs.revisePatch`, never by the
 * worker: the plan in readFiles is a validated plan to patch only when the
 * pipeline has one, and a draft that never validated is the case where it does
 * not (`rounds.mjs` starts a round with `plan: null` and the draft's own
 * rejected output).
 */
const REVISE_PLAN_INSTRUCTION = `Return exactly one worker-result JSON object. Put the revised plan in output.plan as ${PLAN_OUTPUT_SHAPE} and nothing else in output.`;
const REVISE_PATCH_INSTRUCTION = `Return exactly one worker-result JSON object. Put the revision in output.patch as ${REVISE_PATCH_SHAPE} and nothing else in output. The patch applies to the plan JSON in readFiles: a node whose id that plan already has replaces it, a new id adds a node, removedNodeIds names each node the plan must no longer have, and a field you omit keeps the value the plan already has. Carry only the nodes and fields a finding requires — a revise that omits what a finding names has not answered it.`;

/**
 * The instruction list is a frozen table because it is the same for every
 * campaign; only the sizing sentence depends on what kind of package this is.
 *
 * @param {PlanningKind} kind
 * @param {PlanningContractInputs} inputs
 * @returns {string[]}
 */
function instructionsFor(kind, inputs) {
  const lines = kind !== "revise" || inputs.revisePatch !== true
    ? INSTRUCTIONS[kind]
    : INSTRUCTIONS[kind].map((line) => (line === REVISE_PLAN_INSTRUCTION ? REVISE_PATCH_INSTRUCTION : line));
  if (inputs.packageMode !== "exploratory") return lines;
  return lines.map((line) => (line === SIZING_INSTRUCTION ? EXPLORATORY_SIZING_INSTRUCTION : line));
}

// AP1 of safe-to-hand-to-a-friend, measured 2026-09-26: a draft copied the
// spec's requirement proof `node --test --test-name-pattern="<title>"` into a
// Definition of Done item with no file, which runs every test file in the
// tree and read as having measured nothing; two nodes exhausted on it. The
// freeze now refuses that shape (proof-scope.mjs); this is the same rule told
// to the author, so the draft never writes it.
// AP11 of safe-to-hand-to-friend, measured 2026-09-27: the plan proved R6 with
// `! grep -q "\.runs" README.md docs/*.md` while the requirement allowed the
// mention inside a section labelled as legacy layout, and the node exhausted
// both attempts on a proof stricter than the statement it proved. The proof's
// wording is a claim the reviewer can compare with the requirement's own; no
// deterministic check does, because "stricter" is a reading of two sentences.
const PROOF_NOT_STRICTER_THAN_REQUIREMENT_RULE = "For every node, compare each command proof with the requirement statement it proves, sentence by sentence: a proof that asserts more than the statement is a finding, because the node is refused for work the requirement allows. A bare `grep` for an absence the statement does not claim, a pattern narrower than the statement's words, or a whole-file scope where the statement names a section are the three shapes this takes.";

const NAMED_TEST_FILE_RULE = 'A command that filters node:test by name (--test-name-pattern) names the test file it selects from, as in node --test --test-name-pattern="<exact test title>" test/<area>/<file>.test.mjs: with no path node --test runs every test file in the tree and the freeze refuses it. A requirement proof the spec writes without a file gains the file of the test that carries that title.';

// RM-109, measured 2026-09-27 on `safe-to-hand-to-a-friend`: the naming
// convention alone decided a node's test file, so a node whose module was
// exercised by a test named after something else passed its own suite and
// still left four failures for the integration branch (1763 tests, 4 failures,
// phases 3/4/5/3r8). repo-facts.json's testFiles carries what each test file
// references, so the planner names the files that can actually break.
const COVERING_TEST_RULE = 'repo-facts.json\'s testFiles lists, per test file, the repo-relative modules it is named after and the ones it imports or runs. A node\'s verification names every test file whose covers intersects its writeFiles, not only the one named after the module: node --test <file>, one per covering file, and the enclosing test directory when that set is larger than one verification array holds. A test file that references nothing the node writes is not named there; those are the phase\'s finalVerification, which runs the whole suite once when the phase closes.';

// R4 of the phase-2 reissue: repo-facts.json's `paths` is a byte-limited cut
// (DEFAULT_MAX_PATH_BYTES in src/plan/repo-facts.mjs), and the finding it
// answers (judge Sol's `r4-omission-text-legible`) was that a single
// `truncated` flag described nothing: a dropped manifest and a dropped
// historical log read the same. The artefact now reports paths and bytes per
// source kind, so both stages that read it are told to read that report rather
// than to read an absent path as an absent file.
/**
 * What a draft or revise is told about the cut it authors from. The plan is
 * written against the cut, so a node that needs a file the cut discarded has
 * to know the path may exist and be absent from `paths` — otherwise the honest
 * plan it produces is "this repository holds no such file".
 */
export const PATH_CUT_RULE = "repo-facts.json's paths is the byte-limited cut of the tracked tree, never the whole index: it keeps every path a requirement's proof or measure names, every test file, and every module the tree references, and reports what the ceiling discarded in pathOmission — paths and bytes in total, and the same two numbers per source kind (document, archived-log, manifest, code, other). Read pathOmission before concluding the tree holds no file of a kind, and never read a path's absence from paths as proof of absence: it may be one the ceiling discarded. The complete index is staged beside the artefact as repo-paths.txt, for a discovery node the plan explicitly authorises to enumerate the tree; a node's readFiles never names it otherwise.";
/**
 * The reviewer's half of the same rule. A reviewer only ever sees the
 * artefact, so the cut is exactly what could make it raise a finding against
 * the tree rather than against the plan.
 */
export const REVIEW_PATH_CUT_RULE = "repo-facts.json's paths is a byte-limited cut of the tracked tree, so a path absent from it is not evidence that the file is absent. pathOmission reports, per source kind (document, archived-log, manifest, code, other), how many paths and how many bytes the cut discarded, and those per-kind numbers sum to its own paths and bytes totals. A finding that a node misses a file the spec implies is only valid when the path is in paths or named by the requirement itself; the complete index is staged beside the artefact as repo-paths.txt for the plan to read if it needs it.";

// RM-107, measured 2026-09-27 on `safe-to-hand-to-a-friend` phase 1: the phase
// integrated a red tree -- src/host/preflight.mjs at 840 lines against the 800
// ceiling, declaredEnvironment exported by seven modules, three test files
// whose first import was not scoped-home.mjs, one zcode assertion falsified --
// and no node had run test/repo/source-shape.test.mjs (0.36 s measured).
// Contract-level verification was operator-only, so a phase whose whole point
// was a repository-wide ratchet could freeze without one and look fully
// verified. The planner reads the measured candidates, so it is the one that
// proposes them here.
const CONTRACT_VERIFICATION_RULE = Object.freeze([
  "A plan may carry two suites of its own, over and above the per-node verification: output.plan.sharedVerification, whose commands run on every node of the phase, and output.plan.finalVerification, whose commands run once, when the phase closes. Both take exactly a node's verification-command shape. Use them for the proof no single node owns: a repository-wide conformance or structural suite, in sharedVerification, because any node can break one, and the target's whole suite, in finalVerification, because only the last node can run it.",
  "Every command in either suite must be an argv repo-facts.json measured (verificationCandidates includes each measured argv with its measuredMs), copied verbatim, with a timeoutSec of at least twice that measuredMs. A command the facts did not measure is written from memory, not measurement, and is the shape this rule exists to stop. Omit a suite the facts measured nothing for; a plan for a repository with no ratchets carries neither.",
  "A command that already runs in a suite is not repeated in a node's verification, and a node's own verification is never replaced by a suite.",
]);

// The rule every planned packet is held to at freeze time, worded from
// AGENTS.md's Faberun protocol and src/repo/scope-closure.mjs ("reading it
// cannot fix it"): a first draft that ignores it produces a plan that fails
// the pipeline's in-round contract check a round later than a draft that
// could have written the write set honestly.
const SCOPE_CLOSURE_RULE = Object.freeze([
  "Each node's writeFiles lists what the change forces to change, not only what it intends to: the importers a written module drags along, the schema validator for a field the node adds, the registry that field is recorded in, and any reader the node's own instructions tell the worker to touch.",
  "Scope closure refuses a task packet whose transitive imports reach an undeclared file, so an importer the change breaks belongs in writeFiles or scopeAcknowledged — readFiles only permits reading, and a broken importer can only be repaired by a write.",
]);

/** @type {Record<PlanningKind, string>} */
const OBJECTIVES = Object.freeze({
  draft: "Draft an execution plan for this phase: classify every node's taskKind and riskTier from the spec and the repository facts, and propose the dependency graph.",
  revise: "Revise the plan in readFiles to resolve every one of the reviewer's findings, changing only what a finding requires.",
  review: "Review this plan against the spec and the repository facts, and report only findings.",
  "spec-author": "Turn free notes into a structured spec document following the spec format.",
  "spec-review": "Review this spec for traceability and completeness, and report only findings.",
});

/** @type {Record<PlanningKind, string[]>} */
const INSTRUCTIONS = Object.freeze({
  draft: [
    `Consult the ${TASK_KIND_CATALOGUE_FILE} in readFiles before classifying any node; taskKind must be one of that catalogue and riskTier must be one of ${RISK_TIERS.join(", ")}.`,
    "Declare every phase the plan serves in output.plan.phases: the requirement ids (R<n> from the spec) the phase satisfies, the planned node ids it assigns, and the deliverable it produces in one sentence. Every planned node must appear in exactly one phase's nodeIds; a missing, duplicate, or unknown node assignment is refused.",
    ...SCOPE_CLOSURE_RULE,
    NAMED_TEST_FILE_RULE,
    COVERING_TEST_RULE,
    PATH_CUT_RULE,
    ...CONTRACT_VERIFICATION_RULE,
    `Return exactly one worker-result JSON object. Put the plan in output.plan as ${PLAN_OUTPUT_SHAPE} and nothing else in output.`,
    "Never name a runtime, harness, model, or vendor anywhere in output.plan. taskKind and riskTier are the only classification a draft makes; a routing table assigns a runtime afterward, from those two fields alone.",
    SIZING_INSTRUCTION,
  ],
  revise: [
    "Start from the plan JSON in readFiles, the plan the findings were raised against, and return it with only the changes the findings require. Keep every node id, write file, definitionOfDone item and contract-level suite that no finding asks you to change: a revise that redrafts from the findings alone loses what the plan already got right.",
    "Read the findings and resolve every one; do not leave a critical or major finding unaddressed.",
    "Declare every phase the plan serves in output.plan.phases: the requirement ids (R<n> from the spec) the phase satisfies, the planned node ids it assigns, and the deliverable it produces in one sentence. Every planned node must appear in exactly one phase's nodeIds; a missing, duplicate, or unknown node assignment is refused.",
    ...SCOPE_CLOSURE_RULE,
    NAMED_TEST_FILE_RULE,
    COVERING_TEST_RULE,
    PATH_CUT_RULE,
    ...CONTRACT_VERIFICATION_RULE,
    REVISE_PLAN_INSTRUCTION,
    "Never name a runtime, harness, model, or vendor anywhere in output.plan.",
    SIZING_INSTRUCTION,
  ],
  review: [
    "You are given only the spec, the repository facts, and the plan under review; you have not seen how the plan was produced or any reasoning behind it. Review the artefact alone.",
    PROOF_NOT_STRICTER_THAN_REQUIREMENT_RULE,
    REVIEW_PATH_CUT_RULE,
    `Return exactly one worker-result JSON object. Put your findings in output.findings as ${FINDINGS_SHAPE} and nothing else in output.`,
    "severity must be one of critical, major, minor. Every finding's nodeId must name a node id that actually appears in the plan under review.",
  ],
  "spec-author": [
    "Read the notes and turn them into a structured spec document: front matter, Intent, Requirements (each with a stable R<n> id and a proof), Non-goals, Constraints, Success criteria, and Risks.",
    "Return exactly one worker-result JSON object. Put the authored spec text, as one markdown document, in output.spec and nothing else in output.",
  ],
  "spec-review": [
    "You are given only the spec under review; you have not seen the author's notes or reasoning. Review the document alone.",
    `Return exactly one worker-result JSON object. Put your findings in output.findings as ${FINDINGS_SHAPE} and nothing else in output.`,
    "severity must be one of critical, major, minor. Every finding's nodeId must name the requirement id, or section heading, it concerns.",
  ],
});

/** @type {Record<PlanningKind, string[]>} */
const NON_GOALS = Object.freeze({
  draft: ["Assigning a runtime, harness, or model to any node."],
  revise: ["Assigning a runtime, harness, or model to any node.", "Reopening a finding the reviewer did not raise."],
  review: ["Proposing a replacement plan.", "Assigning a runtime, harness, or model to any node."],
  "spec-author": ["Declaring nodes, phases, or architecture in the spec."],
  "spec-review": ["Proposing a replacement spec."],
});

/**
 * @param {PlanningKind} kind
 * @param {PlanningContractInputs} inputs
 * @returns {string[]}
 */
function readFilesForKind(kind, inputs) {
  if (kind === "draft") return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), /** @type {string} */ (inputs.cataloguePath)];
  if (kind === "revise") {
    return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), /** @type {string} */ (inputs.cataloguePath), /** @type {string} */ (inputs.findingsPath), /** @type {string} */ (inputs.planPath)];
  }
  if (kind === "review") return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), /** @type {string} */ (inputs.planPath)];
  if (kind === "spec-author") return [/** @type {string} */ (inputs.notesPath)];
  return [/** @type {string} */ (inputs.specPath)];
}

/**
 * The wall clock one planning stage gets, from the reasoning effort of the
 * runtime that runs it. A stage is a single long turn over the whole plan, so
 * the contract default (2400 s) fits a draft at ordinary effort but not a
 * revise at high effort. Measured 2026-09-27: Opus 5.5 at `xhigh` revising
 * a 20-node plan against 13 findings was still reasoning when the 2400 s wall
 * clock ended the stage, and the pipeline, which cannot resume a stage, lost
 * the draft and review it had already paid for.
 *
 * @param {Record<string, unknown>|undefined} runtime
 * @returns {number}
 */
export function planningStageTimeoutSec(runtime) {
  const reasoning = runtime?.reasoning;
  if (reasoning === "xhigh" || reasoning === "max") return 7200;
  if (reasoning === "high") return 3600;
  return 2400;
}

/**
 * Build one of the planning pipeline's one-node discovery contracts. Pure:
 * no file is read or written, and no model is invoked. The returned object is
 * the raw, not-yet-validated contract JSON `validateContract` accepts.
 *
 * @param {PlanningKind} kind
 * @param {PlanningContractInputs} inputs
 * @returns {JsonObject}
 */
export function buildPlanningContract(kind, inputs) {
  const required = REQUIRED_INPUTS[kind];
  if (!required) throw new TypeError(`buildPlanningContract: unknown kind ${kind}`);
  requireId(inputs.campaignId, "inputs.campaignId");
  requireString(inputs.phase, "inputs.phase");
  if (!Number.isInteger(inputs.n) || inputs.n <= 0) throw new TypeError("inputs.n must be a positive integer");
  assertObject(inputs.runtimes, "inputs.runtimes");
  assertObject(inputs.runtimeDefaults ?? {}, "inputs.runtimeDefaults");
  const inputRecord = /** @type {Record<string, unknown>} */ (inputs);
  for (const field of required) requireString(inputRecord[field], `inputs.${field}`);

  const readFiles = readFilesForKind(kind, inputs);
  const role = KIND_ROLE[kind];
  const runtimeId = role === "reviewer" ? inputs.reviewerId : (inputs.runtimeDefaults ?? {})[role];

  /** @type {JsonObject} */
  const taskPacket = {
    mode: "discovery",
    objective: OBJECTIVES[kind],
    instructions: instructionsFor(kind, inputs),
    readFiles,
    writeFiles: [],
    symbols: [],
    decisions: [],
    nonGoals: NON_GOALS[kind],
    verification: [],
  };

  const stageRuntime = runtimeId === undefined ? undefined : /** @type {Record<string, unknown>|undefined} */ (inputs.runtimes[runtimeId]);

  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: `${inputs.campaignId}-plan-${inputs.phase}-${kind}-${inputs.n}`,
    timeoutSec: planningStageTimeoutSec(stageRuntime),
    campaignId: inputs.campaignId,
    goal: inputs.goal ?? `Plan ${kind} for phase ${inputs.phase}`,
    cwd: inputs.cwd ?? ".",
    runtimes: inputs.runtimes,
    runtimeDefaults: inputs.runtimeDefaults ?? {},
    nodes: [
      {
        id: kind,
        type: kind,
        phase: inputs.phase,
        dependsOn: [],
        ...(runtimeId === undefined ? {} : { runtime: runtimeId }),
        taskPacket,
        gate: false,
      },
    ],
  };
}

const PLAN_FIELDS = new Set(["nodes", "phases", "sharedVerification", "finalVerification", "justification"]);
/** A patch's fields: the plan's own, minus `nodes`, plus the ids it removes. */
const PATCH_FIELDS = new Set(["nodes", "removedNodeIds", "phases", "sharedVerification", "finalVerification", "justification"]);
const PLAN_NODE_FIELDS = new Set(["id", "objective", "taskKind", "riskTier", "dependsOn", "readFiles", "writeFiles", "scopeAcknowledged", "definitionOfDone", "verification", "expectedTurns"]);

/**
 * The node list of a plan, or of a revise's `output.patch`, under one
 * validator: a node's shape is the same in both, so a patch node is refused
 * for exactly what a plan node is. `label` is the caller's own field path, so
 * the message a worker reads names the field it actually wrote.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {PlanOutputNode[]}
 */
function validatePlanNodes(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((node, index) => {
    const nodeLabel = `${label}[${index}]`;
    assertObject(node, nodeLabel);
    const nodeRecord = /** @type {Record<string, unknown>} */ (node);
    rejectUnknown(nodeRecord, PLAN_NODE_FIELDS, nodeLabel);
    requireId(nodeRecord.id, `${nodeLabel}.id`);
    requireString(nodeRecord.objective, `${nodeLabel}.objective`);
    if (typeof nodeRecord.taskKind !== "string" || !TASK_KINDS.includes(nodeRecord.taskKind)) {
      throw new TypeError(`${nodeLabel}.taskKind must be one of ${TASK_KINDS.join(", ")}`);
    }
    if (typeof nodeRecord.riskTier !== "string" || !RISK_TIERS.includes(nodeRecord.riskTier)) {
      throw new TypeError(`${nodeLabel}.riskTier must be one of ${RISK_TIERS.join(", ")}`);
    }
    const dependsOn = nodeRecord.dependsOn ?? [];
    requireStringArray(dependsOn, `${nodeLabel}.dependsOn`);
    const readFiles = nodeRecord.readFiles ?? [];
    requireStringArray(readFiles, `${nodeLabel}.readFiles`);
    const writeFiles = nodeRecord.writeFiles ?? [];
    requireStringArray(writeFiles, `${nodeLabel}.writeFiles`);
    // A node that reaches an importer it must not change says so here. Without
    // this field the drafter is told (INSTRUCTIONS, draft/revise) to answer a
    // scope-closure finding with `writeFiles or scopeAcknowledged` and has no
    // way to say the second, so the only expressible answer is the wrong one:
    // declaring a read-only importer writable. Measured 2026-09-20 -- a revise
    // round could not resolve the finding the preflight had just raised.
    const scopeAcknowledged = nodeRecord.scopeAcknowledged ?? [];
    requireStringArray(scopeAcknowledged, `${nodeLabel}.scopeAcknowledged`);
    // Verification is validated first so a DoD proof that names a verification
    // command by its exact text (R21) can be checked and normalized to that
    // command's index against this node's own commands, in hand here.
    const verification = validateVerificationCommands(nodeRecord.verification ?? [], `${nodeLabel}.verification`);
    const definitionOfDone = validateDefinitionOfDone(
      nodeRecord.definitionOfDone ?? [],
      `${nodeLabel}.definitionOfDone`,
      { commands: verification, nodeId: /** @type {string} */ (nodeRecord.id) },
    );
    const expectedTurns = nodeRecord.expectedTurns === undefined ? undefined : positiveInteger(nodeRecord.expectedTurns, `${nodeLabel}.expectedTurns`);
    return /** @type {PlanOutputNode} */ ({
      id: /** @type {string} */ (nodeRecord.id),
      objective: /** @type {string} */ (nodeRecord.objective),
      taskKind: /** @type {string} */ (nodeRecord.taskKind),
      riskTier: /** @type {RiskTier} */ (nodeRecord.riskTier),
      dependsOn: /** @type {string[]} */ (dependsOn),
      readFiles: /** @type {string[]} */ (readFiles),
      writeFiles: /** @type {string[]} */ (writeFiles),
      scopeAcknowledged: /** @type {string[]} */ (scopeAcknowledged),
      definitionOfDone,
      verification,
      ...(expectedTurns === undefined ? {} : { expectedTurns }),
    });
  });
}

/**
 * Validate a draft's `output.plan`. Rejects a node naming a
 * runtime, harness, model, or vendor (an unknown field, since a plan node's
 * shape never includes one) and a node missing taskKind or riskTier. A
 * declared phase associated with no requirement is reported as a finding on
 * the result, never a silent pass and never a refusal.
 *
 * @param {unknown} plan
 * @returns {PlanOutput}
 */
export function validatePlanOutput(plan) {
  assertObject(plan, "plan");
  const record = /** @type {Record<string, unknown>} */ (plan);
  rejectUnknown(record, PLAN_FIELDS, "plan");
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new TypeError("plan.nodes must be a non-empty array");
  }
  const nodes = validatePlanNodes(record.nodes, "plan.nodes");
  if (record.justification !== undefined) requireString(record.justification, "plan.justification");
  // The two contract-level suites, under the validators the contract itself
  // applies, so a plan cannot author a suite the freeze would then refuse. An
  // empty array stays legal here and means what absence means; the assembly
  // (`effectiveVerificationSuites`) is what drops it before the contract.
  const sharedVerification = validateSharedVerification(record.sharedVerification, "plan.sharedVerification");
  const finalVerification = validateFinalVerification(record.finalVerification, "plan.finalVerification");
  const phases = validatePlanPhases(record.phases, nodes.map((node) => node.id));
  const findings = (phases ?? [])
    .filter((phase) => phase.requirementIds.length === 0)
    .map((phase) => /** @type {PlanFindingOutput} */ ({
      id: `no-requirement-${phase.id}`,
      // minor, not major: a support phase with no direct requirement is a
      // question for review, not a defect — the finding exists so the gap is
      // never silent.
      severity: "minor",
      nodeId: phase.id,
      text: `Phase ${phase.id} is associated with no requirement: fill requirementIds with the R<n> ids from the spec that it satisfies, or fold it into a phase that does.`,
    }));
  return {
    nodes,
    ...(phases === undefined ? {} : { phases }),
    ...(sharedVerification === undefined ? {} : { sharedVerification }),
    ...(finalVerification === undefined ? {} : { finalVerification }),
    ...(findings.length > 0 ? { findings } : {}),
    ...(record.justification === undefined ? {} : { justification: /** @type {string} */ (record.justification) }),
  };
}

/**
 * The plan a revise's `output.patch` produces, from the plan the reviser read
 * (RM-110). Measured 2026-09-27 on `safe-to-hand-to-a-friend`: two revise
 * calls died as `prompt_failed` at 65,932 and 66,821 output tokens against the
 * 65,536 ceiling — a revise that must reproduce every node it is not changing
 * pays the whole plan's size for a change to one of them, after the draft and
 * a review round have already been paid for.
 *
 * The merge is deterministic and total: a patch node whose id the plan has
 * replaces it in place (so the plan's node order, which its phases and its
 * working file both read, survives a revise that changes nothing), a new id
 * appends, `removedNodeIds` deletes by name, and a plan-level field the patch
 * omits keeps the plan's own value. Every node in the result is one the
 * validator has seen once already, so the caller's `validatePlanOutput` on the
 * returned record is the same check a draft's output gets, not a weaker one.
 *
 * Three shapes are refused here rather than merged: a node id named twice in
 * the patch, an id removed that the plan does not have (a typo the reviser
 * would otherwise never hear about), and an id in both lists.
 *
 * @param {{nodes: PlanOutputNode[]} & Record<string, unknown>} previous the plan the reviser was handed
 * @param {unknown} patch a revise worker's `output.patch`
 * @returns {{nodes: PlanOutputNode[]} & Record<string, unknown>} the merged plan record, for `validatePlanOutput`
 */
export function applyPlanPatch(previous, patch) {
  assertObject(patch, "patch");
  const record = /** @type {Record<string, unknown>} */ (patch);
  rejectUnknown(record, PATCH_FIELDS, "patch");
  const nodes = record.nodes === undefined ? [] : validatePlanNodes(record.nodes, "patch.nodes");
  const removedNodeIds = /** @type {string[]} */ (record.removedNodeIds ?? []);
  requireStringArray(removedNodeIds, "patch.removedNodeIds");
  const previousIds = new Set(previous.nodes.map((node) => node.id));
  const replacements = new Map(nodes.map((node) => [node.id, node]));
  if (replacements.size !== nodes.length) throw new TypeError("patch.nodes names the same node id twice");
  for (const id of removedNodeIds) {
    if (!previousIds.has(id)) throw new TypeError(`patch.removedNodeIds names ${id}, which the plan it revises does not have`);
    if (replacements.has(id)) throw new TypeError(`patch names ${id} in both nodes and removedNodeIds: a node is replaced or removed, never both`);
  }
  const removed = new Set(removedNodeIds);
  /** @type {{nodes: PlanOutputNode[]} & Record<string, unknown>} */
  const merged = {
    nodes: [
      ...previous.nodes.filter((node) => !removed.has(node.id)).map((node) => replacements.get(node.id) ?? node),
      ...nodes.filter((node) => !previousIds.has(node.id)),
    ],
  };
  for (const field of ["phases", "sharedVerification", "finalVerification", "justification"]) {
    const value = record[field] ?? previous[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

// The fields a phase declaration carries beyond its id: requirementIds|nodeIds|deliverable —
// which spec requirements the phase satisfies, which planned nodes it assigns, and the one
// sentence naming its result.
const PLAN_PHASE_FIELDS = new Set(["id", "requirementIds", "nodeIds", "deliverable"]);

/**
 * Validate a plan's `phases` — the per-phase requirement declarations. The
 * current shape `{id, requirementIds, nodeIds, deliverable}` assigns every
 * planned node to exactly one declaration: `plannedNodeIds` is the plan's own
 * node-id list, and a node no declaration names, a node two declarations both
 * name, or a declared node absent from the plan is refused. A declaration in
 * the older `{id, requirementIds, deliverable}` shape (no `nodeIds` at all)
 * stays legal so a plan frozen before node assignment existed still reads; in
 * that shape an empty `requirementIds` is the caller's finding to report
 * (validatePlanOutput does), not a refusal. Mixing the two shapes is refused
 * because it would leave some nodes silently unattributed. Shared with
 * freeze.mjs, which holds the same declarations on the frozen plan record.
 *
 * @param {unknown} phases
 * @param {string[]|undefined} [plannedNodeIds] the plan's node ids, when the caller has them
 * @returns {PlanPhase[]|undefined} the normalized declarations, or undefined when none were given
 */
export function validatePlanPhases(phases, plannedNodeIds) {
  if (phases === undefined) return undefined;
  if (!Array.isArray(phases)) throw new TypeError("plan.phases must be an array of phase declarations");
  if (phases.length === 0) return undefined;

  /** @type {Set<string>} */
  const ids = new Set();
  const declarations = phases.map((phase, index) => {
    const label = `plan.phases[${index}]`;
    assertObject(phase, label);
    const record = /** @type {Record<string, unknown>} */ (phase);
    rejectUnknown(record, PLAN_PHASE_FIELDS, label);
    requireId(record.id, `${label}.id`);
    const id = /** @type {string} */ (record.id);
    if (ids.has(id)) throw new TypeError(`plan.phases has duplicate phase id ${id}`);
    ids.add(id);
    requireString(record.deliverable, `${label}.deliverable`);
    const requirementIds = /** @type {string[]} */ (record.requirementIds ?? []);
    requireStringArray(requirementIds, `${label}.requirementIds`);
    /** @type {string[]|undefined} */
    let nodeIds;
    if (record.nodeIds !== undefined) {
      requireStringArray(record.nodeIds, `${label}.nodeIds`);
      nodeIds = /** @type {string[]} */ (record.nodeIds);
      if (nodeIds.length === 0) throw new TypeError(`${label}.nodeIds must name at least one planned node`);
      if (requirementIds.length === 0) throw new TypeError(`${label}.requirementIds must name at least one requirement when the declaration assigns nodes`);
    }
    return /** @type {PlanPhase} */ ({
      id,
      requirementIds: /** @type {string[]} */ (requirementIds),
      ...(nodeIds === undefined ? {} : { nodeIds }),
      deliverable: /** @type {string} */ (record.deliverable),
    });
  });

  const assigned = declarations.filter((declaration) => declaration.nodeIds !== undefined);
  if (assigned.length > 0 && assigned.length !== declarations.length) {
    throw new TypeError("plan.phases must assign nodeIds on every declaration or on none: mixing the two leaves the nodes named by the other declarations unattributed");
  }
  if (assigned.length > 0 && plannedNodeIds !== undefined) {
    validateNodeAssignments(assigned, plannedNodeIds);
  }
  return declarations;
}

/**
 * Refuse a node assignment that does not cover the plan exactly once. Called
 * only for the nodeIds shape, where every declaration already names at least
 * one node and at least one requirement.
 *
 * @param {PlanPhase[]} declarations
 * @param {string[]} plannedNodeIds
 * @returns {void}
 */
function validateNodeAssignments(declarations, plannedNodeIds) {
  const planned = new Set(plannedNodeIds);
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const declaration of declarations) {
    for (const nodeId of declaration.nodeIds ?? []) {
      if (!planned.has(nodeId)) {
        throw new TypeError(`plan.phases: phase ${declaration.id} assigns unknown node ${nodeId}, which is not one of the plan's nodes`);
      }
      const previous = owner.get(nodeId);
      if (previous !== undefined) {
        throw new TypeError(`plan.phases assigns node ${nodeId} to both ${previous} and ${declaration.id}; every planned node belongs to exactly one phase`);
      }
      owner.set(nodeId, declaration.id);
    }
  }
  const missing = [...planned].filter((nodeId) => !owner.has(nodeId));
  if (missing.length > 0) {
    throw new TypeError(`plan.phases leaves planned node(s) assigned to no phase: ${missing.join(", ")}`);
  }
}

const FINDING_FIELDS = new Set(["id", "severity", "nodeId", "text"]);
const FINDING_SEVERITIES = new Set(["critical", "major", "minor"]);

/**
 * Validate a review or spec-review worker's `output.findings`. A finding
 * without `severity` or `nodeId` is invalid.
 *
 * @param {unknown} findings
 * @returns {PlanFindingOutput[]}
 */
export function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array");
  return findings.map((finding, index) => {
    const label = `findings[${index}]`;
    assertObject(finding, label);
    const record = /** @type {Record<string, unknown>} */ (finding);
    rejectUnknown(record, FINDING_FIELDS, label);
    requireId(record.id, `${label}.id`);
    if (typeof record.severity !== "string" || !FINDING_SEVERITIES.has(record.severity)) {
      throw new TypeError(`${label}.severity must be one of critical, major, minor`);
    }
    requireString(record.nodeId, `${label}.nodeId`);
    requireString(record.text, `${label}.text`);
    return /** @type {PlanFindingOutput} */ ({
      id: /** @type {string} */ (record.id),
      severity: /** @type {"critical"|"major"|"minor"} */ (record.severity),
      nodeId: /** @type {string} */ (record.nodeId),
      text: /** @type {string} */ (record.text),
    });
  });
}
