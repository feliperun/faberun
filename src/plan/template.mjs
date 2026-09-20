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
 */
import { assertObject, rejectUnknown, requireId, requireString, requireStringArray } from "../contract/assert.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../contract/index.mjs";
import { validateDefinitionOfDone } from "../contract/definition-of-done.mjs";
import { validateVerificationCommands } from "../contract/verification.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {"draft"|"review"|"revise"|"spec-author"|"spec-review"} PlanningKind */
/** @typedef {"low"|"standard"|"high"} RiskTier */
/** @typedef {{campaignId: string, phase: string, n: number, goal?: string, cwd?: string, runtimes: Record<string, JsonObject>, runtimeDefaults: {worker?: string, judge?: string}, specPath?: string, repoFactsPath?: string, planPath?: string, findingsPath?: string, notesPath?: string}} PlanningContractInputs */
/** @typedef {{id: string, objective: string, taskKind: string, riskTier: RiskTier, dependsOn: string[], readFiles: string[], writeFiles: string[], definitionOfDone: import("../contract/definition-of-done.mjs").DefinitionOfDoneItem[], verification: import("../contract/verification.mjs").VerificationCommand[]}} PlanOutputNode */
/** @typedef {{nodes: PlanOutputNode[], justification?: string}} PlanOutput */
/** @typedef {{id: string, severity: "critical"|"major"|"minor", nodeId: string, text: string}} PlanFindingOutput */

/**
 * The taskKind catalogue a draft or revise classifies against. Exported here,
 * not read from a separate document, so `TASK_KIND_CATALOGUE_PATH` (this
 * module's own repo-relative path) is a real, always-present file a
 * closed-context worker can be told to read for the authoritative list.
 */
export const TASK_KINDS = Object.freeze(["docs", "implement", "test", "refactor", "infra", "judge"]);

/** The risk tiers a draft or revise classifies against. */
export const RISK_TIERS = Object.freeze(["low", "standard", "high"]);

/** This module's own repo-relative path: the taskKind catalogue's home. */
export const TASK_KIND_CATALOGUE_PATH = "src/plan/template.mjs";

/**
 * Which of the caller's `runtimeDefaults` roles resolves this contract's
 * single node. A draft or revise is authored by the worker role; a review or
 * spec-review is graded by the judge role — there is no gate on this
 * single-node contract, so the role only decides which runtime id the node
 * itself carries.
 *
 * @type {Record<PlanningKind, "worker"|"judge">}
 */
const KIND_ROLE = Object.freeze({
  draft: "worker",
  revise: "worker",
  "spec-author": "worker",
  review: "judge",
  "spec-review": "judge",
});

/** @type {Record<PlanningKind, string[]>} */
const REQUIRED_INPUTS = Object.freeze({
  draft: ["specPath", "repoFactsPath"],
  revise: ["specPath", "repoFactsPath", "findingsPath"],
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
const PLAN_OUTPUT_SHAPE = '{nodes: [{id, objective, taskKind, riskTier, dependsOn, readFiles, writeFiles, definitionOfDone: [{id, text, proof?: {kind: "command"|"path"|"verification", ref}, judgment?: true}], verification: [{argv: [string], cwd?, timeoutSec?, repeat?, env?, mutation?: {threshold}}]}], justification?}; every id in it (node and definitionOfDone item) must match [A-Za-z0-9._-]+ and never be exactly "." or ".."';
const FINDINGS_SHAPE = "[{id, severity, nodeId, text}]";

/** @type {Record<PlanningKind, string>} */
const OBJECTIVES = Object.freeze({
  draft: "Draft an execution plan for this phase: classify every node's taskKind and riskTier from the spec and the repository facts, and propose the dependency graph.",
  revise: "Revise the plan to resolve every one of the reviewer's findings, keeping the same classification and graph shape as a fresh draft.",
  review: "Review this plan against the spec and the repository facts, and report only findings.",
  "spec-author": "Turn free notes into a structured spec document following the spec format.",
  "spec-review": "Review this spec for traceability and completeness, and report only findings.",
});

/** @type {Record<PlanningKind, string[]>} */
const INSTRUCTIONS = Object.freeze({
  draft: [
    `Consult ${TASK_KIND_CATALOGUE_PATH}'s exported TASK_KINDS before classifying any node; taskKind must be one of that catalogue and riskTier must be one of ${RISK_TIERS.join(", ")}.`,
    `Return exactly one worker-result JSON object. Put the plan in output.plan as ${PLAN_OUTPUT_SHAPE} and nothing else in output.`,
    "Never name a runtime, harness, model, or vendor anywhere in output.plan. taskKind and riskTier are the only classification a draft makes; a routing table assigns a runtime afterward, from those two fields alone.",
  ],
  revise: [
    "Read the findings and resolve every one; do not leave a critical or major finding unaddressed.",
    `Consult ${TASK_KIND_CATALOGUE_PATH}'s exported TASK_KINDS before classifying any node; taskKind must be one of that catalogue and riskTier must be one of ${RISK_TIERS.join(", ")}.`,
    `Return exactly one worker-result JSON object. Put the revised plan in output.plan as ${PLAN_OUTPUT_SHAPE} and nothing else in output.`,
    "Never name a runtime, harness, model, or vendor anywhere in output.plan.",
  ],
  review: [
    "You are given only the spec, the repository facts, and the plan under review; you have not seen how the plan was produced or any reasoning behind it. Review the artefact alone.",
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
  if (kind === "draft") return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), TASK_KIND_CATALOGUE_PATH];
  if (kind === "revise") {
    return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), TASK_KIND_CATALOGUE_PATH, /** @type {string} */ (inputs.findingsPath)];
  }
  if (kind === "review") return [/** @type {string} */ (inputs.specPath), /** @type {string} */ (inputs.repoFactsPath), /** @type {string} */ (inputs.planPath)];
  if (kind === "spec-author") return [/** @type {string} */ (inputs.notesPath)];
  return [/** @type {string} */ (inputs.specPath)];
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
  const runtimeId = (inputs.runtimeDefaults ?? {})[role];

  /** @type {JsonObject} */
  const taskPacket = {
    mode: "discovery",
    objective: OBJECTIVES[kind],
    instructions: INSTRUCTIONS[kind],
    readFiles,
    writeFiles: [],
    symbols: [],
    decisions: [],
    nonGoals: NON_GOALS[kind],
    verification: [],
  };

  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: `${inputs.campaignId}-plan-${inputs.phase}-${kind}-${inputs.n}`,
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

const PLAN_FIELDS = new Set(["nodes", "justification"]);
const PLAN_NODE_FIELDS = new Set(["id", "objective", "taskKind", "riskTier", "dependsOn", "readFiles", "writeFiles", "definitionOfDone", "verification"]);

/**
 * Validate a draft or revise worker's `output.plan`. Rejects a node naming a
 * runtime, harness, model, or vendor (an unknown field, since a plan node's
 * shape never includes one) and a node missing taskKind or riskTier.
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
  const nodes = record.nodes.map((node, index) => {
    const label = `plan.nodes[${index}]`;
    assertObject(node, label);
    const nodeRecord = /** @type {Record<string, unknown>} */ (node);
    rejectUnknown(nodeRecord, PLAN_NODE_FIELDS, label);
    requireId(nodeRecord.id, `${label}.id`);
    requireString(nodeRecord.objective, `${label}.objective`);
    if (typeof nodeRecord.taskKind !== "string" || !TASK_KINDS.includes(nodeRecord.taskKind)) {
      throw new TypeError(`${label}.taskKind must be one of ${TASK_KINDS.join(", ")}`);
    }
    if (typeof nodeRecord.riskTier !== "string" || !RISK_TIERS.includes(nodeRecord.riskTier)) {
      throw new TypeError(`${label}.riskTier must be one of ${RISK_TIERS.join(", ")}`);
    }
    const dependsOn = nodeRecord.dependsOn ?? [];
    requireStringArray(dependsOn, `${label}.dependsOn`);
    const readFiles = nodeRecord.readFiles ?? [];
    requireStringArray(readFiles, `${label}.readFiles`);
    const writeFiles = nodeRecord.writeFiles ?? [];
    requireStringArray(writeFiles, `${label}.writeFiles`);
    const definitionOfDone = validateDefinitionOfDone(nodeRecord.definitionOfDone ?? [], `${label}.definitionOfDone`);
    const verification = validateVerificationCommands(nodeRecord.verification ?? [], `${label}.verification`);
    return /** @type {PlanOutputNode} */ ({
      id: /** @type {string} */ (nodeRecord.id),
      objective: /** @type {string} */ (nodeRecord.objective),
      taskKind: /** @type {string} */ (nodeRecord.taskKind),
      riskTier: /** @type {RiskTier} */ (nodeRecord.riskTier),
      dependsOn: /** @type {string[]} */ (dependsOn),
      readFiles: /** @type {string[]} */ (readFiles),
      writeFiles: /** @type {string[]} */ (writeFiles),
      definitionOfDone,
      verification,
    });
  });
  if (record.justification !== undefined) requireString(record.justification, "plan.justification");
  return {
    nodes,
    ...(record.justification === undefined ? {} : { justification: /** @type {string} */ (record.justification) }),
  };
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
