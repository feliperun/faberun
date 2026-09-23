/**
 * Planning pipeline shape adapters: runtime availability, sizing-node input,
 * frozen contract-node output and read-volume measurement. Separate from the
 * pipeline loop so orchestration rounds remain about sequencing and findings.
 */
import { readFileSync } from "node:fs";
import { RISK_TIERS } from "./template.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./pipeline.mjs").SizedPlanNode} SizedPlanNode */

/**
 * @param {Record<string, JsonObject>} runtimes
 * @returns {Record<string, {available: true, exhaustedUntil: null}>}
 */
export function availabilityOf(runtimes) {
  return Object.fromEntries(Object.keys(runtimes).map((id) => [id, { available: true, exhaustedUntil: null }]));
}

/** @param {Record<string, JsonObject>} runtimes @param {string|undefined} id @returns {string} */
export function modelOf(runtimes, id) {
  const model = id ? runtimes[id]?.model : undefined;
  return typeof model === "string" ? model : "";
}

/** @param {string[]} riskTiers @returns {string} */
export function highestOf(riskTiers) {
  return riskTiers.reduce((highest, tier) => (RISK_TIERS.indexOf(tier) > RISK_TIERS.indexOf(highest) ? tier : highest), RISK_TIERS[0]);
}

/**
 * @param {import("./template.mjs").PlanOutputNode} node
 * @returns {SizedPlanNode}
 */
export function toSizingNode(node) {
  return /** @type {SizedPlanNode} */ ({
    id: node.id,
    dependsOn: node.dependsOn,
    taskKind: node.taskKind,
    riskTier: node.riskTier,
    objective: node.objective,
    expectedTurns: node.expectedTurns,
    definitionOfDone: node.definitionOfDone,
    taskPacket: {
      readFiles: node.readFiles,
      writeFiles: node.writeFiles,
      scopeAcknowledged: node.scopeAcknowledged,
      verification: node.verification,
    },
  });
}

/**
 * @param {SizedPlanNode} node
 * @param {string} phase
 * @param {{worker: string|null, judge: string|null}|undefined} assignment
 * @returns {JsonObject}
 */
export function toContractNode(node, phase, assignment) {
  const riskTier = /** @type {string} */ (node.riskTier);
  const gate = riskTier === "low"
    ? false
    : {
      review: riskTier === "high" ? "blocking" : "advisory",
      failOn: riskTier === "high" ? ["major", "critical"] : ["critical"],
      ...(assignment?.judge ? { runtime: assignment.judge } : {}),
    };
  return {
    id: node.id,
    type: node.taskKind,
    phase,
    dependsOn: node.dependsOn ?? [],
    ...(assignment?.worker ? { runtime: assignment.worker } : {}),
    taskPacket: {
      mode: "execution",
      objective: node.objective,
      instructions: [node.objective],
      readFiles: node.taskPacket.readFiles ?? [],
      writeFiles: node.taskPacket.writeFiles ?? [],
      scopeAcknowledged: node.taskPacket.scopeAcknowledged ?? [],
      symbols: [],
      decisions: [],
      nonGoals: [],
      verification: node.taskPacket.verification,
    },
    definitionOfDone: node.definitionOfDone ?? [],
    gate,
  };
}

/** @param {string} path @returns {number|null} */
export function fileLineCount(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (text === "") return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return null;
  }
}
