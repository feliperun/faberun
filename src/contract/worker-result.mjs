import { Buffer } from "node:buffer";
import { validateTaskPacket } from "./task-packet.mjs";
import { assertObject, requireText } from "./assert.mjs";

const RESULT_LIMITS = Object.freeze({
  bytes: 32 * 1024,
  summaryBytes: 4 * 1024,
  arrayItems: 32,
  itemBytes: 2 * 1024,
  artifactBytes: 16 * 1024,
  missingContextItems: 16,
  // A discovery worker's structured findings are the deliverable, not
  // incidental prose, so `output` gets its own ceiling outside the 32 KiB
  // envelope instead of competing with summary/verification for it.
  outputBytes: 64 * 1024,
});

/**
 * Worker-result fields the controller measures and derives itself, so the
 * worker protocol has no owner for them. A result that declares one is
 * rejected, never dropped: a field accepted after it lost its owner is how it
 * comes back in the next prompt generation. The PRD's remaining derived fields
 * -- commit, digest, worktreeIdentity, durationMs, exitCode -- enter this one
 * list as their nodes land, so rejection stays a single edit.
 */
export const DERIVED_WORKER_RESULT_FIELDS = Object.freeze(["changedFiles"]);

/**
 * A worker result that is well-formed JSON but breaks one of the byte
 * ceilings above. Typed, not a plain TypeError, so the repair prompt can name
 * the ceiling that was broken: observed 2026-09-25, a planning draft that
 * copied its 38 KiB plan into `artifacts[0]` was told twice to drop markdown
 * fences it never wrote, and repeated the copy.
 */
export class WorkerResultSizeError extends TypeError {
  /** @param {string} field @param {number} limit */
  constructor(field, limit) {
    super(`${field} exceeds ${limit} bytes`);
    this.name = "WorkerResultSizeError";
    this.field = field;
    this.limit = limit;
  }
}

/** @typedef {"done"|"blocked_context"} WorkerResultStatus */

/**
 * The worker-result protocol: exactly one JSON object returned as the only
 * content of the final worker message. `blocked_context` requires at least one
 * missingContext entry; `done` requires none. `output` is optional and carries
 * a discovery node's structured findings; an execution result must not
 * declare it (enforced where the node's mode is known, not here).
 *
 * @typedef {{status: WorkerResultStatus, summary: string, verification: string[], artifacts: string[], missingContext: string[], output?: Record<string, unknown>}} WorkerResult
 */

/**
 * @param {string} value
 * @returns {WorkerResult}
 */
export function parseWorkerResult(value) {
  if (typeof value !== "string") throw new TypeError("worker result must be JSON text");
  const maxRawBytes = RESULT_LIMITS.bytes + RESULT_LIMITS.outputBytes;
  if (Buffer.byteLength(value, "utf8") > maxRawBytes) {
    throw new WorkerResultSizeError("worker result", maxRawBytes);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`worker result is invalid JSON: ${(error instanceof Error ? error.message : String(error))}`);
  }
  return validateWorkerResult(parsed);
}

/**
 * @param {unknown} value
 * @returns {WorkerResult}
 */
export function validateWorkerResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("worker result must be an object");
  }
  // Worker output is an external LLM boundary: models add fields beyond the
  // protocol. Unknown provider extras are dropped (the normalized pick below
  // keeps only canonical fields), but a field the controller derives is a
  // protocol failure: silently dropping it is how the worker learns to keep
  // sending it. Missing or invalid canonical fields stay fatal too.
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const field of DERIVED_WORKER_RESULT_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new TypeError(`worker result.${field} is derived by the controller and must not be declared`);
    }
  }
  const expected = new Set(["status", "summary", "verification", "artifacts", "missingContext"]);
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`worker result.${key} is required`);
  }
  if (record.status !== "done" && record.status !== "blocked_context") {
    throw new TypeError("worker result.status must be done or blocked_context");
  }
  requireText(record.summary, "worker result.summary", RESULT_LIMITS.summaryBytes);
  requireList(record.verification, "worker result.verification", RESULT_LIMITS.arrayItems, RESULT_LIMITS.itemBytes);
  requireList(record.artifacts, "worker result.artifacts", RESULT_LIMITS.arrayItems, RESULT_LIMITS.artifactBytes);
  requireList(record.missingContext, "worker result.missingContext", RESULT_LIMITS.missingContextItems, RESULT_LIMITS.itemBytes);
  const missingContext = /** @type {string[]} */ (record.missingContext);
  if (record.status === "blocked_context" && missingContext.length === 0) {
    throw new TypeError("worker result.missingContext must not be empty for blocked_context");
  }
  if (record.status === "done" && missingContext.length > 0) {
    throw new TypeError("worker result.missingContext must be empty for done");
  }
  // `output` is accepted on any result here: the schema does not know which
  // node mode produced it. Refusing it for execution results happens exactly
  // once, at the ingestion point that does know the mode (resolveWorkerResult).
  let output;
  if (Object.hasOwn(record, "output") && record.output !== undefined) {
    assertObject(record.output, "worker result.output");
    if (Buffer.byteLength(JSON.stringify(record.output), "utf8") > RESULT_LIMITS.outputBytes) {
      throw new WorkerResultSizeError("worker result.output", RESULT_LIMITS.outputBytes);
    }
    output = /** @type {Record<string, unknown>} */ (record.output);
  }
  const envelope = {
    status: /** @type {WorkerResultStatus} */ (record.status),
    summary: /** @type {string} */ (record.summary),
    verification: [.../** @type {string[]} */ (record.verification)],
    artifacts: [.../** @type {string[]} */ (record.artifacts)],
    missingContext: [...missingContext],
  };
  // `output` is bounded on its own above and kept outside this envelope cap:
  // it is a discovery node's deliverable, not incidental prose competing with
  // summary/verification for the same 32 KiB budget.
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > RESULT_LIMITS.bytes) {
    throw new WorkerResultSizeError("worker result", RESULT_LIMITS.bytes);
  }
  return output === undefined ? envelope : { ...envelope, output };
}

/**
 * A discovery node's structured findings, or null when the result carries
 * none. The one accessor for `output` so callers never read the raw field.
 *
 * @param {WorkerResult} result
 * @returns {Record<string, unknown>|null}
 */
export function discoveryOutput(result) {
  return result.output ?? null;
}

/**
 * @param {string|WorkerResult} value
 * @param {string} cwd
 * @returns {WorkerResult & {discoveryPacket: import("./task-packet.mjs").TaskPacket}}
 */
export function parseDiscoveryResult(value, cwd) {
  const result = typeof value === "string" ? parseWorkerResult(value) : validateWorkerResult(value);
  if (result.status !== "done") throw new TypeError("discovery result must have status done");
  if (result.artifacts.length !== 1) throw new TypeError("discovery result must contain exactly one task packet artifact");
  let packet;
  try {
    packet = JSON.parse(result.artifacts[0]);
  } catch (error) {
    throw new TypeError(`discovery task packet artifact is invalid JSON: ${(error instanceof Error ? error.message : String(error))}`);
  }
  validateTaskPacket(packet, 0, cwd);
  if (packet.mode !== "execution") throw new TypeError("discovery task packet artifact must be execution mode");
  const normalized = { ...result };
  Object.defineProperty(normalized, "discoveryPacket", { value: packet, enumerable: false });
  return /** @type {WorkerResult & {discoveryPacket: import("./task-packet.mjs").TaskPacket}} */ (
    /** @type {unknown} */ (normalized)
  );
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxItems
 * @param {number} itemBytes
 */
function requireList(value, label, maxItems, itemBytes) {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be an array with at most ${maxItems} items`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    if (Buffer.byteLength(item, "utf8") > itemBytes) throw new WorkerResultSizeError(`${label}[${index}]`, itemBytes);
  }
}
