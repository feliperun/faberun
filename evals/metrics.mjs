import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { jsonObjectOf, round4, timestampMs } from "../src/campaign/metrics-evals.mjs";

/**
 * Indicator projection from one run's own recorded artefacts —
 * `events.jsonl` and `usage.jsonl` only, never a node snapshot — and the
 * comparator between two already-projected reports. Same discipline as
 * `src/campaign/metrics.mjs`: every indicator carries
 * its `value`, the `direction` that counts as better, and the `count` of
 * records it was computed from, and an indicator with no supporting record
 * is `null`, never `0`.
 */

/** Transition statuses that have not settled yet; a node still on one of these is excluded from every indicator below. */
const EVAL_OPEN_STATUSES = new Set(["pending", "running"]);
/** Terminal transition statuses that count as the checkpoint having closed. */
const EVAL_DONE_STATUSES = new Set(["done", "no-op"]);
/** Terminal transition status a worker result of `blocked_context` is recorded as (`node.mjs`'s `terminalErrorCode`). */
const EVAL_BLOCKED_STATUS = "blocked";
/** Error code a transition event carries when a worker's malformed reply forced a failover hop (`node.mjs`, `applyInvalidWorkerResult`). */
const PROTOCOL_FAILURE_ERROR = "protocol_failure";
/** A usage record with no provider-reported cost is `unknown` provenance (`appendUsageRecord`). */
const EVAL_UNKNOWN_COST_PROVENANCE = "unknown";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} EvalDirection */
/** @typedef {{value: number|null, direction: EvalDirection, count: number, numerator?: number, denominator?: number, excludedRunIds?: string[], missingSources?: string[]}} EvalIndicator */
/** @typedef {{value: Record<string, number>|null, direction: EvalDirection, count: number, numerator?: Record<string, number>, denominator?: Record<string, number>, excludedRunIds?: string[], missingSources?: string[]}} EvalGroupedIndicator */

/**
 * @typedef {{
 *   costPerClosedCheckpoint: EvalIndicator,
 *   firstPassGateRate: EvalGroupedIndicator,
 *   judgeInvocationRate: EvalIndicator,
 *   revisionsPerDone: EvalIndicator,
 *   blockedContextRate: EvalIndicator,
 *   wallClockPerClosedCheckpoint: EvalIndicator,
 *   providerFailoverRate: EvalIndicator,
 *   protocolFailureRate: EvalIndicator,
 * }} EvalReport
 */

/**
 * Project every indicator from one run's `events.jsonl` and `usage.jsonl`,
 * already parsed. Pure and deterministic. `firstPassGateRate` groups by
 * `taskKind`, which here is the node's own id: neither file this reads
 * carries a coarser task-category field than the node identifier itself.
 *
 * @param {{events?: unknown[], usageRecords?: unknown[], missingSources?: string[], excludedRunIds?: string[]}} [sources]
 * @returns {EvalReport}
 */
export function projectEvalIndicators({ events = [], usageRecords = [], missingSources = [], excludedRunIds = [] } = {}) {
  const excluded = [...new Set(excludedRunIds)].sort();
  const allEventList = events.flatMap((rawEvent) => {
    const event = jsonObjectOf(rawEvent);
    return event !== null ? [event] : [];
  });
  const usageList = usageRecords.flatMap((rawRecord) => {
    const record = jsonObjectOf(rawRecord);
    return record !== null ? [record] : [];
  });
  // Replacement exclusion is a per-node denominator rule. Spend, invocation
  // and protocol evidence remain campaign totals, so keep their source lists
  // intact and filter only the grouped node-rate view.
  const byNode = groupEvalEventsByNode(allEventList.filter((event) => !isExcluded(event, excluded)));
  const allByNode = groupEvalEventsByNode(allEventList);
  /** @type {Map<string, JsonObject>} */
  const terminalByNode = new Map();
  for (const [node, entries] of allByNode) {
    const terminal = terminalEvalEventOf(entries);
    if (terminal !== null) terminalByNode.set(node, terminal);
  }
  const closedCheckpoints = new Set([...terminalByNode].filter(([, event]) => EVAL_DONE_STATUSES.has(/** @type {string} */ (event.to))).map(([node]) => node));

  const cost = evalUsageCostOf(usageList);
  // Only the closed checkpoints whose cost a provider actually reported.
  const costedCheckpoints = new Set([...closedCheckpoints].filter((node) => cost.nodeIds.has(node)));
  const gates = evalFirstPassGateRateOf(byNode);
  const judgedNodes = evalJudgeInvocationNodeIdsOf(usageList);
  const judgedClosed = [...closedCheckpoints].filter((node) => judgedNodes.has(node)).length;
  const revisionsSum = [...closedCheckpoints].reduce((sum, node) => sum + evalRevisionsOf(/** @type {JsonObject} */ (terminalByNode.get(node))), 0);
  const eligibleTerminalByNode = new Map();
  for (const [node, entries] of byNode) {
    const terminal = terminalEvalEventOf(entries);
    if (terminal !== null) eligibleTerminalByNode.set(node, terminal);
  }
  const blocked = [...eligibleTerminalByNode.values()].filter((event) => event.to === EVAL_BLOCKED_STATUS).length;
  const spanSeconds = evalEventSpanSecondsOf(allEventList);
  const workerRuntimesByNode = evalWorkerRuntimesByNodeOf(byNode);
  const failoverNodes = [...workerRuntimesByNode.values()].filter((runtimes) => runtimes.size > 1).length;
  const protocolFailures = allEventList.filter((event) => event.error === PROTOCOL_FAILURE_ERROR).length;

  const report = {
    costPerClosedCheckpoint: evalMeasured("down", costedCheckpoints.size, costedCheckpoints.size === 0 ? null : cost.total / costedCheckpoints.size),
    firstPassGateRate: evalGroupedRate("up", gates, excluded),
    judgeInvocationRate: evalRate("up", judgedClosed, closedCheckpoints.size, excluded),
    revisionsPerDone: evalMeasured("down", closedCheckpoints.size, closedCheckpoints.size === 0 ? null : revisionsSum / closedCheckpoints.size),
    blockedContextRate: evalRate("down", blocked, eligibleTerminalByNode.size, excluded),
    wallClockPerClosedCheckpoint: evalMeasured("down", closedCheckpoints.size, spanSeconds === null || closedCheckpoints.size === 0 ? null : spanSeconds / closedCheckpoints.size),
    providerFailoverRate: evalRate("down", failoverNodes, workerRuntimesByNode.size, excluded),
    protocolFailureRate: evalRate("down", protocolFailures, usageList.length, excluded),
  };
  return applyMissingEvalSources(report, missingSources);
}

/**
 * Preserve the distinction between an absent ledger source and an empty one.
 * Each affected indicator is null and names the exact missing source files.
 *
 * @param {EvalReport} report
 * @param {string[]} missingSources
 * @returns {EvalReport}
 */
function applyMissingEvalSources(report, missingSources) {
  const missing = [...new Set(missingSources)].sort();
  if (missing.length === 0) return report;
  /** @template {EvalIndicator|EvalGroupedIndicator} T @param {T} indicator @param {string[]} suffixes @returns {T} */
  const withMissing = (indicator, suffixes) => {
    const sources = missing.filter((source) => suffixes.some((suffix) => source.endsWith(`.${suffix}`) || source === suffix));
    return /** @type {T} */ (sources.length === 0 ? indicator : { ...indicator, value: null, missingSources: sources });
  };
  return {
    costPerClosedCheckpoint: withMissing(report.costPerClosedCheckpoint, ["usage.jsonl"]),
    firstPassGateRate: withMissing(report.firstPassGateRate, ["events.jsonl"]),
    judgeInvocationRate: withMissing(report.judgeInvocationRate, ["events.jsonl", "usage.jsonl"]),
    revisionsPerDone: withMissing(report.revisionsPerDone, ["events.jsonl"]),
    blockedContextRate: withMissing(report.blockedContextRate, ["events.jsonl"]),
    wallClockPerClosedCheckpoint: withMissing(report.wallClockPerClosedCheckpoint, ["events.jsonl"]),
    providerFailoverRate: withMissing(report.providerFailoverRate, ["events.jsonl"]),
    protocolFailureRate: withMissing(report.protocolFailureRate, ["events.jsonl", "usage.jsonl"]),
  };
}

/**
 * Wrap one scalar indicator. A count of zero is a missing measurement and
 * yields a null value whatever was computed; a non-finite value is missing too.
 *
 * @param {EvalDirection} direction
 * @param {number} count
 * @param {number|null} value
 * @returns {EvalIndicator}
 */
function evalMeasured(direction, count, value) {
  const missing = count === 0 || value === null || !Number.isFinite(value);
  return { value: missing ? null : round4(/** @type {number} */ (value)), direction, count };
}

/** @param {EvalDirection} direction @param {number} numerator @param {number} denominator @param {string[]} excludedRunIds @param {number} [count] @returns {EvalIndicator} */
function evalRate(direction, numerator, denominator, excludedRunIds, count = denominator) {
  return {
    value: denominator === 0 || !Number.isFinite(numerator / denominator) ? null : round4(numerator / denominator),
    direction,
    count,
    numerator,
    denominator,
    excludedRunIds: [...excludedRunIds],
  };
}

/** @param {EvalDirection} direction @param {{value: Record<string, number>, numerator: Record<string, number>, denominator: Record<string, number>, count: number}} groups @param {string[]} excludedRunIds @returns {EvalGroupedIndicator} */
function evalGroupedRate(direction, groups, excludedRunIds) {
  return {
    value: groups.count === 0 || Object.keys(groups.value).length === 0 ? null : groups.value,
    direction,
    count: groups.count,
    numerator: groups.numerator,
    denominator: groups.denominator,
    excludedRunIds: [...excludedRunIds],
  };
}

/** @param {JsonObject} record @param {string[]} excludedRunIds @returns {boolean} */
function isExcluded(record, excludedRunIds) {
  return typeof record.runId === "string" && excludedRunIds.includes(record.runId);
}

/**
 * Group transition events by node, ordered by timestamp with the recorded
 * order breaking ties.
 *
 * @param {JsonObject[]} events
 * @returns {Map<string, {atMs: number, index: number, event: JsonObject}[]>}
 */
function groupEvalEventsByNode(events) {
  /** @type {Map<string, {atMs: number, index: number, event: JsonObject}[]>} */
  const byNode = new Map();
  events.forEach((event, index) => {
    if (typeof event.node !== "string") return;
    const list = byNode.get(event.node) ?? [];
    list.push({ atMs: timestampMs(event.at), index, event });
    byNode.set(event.node, list);
  });
  for (const list of byNode.values()) list.sort((left, right) => evalOrderOf(left) - evalOrderOf(right) || left.index - right.index);
  return byNode;
}

/** @param {{atMs: number}} entry @returns {number} */
function evalOrderOf(entry) {
  return Number.isFinite(entry.atMs) ? entry.atMs : 0;
}

/**
 * The last recorded event for one node whose `to` has settled — a node still
 * `pending` or `running` has not reached a terminal state yet and is excluded.
 *
 * @param {{event: JsonObject}[]} entries
 * @returns {JsonObject|null}
 */
function terminalEvalEventOf(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const to = entries[index].event.to;
    if (typeof to === "string" && !EVAL_OPEN_STATUSES.has(to)) return entries[index].event;
  }
  return null;
}

/**
 * @param {JsonObject} terminalEvent
 * @returns {number}
 */
function evalRevisionsOf(terminalEvent) {
  return typeof terminalEvent.revisions === "number" && Number.isFinite(terminalEvent.revisions) ? terminalEvent.revisions : 0;
}

/**
 * Total cost across every usage record whose provenance is not `unknown`
 * (`appendUsageRecord` sets `unknown` exactly when the provider reported no
 * cost), plus the node ids those costed records belong to.
 *
 * The node set is the point. Dividing this total by *every* closed checkpoint
 * treats a node that ran on a provider reporting no cost as a free node, so
 * the indicator falls whenever work moves to `dsh`, `zcode`, or `codex` on a
 * ChatGPT account -- it rewards routing spend to whoever stays quiet about
 * it. In `interception-and-backlog-20260912`, 15 of 19 records were unknown
 * and the reported 0.7377 was really one phase's bill spread over three.
 * Divide by the checkpoints that were actually measured instead, and publish
 * that as the `count` so the reader can see how much of the campaign the
 * number covers.
 *
 * @param {JsonObject[]} usageRecords
 * @returns {{total: number, count: number, nodeIds: Set<string>}}
 */
function evalUsageCostOf(usageRecords) {
  let total = 0;
  let count = 0;
  /** @type {Set<string>} */
  const nodeIds = new Set();
  for (const record of usageRecords) {
    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== EVAL_UNKNOWN_COST_PROVENANCE) {
      total += record.costUsd;
      count += 1;
      if (typeof record.nodeId === "string" && record.nodeId) nodeIds.add(record.nodeId);
    }
  }
  return { total, count, nodeIds };
}

/**
 * Node ids with at least one `role: "judge"` usage record.
 *
 * @param {JsonObject[]} usageRecords
 * @returns {Set<string>}
 */
function evalJudgeInvocationNodeIdsOf(usageRecords) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const record of usageRecords) if (record.role === "judge" && typeof record.nodeId === "string") ids.add(record.nodeId);
  return ids;
}

/**
 * Fraction of gated taskKinds (here, node ids) whose first recorded verdict
 * passed. `taskKind` is the node id because `events.jsonl`/`usage.jsonl`
 * carry no coarser task-category field to group by.
 *
 * @param {Map<string, {event: JsonObject}[]>} byNode
 * @returns {{value: Record<string, number>, numerator: Record<string, number>, denominator: Record<string, number>, count: number}}
 */
function evalFirstPassGateRateOf(byNode) {
  /** @type {Record<string, number>} */
  const value = {};
  /** @type {Record<string, number>} */
  const numerator = {};
  /** @type {Record<string, number>} */
  const denominator = {};
  let count = 0;
  for (const [node, entries] of byNode) {
    const first = entries.find(({ event }) => typeof event.verdict === "string");
    if (first === undefined) continue;
    count += 1;
    value[node] = first.event.verdict === "pass" ? 1 : 0;
    numerator[node] = first.event.verdict === "pass" ? 1 : 0;
    denominator[node] = 1;
  }
  return { value, numerator, denominator, count };
}

/**
 * Wall-clock span of the recording, in seconds. A single timestamped event
 * spans nothing measurable.
 *
 * @param {JsonObject[]} events
 * @returns {number|null}
 */
function evalEventSpanSecondsOf(events) {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const event of events) {
    const atMs = timestampMs(event.at);
    if (!Number.isFinite(atMs)) continue;
    count += 1;
    if (atMs < earliest) earliest = atMs;
    if (atMs > latest) latest = atMs;
  }
  return count < 2 ? null : (latest - earliest) / 1000;
}

/**
 * Distinct runtime ids a node's `phase: "worker"` transitions ran on. More
 * than one means the node failed over to a different provider mid-flight.
 *
 * @param {Map<string, {event: JsonObject}[]>} byNode
 * @returns {Map<string, Set<string>>}
 */
function evalWorkerRuntimesByNodeOf(byNode) {
  /** @type {Map<string, Set<string>>} */
  const workerRuntimesByNode = new Map();
  for (const [node, entries] of byNode) {
    /** @type {Set<string>} */
    const runtimes = new Set();
    for (const { event } of entries) if (event.phase === "worker" && typeof event.runtime === "string") runtimes.add(event.runtime);
    if (runtimes.size > 0) workerRuntimesByNode.set(node, runtimes);
  }
  return workerRuntimesByNode;
}

/**
 * Read one run's own `events.jsonl` and `usage.jsonl`, unparsed into the
 * shape `projectEvalIndicators` takes. A missing artefact reads as empty,
 * which the projector reports as a missing measurement and never as a
 * measured zero.
 *
 * @param {string} runDir
 * @returns {{events: unknown[], usageRecords: unknown[]}}
 */
export function readEvalRunSources(runDir) {
  const runId = basename(runDir);
  return {
    events: readEvalJsonlRecords(join(runDir, "events.jsonl")).map((record) => ({ ...jsonObjectOf(record), runId })),
    usageRecords: readEvalJsonlRecords(join(runDir, "usage.jsonl")).map((record) => ({ ...jsonObjectOf(record), runId })),
  };
}

/**
 * Merge several runs' already-read sources into one. A campaign built from
 * more than one sequential orchestrator run (one directory per attempt, each
 * with its own `events.jsonl`/`usage.jsonl`) has no single run directory
 * that holds every record, so `--project` reads each directory separately
 * with `readEvalRunSources` and merges here before `projectEvalIndicators`
 * regroups everything by node and timestamp; which source contributed a
 * given record does not matter past this point.
 *
 * @param {{runIds?: string[], events: unknown[], usageRecords: unknown[], missingSources?: string[], excludedRunIds?: string[]}[]} sourcesList
 * @returns {{runIds: string[], events: unknown[], usageRecords: unknown[], missingSources: string[], excludedRunIds: string[]}}
 */
export function mergeEvalRunSources(sourcesList) {
  return {
    runIds: [...new Set(sourcesList.flatMap((sources) => sources.runIds ?? []))],
    events: sourcesList.flatMap((sources) => sources.events),
    usageRecords: sourcesList.flatMap((sources) => sources.usageRecords),
    missingSources: [...new Set(sourcesList.flatMap((sources) => sources.missingSources ?? []))],
    excludedRunIds: [...new Set(sourcesList.flatMap((sources) => sources.excludedRunIds ?? []))],
  };
}

/**
 * Records of one JSONL artefact. An unterminated final line was never a
 * committed record, so it is skipped rather than parsed.
 *
 * @param {string} path
 * @returns {unknown[]}
 */
function readEvalJsonlRecords(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  /** @type {unknown[]} */
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (index === lines.length - 1 && !text.endsWith("\n")) continue;
    records.push(JSON.parse(lines[index]));
  }
  return records;
}

/**
 * One indicator's value, reduced to a plain number when it can stand on one
 * side of a subtraction. A grouped indicator's per-taskKind map, or a
 * missing (`null`) measurement, is not — comparing either against a number
 * never yields a numeric delta.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function evalComparableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @typedef {{
 *   before: {value: unknown, count: number},
 *   after: {value: unknown, count: number},
 *   direction: EvalDirection,
 *   delta: number|null,
 *   comparable: boolean,
 *   band?: number|null,
 *   significant?: boolean|null,
 * }} EvalIndicatorComparison
 */

/**
 * Compare one indicator between two already-projected reports. A `null`
 * indicator (no supporting record) compared against a measured number, or a
 * grouped indicator's map compared against anything, never produces a
 * numeric delta — it reports `comparable: false` instead of a delta that
 * would silently read as zero.
 *
 * @param {JsonObject|undefined} before
 * @param {JsonObject|undefined} after
 * @param {number|null} [band] the indicator's noise band, when a band report was given
 * @returns {EvalIndicatorComparison}
 */
function compareEvalIndicator(before, after, band = undefined) {
  const beforeNumber = evalComparableNumber(before?.value);
  const afterNumber = evalComparableNumber(after?.value);
  const comparable = beforeNumber !== null && afterNumber !== null;
  const delta = comparable ? round4(/** @type {number} */ (afterNumber) - /** @type {number} */ (beforeNumber)) : null;
  const entry = {
    before: { value: before?.value ?? null, count: typeof before?.count === "number" ? before.count : 0 },
    after: { value: after?.value ?? null, count: typeof after?.count === "number" ? after.count : 0 },
    direction: /** @type {EvalDirection} */ (after?.direction ?? before?.direction ?? "informative"),
    delta,
    comparable,
  };
  if (band === undefined) return entry;
  // With a noise band the comparison says one more thing: whether the delta
  // is larger than the spread repetition alone produces. Inside the band it
  // is not a difference, and the report says "not measured", never "none".
  return { ...entry, band, significant: comparable && band !== null && delta !== null ? Math.abs(delta) > band : null };
}

/**
 * Compare every indicator of two already-projected reports (the `--compare`
 * CLI command's core). The two reports need not share the same indicator
 * set — an indicator present on only one side still gets an entry, missing
 * on the other side.
 *
 * @param {JsonObject} before
 * @param {JsonObject} after
 * @param {JsonObject} [bands] a `--band` report's indicators, or a bare `{name: band}` map
 * @returns {Record<string, EvalIndicatorComparison>}
 */
export function compareEvalReports(before, after, bands = undefined) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  /** @type {Record<string, EvalIndicatorComparison>} */
  const comparison = {};
  for (const name of [...names].sort()) {
    comparison[name] = compareEvalIndicator(
      jsonObjectOf(before[name]) ?? undefined,
      jsonObjectOf(after[name]) ?? undefined,
      bands === undefined ? undefined : bandValueOf(bands[name]),
    );
  }
  return comparison;
}

/**
 * The band a `--band` report (or a bare `{name: number}` map) states for one
 * indicator; an indicator the band report never measured has none.
 *
 * @param {unknown} entry
 * @returns {number|null}
 */
function bandValueOf(entry) {
  if (typeof entry === "number" && Number.isFinite(entry)) return entry;
  const value = jsonObjectOf(entry)?.band;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The noise band per indicator across repeated projections of the same
 * setup: half the range of the measured values, with their median and how
 * many repetitions measured it. An indicator measured in fewer than two
 * repetitions has no band -- one reading is not a spread. measured
 * 2026-09-20: the same packet on the same model varied by a factor of 3.3
 * across 10 repetitions in one campaign and 2.12 across 2 in another, so a
 * comparison of one run per arm reports noise as a result.
 *
 * @param {JsonObject[]} reports bare indicator maps or `{indicators}` wrappers
 * @returns {Record<string, {band: number|null, median: number|null, n: number}>}
 */
export function noiseBandOf(reports) {
  const maps = reports.map((report) => {
    const object = jsonObjectOf(report) ?? {};
    return jsonObjectOf(object.indicators) ?? object;
  });
  const names = new Set(maps.flatMap((map) => Object.keys(map)));
  /** @type {Record<string, {band: number|null, median: number|null, n: number}>} */
  const result = {};
  for (const name of [...names].sort()) {
    const values = maps
      .map((map) => evalComparableNumber(jsonObjectOf(map[name])?.value))
      .filter((value) => value !== null)
      .map((value) => /** @type {number} */ (value))
      .sort((left, right) => left - right);
    const n = values.length;
    if (n < 2) {
      result[name] = { band: null, median: n === 1 ? values[0] : null, n };
      continue;
    }
    const median = n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    result[name] = { band: round4((values[n - 1] - values[0]) / 2), median: round4(median), n };
  }
  return result;
}

/**
 * Render `--compare`'s comparison as the human-readable report.
 *
 * @param {Record<string, EvalIndicatorComparison>} comparison
 * @returns {string}
 */
export function renderEvalComparisonReport(comparison) {
  const lines = [];
  for (const [name, entry] of Object.entries(comparison)) {
    lines.push(name);
    lines.push(`  before: ${JSON.stringify(entry.before.value)} (n=${entry.before.count})`);
    lines.push(`  after:  ${JSON.stringify(entry.after.value)} (n=${entry.after.count})`);
    lines.push(`  delta:  ${renderDelta(entry)}`);
    lines.push(`  melhora conta como: ${entry.direction}`);
  }
  return `${lines.join("\n")}\n`;
}

/** @param {EvalIndicatorComparison} entry @returns {string} */
function renderDelta(entry) {
  if (!entry.comparable) return "no data";
  if (entry.band === undefined || entry.band === null) return String(entry.delta);
  return entry.significant
    ? `${entry.delta} (outside the noise band ±${entry.band})`
    : `not measured: |${entry.delta}| is within the noise band ±${entry.band}`;
}
