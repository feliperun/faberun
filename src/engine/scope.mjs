/**
 * The write boundary: what a node was allowed to touch, what it actually
 * touched, and what to do when those differ.
 *
 * Scope is advisory by design -- an unexpected write is recorded as a finding
 * and shown to the judge, not treated as a crime -- with two exceptions:
 * `resolveUnknownEffect` decides whether an invocation whose effect is unproven
 * may be replayed at all, and a dirty scope there is a refusal; and a write
 * that lands on a file the node's own proof names is never deferred, because a
 * verification that passes over an edited prover has proven nothing.
 */
import { relative, resolve } from "node:path";

import { SETTLED } from "./prompts.mjs";
import { appendTransitionEvent, recordExecutionOverride, transition, writeNode } from "./state.mjs";
import { attemptWorkspace } from "../repo/worktree.mjs";

import { errorCode, errorMessage, excerpt, isContained } from "../util.mjs";
import { executeControllerVerification } from "./verify.mjs";
import { providerReceiptsFromInvocationTail, settleInvocation } from "../run/operations.mjs";
import { readJson } from "../run/store.mjs";
import { scopeFindingFromScope } from "../contract/scope-findings.mjs";
import { captureWorkspaceScope, compareWorkspaceSnapshot, validateWorkspaceScopeBoundary } from "../repo/workspace.mjs";

/** @typedef {import("../contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./lifecycle.mjs").Job} Job */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../run/usage.mjs").RecoveryOutcome} RecoveryOutcome */
/** @typedef {import("../repo/workspace.mjs").ScopeComparison} ScopeComparison */
/** @typedef {import("../contract/index.mjs").TaskPacket} TaskPacket */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../repo/workspace.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */
/** @typedef {import("../repo/workspace.mjs").WorkspaceSnapshot} WorkspaceSnapshot */

/**
 * @param {NodeSnapshot} state
 * @returns {string|null}
 */
export function sourceWorkerRuntime(state) {
  return [...(state.invocations ?? [])].reverse().find((invocation) => invocation.phase === "worker")?.runtimeId
    ?? state.runtime?.id
    ?? null;
}
/**
 * @param {ScopeComparison} scope
 * @param {import("../repo/workspace.mjs").WorkspaceScopeBoundary} boundary
 * @returns {BoundedScope}
 */
function boundedScope(scope, boundary) {
  return {
    boundary,
    changedPaths: scope.changedPaths.slice(0, 64),
    unexpectedPaths: scope.unexpectedPaths.slice(0, 64),
    changedPathCount: scope.changedPaths.length,
    unexpectedPathCount: scope.unexpectedPaths.length,
    truncated: scope.changedPaths.length > 64 || scope.unexpectedPaths.length > 64,
  };
}
/**
 * @param {import("../repo/workspace.mjs").WorkspaceScopeBoundary} boundary
 * @returns {BoundedScope}
 */
export function emptyScope(boundary) {
  if (!boundary) throw Object.assign(new Error("worker scope boundary is missing"), { code: "scope_boundary_missing" });
  return {
    boundary,
    changedPaths: [],
    unexpectedPaths: [],
    changedPathCount: 0,
    unexpectedPathCount: 0,
    truncated: false,
  };
}
/**
 * @param {ValidatedContract} contract
 * @returns {Map<string, import("../repo/workspace.mjs").WorkspaceScopeBoundary>}
 */
export function captureNodeScopeBoundaries(contract) {
  return new Map(contract.nodes.map((node) => [node.id, captureWorkspaceScope(contract.cwd, workerScope(node.taskPacket))]));
}
/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot|undefined} state
 * @returns {import("../repo/workspace.mjs").WorkspaceScopeBoundary}
 */
export function persistedScopeBoundary(contract, node, state, workspace = contract.cwd) {
  const boundary = state?.scope?.boundary;
  if (!boundary) throw Object.assign(new Error(`node ${node.id} has no persisted worker scope boundary`), { code: "scope_boundary_missing" });
  return validateWorkspaceScopeBoundary(workspace, boundary, workerScope(node.taskPacket));
}
/**
 * @param {import("../contract/index.mjs").TaskPacket} taskPacket
 * @returns {{files: string[], roots: string[]}}
 */
export function workerScope(taskPacket) {
  return {
    files: taskPacket.writeFiles ?? [],
    roots: taskPacket.writeRoots ?? [],
  };
}
/**
 * @typedef {{tokens: string[], cwd: string, literal: boolean, citation: string}} ProofCitation
 */

/**
 * Everything a node's own proofs name: a Definition of Done `path` proof's
 * path, the words of a `command` proof (a command proof carries a display
 * string, not an argv, so a quoted path holding a space is not recovered), the
 * argv of the verification entry a `verification` proof references, and the
 * argv of every verification command the packet declares.
 *
 * @param {ValidatedNode} node
 * @returns {ProofCitation[]}
 */
function proofCitations(node) {
  const commands = node.taskPacket.verification ?? [];
  /** @type {ProofCitation[]} */
  const citations = [];
  // Definition of Done items come first so that a path both a checklist item
  // and a verification command name is reported under the checklist item, the
  // name a human reading the failure can act on.
  for (const item of node.definitionOfDone ?? []) {
    const proof = item.proof;
    if (!proof) continue;
    if (proof.kind === "path") {
      citations.push({ tokens: [proof.ref], cwd: ".", literal: true, citation: `${item.id} path proof` });
    } else if (proof.kind === "command") {
      citations.push({ tokens: proof.ref.split(/\s+/u), cwd: ".", literal: false, citation: `${item.id} command proof` });
    } else {
      const command = commands[Number.parseInt(proof.ref, 10)];
      if (command) citations.push({ tokens: command.argv, cwd: command.cwd ?? ".", literal: false, citation: `${item.id} verification[${proof.ref}] proof` });
    }
  }
  for (const [index, command] of commands.entries()) {
    citations.push({ tokens: command.argv, cwd: command.cwd ?? ".", literal: false, citation: `verification[${index}]` });
  }
  return citations;
}
const PATH_SEPARATOR = /[\\/]/u;

/**
 * The unexpected writes that landed on a file the node's own proof names.
 * Matching a command's argv against files is inherently approximate, so this is
 * lexical and deliberately narrow. A word is read as a path only when it is not
 * an option, is shaped like one (a `path` proof's ref, or a word carrying a
 * separator or an extension), and resolves inside the workspace; it then claims
 * an unexpected path it equals, or -- when it carries a separator or is a `path`
 * proof's ref, so a directory really was named -- one it is the directory
 * prefix of.
 *
 * What it deliberately does not catch: a file a proof reaches through a script
 * (`npm test`), a shell string, or a glob the tool expands itself. The bare
 * words of a command are never paths, which is what keeps the ordinary case
 * advisory -- measured against the real node `requirement-ids-reach-the-node`
 * (run `state-location-and-routing-economics-10-requirement-ids-and-closure`),
 * whose legitimate out-of-scope write to `src/plan/freeze.mjs` is claimed by
 * none of its proofs: not by `npm run typecheck`, not by the two test files its
 * `command` proofs name, and not by the loose words of a quoted
 * `--test-name-pattern`.
 *
 * @param {ValidatedNode} node
 * @param {string[]} unexpectedPaths
 * @param {string} workspace
 * @returns {{path: string, citation: string}[]}
 */
function proofCitedWrites(node, unexpectedPaths, workspace) {
  /** @type {Map<string, string>} */
  const cited = new Map();
  for (const citation of proofCitations(node)) {
    const base = resolve(workspace, citation.cwd);
    for (const token of citation.tokens) {
      if (!token || token.startsWith("-")) continue;
      const directory = citation.literal || PATH_SEPARATOR.test(token);
      if (!directory && !/\.[A-Za-z0-9]+$/u.test(token)) continue;
      const target = resolve(base, token);
      if (!isContained(workspace, target)) continue;
      const named = relative(workspace, target).replaceAll("\\", "/");
      // The workspace root itself names no file in particular: a proof run from
      // the root must not make every unexpected write a proof-citing one.
      if (!named) continue;
      for (const path of unexpectedPaths) {
        if (cited.has(path)) continue;
        if (path === named || (directory && path.startsWith(`${named}/`))) cited.set(path, citation.citation);
      }
    }
  }
  return [...cited].map(([path, citation]) => ({ path, citation }));
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Job} job
 * @param {LockHandle} lock
 * @param {{deferViolation?: boolean}} [options]
 * @returns {boolean}
 */
export function checkWorkerScope(contract, runDir, job, lock, options = {}) {
  if (job.scopeChecked) return !job.scopeViolation;
  job.scopeChecked = true;
  const state = job.state;
  try {
    const baseline = /** @type {WorkspaceSnapshot|undefined} */ (job.scopeBaseline ?? (job.invocation.snapshotPath ? readJson(job.invocation.snapshotPath) : null));
    if (!baseline) throw Object.assign(new Error("worker scope snapshot is missing"), { code: "scope_snapshot_missing" });
    const boundary = persistedScopeBoundary(contract, job.node, state, job.cwd);
    const scope = compareWorkspaceSnapshot(baseline, job.cwd, { ...workerScope(job.node.taskPacket), boundary });
    const bounded = boundedScope(scope, boundary);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length) return true;
    job.scopeViolation = true;
    // A completed attempt whose controller verification passes never fails
    // on scope alone (TECH-SPEC lean, rule 1): the caller defers the verdict
    // until verification has run and records an advisory finding instead.
    // The single exception is a write onto a file the node's own proof names:
    // verification then passes because the attempt edited the thing doing the
    // proving, and an advisory nobody must read before the gate is too weak a
    // signal for that. Scanned over the bounded path list -- the same first 64
    // paths every other surface reports.
    const cited = proofCitedWrites(job.node, bounded.unexpectedPaths, job.cwd);
    if (options.deferViolation && !cited.length) return true;
    const message = cited.length
      // Kept short on purpose: an error message is capped at 120 characters,
      // and the proof that names the path is the part a reader cannot recover
      // from `state.scope` afterwards.
      ? `proof-cited unexpected write (${cited.length}): ${cited.slice(0, 8).map(({ path, citation }) => `${path} (${citation})`).join(", ")}`
      : `unexpected paths changed (${scope.unexpectedPaths.length}): ${bounded.unexpectedPaths.slice(0, 8).join(", ")}`;
    if (!SETTLED.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: "unexpected_write", message: excerpt(message) } }, lock);
      appendTransitionEvent(runDir, state, "failed", "failed", {
        unexpectedPaths: bounded.unexpectedPaths,
        unexpectedPathCount: bounded.unexpectedPathCount,
      }, lock);
    }
    return false;
  } catch (error) {
    job.scopeViolation = true;
    if (!SETTLED.has(state.status)) {
      transition(runDir, state, "failed", { phase: "worker", error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) } }, lock);
    }
    return false;
  }
}
/**
 * A result-only continuation is not implementation work. Its baseline is
 * captured immediately before that single turn, so every workspace change is
 * outside its authority (the run-owned result file is ignored by snapshots).
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Job} job
 * @param {LockHandle} lock
 * @param {string} [label]
 * @returns {boolean}
 */
export function checkResultMaterializationScope(contract, runDir, job, lock, label = "result materialization") {
  if (job.scopeChecked) return !job.scopeViolation;
  job.scopeChecked = true;
  const state = job.state;
  try {
    const baseline = /** @type {WorkspaceSnapshot|undefined} */ (job.recoveryBaseline ?? (job.invocation.snapshotPath ? readJson(job.invocation.snapshotPath) : null));
    if (!baseline) throw Object.assign(new Error(`${label} scope snapshot is missing`), { code: "scope_snapshot_missing" });
    const scope = compareWorkspaceSnapshot(baseline, job.cwd);
    if (!scope.changedPaths.length) return true;
    job.scopeViolation = true;
    const shown = scope.changedPaths.slice(0, 8).join(", ");
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: "unexpected_write", message: excerpt(`${label} changed workspace paths (${scope.changedPaths.length}): ${shown}`) },
    }, lock);
    return false;
  } catch (error) {
    job.scopeViolation = true;
    transition(runDir, state, "failed", {
      phase: "worker",
      error: { code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), message: excerpt(errorMessage(error)) },
    }, lock);
    return false;
  }
}
/**
 * Materialization can reuse prior controller evidence only when that evidence
 * survived the same worker attempt. A fresh worker clears verification; the
 * retained, completed record is therefore the bounded same-attempt proof.
 * Judge evidence cannot currently carry that identity, so gated nodes fail
 * closed and run their normal judge phase.
 *
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @returns {boolean}
 */
export function canReuseResultEvidence(state, node) {
  if (state.verification?.completed !== true || state.verification.passed !== true) return false;
  return !node.gate.enabled;
}
/**
 * Compare the current workspace against the persisted worker baseline without
 * transitioning the node. Shared by the unexpected-write failure path and the
 * unknown_effect replay gate.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} invocation
 * @param {{strict?: boolean}} [options]
 * @returns {{ok: true}|{ok: false, code: string, detail: string, unexpectedPaths?: string[], unexpectedPathCount?: number, changedPaths?: string[], changedPathCount?: number}}
 */
function evaluatePersistedWorkerScope(contract, node, state, invocation, options = {}) {
  const strict = options.strict === true;
  try {
    const baseline = invocation?.snapshotPath
      ? /** @type {WorkspaceSnapshot} */ (readJson(invocation.snapshotPath))
      : null;
    if (!baseline) return { ok: false, code: "scope_snapshot_missing", detail: "worker scope snapshot is missing" };
    const workspace = attemptWorkspace(state) ?? invocation?.workspace ?? contract.cwd;
    const boundary = persistedScopeBoundary(contract, node, state, workspace);
    const scope = compareWorkspaceSnapshot(baseline, workspace, { ...workerScope(node.taskPacket), boundary });
    const bounded = boundedScope(scope, boundary);
    state.scope = bounded;
    if (!scope.unexpectedPaths.length && (!strict || scope.changedPaths.length === 0)) return { ok: true };
    if (scope.unexpectedPaths.length) {
      const shown = bounded.unexpectedPaths.slice(0, 8).join(", ");
      return {
        ok: false,
        code: "unexpected_write",
        detail: `unexpected paths changed (${scope.unexpectedPaths.length}): ${shown}`,
        unexpectedPaths: bounded.unexpectedPaths,
        unexpectedPathCount: bounded.unexpectedPathCount,
      };
    }
    return {
      ok: false,
      code: "declared_paths_changed",
      detail: `declared workspace paths changed across the ambiguous window (${scope.changedPaths.length}): ${bounded.changedPaths.slice(0, 8).join(", ")}`,
      changedPaths: bounded.changedPaths,
      changedPathCount: bounded.changedPathCount,
    };
  } catch (error) {
    return { ok: false, code: /** @type {string} */ (errorCode(error) ?? "scope_snapshot_invalid"), detail: errorMessage(error) };
  }
}
/**
 * Gate a worker restart behind proof that the replay cannot duplicate effects.
 * Declared workspace changes are not proof of absence: any change across the
 * ambiguous window (declared or unexpected) or a missing scope baseline is
 * reconciled as terminal attention instead of silently replaying the attempt.
 * Returns true when the restart must not proceed (the node was blocked).
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} invocation
 * @param {RecoveryOutcome} recovery
 * @param {Record<string, unknown>|undefined} persistedRecovery
 * @param {LockHandle} lock
 * @returns {boolean}
 */
export function reconcileAmbiguousWorkerRestart(contract, runDir, node, state, invocation, recovery, persistedRecovery, lock) {
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, invocation, { strict: true });
  if (evaluation.ok) return false;
  const invocationId = recovery.invocationId ?? invocation?.id;
  const reason = evaluation.code === "declared_paths_changed"
    ? `declared workspace changes across the ambiguous window are not proof that replay cannot duplicate effects for node ${state.id}: ${evaluation.detail}`
    : evaluation.code === "unexpected_write"
      ? `workspace moved outside the declared write scope across the ambiguous window: ${evaluation.detail}`
      : `the ambiguous worker window for node ${state.id} cannot prove replay safety: ${evaluation.detail}`;
  if (invocationId) {
    settleInvocation(runDir, invocationId, {
      status: "reconciled",
      usage: invocation?.usage ?? recovery.usage ?? null,
      costUsd: typeof invocation?.costUsd === "number" ? invocation.costUsd : recovery.costUsd ?? null,
      receipts: providerReceiptsFromInvocationTail(contract, invocation),
      unknownEffect: true,
      classification: "unknown_effect",
      reason,
    });
  }
  if (!persistedRecovery) recordExecutionOverride(runDir, state, {
    kind: "recovery",
    decision: "reconciled",
    invocationId,
    phase: recovery.phase,
    reason,
  }, lock);
  transition(runDir, state, "blocked", {
    phase: recovery.phase,
    error: { code: "unknown_effect_reconciled", message: excerpt(reason) },
  }, lock);
  return true;
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {ValidatedNode} node
 * @param {Invocation|undefined} invocation
 * @param {LockHandle} lock
 * @param {{materialization?: boolean}} [options]
 * @returns {boolean}
 */
export function checkPersistedWorkerScope(contract, runDir, state, node, invocation, lock, options = {}) {
  const materialization = options.materialization === true;
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, invocation, { strict: materialization });
  if (evaluation.ok) return true;
  // A recovered materialization turn mirrors the live check: it may only write
  // the canonical result file, so declared-path changes are as terminal as
  // unexpected ones.
  const failure = materialization && (evaluation.code === "unexpected_write" || evaluation.code === "declared_paths_changed")
    ? {
      code: "unexpected_write",
      message: excerpt(`result materialization changed workspace paths (${evaluation.changedPathCount ?? evaluation.unexpectedPathCount}): ${(evaluation.changedPaths ?? evaluation.unexpectedPaths ?? []).slice(0, 8).join(", ")}`),
    }
    : { code: evaluation.code, message: excerpt(evaluation.detail) };
  transition(runDir, state, "failed", {
    phase: "worker",
    error: failure,
  }, lock);
  if (evaluation.unexpectedPaths) {
    appendTransitionEvent(runDir, state, "failed", "failed", {
      unexpectedPaths: evaluation.unexpectedPaths,
      unexpectedPathCount: evaluation.unexpectedPathCount,
    }, lock);
  }
  return false;
}
/**
 * Record a deferred scope violation as an advisory finding on a node whose
 * controller verification passed: the node proceeds into the gate exactly as
 * a clean node would (TECH-SPEC lean, rule 1).
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 */
export function recordScopeFinding(runDir, state, lock) {
  if (!state.scope?.unexpectedPaths?.length) return;
  state.scopeFindings = scopeFindingFromScope(state.scope);
  writeNode(runDir, state, lock);
  appendTransitionEvent(runDir, state, state.status, state.status, {
    type: "scope.finding",
    unexpectedPaths: state.scopeFindings.unexpectedPaths,
    unexpectedPathCount: state.scope.unexpectedPathCount,
  }, lock);
}
/**
 * Resolve an unknown_effect window (intent without settlement) per the node's
 * replayPolicy. Adoption proof was already applied by recoverOrphan when it
 * applied; what remains is the scoped safe-replay or a durable reconcile.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Invocation|undefined} workerInvocation
 * @param {LockHandle} lock
 * @returns {Promise<{action: "replay"}|{action: "reconcile", reason: string}>}
 */
export async function resolveUnknownEffect(contract, runDir, node, state, workerInvocation, lock) {
  const policy = node.replayPolicy ?? "safe";
  if (policy !== "safe") {
    return { action: "reconcile", reason: `node ${state.id} declares replayPolicy ${policy}; the interrupted attempt with unknown effects requires manual reconciliation` };
  }
  const evaluation = evaluatePersistedWorkerScope(contract, node, state, workerInvocation, { strict: true });
  if (!evaluation.ok) {
    return {
      action: "reconcile",
      reason: evaluation.code === "declared_paths_changed"
        ? `declared workspace changes across the ambiguous window are not proof that replay cannot duplicate effects for node ${state.id}: ${evaluation.detail}`
        : `workspace moved outside the declared write scope across the ambiguous window: ${evaluation.detail}`,
    };
  }
  await executeControllerVerification(contract, runDir, node, state, lock);
  if (!state.verification?.passed) {
    return { action: "reconcile", reason: `deterministic verification failed while resolving the ambiguous window for node ${state.id}; partial effects cannot be proven absent` };
  }
  return { action: "replay" };
}
