/**
 * A declared runtime: its fields, the harness names it may name, whether its
 * permission mode can execute a command, and how a role resolves to one -- the
 * latter including the strategies a routing rule may name, which are authored
 * protocol surface a reader can reject by name just like a harness name.
 *
 * Split out because both the contract validator and the snapshot validator need
 * it -- a persisted `runtime` on a node snapshot is the shape the contract
 * declared -- and the snapshot validator should not import the contract
 * validator to reach it.
 */
import { assertObject, nonNegativeNumber, positiveInteger, positiveNumber, rejectUnknown, requireId, requireString, requireStringArray, requireTimestamp } from "./assert.mjs";
import { composeAssignments } from "../engine/runtime-discovery.mjs";
import { harnessCapabilities, resolvePermissionExecution, resolveVendor, validateCapabilityRequirements, writesWorkspace } from "../harnesses/index.mjs";
import { stableJson } from "../util.mjs";
/** @typedef {import("./index.mjs").NodeStatus} NodeStatus */
/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */

/** @typedef {import("./index.mjs").CapabilityRequirements} CapabilityRequirements */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./index.mjs").ValidatedRuntime} ValidatedRuntime */

const RUNTIME_FIELDS = new Set([
  "harness", "model", "reasoning", "sandbox", "permissionMode", "config", "printTimeout", "tools",
  "executable", "args", "versionArgs", "maxArgvPromptBytes", "requiredCapabilities", "costRank",
  "fallback", "vendor", "tier", "pricing", "stallTimeoutSec", "maxConcurrent",
]);
const RUNTIME_HARNESSES = new Set(["claude", "codex", "agy", "dsh", "zcode", "exec-jsonl", "replay"]);

/**
 * The strategies a routing rule may name: how a rule consumes its `prefer`
 * list. `priority` takes the first admissible candidate; `cost` the lowest
 * declared `costRank`; `reset-proximity` the least observed `remaining`
 * allowance -- the window nearest its reset is spent first; `attempt-affinity`
 * the previous attempt's runtime for the same node. A strategy whose datum a
 * given runtime does not expose is inert for that runtime -- never a failure.
 * An assignment records `declared` instead of any of these when an operator's
 * runtime instruction prevailed over the table and every strategy.
 * @typedef {"priority" | "cost" | "reset-proximity" | "attempt-affinity"} RoutingStrategy
 */
export const ROUTING_STRATEGIES = Object.freeze(new Set(["priority", "cost", "reset-proximity", "attempt-affinity"]));

/**
 * Harness-specific stall thresholds where the contract's single default is
 * wrong for every turn the harness runs. `zcode` has no streaming flag: its
 * `--json` mode buffers the whole turn and writes the transcript only at exit,
 * so the 300 s contract default would kill a healthy long turn. Its own value
 * still bounds a genuinely dead provider well inside the 2400 s wall clock.
 * A runtime may always override its harness's value explicitly.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const HARNESS_STALL_TIMEOUT_SEC = Object.freeze({ zcode: 1_800 });
const PRICING_FIELDS = new Set(["inputPerMTok", "cachedInputPerMTok", "outputPerMTok"]);
const SNAPSHOT_RUNTIME_FIELDS = new Set(["id", ...RUNTIME_FIELDS, "capabilities"]);
const CAPABILITY_FIELDS = new Set([
  "structuredOutput", "promptTransport", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget",
  "usage", "cost", "toolPolicy", "streamsOutput", "signalsProcesses", "maxArgvPromptBytes",
]);
/** @typedef {{id: string, type?: string, runtime?: string, gate: {runtime?: string}, status?: NodeStatus, errorCode?: string, currentRuntime?: string}} RoutableNode */
/** @typedef {{status?: NodeStatus, errorCode?: string, currentRuntime?: string, assignment?: string, availability?: Record<string, RuntimeAvailability>}} RoutingEvent */
/**
 * Resolve which runtime is currently assigned to a role. There is no dynamic
 * rerouting here — rerouting is owned entirely by `planRoute` (backoff.mjs),
 * which walks the one declared `fallback` hop off the current runtime.
 *
 * @param {ValidatedContract} contract @param {RoutableNode} node @param {"worker"|"judge"} role @param {RoutingEvent} event
 */
export function routeRuntime(contract, node, role = "worker", event = {}) {
  if (role !== "worker" && role !== "judge") throw new TypeError("route role must be worker or judge");
  // Catalogue records entering a routing decision are validated here, the one
  // boundary every runtime-routing reader shares; the copies persisted on node
  // snapshots are validated where they are written.
  if (event.availability) {
    for (const [id, availability] of Object.entries(event.availability)) {
      validateRuntimeAvailability(availability, `routing availability ${id}`);
    }
  }
  const initialRuntimeId = role === "judge"
    ? node.gate.runtime ?? contract.runtimeDefaults?.judge
    : node.runtime ?? contract.runtimeDefaults?.worker;
  const composed = !initialRuntimeId && event.availability
    ? composeAssignments(contract, event.availability)[node.id]?.[role]
    : undefined;
  const runtimeId = event.currentRuntime ?? node.currentRuntime ?? event.assignment ?? composed ?? initialRuntimeId;
  requireRuntime(contract.runtimes, runtimeId, "routing current runtime");
  const runtime = contract.runtimes[/** @type {string} */ (runtimeId)];
  return { id: runtimeId, ...runtime, capabilities: harnessCapabilities(runtime) };
}
/**
 * @param {string} id
 * @param {unknown} runtime
 * @returns {ValidatedRuntime}
 */
export function validateRuntime(id, runtime) {
  requireId(id, `runtime ${id}`);
  assertObject(runtime, `runtime ${id}`);
  rejectUnknown(runtime, RUNTIME_FIELDS, `runtime ${id}`);
  validateRuntimeValues(runtime, `runtime ${id}`, runtime.harness === "exec-jsonl");
  const vendor = resolveVendor(/** @type {{harness: string, vendor?: string, config?: Record<string, unknown>}} */ (runtime));
  if (!vendor) throw new TypeError(`runtime ${id} has no resolvable vendor`);
  const stallTimeoutSec = runtime.stallTimeoutSec ?? HARNESS_STALL_TIMEOUT_SEC[/** @type {string} */ (runtime.harness)];
  return /** @type {ValidatedRuntime} */ ({
    ...runtime,
    vendor,
    ...(stallTimeoutSec !== undefined ? { stallTimeoutSec } : {}),
  });
}
/**
 * @param {JsonObject} runtime
 * @param {string} label
 * @param {boolean} executableRequired
 */
function validateRuntimeValues(runtime, label, executableRequired) {
  const harness = runtime.harness;
  if (typeof harness !== "string" || !RUNTIME_HARNESSES.has(harness)) throw new TypeError(`${label}.harness is invalid`);
  requireString(runtime.model, `${label}.model`);
  if (runtime.reasoning !== undefined) requireString(runtime.reasoning, `${label}.reasoning`);
  if (runtime.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(/** @type {string} */ (runtime.sandbox))) {
    throw new TypeError(`${label}.sandbox is invalid`);
  }
  if (runtime.permissionMode !== undefined) requireString(runtime.permissionMode, `${label}.permissionMode`);
  // How many attempts this runtime may run at once, below the run's
  // maxParallel; absent leaves only maxParallel to bound it.
  if (runtime.maxConcurrent !== undefined) positiveInteger(runtime.maxConcurrent, `${label}.maxConcurrent`);
  if (runtime.config !== undefined && (!runtime.config || typeof runtime.config !== "object" || Array.isArray(runtime.config))) {
    throw new TypeError(`${label}.config must be an object`);
  }
  if (runtime.printTimeout !== undefined) requireString(runtime.printTimeout, `${label}.printTimeout`);
  if (runtime.tools !== undefined) requireStringArray(runtime.tools, `${label}.tools`);
  if (runtime.executable !== undefined) requireString(runtime.executable, `${label}.executable`);
  if (runtime.args !== undefined) requireStringArray(runtime.args, `${label}.args`);
  if (runtime.versionArgs !== undefined) requireStringArray(runtime.versionArgs, `${label}.versionArgs`);
  if (runtime.maxArgvPromptBytes !== undefined) positiveInteger(runtime.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
  if (runtime.costRank !== undefined) nonNegativeNumber(runtime.costRank, `${label}.costRank`);
  if (runtime.stallTimeoutSec !== undefined) positiveNumber(runtime.stallTimeoutSec, `${label}.stallTimeoutSec`);
  if (runtime.pricing !== undefined) validatePricing(runtime.pricing, `${label}.pricing`);
  if (runtime.tier !== undefined && !(
    (typeof runtime.tier === "number" && Number.isInteger(runtime.tier) && runtime.tier >= 0)
    || (typeof runtime.tier === "string" && runtime.tier.trim())
  )) throw new TypeError(`${label}.tier must be a non-negative integer or non-empty string`);
  if (runtime.fallback !== undefined) requireString(runtime.fallback, `${label}.fallback`);
  if (runtime.vendor !== undefined) requireString(runtime.vendor, `${label}.vendor`);
  validateCapabilityRequirements(
    /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (runtime.requiredCapabilities),
    `${label}.requiredCapabilities`,
  );
  // The provider route belongs to the adapter, not to arbitrary provider
  // config: `sdk` hands it to `initialize` verbatim, so a dsh runtime without
  // one cannot start a turn.
  if (harness === "dsh") requireString(/** @type {Record<string, unknown>|undefined} */ (runtime.config)?.provider, `${label}.config.provider`);
  if (executableRequired && runtime.executable === undefined) requireString(runtime.executable, `${label}.executable`);
}
/**
 * A runtime's operator-declared price. Each rate is optional, but an empty
 * object is meaningless rather than free, so at least one rate must be
 * declared, every rate must be a finite number at least zero, and no key
 * outside the three canonical counters is accepted.
 *
 * @param {unknown} value
 * @param {string} label
 */
function validatePricing(value, label) {
  assertObject(value, label);
  rejectUnknown(value, PRICING_FIELDS, label);
  if (Object.keys(value).length === 0) throw new TypeError(`${label} must declare at least one rate`);
  for (const key of Object.keys(value)) {
    const rate = value[key];
    if (typeof rate !== "number" || Number.isNaN(rate)) throw new TypeError(`${label}.${key} must be a number`);
    if (!Number.isFinite(rate)) throw new TypeError(`${label}.${key} must be a finite number`);
    if (rate < 0) throw new TypeError(`${label}.${key} must not be negative`);
  }
}
/** The fields of one runtime-catalogue record (`RuntimeAvailability`). */
const AVAILABILITY_FIELDS = new Set(["available", "exhaustedUntil", "reason", "observedAt", "window", "remaining"]);

/**
 * One runtime-catalogue record: what the harness de facto reported, and when.
 * The three classified fields are required; the observables may be absent (a
 * record that predates the field) or null (the harness exposes nothing -- never
 * zero and never full allowance), but a present one must be typed: a record is
 * persisted or read into a routing decision only through validators that can
 * say what each datum means.
 *
 * @param {unknown} value
 * @param {string} label
 */
export function validateRuntimeAvailability(value, label) {
  assertObject(value, label);
  rejectUnknown(value, AVAILABILITY_FIELDS, label);
  if (typeof value.available !== "boolean") throw new TypeError(`${label}.available must be boolean`);
  if (value.exhaustedUntil !== undefined && value.exhaustedUntil !== null) requireTimestamp(value.exhaustedUntil, `${label}.exhaustedUntil`);
  requireString(value.reason, `${label}.reason`);
  if (value.observedAt !== undefined && value.observedAt !== null) requireTimestamp(value.observedAt, `${label}.observedAt`);
  if (value.window !== undefined && value.window !== null) requireString(value.window, `${label}.window`);
  if (value.remaining !== undefined && value.remaining !== null) nonNegativeNumber(value.remaining, `${label}.remaining`);
}

/**
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {string} runtimeId
 * @param {number} index
 * @param {string} nodeId
 * @param {string} label
 */
export function assertRuntimeExecutesCommands(runtimes, runtimeId, index, nodeId, label) {
  const runtime = runtimes[runtimeId];
  const execution = resolvePermissionExecution(runtime);
  if (execution.executes) return;
  throw new TypeError(
    `nodes[${index}] (${nodeId}) has verification but ${label} ${runtimeId} uses ${execution.field}=${execution.mode}; ${runtime.harness} executes commands only in ${execution.executingModes.join(", ")}`,
  );
}
/**
 * A judge runtime that declares a writing mode its harness offers a read-only
 * alternative to. The verdict reaches the gate without a write (RM-058), and
 * `judge_protocol` blocks a judge that writes anyway, so the grant buys
 * nothing but the chance to write where the judge should not.
 *
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {{judge?: string}} defaults
 * @param {{gate?: {runtime?: string}|false|null}[]} nodes
 * @returns {string[]}
 */
export function judgeWriteWarnings(runtimes, defaults, nodes) {
  const judges = new Set([defaults.judge, ...nodes.map((node) => (node.gate ? node.gate.runtime : undefined))].filter((id) => typeof id === "string"));
  return [...judges].flatMap((id) => {
    const runtime = runtimes[/** @type {string} */ (id)];
    const execution = resolvePermissionExecution(runtime);
    if (!execution.field || runtime[execution.field] === undefined || !writesWorkspace(runtime)) return [];
    if (writesWorkspace({ ...runtime, [execution.field]: "read-only" })) return [];
    return [`judge runtime ${id} declares ${execution.field} ${execution.mode}; a judge's verdict reaches the gate without writing, so declare ${execution.field} read-only`];
  });
}
/**
 * @param {unknown} value
 * @param {string} label
 */
export function validateSnapshotRuntime(value, label) {
  if (value === null) return;
  assertObject(value, label);
  rejectUnknown(value, SNAPSHOT_RUNTIME_FIELDS, label);
  requireId(value.id, `${label}.id`);
  validateRuntimeValues(value, label, value.harness === "exec-jsonl");
  validateCapabilities(/** @type {JsonObject} */ (value.capabilities), `${label}.capabilities`);
  const expected = harnessCapabilities(/** @type {{harness: string}} */ (value));
  if (stableJson(value.capabilities) !== stableJson(expected)) {
    throw new TypeError(`${label}.capabilities does not match its harness`);
  }
}
/**
 * @param {JsonObject} value
 * @param {string} label
 */
export function validateCapabilities(value, label) {
  assertObject(value, label);
  rejectUnknown(value, CAPABILITY_FIELDS, label);
  for (const name of ["structuredOutput", "sandbox", "permissions", "continuation", "tokenBudget", "costBudget", "usage", "cost", "toolPolicy", "streamsOutput"]) {
    if (typeof value[name] !== "boolean") throw new TypeError(`${label}.${name} must be boolean`);
  }
  // `signalsProcesses` is tri-state: null is a sandbox nobody has measured.
  if (value.signalsProcesses !== null && typeof value.signalsProcesses !== "boolean") {
    throw new TypeError(`${label}.signalsProcesses must be boolean or null`);
  }
  if (!["stdin", "argv"].includes(/** @type {string} */ (value.promptTransport))) {
    throw new TypeError(`${label}.promptTransport is invalid`);
  }
  if (value.maxArgvPromptBytes !== undefined) {
    positiveInteger(value.maxArgvPromptBytes, `${label}.maxArgvPromptBytes`);
  }
}
/**
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {unknown} id
 * @param {string} label
 */
export function requireRuntime(runtimes, id, label) {
  if (typeof id !== "string" || !runtimes[id]) throw new TypeError(`${label} names an unknown runtime`);
}
