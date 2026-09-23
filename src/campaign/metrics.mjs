/**
 * Metrics projector (TECH-SPEC lean section 6). One pure function over a
 * campaign's own parsed artefacts — node snapshots, transitions, priced
 * invocations and delivery receipts — returning exactly the indicators
 * section 6 measures at close. Nothing here estimates a token count or reads
 * a heartbeat: every value comes from a record the platform already wrote for
 * another reason.
 *
 * `projectMetrics` takes already-parsed records and never a filesystem path,
 * which keeps every indicator testable without fixtures on disk. Each
 * indicator carries its value, the direction that counts as better, and the
 * number of records it was computed from. An indicator with no supporting
 * record is `null`, never `0`: a missing measurement and a measured zero are
 * different facts.
 *
 * A *logical node* is a contract node id within one run (TECH-SPEC section
 * 6): the same id in two different runs is two logical nodes, because a
 * fresh run re-authors the work rather than resuming it. A *checkpoint* is
 * coarser — the node id alone, deduplicated across every linked run — and is
 * what `linkedRunsPerClosedCheckpoint` divides the run count by: normally the
 * same node closes in the one run that carries it, and the ratio drifts above
 * 1 only when a whole run had to be re-authored after a failure that
 * `resume` could not repair.
 *
 * Filesystem reads and the `faberun metrics` command's flags live in
 * `metrics-command.mjs`; keeping them separate leaves this module a pure
 * function over parsed records.
 */

import { jsonObjectOf, round4, timestampMs } from "./metrics-evals.mjs";
import { UNKNOWN_COST_REASONS } from "../run/usage.mjs";
import { MAX_ATTEMPTS as NOTIFY_MAX_ATTEMPTS } from "../notify/index.mjs";

/** Node statuses that are not terminal: everything else settles a logical node. */
const OPEN_STATUSES = new Set(["pending", "running"]);
/** Terminal statuses that count as the node's work having landed. */
const DONE_STATUSES = new Set(["done", "no-op"]);
/** Gate review that blocks the node on a failing verdict (TECH-SPEC lean, rule 2). */
const BLOCKING_REVIEW = "blocking";
/** A receipt this settled: delivered, no transport bound, or the retry budget spent. */
// `filtered` is a decided outcome too: the event type was kept out of every
// transport on purpose (`FABERUN_NOTIFY_EVENTS`), not lost.
const SETTLED_NOTIFY_STATUSES = new Set(["delivered", "no_transport", "filtered"]);
/** Target latency for a terminal/attention event to carry a settled receipt (TECH-SPEC section 6). */
const NOTIFY_TARGET_SEC = 60;
const SECONDS_PER_HOUR = 3600;
/** A usage record with no provider-reported cost is `unknown` provenance (`appendUsageRecord`). */
const UNKNOWN_COST_PROVENANCE = "unknown";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"down"|"up"|"informative"} Direction */
/** @typedef {{value: number|null, direction: Direction, count: number, numerator?: number, denominator?: number, excludedRunIds?: string[], missingSources?: string[]}} Indicator */
/** @typedef {Indicator & {unknownCount: number, unknownCountByReason: Record<string, number>, unknownFractionByReason: Record<string, number>}} CostIndicator */
/** @typedef {{value: Record<string, number>|null, direction: Direction, count: number, numerator?: Record<string, number>, denominator?: Record<string, number>, excludedRunIds?: string[], missingSources?: string[]}} GroupedIndicator */
/** @typedef {{atMs: number, index: number, event: JsonObject}} RunEvent */
/** @typedef {{runId: string, id: string, status: string, attempt?: number|null, revisions?: number|null, review?: string|null}} RunNode */

/**
 * @typedef {{
 *   events?: unknown[],
 *   usageRecords?: unknown[],
 *   notifications?: unknown[],
 *   nodes?: RunNode[],
 *   journal?: unknown[],
 *   campaign?: JsonObject,
 *   requirements?: unknown[],
 *   excludedRunIds?: string[],
 *   missingSources?: string[],
 *   now?: number,
 * }} MetricsInput
 */

/**
 * @typedef {{
 *   nodesDoneRate: Indicator,
 *   linkedRunsPerClosedCheckpoint: Indicator,
 *   runsPerCampaign: Indicator,
 *   wallClockSec: Indicator,
 *   usageTokensByKind: GroupedIndicator,
 *   usageTokensByKindByRuntime: GroupedIndicator,
 *   usageCostUsd: CostIndicator,
 *   blockingJudgeFirstPassRate: GroupedIndicator,
 *   notifyReceiptRate: Indicator,
 *   silentStallRate: Indicator,
 *   intentToVerifiedSeconds: Indicator,
 *   humanTouches: Indicator,
 * }} CampaignMetrics
 */

/**
 * Project every section-6 indicator from one campaign's recorded artefacts.
 * Pure and deterministic: identical records yield identical output, rates
 * round to 4 decimals, and durations are seconds.
 *
 * @param {MetricsInput} [input]
 * @returns {CampaignMetrics}
 */
export function projectMetrics({ events = [], usageRecords = [], notifications = [], nodes = [], journal = [], campaign = undefined, requirements = undefined, excludedRunIds = [], missingSources = [], now = Date.now() } = {}) {
  void now;
  const eventList = events.map(jsonObjectOf).filter((event) => event !== null);
  const excluded = excludedRunIdsFor(campaign, excludedRunIds);
  const eligibleNodes = nodes.filter((node) => !excluded.includes(node.runId));
  const eligibleEvents = eventList.filter((event) => typeof event.runId !== "string" || !excluded.includes(event.runId));
  const eligibleNotifications = notifications.filter((record) => {
    const object = jsonObjectOf(record);
    return object === null || typeof object.runId !== "string" || !excluded.includes(object.runId);
  });
  const nodesDone = nodesDoneRateOf(eligibleNodes);
  const runs = runsPerCampaignOf(nodes, eventList);
  const closedCheckpoints = closedCheckpointsOf(nodes);
  const span = eventSpanOf(eventList);
  const usage = usageTotalsOf(usageRecords);
  const gates = blockingJudgeFirstPassRateOf(eligibleNodes, eligibleEvents);
  const notify = notifyReceiptRateOf(eligibleNotifications);
  const stalls = silentStallRateOf(eligibleNodes, eligibleEvents);
  const declaredRequirements = campaign !== undefined && Array.isArray(campaign.requirements) ? campaign.requirements : requirements;
  const northStar = intentToVerifiedSecondsOf(journal, declaredRequirements, eventList);
  const touches = humanTouchesOf(journal, eventList);
  const metrics = {
    nodesDoneRate: rate("up", nodesDone.done, nodesDone.terminal, excluded),
    linkedRunsPerClosedCheckpoint: measured("down", closedCheckpoints, closedCheckpoints === 0 ? null : runs / closedCheckpoints),
    runsPerCampaign: measured("down", runs, runs === 0 ? null : runs),
    wallClockSec: measured("down", span.count, span.seconds),
    usageTokensByKind: grouped("informative", usage.tokenCount, usage.tokensByKind),
    usageTokensByKindByRuntime: grouped("informative", usage.tokenCount, usage.tokensByKindByRuntime),
    usageCostUsd: {
      ...measured("down", usage.costCount, usage.costCount === 0 ? null : usage.costUsd),
      unknownCount: usage.unknownCount,
      unknownCountByReason: usage.unknownCountByReason,
      unknownFractionByReason: usage.unknownFractionByReason,
    },
    blockingJudgeFirstPassRate: groupedRate("up", gates, excluded),
    notifyReceiptRate: rate("up", notify.satisfied, notify.count, excluded),
    silentStallRate: rate("down", stalls.stalled, stalls.activeHours, excluded, stalls.activeIntervals),
    intentToVerifiedSeconds: northStar,
    humanTouches: touches,
  };
  return applyMissingSources(metrics, missingSources);
}

/**
 * A missing ledger file is incomplete evidence, not an empty measurement.
 * Preserve the exact filenames so both report forms explain the gap.
 *
 * @param {CampaignMetrics} metrics
 * @param {string[]} missingSources
 * @returns {CampaignMetrics}
 */
function applyMissingSources(metrics, missingSources) {
  const missing = [...new Set(missingSources)].sort();
  if (missing.length === 0) return metrics;
  /** @template {Indicator|GroupedIndicator} T @param {T} indicator @param {string[]} suffixes @returns {T} */
  const withMissing = (indicator, suffixes) => {
    const sources = missing.filter((source) => suffixes.some((suffix) => source.endsWith(`.${suffix}`) || source === suffix));
    return /** @type {T} */ (sources.length === 0 ? indicator : { ...indicator, value: null, missingSources: sources });
  };
  return {
    nodesDoneRate: withMissing(metrics.nodesDoneRate, ["nodes.json"]),
    linkedRunsPerClosedCheckpoint: withMissing(metrics.linkedRunsPerClosedCheckpoint, ["nodes.json"]),
    runsPerCampaign: withMissing(metrics.runsPerCampaign, ["events.jsonl"]),
    wallClockSec: withMissing(metrics.wallClockSec, ["events.jsonl"]),
    usageTokensByKind: withMissing(metrics.usageTokensByKind, ["usage.jsonl"]),
    usageTokensByKindByRuntime: withMissing(metrics.usageTokensByKindByRuntime, ["usage.jsonl"]),
    usageCostUsd: withMissing(metrics.usageCostUsd, ["usage.jsonl"]),
    blockingJudgeFirstPassRate: withMissing(metrics.blockingJudgeFirstPassRate, ["nodes.json", "events.jsonl"]),
    notifyReceiptRate: withMissing(metrics.notifyReceiptRate, ["notify.jsonl"]),
    silentStallRate: withMissing(metrics.silentStallRate, ["nodes.json", "events.jsonl"]),
    intentToVerifiedSeconds: withMissing(metrics.intentToVerifiedSeconds, ["journal.jsonl", "campaign.json"]),
    humanTouches: withMissing(metrics.humanTouches, ["journal.jsonl"]),
  };
}

/** @param {JsonObject|undefined} campaign @param {string[]} requested @returns {string[]} */
export function excludedRunIdsFor(campaign, requested) {
  const fromCampaign = Array.isArray(campaign?.replacements)
    ? campaign.replacements.flatMap((entry) => {
      const replacement = jsonObjectOf(entry);
      return replacement !== null && Array.isArray(replacement.runIds)
        ? replacement.runIds.filter((id) => typeof id === "string")
        : [];
    })
    : [];
  return [...new Set([...requested, ...fromCampaign])].sort();
}

/**
 * Wrap one scalar indicator. A count of zero is a missing measurement and
 * yields a null value whatever was computed; a non-finite value is missing too.
 *
 * @param {Direction} direction
 * @param {number} count
 * @param {number|null} value
 * @returns {Indicator}
 */
function measured(direction, count, value) {
  const missing = count === 0 || value === null || !Number.isFinite(value);
  return { value: missing ? null : round4(/** @type {number} */ (value)), direction, count };
}

/** @param {Direction} direction @param {number} numerator @param {number} denominator @param {string[]} excludedRunIds @param {number} [count] @returns {Indicator} */
function rate(direction, numerator, denominator, excludedRunIds, count = denominator) {
  return {
    value: denominator === 0 || !Number.isFinite(numerator / denominator) ? null : round4(numerator / denominator),
    direction,
    count,
    numerator,
    denominator,
    excludedRunIds: [...excludedRunIds],
  };
}

/**
 * Wrap one indicator reported per group (lane or runtime). The empty group map
 * is a missing measurement, not a measured zero.
 *
 * @param {Direction} direction
 * @param {number} count
 * @param {Record<string, number>} value
 * @returns {GroupedIndicator}
 */
function grouped(direction, count, value) {
  return { value: count === 0 || Object.keys(value).length === 0 ? null : value, direction, count };
}

/** @param {{value: Record<string, number>, numerator: Record<string, number>, denominator: Record<string, number>, count: number}} groups @param {Direction} direction @param {string[]} excludedRunIds @returns {GroupedIndicator} */
function groupedRate(direction, groups, excludedRunIds) {
  return {
    value: groups.count === 0 || Object.keys(groups.value).length === 0 ? null : groups.value,
    direction,
    count: groups.count,
    numerator: groups.numerator,
    denominator: groups.denominator,
    excludedRunIds: [...excludedRunIds],
  };
}

/**
 * The north star is complete only when every declared requirement has an
 * approved closure evidence entry. The completion instant is the matching
 * done/proof event, not campaign close, so a late retrospective cannot make
 * the work look slower or faster than it was.
 *
 * @param {unknown[]} journal
 * @param {unknown[]|undefined} requirements
 * @param {JsonObject[]} events
 * @returns {Indicator}
 */
function intentToVerifiedSecondsOf(journal, requirements, events) {
  const entries = journal.map(jsonObjectOf).filter((entry) => entry !== null);
  const initialized = entries
    .filter((entry) => entry.type === "campaign.initialized")
    .map((entry) => timestampMs(entry.at))
    .find((atMs) => Number.isFinite(atMs));
  if (!Number.isFinite(initialized) || !Array.isArray(requirements) || requirements.length === 0) {
    return measured("down", 0, null);
  }
  /** @type {number[]} */
  const proofTimes = [];
  for (const raw of requirements) {
    const requirement = jsonObjectOf(raw);
    if (requirement === null || requirement.status !== "covered" || !Array.isArray(requirement.nodes)) {
      return measured("down", 0, null);
    }
    const approved = requirement.nodes.flatMap((rawEvidence) => {
      const evidence = jsonObjectOf(rawEvidence);
      return evidence !== null && evidence.passed === true && (evidence.verdict === null || evidence.verdict === "pass") ? [evidence] : [];
    });
    if (approved.length === 0) return measured("down", 0, null);
    const times = approved.flatMap((evidence) => proofTimesForEvidence(evidence, events));
    if (times.length === 0) return measured("down", 0, null);
    proofTimes.push(Math.min(...times));
  }
  const lastProof = Math.max(...proofTimes);
  return measured("down", 1, (lastProof - /** @type {number} */ (initialized)) / 1000);
}

/** @param {JsonObject} evidence @param {JsonObject[]} events @returns {number[]} */
function proofTimesForEvidence(evidence, events) {
  for (const field of ["approvedAt", "at"]) {
    const direct = timestampMs(evidence[field]);
    if (Number.isFinite(direct)) return [direct];
  }
  return events
    .filter((event) => event.runId === evidence.runId && event.node === evidence.node)
    .filter((event) => event.to === "done" || event.proofApproved === true || (event.phase === "verification" && event.passed === true))
    .map((event) => timestampMs(event.at))
    .filter((atMs) => Number.isFinite(atMs));
}

/** @param {unknown[]} journal @param {JsonObject[]} events @returns {Indicator} */
function humanTouchesOf(journal, events) {
  const entries = journal.map(jsonObjectOf).filter((entry) => entry !== null);
  if (entries.length === 0) return { value: null, direction: "informative", count: 0 };
  const launchTimes = entries
    .filter((entry) => entry.type === "run.registered")
    .map((entry) => timestampMs(entry.at))
    .filter((atMs) => Number.isFinite(atMs));
  if (launchTimes.length === 0) return { value: 0, direction: "informative", count: 0 };
  const firstLaunch = Math.min(...launchTimes);
  const recoveryTouches = events
    .filter(isRecordedOperatorEvent)
    .sort((left, right) => timestampMs(left.at) - timestampMs(right.at))
    .filter((event, index, all) => event.to !== "canceled" || all.findIndex((candidate) => candidate.to === "canceled" && candidate.runId === event.runId) === index);
  const touches = [...entries.filter(isRecordedJournalTouch), ...recoveryTouches].filter((entry) => {
    const atMs = timestampMs(entry.at);
    return Number.isFinite(atMs) && atMs > firstLaunch;
  });
  return { value: touches.length, direction: "informative", count: touches.length };
}

/** @param {JsonObject} entry @returns {boolean} */
function isRecordedJournalTouch(entry) {
  return entry.type === "question.resolved"
    || (entry.type === "operator.command" && ["campaign add-contract", "campaign supervise --refresh-controller"].includes(String(entry.command)));
}

/** @param {JsonObject} entry @returns {boolean} */
function isRecordedOperatorEvent(entry) {
  const override = jsonObjectOf(entry.override);
  return entry.to === "canceled"
    || override?.kind === "operator-answer"
    || entry.recovery === "reconcile_acknowledged";
}

/**
 * Logical nodes done at any attempt, over logical nodes that reached a
 * terminal state. A node still `pending` or `running` at close is censored:
 * it counts toward neither side (TECH-SPEC section 6 denominators).
 *
 * @param {RunNode[]} nodes
 * @returns {{done: number, terminal: number}}
 */
function nodesDoneRateOf(nodes) {
  let done = 0;
  let terminal = 0;
  for (const node of nodes) {
    if (OPEN_STATUSES.has(node.status)) continue;
    terminal += 1;
    if (DONE_STATUSES.has(node.status)) done += 1;
  }
  return { done, terminal };
}

/**
 * Distinct checkpoints (node ids, deduplicated across every linked run) that
 * closed at least once.
 *
 * @param {RunNode[]} nodes
 * @returns {number}
 */
function closedCheckpointsOf(nodes) {
  const closed = new Set();
  for (const node of nodes) if (DONE_STATUSES.has(node.status)) closed.add(node.id);
  return closed.size;
}

/**
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {number}
 */
function runsPerCampaignOf(nodes, events) {
  const runIds = new Set();
  for (const node of nodes) runIds.add(node.runId);
  for (const event of events) if (typeof event.runId === "string") runIds.add(event.runId);
  return runIds.size;
}

/**
 * Wall-clock span of the recording, in seconds, with the number of timestamped
 * events it was measured from. A single event spans nothing measurable.
 *
 * @param {JsonObject[]} events
 * @returns {{seconds: number|null, count: number}}
 */
function eventSpanOf(events) {
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
  return count < 2 ? { seconds: null, count: 0 } : { seconds: (latest - earliest) / 1000, count };
}

/**
 * Tokens by kind and total cost across every linked run's usage records, both
 * as a campaign total and broken out per runtime (TECH-SPEC section 6). A
 * record contributes exactly what it recorded: uncached input, cache-read
 * input and output tokens are independent totals. Cost sums only records
 * whose provenance is not `unknown` (`appendUsageRecord` sets `unknown`
 * exactly when the provider reported no cost); every other record's
 * invocation is counted separately rather than folded into a measured zero.
 *
 * @param {unknown[]} usageRecords
 * @returns {{tokensByKind: Record<string, number>, tokensByKindByRuntime: Record<string, number>, tokenCount: number, costUsd: number|null, costCount: number, unknownCount: number, unknownCountByReason: Record<string, number>, unknownFractionByReason: Record<string, number>}}
 */
function usageTotalsOf(usageRecords) {
  const tokensByKind = { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
  /** @type {Record<string, number>} */
  const tokensByKindByRuntime = {};
  let tokenCount = 0;
  let costUsd = 0;
  let costCount = 0;
  let unknownCount = 0;
  /** @type {Record<string, number>} */
  const unknownCountByReason = {};
  const kinds = /** @type {("inputTokens"|"cacheReadInputTokens"|"outputTokens")[]} */ (["inputTokens", "cacheReadInputTokens", "outputTokens"]);
  for (const raw of usageRecords) {
    const record = jsonObjectOf(raw);
    if (record === null) continue;
    let measuredAny = false;
    const runtime = typeof record.runtimeId === "string" && record.runtimeId !== "" ? record.runtimeId : null;
    for (const kind of kinds) {
      if (typeof record[kind] !== "number" || !Number.isFinite(record[kind])) continue;
      const value = /** @type {number} */ (record[kind]);
      tokensByKind[kind] += value;
      if (runtime !== null) tokensByKindByRuntime[`${runtime}.${kind}`] = (tokensByKindByRuntime[`${runtime}.${kind}`] ?? 0) + value;
      measuredAny = true;
    }
    if (measuredAny) tokenCount += 1;
    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance !== UNKNOWN_COST_PROVENANCE) {
      costUsd += record.costUsd;
      costCount += 1;
    } else {
      unknownCount += 1;
      const reason = typeof record.unknownReason === "string" && UNKNOWN_COST_REASONS.includes(record.unknownReason)
        ? record.unknownReason
        : "legacy";
      unknownCountByReason[reason] = (unknownCountByReason[reason] ?? 0) + 1;
    }
  }
  const totalCount = costCount + unknownCount;
  const unknownFractionByReason = Object.fromEntries(
    Object.entries(unknownCountByReason).map(([reason, count]) => [reason, round4(count / totalCount)]),
  );
  return {
    tokensByKind,
    tokensByKindByRuntime,
    tokenCount,
    costUsd: costCount === 0 ? null : costUsd,
    costCount,
    unknownCount,
    unknownCountByReason,
    unknownFractionByReason,
  };
}

/**
 * Fraction of blocking-gated checkpoints whose first recorded verdict passed,
 * per lane (the judge runtime that produced it). A node under `advisory` or
 * `none` review never blocks the campaign on a fail, so it is not what this
 * indicator measures (TECH-SPEC section 6, "Blocking judge first-pass rate").
 *
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {{value: Record<string, number>, numerator: Record<string, number>, denominator: Record<string, number>, count: number}}
 */
function blockingJudgeFirstPassRateOf(nodes, events) {
  /** @type {Map<string, string|null>} */
  const reviewByKey = new Map();
  for (const node of nodes) reviewByKey.set(`${node.runId}:${node.id}`, node.review ?? null);
  const byKey = groupEventsByRunNode(events);
  /** @type {Map<string, {gated: number, passed: number}>} */
  const lanes = new Map();
  let gated = 0;
  for (const [key, entries] of byKey) {
    if (reviewByKey.get(key) !== BLOCKING_REVIEW) continue;
    const first = entries.find(({ event }) => typeof event.verdict === "string");
    if (first === undefined) continue;
    gated += 1;
    const lane = typeof first.event.runtime === "string" && first.event.runtime !== "" ? first.event.runtime : "unknown";
    const tally = lanes.get(lane) ?? { gated: 0, passed: 0 };
    tally.gated += 1;
    if (first.event.verdict === "pass") tally.passed += 1;
    lanes.set(lane, tally);
  }
  /** @type {Record<string, number>} */
  const value = {};
  /** @type {Record<string, number>} */
  const numerator = {};
  /** @type {Record<string, number>} */
  const denominator = {};
  for (const lane of [...lanes.keys()].sort()) {
    const tally = /** @type {{gated: number, passed: number}} */ (lanes.get(lane));
    value[lane] = round4(tally.passed / tally.gated);
    numerator[lane] = tally.passed;
    denominator[lane] = tally.gated;
  }
  return { value, numerator, denominator, count: gated };
}

/**
 * Fraction of notified events (grouped by `dedupeKey`, one per logical
 * terminal/attention transition) that reached a settled receipt — delivered,
 * no transport bound, or failed after the bounded retry budget — within
 * `NOTIFY_TARGET_SEC` of the first attempt (TECH-SPEC section 6).
 *
 * @param {unknown[]} notifications
 * @returns {{satisfied: number, count: number}}
 */
function notifyReceiptRateOf(notifications) {
  /** @type {Map<string, JsonObject[]>} */
  const byKey = new Map();
  for (const raw of notifications) {
    const record = jsonObjectOf(raw);
    if (record === null || typeof record.dedupeKey !== "string" || record.dedupeKey === "") continue;
    const list = byKey.get(record.dedupeKey) ?? [];
    list.push(record);
    byKey.set(record.dedupeKey, list);
  }
  let satisfied = 0;
  let count = 0;
  for (const receipts of byKey.values()) {
    const first = receipts.find((receipt) => receipt.attempt === 1);
    if (first === undefined) continue;
    count += 1;
    const firstAtMs = timestampMs(first.at);
    const settled = receipts.find((receipt) => isSettledReceipt(receipt));
    if (settled === undefined) continue;
    const settledAtMs = timestampMs(settled.at);
    if (!Number.isFinite(firstAtMs) || !Number.isFinite(settledAtMs)) continue;
    const deltaSec = (settledAtMs - firstAtMs) / 1000;
    if (deltaSec >= 0 && deltaSec <= NOTIFY_TARGET_SEC) satisfied += 1;
  }
  return { satisfied, count };
}

/**
 * @param {JsonObject} receipt
 * @returns {boolean}
 */
function isSettledReceipt(receipt) {
  if (typeof receipt.status !== "string") return false;
  if (SETTLED_NOTIFY_STATUSES.has(receipt.status)) return true;
  return receipt.status === "failed" && receipt.attempt === NOTIFY_MAX_ATTEMPTS;
}

/**
 * Silent stalls (logical nodes the controller killed for provider silence)
 * per active run-hour. Active time is the sum of every closed `running`
 * interval recorded in `events.jsonl`; a `stalled` status is the controller's
 * own record that a running interval went silent past its timeout, so this
 * needs no heartbeat of its own (TECH-SPEC section 6, hard target zero).
 *
 * @param {RunNode[]} nodes
 * @param {JsonObject[]} events
 * @returns {{stalled: number, activeHours: number, activeIntervals: number}}
 */
function silentStallRateOf(nodes, events) {
  const stalled = nodes.filter((node) => node.status === "stalled").length;
  const byKey = groupEventsByRunNode(events);
  let activeSeconds = 0;
  let activeIntervals = 0;
  for (const entries of byKey.values()) {
    for (let index = 0; index < entries.length; index += 1) {
      const event = entries[index].event;
      if (event.to !== "running") continue;
      const next = entries[index + 1];
      if (next === undefined) continue;
      const startMs = entries[index].atMs;
      const endMs = next.atMs;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
      activeSeconds += (endMs - startMs) / 1000;
      activeIntervals += 1;
    }
  }
  return { stalled, activeHours: activeSeconds / SECONDS_PER_HOUR, activeIntervals };
}

/**
 * Group transition events by run and node, ordered by timestamp with the
 * recorded order breaking ties, so a running interval can be paired with the
 * event that ends it.
 *
 * @param {JsonObject[]} events
 * @returns {Map<string, RunEvent[]>}
 */
function groupEventsByRunNode(events) {
  /** @type {Map<string, RunEvent[]>} */
  const byKey = new Map();
  events.forEach((event, index) => {
    if (typeof event.node !== "string") return;
    const key = `${typeof event.runId === "string" ? event.runId : ""}:${event.node}`;
    const list = byKey.get(key) ?? [];
    list.push({ atMs: timestampMs(event.at), index, event });
    byKey.set(key, list);
  });
  for (const list of byKey.values()) list.sort((left, right) => orderOf(left) - orderOf(right) || left.index - right.index);
  return byKey;
}

/** @param {RunEvent} entry @returns {number} */
function orderOf(entry) {
  return Number.isFinite(entry.atMs) ? entry.atMs : 0;
}
