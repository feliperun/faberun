/**
 * Comparing what a case actually produced against what it declared, and proving
 * the case can fail.
 *
 * `applyDiscriminator` is the second half and the more important one: it undoes
 * the fix a case is meant to cover and asserts the case then fails. A green
 * eval suite where every case would pass without the fix is a suite that
 * measures nothing, which is what `--verify-discriminating` refuses.
 *
 * `runCompare` is the `--compare` entry point: it reduces the older indicator
 * reports through `compareEvalReports`, and a pair of stochastic class results
 * (R8) through their provenance — refusing two different classes. It lives here
 * rather than in `run.mjs` because `run.mjs` is at the file ceiling and this is
 * the one module that already owns "compare these two things".
 */
import { gitHead, runRefName } from "../src/repo/worktree.mjs";
import { attemptWorktreePath, candidateWorktreePath, runsRoot } from "../src/run/paths.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readIntegrationJournal } from "../src/repo/integrate.mjs";
import { compareEvalReports, renderEvalComparisonReport } from "./metrics.mjs";
import { usageError } from "./paths.mjs";

/**
 * @param {string} nodeId
 * @param {Record<string, unknown>} expectedNode
 * @param {string} runDir
 * @returns {string[]}
 */
export function compareNode(nodeId, expectedNode, runDir) {
  /** @type {string[]} */
  const failures = [];
  const statePath = join(runDir, "nodes", `${nodeId}.json`);
  if (!existsSync(statePath)) {
    failures.push(`node ${nodeId}: state file is missing at ${statePath}`);
    return failures;
  }
  const actual = JSON.parse(readFileSync(statePath, "utf8"));

  if (expectedNode.status !== undefined && actual.status !== expectedNode.status) {
    failures.push(`node ${nodeId}.status: expected ${JSON.stringify(expectedNode.status)}, got ${JSON.stringify(actual.status)}`);
  }
  if (expectedNode.errorCode !== undefined) {
    const errorCode = actual.error?.code ?? null;
    if (errorCode !== expectedNode.errorCode) {
      failures.push(`node ${nodeId}.errorCode: expected ${JSON.stringify(expectedNode.errorCode)}, got ${JSON.stringify(errorCode)}`);
    }
  }
  if (expectedNode.revisions !== undefined) {
    const revisions = actual.revisions ?? 0;
    if (revisions !== expectedNode.revisions) {
      failures.push(`node ${nodeId}.revisions: expected ${expectedNode.revisions}, got ${revisions}`);
    }
  }
  if (expectedNode.runtimeIds !== undefined) {
    const runtimeIds = (actual.invocations ?? []).map((/** @type {{runtimeId?: string|null}} */ invocation) => invocation.runtimeId);
    if (JSON.stringify(runtimeIds) !== JSON.stringify(expectedNode.runtimeIds)) {
      failures.push(`node ${nodeId}.runtimeIds: expected ${JSON.stringify(expectedNode.runtimeIds)}, got ${JSON.stringify(runtimeIds)}`);
    }
  }
  if (expectedNode.routingHistoryLength !== undefined) {
    const length = (actual.routing?.history ?? []).length;
    if (length !== expectedNode.routingHistoryLength) {
      failures.push(`node ${nodeId}.routing.history length: expected ${expectedNode.routingHistoryLength}, got ${length}`);
    }
  }
  if (expectedNode.integratedHead !== undefined) {
    const integratedHead = actual.integratedHead ?? null;
    if (expectedNode.integratedHead === true && typeof integratedHead !== "string") {
      failures.push(`node ${nodeId}.integratedHead: expected a published sha, got ${JSON.stringify(integratedHead)}`);
    } else if (expectedNode.integratedHead === false && integratedHead !== null) {
      failures.push(`node ${nodeId}.integratedHead: expected null, got ${JSON.stringify(integratedHead)}`);
    } else if (typeof expectedNode.integratedHead === "string" && integratedHead !== expectedNode.integratedHead) {
      failures.push(`node ${nodeId}.integratedHead: expected ${JSON.stringify(expectedNode.integratedHead)}, got ${JSON.stringify(integratedHead)}`);
    }
  }
  return failures;
}
/**
 * Compare a case's `preflight` expectation against the `preflight.json` a
 * `preflight` setup step wrote (see `executeStep`) — one static probe result
 * per reachable runtime, keyed by runtime id.
 *
 * @param {Record<string, unknown>} expectedPreflight
 * @param {string} workDir
 * @returns {string[]}
 */
export function comparePreflight(expectedPreflight, workDir) {
  const path = join(workDir, "preflight.json");
  if (!existsSync(path)) {
    return [`preflight: no preflight.json was written; the case needs a "preflight" setup step`];
  }
  const results = /** @type {{id: string|null, availability?: {available: boolean, exhaustedUntil: string|null, reason: string}}[]} */ (
    JSON.parse(readFileSync(path, "utf8"))
  );
  const byId = Object.fromEntries(results.map((entry) => [entry.id, entry]));
  /** @type {string[]} */
  const failures = [];
  for (const [runtimeId, expectedEntry] of Object.entries(expectedPreflight)) {
    const actualEntry = byId[runtimeId]?.availability ?? null;
    if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      failures.push(`preflight.${runtimeId}.availability: expected ${JSON.stringify(expectedEntry)}, got ${JSON.stringify(actualEntry)}`);
    }
  }
  return failures;
}
/**
 * Compare a case's `gc` expectation against the actual `.runs/` directory
 * listing and `.runs/gc.jsonl` after every `setup` step has run — the disk-
 * pressure garbage collector (`disk-gc.mjs`) has no node snapshot of its own
 * to read, since it can span (and remove) run directories no single node
 * belongs to.
 *
 * @param {{removed?: string[], kept?: string[], events?: {path: string, reason: string}[]}} expectedGc
 * @param {string} workDir
 * @returns {string[]}
 */
export function compareGc(expectedGc, workDir) {
  const runsDir = runsRoot(workDir);
  /** @type {string[]} */
  const failures = [];
  for (const id of expectedGc.removed ?? []) {
    if (existsSync(join(runsDir, id))) failures.push(`gc: expected ${id} to have been removed by garbage collection, but it still exists`);
  }
  for (const id of expectedGc.kept ?? []) {
    if (!existsSync(join(runsDir, id))) failures.push(`gc: expected ${id} to still exist, but it is gone`);
  }
  if (expectedGc.events !== undefined) {
    const gcLogPath = join(runsDir, "gc.jsonl");
    const events = existsSync(gcLogPath)
      ? readFileSync(gcLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    for (const expectedEvent of expectedGc.events) {
      const match = events.some((event) => typeof event.path === "string" && event.path.endsWith(expectedEvent.path) && event.reason === expectedEvent.reason);
      if (!match) failures.push(`gc.events: no gc.jsonl event matching ${JSON.stringify(expectedEvent)} (got ${JSON.stringify(events)})`);
    }
  }
  return failures;
}
/**
 * Facts about integration recovery that live outside any single node's
 * snapshot: the run ref, the integration journal, and worktree cleanup.
 *
 * @param {Record<string, unknown>|undefined} expectedIntegration
 * @param {{repo: string, runDir: string, runId: string}} context
 * @returns {string[]}
 */
export function compareIntegration(expectedIntegration, { repo, runDir, runId }) {
  if (!expectedIntegration) return [];
  /** @type {string[]} */
  const failures = [];

  for (const nodeId of /** @type {string[]} */ (expectedIntegration.runRefMatchesIntegratedHead ?? [])) {
    const statePath = join(runDir, "nodes", `${nodeId}.json`);
    if (!existsSync(statePath)) {
      failures.push(`integration.runRefMatchesIntegratedHead: node ${nodeId} has no state file`);
      continue;
    }
    const actual = JSON.parse(readFileSync(statePath, "utf8"));
    const runRef = gitHead(repo, runRefName(runId));
    if (!runRef) {
      failures.push(`integration.runRefMatchesIntegratedHead: run ref ${runRefName(runId)} does not exist`);
      continue;
    }
    if (!actual.integratedHead) {
      failures.push(`integration.runRefMatchesIntegratedHead: node ${nodeId}.integratedHead is not set`);
      continue;
    }
    if (runRef !== actual.integratedHead) {
      failures.push(`integration.runRefMatchesIntegratedHead: run ref ${runRef} does not match node ${nodeId}.integratedHead ${actual.integratedHead}`);
    }
  }

  const journal = readIntegrationJournal(runDir);
  for (const record of /** @type {{node: string, attempt: number}[]} */ (expectedIntegration.acceptedRecords ?? [])) {
    const found = journal.some((entry) => entry.node === record.node && entry.attempt === record.attempt && entry.status === "accepted");
    if (!found) failures.push(`integration.acceptedRecords: no accepted record for node ${record.node} attempt ${record.attempt}`);
  }

  const worktreesAbsent = /** @type {{attempts?: {node: string, attempt: number}[], candidate?: boolean}|undefined} */ (expectedIntegration.worktreesAbsent);
  if (worktreesAbsent) {
    for (const attempt of worktreesAbsent.attempts ?? []) {
      const path = attemptWorktreePath(runDir, runId, attempt.node, attempt.attempt);
      if (existsSync(path)) failures.push(`integration.worktreesAbsent: attempt worktree still exists at ${path}`);
    }
    if (worktreesAbsent.candidate) {
      const path = candidateWorktreePath(runDir, runId);
      if (existsSync(path)) failures.push(`integration.worktreesAbsent: candidate worktree still exists at ${path}`);
    }
  }

  return failures;
}
/**
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, unknown>[]}
 */
export function normalizedSteps(spec) {
  return Array.isArray(spec.setup) && spec.setup.length ? spec.setup : [{ type: "run" }];
}
/**
 * A discriminator names one mutation that must make its case fail. Step
 * removal is applied to the normalized step list; the other mutation types
 * are applied to a case's contract or a recording only in memory, once
 * materialized into a fresh temporary workspace — never to a file on disk, so
 * a discriminator can never touch a versioned fixture.
 *
 * @param {Record<string, unknown>} spec
 * @param {Record<string, unknown>|undefined} discriminator
 * @returns {{steps: Record<string, unknown>[], contractPatch: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}}
 */
export function applyDiscriminator(spec, discriminator) {
  const caseId = /** @type {string} */ (spec.id);
  const steps = normalizedSteps(spec);
  if (!discriminator || typeof discriminator !== "object") throw new Error(`case ${caseId} has no discriminator block`);

  if (discriminator.type === "removeSetupStep") {
    const indices = new Set(/** @type {number[]} */ (discriminator.indices ?? []));
    if (!indices.size) throw new Error(`discriminator "removeSetupStep" needs a non-empty "indices" array`);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        throw new Error(`discriminator "removeSetupStep" index ${index} is out of range for ${steps.length} step(s)`);
      }
    }
    const remaining = steps.filter((_, index) => !indices.has(index));
    // A mutation that erases every step that actually invokes the runner
    // makes the case fail because nothing ran at all, not because of
    // whatever the case claims to prove — that passes --verify-discriminating
    // for a trivial reason instead of a real one.
    const hadExecutingStep = steps.some((step) => step.type === "run" || step.type === "resume");
    const stillHasExecutingStep = remaining.some((step) => step.type === "run" || step.type === "resume");
    if (hadExecutingStep && !stillHasExecutingStep) {
      throw new Error(`case ${caseId}: discriminator "removeSetupStep" removes every "run"/"resume" step, leaving nothing to execute — pick a mutation that isolates what the case actually proves`);
    }
    return { steps: remaining, contractPatch: null, recordingPatch: null };
  }

  if (discriminator.type === "patchContractField") {
    const path = /** @type {(string|number)[]} */ (discriminator.path);
    if (!Array.isArray(path) || path.length === 0) throw new Error(`discriminator "patchContractField" needs a non-empty "path" array`);
    const remove = discriminator.remove === true;
    if (!remove && !("value" in discriminator)) throw new Error(`discriminator "patchContractField" needs a "value" (or "remove": true)`);
    return { steps, contractPatch: { path, value: discriminator.value, remove }, recordingPatch: null };
  }

  if (discriminator.type === "patchRecordingErrorCode") {
    const runtime = discriminator.runtime;
    const code = discriminator.code;
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingErrorCode" needs a "runtime"`);
    if (typeof code !== "string" || !code) throw new Error(`discriminator "patchRecordingErrorCode" needs a "code"`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { steps, contractPatch: null, recordingPatch: { runtime, index, code } };
  }

  if (discriminator.type === "patchRecordingEnvelopeField") {
    const runtime = discriminator.runtime;
    const path = /** @type {(string|number)[]} */ (discriminator.path);
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "runtime"`);
    if (!Array.isArray(path) || path.length === 0) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a non-empty "path" array`);
    const remove = discriminator.remove === true;
    if (!remove && !("value" in discriminator)) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "value" (or "remove": true)`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { steps, contractPatch: null, recordingPatch: { runtime, index, path, value: discriminator.value, remove } };
  }

  throw new Error(`unknown discriminator type: ${discriminator.type}`);
}

/**
 * Whether a parsed JSON document is a stochastic class result: it names its
 * class at the top level and carries the provenance block R8 requires. A bare
 * indicator report (`--project`) names no class and stays on the older
 * comparison path.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStochasticResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.class === "string" && Boolean(record.provenance) && typeof record.provenance === "object";
}

/**
 * Compare two stochastic class results. A same-class pair is accepted and
 * reduced to the provenance fields both sides carry; a pair of different
 * classes is refused, because a `paired` result and a `judge-canary` result
 * measure different quantities and their numbers are not comparable.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @returns {{schemaVersion: number, class: string, before: Record<string, unknown>, after: Record<string, unknown>, deltas: Record<string, number|null>, armBands?: {before: Record<string, unknown>, after: Record<string, unknown>}, hypotheses?: {before: unknown, after: unknown}}}
 */
export function compareStochasticResults(before, after) {
  if (!isStochasticResult(before) || !isStochasticResult(after)) {
    throw new Error("--compare needs two stochastic class results");
  }
  const beforeClass = String(/** @type {Record<string, unknown>} */ (before).class);
  const afterClass = String(/** @type {Record<string, unknown>} */ (after).class);
  if (beforeClass !== afterClass) {
    throw new Error(`--compare refuses a ${beforeClass} result beside a ${afterClass} result: different classes`);
  }
  const beforeProvenance = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (before).provenance);
  const afterProvenance = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (after).provenance);
  if (beforeClass === "paired") {
    for (const field of ["corpusHash", "armsFileHash"]) {
      if (beforeProvenance[field] !== afterProvenance[field]) {
        throw new Error(`--compare refuses paired results with different ${field}`);
      }
    }
  }
  /** @type {Record<string, number|null>} */
  const deltas = {};
  for (const field of ["seed", "repeat", "budgetUsd", "pricedSpendUsd", "voidedSpendUsd"]) {
    const left = beforeProvenance[field];
    const right = afterProvenance[field];
    deltas[field] = typeof left === "number" && typeof right === "number" ? Math.round((right - left) * 10_000) / 10_000 : null;
  }
  const beforeResult = /** @type {any} */ (before);
  const afterResult = /** @type {any} */ (after);
  const comparison = /** @type {any} */ ({ schemaVersion: 1, class: beforeClass, before: beforeProvenance, after: afterProvenance, deltas });
  if (beforeClass === "paired") {
    comparison.armBands = {
      before: Object.fromEntries((/** @type {any[]} */ (beforeResult.arms ?? [])).map((/** @type {any} */ arm) => [arm.arm, arm.band])),
      after: Object.fromEntries((/** @type {any[]} */ (afterResult.arms ?? [])).map((/** @type {any} */ arm) => [arm.arm, arm.band])),
    };
    comparison.hypotheses = { before: beforeResult.hypotheses ?? null, after: afterResult.hypotheses ?? null };
  }
  return comparison;
}

/**
 * Render `--compare`'s stochastic comparison as text.
 *
 * @param {{class: string, before: Record<string, unknown>, after: Record<string, unknown>, deltas: Record<string, number|null>, armBands?: {before: Record<string, unknown>, after: Record<string, unknown>}, hypotheses?: {before: unknown, after: unknown}}} comparison
 * @returns {string}
 */
function renderStochasticComparison(comparison) {
  const lines = [`${comparison.class} compared with itself: before → after`];
  for (const [field, delta] of Object.entries(comparison.deltas)) {
    const left = comparison.before[field];
    const right = comparison.after[field];
    lines.push(`${field}: ${JSON.stringify(left)} → ${JSON.stringify(right)}${delta === null ? "" : ` (delta ${delta})`}`);
  }
  if (comparison.armBands) {
    lines.push("arm bands:");
    for (const arm of Object.keys(comparison.armBands.before)) {
      lines.push(`${arm}: ${JSON.stringify(comparison.armBands.before[arm])} → ${JSON.stringify(comparison.armBands.after[arm] ?? null)}`);
    }
  }
  if (comparison.hypotheses) lines.push(`hypotheses: ${JSON.stringify(comparison.hypotheses)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * A report file on disk is either a bare indicator map (the `EvalReport`
 * shape `projectEvalIndicators` returns) or that same map wrapped with a
 * `provenance` block (what `--project` writes and what `evals/baseline.json`
 * and `evals/fixtures/*.json` carry). Either way, `compareEvalReports` only
 * ever wants the indicator map.
 *
 * @param {unknown} parsed
 * @returns {Record<string, unknown>}
 */
function evalIndicatorsOf(parsed) {
  const object = /** @type {Record<string, unknown>} */ (parsed);
  return object && typeof object.indicators === "object" && object.indicators !== null ? /** @type {Record<string, unknown>} */ (object.indicators) : object;
}

/**
 * `evals/run.mjs --compare <before.json> <after.json> [--json]`: compare two
 * already-projected eval reports and print the result, or two stochastic class
 * results by their provenance — and refuse a pair of different classes.
 *
 * @param {string[]} rest
 * @returns {void}
 */
export function runCompare(rest) {
  const asJson = rest.includes("--json");
  const bandIndex = rest.indexOf("--band");
  const bandPath = bandIndex >= 0 ? rest[bandIndex + 1] : undefined;
  if (bandIndex >= 0 && (bandPath === undefined || bandPath.startsWith("--"))) {
    usageError("--band needs the path of a report written by `--band <report.json>...`");
    return;
  }
  const positionals = rest.filter((arg, index) => arg !== "--json" && (bandIndex < 0 || (index !== bandIndex && index !== bandIndex + 1)));
  if (positionals.length !== 2) {
    usageError("--compare needs exactly two report paths: <before.json> <after.json>");
    return;
  }
  const [beforePath, afterPath] = positionals;
  const beforeParsed = JSON.parse(readFileSync(resolve(beforePath), "utf8"));
  const afterParsed = JSON.parse(readFileSync(resolve(afterPath), "utf8"));
  // A paired or judge-canary result carries its class and provenance; two of
  // those are compared by that provenance, and a pair of different classes is
  // refused rather than folded into the indicator diff.
  if (isStochasticResult(beforeParsed) || isStochasticResult(afterParsed)) {
    let comparison;
    try {
      comparison = compareStochasticResults(beforeParsed, afterParsed);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
      return;
    }
    process.stdout.write(asJson ? `${JSON.stringify(comparison, null, 2)}\n` : renderStochasticComparison(comparison));
    return;
  }
  const before = evalIndicatorsOf(beforeParsed);
  const after = evalIndicatorsOf(afterParsed);
  const bands = bandPath === undefined ? undefined : evalIndicatorsOf(JSON.parse(readFileSync(resolve(bandPath), "utf8")));
  const comparison = compareEvalReports(before, after, bands);
  process.stdout.write(asJson ? `${JSON.stringify({ schemaVersion: 1, indicators: comparison }, null, 2)}\n` : renderEvalComparisonReport(comparison));
}
