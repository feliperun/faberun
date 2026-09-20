/**
 * Generic exec-jsonl adapter protocol.
 *
 * The executable receives one UTF-8 JSON line on stdin:
 * `{schemaVersion:1,type:"run.request",model,prompt,structuredOutput,
 * outputSchema,continuationId}`. The request deliberately carries no tool
 * policy: an
 * arbitrary wrapper executable cannot prove enforcement, so the mechanical
 * policy travels only where a hook surface can enforce it (claude). It
 * writes JSONL events to stdout:
 * `run.started` (optional), `message` (zero or more), then exactly one
 * `run.completed` or `run.failed` event. Events must appear in that order,
 * with no unknown fields. A completed event is
 * `{schemaVersion:1,type:"run.completed",result,continuationId,usage,costUsd}`;
 * `result` is required and may be any JSON value. A failed event is
 * `{schemaVersion:1,type:"run.failed",error:{code,message}}`.
 *
 * Stderr is diagnostic only. Unknown or malformed output is rejected by the
 * runtime normalizer; wrappers should emit this protocol rather than making
 * scheduler-specific provider branches.
 */

import {
  canonicalUsage,
  failed,
  parseJsonLines,
  parseVersion,
} from "../protocol.mjs";
import { rejectUnknown } from "../../contract/assert.mjs";
import { finite } from "../../util.mjs";

export { HARNESS_OUTPUT_LIMIT_BYTES } from "../protocol.mjs";

export const EXEC_JSONL_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  requestType: "run.request",
  completedType: "run.completed",
  failedType: "run.failed",
});

/** Exact tool-output bound (UTF-8 bytes) carried by the toolPolicy contract. */
export const TOOL_OUTPUT_LIMIT_BYTES = 8192;

const EVENT_FIELDS = Object.freeze({
  "run.started": new Set(["schemaVersion", "type", "continuationId"]),
  message: new Set(["schemaVersion", "type", "text"]),
  "run.completed": new Set(["schemaVersion", "type", "result", "continuationId", "usage", "costUsd"]),
  "run.failed": new Set(["schemaVersion", "type", "error"]),
});

const EVENT_TYPES = new Set(Object.keys(EVENT_FIELDS));

/** @typedef {import("../index.mjs").HarnessAdapter} HarnessAdapter */

/**
 * @type {HarnessAdapter}
 */
export const execJsonlHarness = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: false,
    continuation: true,
    tokenBudget: true,
    costBudget: false,
    usage: true,
    cost: true,
    // An arbitrary wrapper executable cannot honestly advertise mechanical
    // tool-policy enforcement; the request carries none.
    toolPolicy: false,
    // The protocol allows zero `message` events before the terminal one, so
    // an arbitrary wrapper cannot honestly advertise incremental output either.
    streamsOutput: false,
    // Unmeasured: an arbitrary wrapper executable names no sandbox to measure.
    signalsProcesses: null,
  },

  // The wrapper protocol exposes no permission mode.
  permissionExecution: null,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.FABERUN_EXEC_JSONL_BIN ?? runtime.executable ?? "exec-jsonl";
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @param {string} prompt @param {import("../index.mjs").CommandOptions} options @returns {import("../index.mjs").HarnessCommand} */
  command(runtime, prompt, options) {
    const request = {
      schemaVersion: 1,
      type: "run.request",
      model: runtime.model,
      prompt,
      structuredOutput: Boolean(options.schema || options.schemaPath),
      outputSchema: options.schema ?? options.schemaPath ?? null,
      continuationId: options.continuationId ?? null,
    };
    const args = runtime.args ?? [];
    return {
      executable: this.executable(runtime),
      args: [...args],
      promptTransport: "stdin",
      input: `${JSON.stringify(request)}\n`,
    };
  },

  normalize: normalizeExecJsonlResult,
};

export const harness = execJsonlHarness;
export default execJsonlHarness;

/**
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @returns {import("../index.mjs").ProviderEnvelope}
 */
export function normalizeExecJsonlResult(stdout, exitCode, signal) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  let events;
  try {
    events = parseJsonLines(stdout, "exec-jsonl");
    validateExecJsonlEvents(events);
  } catch (error) {
    return failed("invalid_protocol", error instanceof Error ? error.message : String(error));
  }
  const lastEvent = events.at(-1);
  if (!lastEvent) return failed("invalid_protocol", "exec-jsonl emitted no events");
  const terminal = /** @type {Record<string, unknown>} */ (lastEvent);
  if (terminal.type === "run.failed") {
    const error = /** @type {Record<string, unknown>|undefined} */ (terminal.error);
    return failed(
      typeof error?.code === "string" ? error.code : "provider_error",
      typeof error?.message === "string" ? error.message : "exec-jsonl failed",
    );
  }
  if (exitCode !== 0) return failed("provider_error", `exec-jsonl exited with code ${exitCode}`);
  const rawResult = terminal.result;
  const result = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
  return {
    status: result.trim() ? "done" : "no-op",
    result,
    continuationId: typeof terminal.continuationId === "string" ? terminal.continuationId : null,
    usage: canonicalUsage(terminal.usage),
    costUsd: finite(terminal.costUsd),
    error: null,
  };
}

/**
 * @param {Record<string, unknown>[]} events
 */
function validateExecJsonlEvents(events) {
  if (!events.length) throw new TypeError("exec-jsonl emitted no events");
  let terminalCount = 0;
  let phase = "start";
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError(`exec-jsonl event ${index + 1} must be an object`);
    }
    if (event.schemaVersion !== 1) {
      throw new TypeError(`exec-jsonl event ${index + 1} schemaVersion must be 1`);
    }
    const type = /** @type {keyof typeof EVENT_FIELDS} */ (event.type);
    if (!EVENT_TYPES.has(type)) {
      throw new TypeError(`exec-jsonl event ${index + 1} type is unknown`);
    }
    rejectUnknown(event, EVENT_FIELDS[type], `exec-jsonl event ${index + 1}`);
    if (type === "run.started") {
      if (phase !== "start") throw new TypeError("exec-jsonl run.started must be the first event");
      phase = "messages";
      validateContinuationId(event.continuationId, `exec-jsonl event ${index + 1}.continuationId`);
      continue;
    }
    if (type === "message") {
      if (phase === "terminal") throw new TypeError("exec-jsonl message cannot follow a terminal event");
      phase = "messages";
      if (typeof event.text !== "string") throw new TypeError(`exec-jsonl event ${index + 1}.text must be a string`);
      continue;
    }
    if (phase === "terminal") throw new TypeError("exec-jsonl emitted multiple terminal events");
    phase = "terminal";
    terminalCount += 1;
    if (event.type === "run.completed") {
      if (!Object.hasOwn(event, "result")) throw new TypeError("exec-jsonl run.completed.result is required");
      validateContinuationId(event.continuationId, `exec-jsonl event ${index + 1}.continuationId`);
      validateUsage(event.usage, `exec-jsonl event ${index + 1}.usage`);
      validateCost(event.costUsd, `exec-jsonl event ${index + 1}.costUsd`);
    } else {
      validateError(event.error, `exec-jsonl event ${index + 1}.error`);
    }
    if (index !== events.length - 1) {
      if (events.slice(index + 1).some((next) => next?.type === "run.completed" || next?.type === "run.failed")) {
        throw new TypeError("exec-jsonl emitted multiple terminal events");
      }
      throw new TypeError("exec-jsonl terminal event must be last");
    }
  }
  if (terminalCount !== 1) throw new TypeError("exec-jsonl requires exactly one terminal event");
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateContinuationId(value, label) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateUsage(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  const allowed = new Set(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
  rejectUnknown(record, allowed, label);
  for (const key of allowed) {
    const raw = record[key];
    if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
      throw new TypeError(`${label}.${key} must be a non-negative integer or null`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateCost(value, label) {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative number or null`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validateError(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, new Set(["code", "message"]), label);
  if (typeof record.code !== "string" || !record.code.trim()) throw new TypeError(`${label}.code must be a non-empty string`);
  if (typeof record.message !== "string" || !record.message.trim()) throw new TypeError(`${label}.message must be a non-empty string`);
}

/**
 * Bound one tool result to at most `maxBytes` UTF-8 bytes, keeping the head
 * and the tail around an omission marker. This is the reference head+tail
 * form the toolPolicy contract names; a cut never splits a UTF-8 sequence.
 *
 * @param {string} value
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateToolOutput(value, maxBytes = TOOL_OUTPUT_LIMIT_BYTES) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  if (maxBytes < 192) {
    // Too small to carry a head+tail marker: keep only a UTF-8-safe prefix.
    let end = Math.max(0, maxBytes - 3);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return end > 0 ? `${bytes.subarray(0, end).toString("utf8")}…` : "";
  }
  // Reserve headroom for the marker so the bounded result can never exceed
  // the limit regardless of how many digits the omission count needs.
  const markerBudget = 96;
  const headBudget = Math.floor((maxBytes - markerBudget) / 2);
  const tailBudget = maxBytes - markerBudget - headBudget;
  let headEnd = headBudget;
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes.length - tailBudget;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const head = bytes.subarray(0, headEnd);
  const tail = bytes.subarray(tailStart);
  const marker = `\n…[${bytes.length - head.length - tail.length} bytes truncated; narrow with grep or tail]…\n`;
  return Buffer.concat([head, Buffer.from(marker, "utf8"), tail]).toString("utf8");
}
