/**
 * Verification schema that is not part of a task packet (TECH-SPEC section 6.2,
 * rule 12).
 *
 * `contract.finalVerification` is the contract-wide proof that the phase as a
 * whole closes: the controller runs it before the judge, once, on whichever
 * phase-terminal node (a node no other node depends on) is the last of them
 * to settle, so no final checkpoint is ever approved on partial verification
 * and a flake on one phase-terminal node cannot also cost its siblings a
 * revision. `contract.sharedVerification` carries the same command schema but
 * is appended to every node's attempt and integration candidate, for the fast
 * repository ratchets a node's write set can break.
 * The persisted node-snapshot shape for verification evidence lives here too,
 * next to the schema it records.
 */

import { Buffer } from "node:buffer";
import { validateVerificationCommands } from "./verification.mjs";
import { assertObject, nonNegativeInteger, positiveInteger, rejectUnknown, requireInteger, requireString, requireTimestamp } from "./assert.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {import("./verification.mjs").VerificationCommand} VerificationCommand */

/**
 * Validate the optional contract-level `finalVerification` field. It carries
 * the full verification-command schema and nothing else.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {VerificationCommand[]|undefined}
 */
export function validateFinalVerification(value, label = "contract.finalVerification") {
  if (value === undefined) return undefined;
  return validateVerificationCommands(value, label);
}

/**
 * Validate the optional contract-level `sharedVerification` field. It carries
 * the identical verification-command schema as `finalVerification`; only the
 * audience differs.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {VerificationCommand[]|undefined}
 */
export function validateSharedVerification(value, label = "contract.sharedVerification") {
  if (value === undefined) return undefined;
  return validateVerificationCommands(value, label);
}

/**
 * The contract's `sharedVerification` commands, which every node's verification
 * carries on both its attempt and its integration candidate. Absent means none,
 * so a contract that declares nothing is unchanged.
 *
 * @param {{sharedVerification?: VerificationCommand[]}} contract
 * @returns {VerificationCommand[]}
 */
export function sharedVerificationCommands(contract) {
  return contract.sharedVerification ?? [];
}

/**
 * Whether no other node in the contract depends on this one. `finalVerification`
 * is a candidate to run on a phase-terminal node only; a node with a dependant
 * never carries it, no matter which of its siblings settles last.
 *
 * @param {{nodes: {id: string, dependsOn: string[]}[]}} contract
 * @param {{id: string}} node
 * @returns {boolean}
 */
export function phaseTerminalNode(contract, node) {
  return !contract.nodes.some((candidate) => candidate.dependsOn.includes(node.id));
}

/**
 * The contract's `finalVerification` commands when this node is the one that
 * closes the phase, otherwise none. A phase can have several phase-terminal
 * nodes (several nodes no other node depends on); the suite runs once for the
 * phase, on whichever of them is the last to settle, not on every one of them.
 *
 * `settledIds` is the set of sibling node ids (any status a node does not
 * leave on its own -- see `SETTLED` in `engine/prompts.mjs`) already reached
 * at the moment this call is made. A phase-terminal node carries the suite
 * exactly when every *other* phase-terminal node is already in that set --
 * whichever node that is true for, in whatever order nodes actually settle,
 * including a node retried after every sibling has already closed. Omitting
 * `settledIds` (the scheduler's budget estimate, which has no run to inspect)
 * falls back to the old per-node-shape answer: any phase-terminal node may
 * still turn out to be the one that carries it, so the estimate stays an
 * upper bound.
 *
 * @param {{finalVerification?: VerificationCommand[], nodes: {id: string, dependsOn: string[]}[]}} contract
 * @param {{id: string}} node
 * @param {Set<string>} [settledIds]
 * @returns {VerificationCommand[]}
 */
export function finalVerificationCommands(contract, node, settledIds) {
  const commands = contract.finalVerification ?? [];
  if (commands.length === 0) return [];
  if (!phaseTerminalNode(contract, node)) return [];
  if (!settledIds) return commands;
  const siblings = contract.nodes.filter((candidate) => candidate.id !== node.id && phaseTerminalNode(contract, candidate));
  const isLastToClose = siblings.every((sibling) => settledIds.has(sibling.id));
  return isLastToClose ? commands : [];
}

/**
 * @param {unknown} value
 */
export function validateVerificationSnapshot(value) {
  assertObject(value, "node snapshot.verification");
  if (typeof value.passed !== "boolean" || !Array.isArray(value.commands) || value.commands.length > 32) {
    throw new TypeError("node snapshot.verification is invalid");
  }
  if (value.completed !== undefined && typeof value.completed !== "boolean") throw new TypeError("node snapshot.verification.completed is invalid");
  if (value.attempts !== undefined) {
    if (!Array.isArray(value.attempts) || value.attempts.length > 16) throw new TypeError("node snapshot.verification.attempts is invalid");
    const attempts = /** @type {unknown[]} */ (value.attempts);
    for (const [index, attempt] of attempts.entries()) validateVerificationAttempt(attempt, `node snapshot.verification.attempts[${index}]`);
  }
  if (value.error !== undefined && (typeof value.error !== "string" || Buffer.byteLength(value.error, "utf8") > 4096)) {
    throw new TypeError("node snapshot.verification.error is invalid");
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateVerificationAttempt(value, label) {
  assertObject(value, label);
  rejectUnknown(value, new Set([
    "invocationId", "commandIndex", "attempt", "pid", "processStartToken", "processGroupId",
    "startedAt", "deadlineAt", "status", "completedAt", "result",
  ]), label);
  requireString(value.invocationId, `${label}.invocationId`);
  nonNegativeInteger(value.commandIndex, `${label}.commandIndex`);
  positiveInteger(value.attempt, `${label}.attempt`);
  if (value.pid !== null) requireInteger(value.pid, `${label}.pid`);
  if (value.processGroupId !== null) requireInteger(value.processGroupId, `${label}.processGroupId`);
  if (value.processStartToken !== null) requireString(value.processStartToken, `${label}.processStartToken`);
  requireTimestamp(value.startedAt, `${label}.startedAt`);
  requireTimestamp(value.deadlineAt, `${label}.deadlineAt`);
  if (!["active", "closed", "failed", "crashed", "canceled"].includes(/** @type {string} */ (value.status))) throw new TypeError(`${label}.status is invalid`);
  if (value.completedAt !== null) requireTimestamp(value.completedAt, `${label}.completedAt`);
  if (value.result !== null) {
    assertObject(value.result, `${label}.result`);
    const result = /** @type {JsonObject} */ (value.result);
    for (const key of ["stdout", "stderr", "error"]) {
      if (result[key] !== null && result[key] !== undefined && (typeof result[key] !== "string" || Buffer.byteLength(result[key], "utf8") > 2048)) throw new TypeError(`${label}.result.${key} is invalid`);
    }
    if (typeof result.passed !== "boolean") throw new TypeError(`${label}.result.passed is invalid`);
  }
}

