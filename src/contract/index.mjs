import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadTaskPacket, renderWorkerPrompt } from "./task-packet.mjs";
import { RESERVED_ARTICLES } from "./articles.mjs";
import { judgmentReasonWarnings, unquotedFilterValueWarnings, validateDefinitionOfDone } from "./definition-of-done.mjs";
import { validateFinalVerification, validateSharedVerification } from "./final-verification.mjs";
import { VERIFICATION_LIMITS, requirementProofWarnings } from "./verification.mjs";
import {
  validateCapabilityRequirements,
} from "../harnesses/index.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../engine/runtime-discovery.mjs";
import { stableJson } from "../util.mjs";
import { assertObject, boundedString, nonNegativeInteger, nonNegativeNumber, positiveInteger, positiveNumber, rejectUnknown, requireId, requireString } from "./assert.mjs";
import { validateMetadata } from "./schema-version.mjs";
import { assertRuntimeExecutesCommands, judgeWriteWarnings, requireRuntime, validateRuntime } from "./runtime.mjs";
import { validateJudgeList } from "./judges.mjs";
import { validateSourceIdentity } from "../repo/source-identity.mjs";
import { commandCoverageWarnings, ignoreSourceWriteWarnings, mirrorCoverageWarnings, unsnapshottedWriteWarnings } from "../repo/declared-paths.mjs";
import { crossNodeScopeFindings, scopeClosureFindings } from "../repo/scope-closure.mjs";

export { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../harnesses/index.mjs";

// Mirrors test/repo/source-shape.test.mjs's LINE_CEILING; that test refuses a
// file over it, at commit time. The margin is 100 lines: measured against
// this tree (`find src -name '*.mjs' | xargs wc -l`, 2026-09-18), it is the
// smallest round number that would have flagged both write targets a real
// node overran -- 783 and 749 lines, both later landing at 801 -- while
// catching only about 8 of this tree's ~230 modules today, so the warning
// stays rare enough to read instead of becoming routine noise.
const WRITE_FILE_LINE_CEILING = 800;
const WRITE_FILE_LINE_WARN_MARGIN = 100;

const CONTRACT_FIELDS = new Set([
  "schemaVersion", "contractVersion", "id", "campaignId", "goal", "cwd", "sourceIdentity",
  "maxParallel", "pollIntervalMs", "stallTimeoutSec", "timeoutSec", "maxTurns", "phaseSessionReuse",
  "runtimeDefaults", "runtimes", "nodes", "warnings", "finalVerification", "sharedVerification", "nodeAdvisory", "judges",
]);
const DEFAULTS_FIELDS = new Set(["worker", "judge"]);
const NODE_FIELDS = new Set([
  "id", "type", "phase", "requirementIds", "runtime", "dependsOn", "taskPacket", "taskPacketFile", "prompt", "promptFile",
  "definitionOfDone", "gate", "timeoutSec", "maxTurns",
  "requiredCapabilities", "packetHash", "sourceIdentity", "replayPolicy",
]);
const REPLAY_POLICIES = new Set(["safe", "reconcile", "never"]);
/**
 * Provider requests one attempt may make before the controller ends it, when
 * neither the contract nor the node says otherwise. measured 2026-09-20 over
 * 200 completed claude worker turns: p90 83, p95 96, p99 122, max 339; the 23
 * turns that never produced a result held 25% of all context spend, and six
 * of them ran past 150 (180 to 600 requests). One completed turn would have
 * been cut and retried once.
 */
export const DEFAULT_MAX_TURNS = 150;
const GATE_FIELDS = new Set(["enabled", "runtime", "review", "failOn", "maxRevisions", "requiredCapabilities", "skipWhen"]);
const GATE_REVIEWS = new Set(["none", "advisory", "blocking"]);

/** @typedef {Record<string, unknown>} JsonObject */

/** @typedef {{structuredOutput?: boolean, promptTransport?: "stdin"|"argv", sandbox?: boolean, permissions?: boolean, continuation?: boolean, tokenBudget?: boolean, costBudget?: boolean, usage?: boolean, cost?: boolean}} CapabilityRequirements */

/** @typedef {{kind: string, id?: string, campaignId?: string, contractId?: string, nodeId?: string, cwd?: string, gitHead?: string|null, dirtyTreeFingerprint?: string|null, packetHashes?: Record<string, string>, harnessVersions?: Record<string, string|null>, baseRef?: string|null}} SourceIdentity */

/** @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[]}} VerificationCommand */

/** @typedef {{mode: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], readFiles: string[], writeFiles?: string[], writeRoots?: string[], symbols: string[], scopeAcknowledged?: string[], decisions: string[], nonGoals: string[], verification: VerificationCommand[]}} TaskPacket */

/** @typedef {{harness: "claude"|"codex"|"agy"|"dsh"|"zcode"|"exec-jsonl"|"replay", model: string, reasoning?: string, sandbox?: "read-only"|"workspace-write"|"danger-full-access", permissionMode?: string, config?: Record<string, unknown>, printTimeout?: string, tools?: string[], executable?: string, args?: string[], versionArgs?: string[], maxArgvPromptBytes?: number, requiredCapabilities?: CapabilityRequirements, costRank?: number, fallback?: string, vendor: string, tier?: number|string, stallTimeoutSec?: number, maxConcurrent?: number}} ValidatedRuntime */

/** @typedef {{enabled: boolean, review?: ("none"|"advisory"|"blocking"), runtime?: string, failOn?: ("minor"|"major"|"critical")[], maxRevisions?: number, requiredCapabilities?: CapabilityRequirements, skipWhen?: {verificationGreen: true, maxChangedPaths: number}}} ValidatedGate */

/** @typedef {{id: string, type: string, phase: string, requirementIds?: string[], runtime?: string, dependsOn: string[], taskPacket: TaskPacket, taskPacketFile?: string, prompt: string, definitionOfDone: import("./definition-of-done.mjs").DefinitionOfDoneItem[], gate: ValidatedGate, timeoutSec?: number, maxTurns?: number, requiredCapabilities: CapabilityRequirements, packetHash: string, sourceIdentity: SourceIdentity, replayPolicy: "safe"|"reconcile"|"never"}} ValidatedNode */

/** @typedef {{schemaVersion: number, contractVersion: string, id: string, campaignId: string, goal: string, cwd: string, sourceIdentity: SourceIdentity, runtimes: Record<string, ValidatedRuntime>, runtimeDefaults: {worker?: string, judge?: string}, judges?: string[], nodes: ValidatedNode[], maxParallel: number, pollIntervalMs: number, stallTimeoutSec: number, timeoutSec: number, maxTurns: number, phaseSessionReuse: boolean, finalVerification?: VerificationCommand[], sharedVerification?: VerificationCommand[], nodeAdvisory?: NodeAdvisoryPolicy, warnings: string[]}} ValidatedContract */
/** @typedef {{costUsd?: number, durationSec?: number}} NodeAdvisoryPolicy */

/** @typedef {"pending"|"running"|"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"} NodeStatus */
/** @typedef {"waiting"|"worker"|"judge"|"complete"|"dependency"|"canceled"} NodePhase */
/** @typedef {{severity: "minor"|"major"|"critical", description: string, evidence: string}} Finding */
/** @typedef {{verdict: "pass"|"fail"|"invalid_judge_output", maxSeverity: "none"|"minor"|"major"|"critical", summary: string, findings: Finding[]}} GateResult */
/** @typedef {{code: string, message: string, exhaustedUntil?: string|null}} SnapshotError */
/** @typedef {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} Usage */
/** @typedef {ValidatedRuntime & {id: string, capabilities: import("../harnesses/index.mjs").HarnessCapabilities}} RuntimeSnapshot */
/** @typedef {import("../engine/lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./verification.mjs").VerificationCommandResult} VerificationCommandResult */
/** @typedef {import("./verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {{passed: boolean, commands?: VerificationCommandResult[], completed?: boolean, error?: string, attempts?: VerificationAttempt[]}} VerificationState */
/** @typedef {{kind: "recovery"|"timeout"|"rotation", decision?: string, invocationId?: string, phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, reason?: string, timeoutSec?: number, at?: string}} ExecutionOverride */
/** @typedef {{literal: string, paths: string[]}} WorkspaceScopeOrigin */
/** @typedef {{schemaVersion: 1, files: string[], roots: string[], fileRoots?: string[], fileOrigins: WorkspaceScopeOrigin[], rootOrigins: WorkspaceScopeOrigin[]}} WorkspaceScopeBoundary */
/** @typedef {{changedPaths: string[], unexpectedPaths: string[], changedPathCount: number, unexpectedPathCount: number, truncated: boolean, boundary?: WorkspaceScopeBoundary}} BoundedScope */
/** @typedef {{unexpectedPaths: string[]}} ScopeFindings */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, status?: NodeStatus, errorCode?: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null, costProvenance?: "priced"}} RoutingHistoryEntry */
/** @typedef {{at: string, role: "worker"|"judge", runtime: string, nextRuntime?: string, rule?: number, ruleIndex?: number, revision?: number, hop?: number, reason: string, backoffSec?: number, backoffUntil?: string, usage?: Usage, costUsd?: number|null, costProvenance?: "priced"}} RoutingOverride */
/** @typedef {{worker: string, judge: string, composedWorker?: boolean, composedJudge?: boolean}} RuntimeAssignments */
/** @typedef {{available: boolean, exhaustedUntil: string|null, reason: string}} RuntimeAvailability */
/** @typedef {{runtimeId: string, exhaustedUntil: string|null}} TierExhaustionCandidate */
/** @typedef {{role: "worker"|"judge", candidates: TierExhaustionCandidate[]}} TierExhaustion */
/** @typedef {{id: string, reason: string}} JudgeSkip */
/** @typedef {{list: string[], chosen: string|null, skipped: JudgeSkip[]}} JudgeListState */
/** @typedef {{history: RoutingHistoryEntry[], currentOverride: RoutingOverride|null, assignments?: RuntimeAssignments, availability?: Record<string, RuntimeAvailability>, tierExhaustion?: TierExhaustion, tierExhaustionCycle?: number, judgeList?: JudgeListState}} RoutingState */
/** @typedef {{revision?: number, heartbeatCount: number, dryHeartbeatCount: number, progressSignature?: string|null, lastHeartbeatAt: string|null, lastProgressAt: string|null, nextCheckAt?: string|null}} ProgressState */
/** @typedef {{status: "unassigned"|"provisioning"|"ready"|"failed"|"removed", path: string|null, branch: string|null, commit: string|null, baseSha?: string|null, sealedSha?: string|null, sealError?: string|null, previousAttempt?: number|null}} WorktreeState */
/** @typedef {{schemaVersion: number, contractVersion: string, id: string, type: string, sourceIdentity: SourceIdentity, packetHash: string, requirementIds?: string[], status: NodeStatus, phase: NodePhase, attempt: number, revisions: number, judgeFailures?: number, review?: ("none"|"advisory"|"blocking"), runtime: RuntimeSnapshot|null, blockedBy: string[], startedAt: string|null, updatedAt: string, result: unknown, gate: GateResult|null, error: SnapshotError|null, usage?: Usage, costUsd?: number, routing?: RoutingState|null, progress?: ProgressState|null, worktree?: WorktreeState|null, integratedHead?: string|null, invocations?: Invocation[], executionOverrides?: ExecutionOverride[], verification?: VerificationState|null, scope?: BoundedScope|null, scopeFindings?: ScopeFindings|null, verificationArtifacts?: string[], previousAttempt?: string, sessionPolicy?: {forceFresh?: boolean}|null, declaredReadBytes?: number|null}} NodeSnapshot */
/** @typedef {{path: string, sha: string}} ControllerIdentity */
/** @typedef {{schemaVersion: number, contractVersion: string, pid: number, processStartToken: string|null, startedAt: string, sourceIdentity: SourceIdentity, controllerIdentity?: ControllerIdentity, integrationRef?: string, identityWarnings?: string[], relaunchCount?: number, lastRelaunchProgressAt?: string|null, attention?: {code: string, message: string, at: string}|null, contractDigest?: string, scopeDecision?: ScopeDecision, autoRetries?: Record<string, {code: string, at: string}>}} RunMetadata */
/** @typedef {{at: string, base: string|null, dirtyTreeFingerprint: string|null}} ScopeDecision */
/** @typedef {{schemaVersion: number, contractVersion: string, at: string, node: string, from?: string, to: string, type?: string, phase?: string, attempt?: number, role?: "worker"|"judge", status?: NodeStatus, runtime?: string, currentRuntime?: string, errorCode?: string, error?: SnapshotError, verdict?: string, summary?: string, revisions?: number, requirementIds?: string[], sourceIdentity: SourceIdentity, packetHash: string, override?: unknown, recovery?: unknown, invocationId?: string, unexpectedPaths?: string[], unexpectedPathCount?: number}} EventRecord */

/**
 * Validate and canonicalize the versioned contract. Runtime JSON remains
 * authoritative; JSDoc types document the validated shape only.
 *
 * `persisted` is the frozen-replay path: the contract was already validated at
 * run creation, so every tree-dependent decision (the cwd directory, readFiles
 * and writeRoots existence and anchors, realpath and symlink checks,
 * verification cwds, scope closure, ignore probes) is skipped. A persisted
 * load touches no filesystem at all; it differs from authoring only in what it
 * refuses to re-derive from the mutated tree.
 *
 * @param {JsonObject} raw
 * @param {string} contractPath
 * @param {{persisted?: boolean, contractDigest?: string}} [options]
 * @returns {ValidatedContract}
 */
export function validateContract(raw, contractPath, options = {}) {
  const persisted = options.persisted === true;
  assertObject(raw, "contract");
  rejectUnknown(raw, CONTRACT_FIELDS, "contract");
  validateMetadata(raw, "contract");
  requireId(raw.id, "contract.id");
  requireId(raw.campaignId, "contract.campaignId");
  requireString(raw.goal, "contract.goal");

  const contractDir = dirname(resolve(contractPath));
  const cwd = resolve(contractDir, typeof raw.cwd === "string" ? raw.cwd : ".");
  if (!persisted && !statSync(cwd).isDirectory()) throw new TypeError("contract.cwd must be a directory");

  const sourceIdentity = validateSourceIdentity(
    raw.sourceIdentity ?? { kind: "contract", id: raw.id, campaignId: raw.campaignId },
    "contract.sourceIdentity",
    { kind: "contract", id: raw.id, campaignId: raw.campaignId },
  );

  const rawRuntimes = /** @type {Record<string, JsonObject>} */ (raw.runtimes ?? DISCOVERY_RUNTIME_DEFINITIONS);
  if (!rawRuntimes || typeof rawRuntimes !== "object" || Array.isArray(rawRuntimes)) {
    throw new TypeError("contract.runtimes must be an object");
  }
  const runtimes = /** @type {Record<string, ValidatedRuntime>} */ ({});
  for (const [id, runtime] of Object.entries(rawRuntimes)) runtimes[id] = validateRuntime(id, runtime);
  // A runtime's fallback is validated against sibling runtimes once every
  // runtime is known, so declaration order never matters.
  for (const [id, runtime] of Object.entries(runtimes)) {
    if (runtime.fallback === undefined) continue;
    if (runtime.fallback === id) throw new TypeError(`runtime ${id}.fallback cannot name itself`);
    requireRuntime(runtimes, runtime.fallback, `runtime ${id}.fallback`);
  }

  const defaults = /** @type {JsonObject} */ (raw.runtimeDefaults ?? {});
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new TypeError("contract.runtimeDefaults must be an object when provided");
  }
  rejectUnknown(defaults, DEFAULTS_FIELDS, "contract.runtimeDefaults");
  if (defaults.worker !== undefined) requireRuntime(runtimes, defaults.worker, "runtimeDefaults.worker");
  if (defaults.judge !== undefined) requireRuntime(runtimes, defaults.judge, "runtimeDefaults.judge");
  const judges = validateJudgeList(raw.judges, runtimes, "contract.judges");

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new TypeError("contract.nodes must be a non-empty array");
  }
  const rawNodes = /** @type {JsonObject[]} */ (raw.nodes);
  const ids = new Set();
  /** @type {{path: string, label: string, kind: "read"|"acknowledged"}[][]} */
  const deferredReadsByNode = [];
  const nodes = rawNodes.map((node, index) => {
    assertObject(node, `nodes[${index}]`);
    rejectUnknown(node, NODE_FIELDS, `nodes[${index}]`);
    if (node.prompt !== undefined || node.promptFile !== undefined) {
      throw new TypeError(`nodes[${index}] must not use prompt or promptFile; provide exactly one of taskPacket or taskPacketFile`);
    }
    requireId(node.id, `nodes[${index}].id`);
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    requireString(node.type, `nodes[${index}].type`);
    boundedString(node.phase, `nodes[${index}].phase`, 128);
    // A node's requirementIds are inherited from its phase at freeze time
    // (src/plan/freeze.mjs stamps them) and are optional on read: a contract
    // without the field loads unchanged, which is what keeps CONTRACT_VERSION
    // at 0.3.0 while requirement ids reach the node.
    const requirementIds = node.requirementIds;
    if (requirementIds !== undefined) {
      if (!Array.isArray(requirementIds) || requirementIds.length > 64) {
        throw new TypeError(`nodes[${index}].requirementIds must be an array of at most 64 requirement ids`);
      }
      requirementIds.forEach((id, position) => boundedString(id, `nodes[${index}].requirementIds[${position}]`, 128));
    }
    if (node.runtime !== undefined) requireRuntime(runtimes, node.runtime, `nodes[${index}].runtime`);
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
      throw new TypeError(`nodes[${index}].dependsOn must be an array of ids`);
    }
    // A readFiles -- or scopeAcknowledged -- entry that names a file no
    // dependency has produced yet is a missing path today, but the graph is not
    // known until every node is loaded. Collect the candidate here; the second
    // pass below resolves each against the node's transitive closure once all
    // packets and dependsOn edges are in hand.
    /** @type {{path: string, label: string, kind: "read"|"acknowledged"}[]} */
    const deferredReads = [];
    const taskPacket = loadTaskPacket(node, contractDir, cwd, index, { deferMissingReads: true, deferredReads, persisted });
    deferredReadsByNode.push(deferredReads);
    // The reserved articles are the common law: a contract adds its own as
    // references/local-*.md and may never claim a reserved name, at any
    // directory depth, or a run could overwrite the constitution mid-flight.
    const reservedClaim = reservedArticleClaim(taskPacket);
    if (reservedClaim !== undefined) {
      throw new TypeError(`nodes[${index}] (${node.id}): ${reservedClaim} is a reserved article; declare contract articles as references/local-*.md`);
    }
    const prompt = renderWorkerPrompt(taskPacket, /** @type {string} */ (node.id));
    const packetHash = hashPacket(taskPacket);
    if (node.packetHash !== undefined && node.packetHash !== packetHash) {
      throw new TypeError(`nodes[${index}].packetHash does not match taskPacket`);
    }
    const source = validateSourceIdentity(
      node.sourceIdentity ?? { kind: "node", contractId: raw.id, nodeId: node.id },
      `nodes[${index}].sourceIdentity`,
      { kind: "node", contractId: raw.id, nodeId: node.id },
    );
    const definitionOfDone = validateDefinitionOfDone(
      node.definitionOfDone ?? [],
      `nodes[${index}].definitionOfDone`,
      {
        // A `verification` proof names an entry of this packet's verification
        // array by position and reuses its recorded result at gate time; an
        // entry the node snapshot cannot record could never be reused.
        verificationCount: taskPacket.verification.length,
        recordableCount: VERIFICATION_LIMITS.stateCommands,
      },
    );
    const requiredCapabilities = validateCapabilityRequirements(
      /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (node.requiredCapabilities),
      `nodes[${index}].requiredCapabilities`,
    );
    const gate = validateGate(node.gate, runtimes, index, /** @type {string} */ (node.id));
    const timeoutSec = node.timeoutSec === undefined
      ? undefined
      : positiveNumber(node.timeoutSec, `nodes[${index}].timeoutSec`);
    const maxTurns = node.maxTurns === undefined
      ? undefined
      : positiveInteger(node.maxTurns, `nodes[${index}].maxTurns`);
    const replayPolicy = validateReplayPolicy(node.replayPolicy, `nodes[${index}]`);
    return /** @type {ValidatedNode} */ ({
      ...node,
      dependsOn,
      definitionOfDone,
      requiredCapabilities,
      taskPacket,
      packetHash,
      sourceIdentity: source,
      prompt,
      gate,
      timeoutSec,
      maxTurns,
      replayPolicy,
    });
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new TypeError(`${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new TypeError(`${node.id} cannot depend on itself`);
    }
  }
  assertAcyclic(nodes);

  // Second pass: a readFiles or scopeAcknowledged entry deferred at packet
  // load is accepted only when some transitive dependency produces it --
  // declares the identical path in its writeFiles, or the path sits under a
  // dependency's directory-shaped writeRoots entry (a file-shaped entry
  // authorizes exactly that path). Every other caller of validateTaskPacket
  // keeps rejecting the missing path inline; this graph-aware deferral is a
  // contract-loading capability only. Persisted loads never defer -- they
  // skipped the existence probe, so there is nothing to resolve and nothing to
  // stat.
  if (!persisted) {
    for (const [index, node] of nodes.entries()) {
      const deferredReads = deferredReadsByNode[index];
      if (deferredReads.length === 0) continue;
      const closure = transitiveDependencyClosure(node, nodes);
      for (const { path, label } of deferredReads) {
        if (!dependencyCoversPath(closure, path, cwd)) {
          throw new TypeError(`${label} does not exist: ${path}`);
        }
      }
    }
  }

  // A gated node whose worker and judge share a vendor cannot produce an
  // independent review — the same vendor grading its own output is not a
  // gate, so this is rejected outright rather than left to reach dispatch.
  // The worker's declared fallback chain is checked the same way, since it is
  // statically known which runtime a worker failover lands on; the symmetric
  // case — the judge's own fallback landing on the worker's vendor — depends
  // on which worker runtime actually ran and is refused at execution instead
  // (node.mjs, `judge_fallback_vendor_conflict`).
  for (const [index, node] of nodes.entries()) {
    if (!node.gate.enabled) continue;
    const workerRuntimeId = node.runtime ?? defaults.worker;
    const judgeRuntimeId = node.gate.runtime ?? defaults.judge;
    if (!workerRuntimeId || !judgeRuntimeId) continue;
    const workerVendor = runtimes[/** @type {string} */ (workerRuntimeId)].vendor;
    const judgeVendor = runtimes[/** @type {string} */ (judgeRuntimeId)].vendor;
    if (workerVendor === judgeVendor) {
      throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} and judge runtime ${judgeRuntimeId} share vendor ${workerVendor}`);
    }
    const seenFallbacks = new Set([/** @type {string} */ (workerRuntimeId)]);
    let fallbackId = runtimes[/** @type {string} */ (workerRuntimeId)].fallback;
    while (fallbackId !== undefined) {
      if (seenFallbacks.has(fallbackId)) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback chain cycles back to ${fallbackId}`);
      }
      seenFallbacks.add(fallbackId);
      const fallbackVendor = runtimes[fallbackId].vendor;
      if (fallbackVendor === judgeVendor) {
        throw new TypeError(`nodes[${index}] worker runtime ${workerRuntimeId} fallback runtime ${fallbackId} and judge runtime ${judgeRuntimeId} share vendor ${fallbackVendor}`);
      }
      fallbackId = runtimes[fallbackId].fallback;
    }
  }

  // Every worker prompt tells the worker to run its packet verification.
  // Refuse a statically known permission mode that makes that instruction
  // impossible, including every reachable worker fallback. Judges only review
  // captured results, so their permission mode is intentionally irrelevant.
  for (const [index, node] of nodes.entries()) {
    if (node.taskPacket.verification.length === 0) continue;
    const workerRuntimeId = node.runtime ?? defaults.worker;
    if (!workerRuntimeId) continue;
    assertRuntimeExecutesCommands(runtimes, /** @type {string} */ (workerRuntimeId), index, node.id, "worker runtime");
    const seenFallbacks = new Set([/** @type {string} */ (workerRuntimeId)]);
    let fallbackId = runtimes[/** @type {string} */ (workerRuntimeId)].fallback;
    while (fallbackId !== undefined && !seenFallbacks.has(fallbackId)) {
      seenFallbacks.add(fallbackId);
      assertRuntimeExecutesCommands(runtimes, fallbackId, index, node.id, "worker fallback runtime");
      fallbackId = runtimes[fallbackId].fallback;
    }
  }

  // Scope closure is a refusal, not a warning: the warnings below are for the
  // author's attention, but a file that must change with the write set and was
  // neither declared nor acknowledged makes the packet incomplete, and the
  // node would either break it or be structurally unable to touch it. The
  // three incidents this catches (p3 bulk-read, sp1 lossy-notify, sp2
  // seat-switch) each cost a node. This runs on every load, replay included: a
  // persisted packet is the same packet, and a scope gap does not heal because
  // it was recorded.
  //
  // The per-node detectors cannot see the pair that made seat-switch cost a
  // node: seat-lifecycle wrote the test, seat-switch wrote the module, and each
  // packet read alone is clean. `crossNodeScopeFindings` reads all nodes
  // together and names the node whose packet must gain the test.
  const scopeErrors = persisted ? [] : [
    ...nodes.flatMap((node, index) =>
      scopeClosureFindings(node, index, cwd).map(
        (finding) => `nodes[${index}] (${node.id}): ${finding.path} (${finding.detector}: ${finding.reason})`,
      ),
    ),
    ...crossNodeScopeFindings(nodes, cwd).map(
      (finding) => `nodes[${finding.nodeIndex}] (${finding.nodeId}): ${finding.path} (${finding.detector}: ${finding.reason})`,
    ),
  ];
  if (scopeErrors.length) {
    throw new TypeError(`task packet scope does not close; declare in readFiles or writeFiles, or acknowledge in scopeAcknowledged: ${scopeErrors.join("; ")}`);
  }

  // Validated here rather than inline below, because the mirror warning reads
  // them: a layer covered by a shared or final command is covered.
  const finalVerification = validateFinalVerification(raw.finalVerification, "contract.finalVerification");
  const sharedVerification = validateSharedVerification(raw.sharedVerification, "contract.sharedVerification");
  const contractCommands = [...finalVerification ?? [], ...sharedVerification ?? []].map((command) => command.argv.join(" "));
  const contractWrites = new Set(nodes.flatMap((node) => node.taskPacket.writeFiles ?? []));
  const warnings = [
    ...nodes.flatMap((node, index) => [
      ...commandCoverageWarnings(node, index),
      ...unquotedFilterValueWarnings(node.definitionOfDone ?? [], index),
      ...judgmentReasonWarnings(node.definitionOfDone ?? [], index),
      ...(persisted ? [] : mirrorCoverageWarnings(node, index, cwd, contractCommands, contractWrites)),
      ...(persisted ? [] : unsnapshottedWriteWarnings(node, index, cwd)),
      ...(persisted ? [] : ignoreSourceWriteWarnings(node, index)),
      ...(persisted ? [] : writeFileLineBudgetWarnings(node, index, cwd)),
    ]),
    ...judgeWriteWarnings(runtimes, defaults, nodes),
    // Cross-node by construction: a requirement proven in two nodes is only
    // visible when every node's commands are read together, which is the
    // whole point -- one copy repaired and six left behind is what a per-node
    // read cannot see.
    ...requirementProofWarnings([
      ...nodes.map((node, index) => ({ id: `nodes[${index}] (${node.id})`, requirementIds: node.requirementIds, commands: node.taskPacket.verification ?? [] })),
      { id: "contract.sharedVerification", commands: sharedVerification ?? [] },
      { id: "contract.finalVerification", commands: finalVerification ?? [] },
    ]),
  ];
  const contract = /** @type {ValidatedContract} */ ({
    ...raw,
    schemaVersion: /** @type {number} */ (raw.schemaVersion),
    contractVersion: /** @type {string} */ (raw.contractVersion),
    sourceIdentity,
    cwd,
    runtimes,
    runtimeDefaults: /** @type {{worker?: string, judge?: string}} */ (defaults),
    judges,
    nodes,
    maxParallel: validateMaxParallel(raw.maxParallel ?? 1),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs ?? 1_000, "contract.pollIntervalMs"),
    stallTimeoutSec: positiveNumber(raw.stallTimeoutSec ?? 300, "contract.stallTimeoutSec"),
    timeoutSec: positiveNumber(raw.timeoutSec ?? 2_400, "contract.timeoutSec"),
    maxTurns: positiveInteger(raw.maxTurns ?? DEFAULT_MAX_TURNS, "contract.maxTurns"),
    // Opt-in: a phase sibling's provider session is rotated (fresh session,
    // structured summaries carried) unless the contract asks to reuse it.
    // measured 2026-09-20 over 21 runs with both kinds of turn: a turn opened
    // on a sibling's session cost 1.87x the fresh one at the same request
    // count, because it began with 200k tokens of context instead of 45k and
    // re-read them on every request.
    phaseSessionReuse: booleanField(raw.phaseSessionReuse, false, "contract.phaseSessionReuse"),
    finalVerification,
    sharedVerification,
    nodeAdvisory: validateNodeAdvisory(raw.nodeAdvisory),
    warnings,
  });
  // The persisted load is a replay, not a re-authoring: it accepts only bytes
  // whose digest matches the decision frozen at launch. A changed DAG, gate,
  // runtime selection, timeout, definition of done, finalVerification or
  // sharedVerification leaves every packetHash untouched, so only this digest
  // refuses it.
  if (persisted && options.contractDigest !== undefined && contractDigest(raw) !== options.contractDigest) {
    throw new TypeError("persisted contract does not match the contractDigest recorded at run creation; the stored contract was modified after the run was created");
  }
  return contract;
}

/**
 * A persisted load: read the one contract.json the caller handed in, validate
 * it without touching the tree, and refuse it when its digest does not match
 * the decision frozen at launch. This is the only filesystem call the load
 * makes, which is what done-when 5 asserts structurally.
 *
 * @param {string} contractPath
 * @param {string|undefined} expectedDigest the `contractDigest` recorded in run.json
 * @returns {ValidatedContract}
 */
export function loadPersistedContract(contractPath, expectedDigest) {
  const raw = /** @type {JsonObject} */ (JSON.parse(readFileSync(contractPath, "utf8")));
  return validateContract(raw, contractPath, {
    persisted: true,
    ...(expectedDigest === undefined ? {} : { contractDigest: expectedDigest }),
  });
}

/**
 * Canonical digest of the contract that was actually validated, minus
 * `sourceIdentity` (which carries the absolute cwd, git head and fingerprint),
 * minus `warnings` (authoring-attention text, not contract content), and minus
 * the absolute `cwd`. The derived fields a stored contract.json drops --
 * `prompt`, `promptFile`, `taskPacketFile` -- are excluded too, so the digest a
 * load recomputes from the stored bytes matches the one computed at creation.
 *
 * @param {Record<string, unknown>|JsonObject} contract a validated contract or
 *   the stored raw contract it was serialized from
 * @returns {string}
 */
export function contractDigest(contract) {
  const record = /** @type {Record<string, unknown>} */ ({ ...contract });
  delete record.sourceIdentity;
  delete record.warnings;
  delete record.cwd;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  record.nodes = nodes.map((node) => {
    const copy = /** @type {Record<string, unknown>} */ ({ ...(/** @type {Record<string, unknown>} */ (node)) });
    delete copy.prompt;
    delete copy.promptFile;
    delete copy.taskPacketFile;
    return copy;
  });
  return createHash("sha256").update(stableJson(record)).digest("hex");
}

/**
 * Stable hash for the exact validated packet content.
 *
 * @param {TaskPacket} packet
 * @returns {string}
 */
export function hashPacket(packet) {
  return createHash("sha256").update(stableJson(packet)).digest("hex");
}

/**
 * @param {unknown} gate
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {number} index
 * @param {string} nodeId
 * @returns {ValidatedGate}
 */
function validateGate(gate, runtimes, index, nodeId) {
  const label = `nodes[${index}] (${nodeId})`;
  if (gate === false || gate === undefined) return { enabled: false };
  assertObject(gate, `nodes[${index}].gate`);
  rejectUnknown(gate, GATE_FIELDS, `nodes[${index}].gate`);
  if (gate.enabled === false) {
    // A disabled gate reviews nothing, but the node keeps its revision budget
    // for a red verification (default 1, as with a gate); that budget is the
    // one field the disabled shape may carry.
    if (Object.keys(gate).some((key) => key !== "enabled" && key !== "maxRevisions")) {
      throw new TypeError(`nodes[${index}].gate disabled shape only allows enabled and maxRevisions`);
    }
    return {
      enabled: false,
      ...(gate.maxRevisions === undefined ? {} : { maxRevisions: nonNegativeInteger(gate.maxRevisions, `nodes[${index}].gate.maxRevisions`) }),
    };
  }
  if (gate.enabled !== undefined && gate.enabled !== true) {
    throw new TypeError(`nodes[${index}].gate.enabled must be true or false`);
  }
  if (gate.review !== undefined && !GATE_REVIEWS.has(/** @type {string} */ (gate.review))) {
    throw new TypeError(`nodes[${index}].gate.review must be none, advisory, or blocking`);
  }
  const review = /** @type {("none"|"advisory"|"blocking")} */ (gate.review ?? "advisory");
  if (gate.runtime !== undefined) requireRuntime(runtimes, gate.runtime, `nodes[${index}].gate.runtime`);
  const failOnValue = /** @type {unknown} */ (gate.failOn ?? ["critical"]);
  if (!Array.isArray(failOnValue) || failOnValue.some((value) => !["minor", "major", "critical"].includes(value))) {
    throw new TypeError(`nodes[${index}].gate.failOn contains an invalid severity`);
  }
  const failOn = /** @type {("minor"|"major"|"critical")[]} */ (failOnValue);
  // The runner compares the verdict severity against this set by exact
  // membership, so `["major"]` admits a critical finding: the threshold set
  // has to be closed downwards (TECH-SPEC lean, rule 2).
  if (failOn.includes("major") && !failOn.includes("critical")) {
    throw new TypeError(`${label}: gate.failOn lists major without critical, and the gate checks exact membership, so a critical finding would pass (TECH-SPEC lean, rule 2)`);
  }
  // A blocking review that never fails on a major can never reject one, so it
  // is not a review at all. Advisory review ignores failOn and may declare any.
  if (review === "blocking" && !failOn.includes("major")) {
    throw new TypeError(`${label}: gate.review blocking requires major in gate.failOn (TECH-SPEC lean, rule 2)`);
  }
  return {
    enabled: true,
    review,
    runtime: /** @type {string|undefined} */ (gate.runtime),
    failOn,
    maxRevisions: nonNegativeInteger(gate.maxRevisions ?? 1, `nodes[${index}].gate.maxRevisions`),
    skipWhen: validateGateSkipWhen(gate.skipWhen, `nodes[${index}].gate.skipWhen`),
    requiredCapabilities: validateCapabilityRequirements(
      /** @type {import("../harnesses/index.mjs").CapabilityRequirements|undefined} */ (gate.requiredCapabilities),
      `nodes[${index}].gate.requiredCapabilities`,
    ),
  };
}

/**
 * The green-and-small escape hatch for the judge gate. Both conditions must
 * hold — controller verification green and no more changed workspace paths
 * than the declared ceiling — for `startJudge` to skip the judge even though a
 * Definition of Done item carries `judgment: true`. `verificationGreen` is
 * fixed at `true`: a skip rule keyed on red verification would be the opposite
 * of the intent.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {{verificationGreen: true, maxChangedPaths: number}|undefined}
 */
function validateGateSkipWhen(value, label) {
  if (value === undefined) return undefined;
  assertObject(value, label);
  rejectUnknown(value, new Set(["verificationGreen", "maxChangedPaths"]), label);
  if (value.verificationGreen !== true) throw new TypeError(`${label}.verificationGreen must be true`);
  return {
    verificationGreen: true,
    maxChangedPaths: nonNegativeInteger(value.maxChangedPaths, `${label}.maxChangedPaths`),
  };
}

/**
 * The contract-level advisory thresholds, in USD and seconds. Absent means no
 * per-node advisory is configured; the values are advisory only and never stop
 * a node.
 *
 * @param {unknown} value
 * @returns {NodeAdvisoryPolicy}
 */
function validateNodeAdvisory(value) {
  if (value === undefined) return {};
  assertObject(value, "contract.nodeAdvisory");
  rejectUnknown(value, new Set(["costUsd", "durationSec"]), "contract.nodeAdvisory");
  /** @type {NodeAdvisoryPolicy} */
  const policy = {};
  if (value.costUsd !== undefined) policy.costUsd = nonNegativeNumber(value.costUsd, "contract.nodeAdvisory.costUsd");
  if (value.durationSec !== undefined) policy.durationSec = nonNegativeNumber(value.durationSec, "contract.nodeAdvisory.durationSec");
  return policy;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {"safe"|"reconcile"|"never"}
 */
function validateReplayPolicy(value, label) {
  if (value === undefined) return "safe";
  if (typeof value !== "string" || !REPLAY_POLICIES.has(value)) {
    throw new TypeError(`${label}.replayPolicy must be one of safe, reconcile, never`);
  }
  return /** @type {"safe"|"reconcile"|"never"} */ (value);
}

/**
 * The first declared write path that claims a reserved article name, matched
 * on the trailing `references/<name>` segments so the skill's location inside
 * the target repository is not hardcoded here. scopeAcknowledged is checked
 * alongside the write set because an acknowledged path is expected to change.
 *
 * @param {TaskPacket} packet
 * @returns {string|undefined}
 */
function reservedArticleClaim(packet) {
  const declared = [
    ...(packet.writeFiles ?? []),
    ...(packet.writeRoots ?? []),
    ...(packet.scopeAcknowledged ?? []),
  ];
  return declared.find((path) =>
    RESERVED_ARTICLES.some((article) => path === article || path.endsWith(`/${article}`)),
  );
}

/**
 * @param {ValidatedNode[]} nodes
 */
function assertAcyclic(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  /** @type {(id: string) => void} */
  const visit = (id) => {
    if (visiting.has(id)) throw new TypeError(`dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    if (!node) throw new TypeError(`dependency cycle includes ${id}`);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/**
 * Every node reachable from `node` through `dependsOn` (and the dependencies
 * of those, transitively), itself excluded.
 *
 * @param {ValidatedNode} node
 * @param {ValidatedNode[]} nodes
 * @returns {Set<ValidatedNode>}
 */
function transitiveDependencyClosure(node, nodes) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const closure = /** @type {Set<ValidatedNode>} */ (new Set());
  /** @param {string} id */
  const visit = (id) => {
    const dependency = byId.get(id);
    if (!dependency || closure.has(dependency)) return;
    closure.add(dependency);
    for (const next of dependency.dependsOn) visit(next);
  };
  for (const id of node.dependsOn) visit(id);
  return closure;
}

/**
 * Whether a transitive dependency produces the deferred path: it declares the
 * identical path in `writeFiles`, or the path sits under a directory-shaped
 * `writeRoots` entry. A `writeRoots` entry that names an existing regular file
 * authorizes exactly that path and nothing beneath it, mirroring the
 * file-root/directory-root rule workspace.mjs's scope comparison applies.
 *
 * @param {Set<ValidatedNode>} closure
 * @param {string} path
 * @param {string} cwd
 * @returns {boolean}
 */
function dependencyCoversPath(closure, path, cwd) {
  for (const dependency of closure) {
    const packet = dependency.taskPacket;
    if ((packet.writeFiles ?? []).includes(path)) return true;
    for (const root of packet.writeRoots ?? []) {
      if (path === root) return true;
      if (isRegularFileRoot(root, cwd)) continue;
      if (path.startsWith(`${root}/`)) return true;
    }
  }
  return false;
}

/**
 * A `writeFiles` entry naming a file already close to the line ceiling is
 * legal -- the ceiling refuses the file itself, at commit time, not the
 * contract that names it -- but a worker cannot discover the file has no
 * room for its diff until an attempt has already spent an invocation
 * finding out. This warns, never refuses, so the author decides whether the
 * write set needs a split before dispatch. A missing file has no current
 * count to warn about, so it is skipped, not treated as zero.
 *
 * @param {ValidatedNode} node
 * @param {number} index
 * @param {string} cwd
 * @returns {string[]}
 */
function writeFileLineBudgetWarnings(node, index, cwd) {
  const warnings = [];
  for (const path of node.taskPacket.writeFiles ?? []) {
    // The ceiling is a rule about source modules, and `source-shape` enforces
    // it over `.mjs` alone. Measured 2026-09-22: a packet declaring the
    // generated `docs/COMMANDS.md` was warned that 1141 lines left "-341 from
    // the 800-line ceiling", which is not a budget, not true of that file, and
    // trains the reader to skim past the warnings that are.
    if (!path.endsWith(".mjs")) continue;
    let text;
    try {
      text = readFileSync(resolve(cwd, path), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").length;
    const remaining = WRITE_FILE_LINE_CEILING - lines;
    if (remaining > WRITE_FILE_LINE_WARN_MARGIN) continue;
    warnings.push(
      `nodes[${index}] (${node.id}): writeFiles ${path} is already ${lines} lines, ${remaining} from the ${WRITE_FILE_LINE_CEILING}-line ceiling; confirm this node's write has room before it starts`,
    );
  }
  return warnings;
}

/**
 * @param {string} root
 * @param {string} cwd
 * @returns {boolean}
 */
function isRegularFileRoot(root, cwd) {
  try {
    return statSync(resolve(cwd, root)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function validateMaxParallel(value) {
  // Filesystem isolation (attempt worktrees) exists now, so nothing caps this
  // beyond being a sane positive integer.
  return positiveInteger(value, "contract.maxParallel");
}

/** @param {unknown} value @param {boolean} fallback @param {string} label @returns {boolean} */
function booleanField(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}
