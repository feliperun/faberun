/**
 * Which provider session a node's next invocation runs in: fresh, a
 * continuation of a compatible earlier session in the same plan phase, or a
 * rotation -- a fresh session that carries the prior nodes' structured
 * summaries. Separate from dispatch.mjs, which spawns whatever this decides,
 * because the decision reads only persisted node snapshots and the routing
 * table, and because dispatch.mjs crossed the 800-line ceiling carrying it.
 */
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { boundedUtf8, stableJson } from "../util.mjs";
import { providerCommand } from "../harnesses/index.mjs";
import { readJson } from "../run/store.mjs";
import { routeRuntimeForState } from "./failover.mjs";
import { validateNodeSnapshot } from "../contract/snapshot.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./process.mjs").Invocation} Invocation */

/** @typedef {{forceFresh?: boolean}} SessionPolicy */

/**
 * Resolve the session policy one dispatch runs under, then consume the copy the
 * node persisted. The explicit argument comes from a caller that is dispatching
 * on the spot; `state.sessionPolicy` is the copy a rejection decision left when
 * it handed the node back to the scheduler, whose own `startWorker` call passes
 * nothing at all.
 *
 * Persisting is the whole point: `phaseInvocationPlan` rediscovers a compatible
 * continuation from the persisted ledger, so nulling a local continuation id at
 * the call site would let the scheduler's later dispatch find it again. Clearing
 * the stored policy here makes it one-shot — it governs exactly the dispatch it
 * was recorded for, and the next unrelated attempt reuses normally.
 *
 * @param {{sessionPolicy?: SessionPolicy|null}} state
 * @param {SessionPolicy} [explicit]
 * @returns {SessionPolicy}
 */
export function forceFreshSession(state, explicit = {}) {
  const persisted = /** @type {SessionPolicy|undefined} */ (state?.sessionPolicy ?? undefined);
  const policy = { ...(persisted ?? {}), ...explicit };
  if (state && state.sessionPolicy !== undefined && state.sessionPolicy !== null) state.sessionPolicy = null;
  return policy;
}

/**
 * Select the only continuation that is allowed for this plan phase and role.
 * The search is intentionally limited to persisted node snapshots in this run.
 *
 * `policy.forceFresh` is the explicit session policy a rejection decision
 * carries: it short-circuits the search before it can rediscover a compatible
 * continuation, so a retry after a gate rejection starts a fresh provider
 * session instead of re-reading the failed transcript. Nulling a local id at
 * the call site is not enough, because this function rediscovers the prior
 * continuation from the persisted ledger.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {"worker"|"judge"} role
 * @param {string} prompt
 * @param {SessionPolicy} [policy]
 * @returns {{prompt: string, continuationId: string|null, mode: "fresh"|"reuse"|"rotate"}}
 */
export function phaseInvocationPlan(contract, node, state, runDir, role, prompt, policy = {}) {
  if (policy.forceFresh === true) {
    return { prompt, continuationId: null, mode: "fresh" };
  }
  const runId = basename(runDir);
  const session = phaseSessionCandidates(contract, node, state, runDir, role).at(-1);
  const runtime = routeRuntimeForState(contract, node, state, role);
  const identityMatches = session && session.invocation.runId === runId
    && session.invocation.campaignId === contract.campaignId
    && session.invocation.planPhase === node.phase
    && session.invocation.role === role
    && session.invocation.harness === runtime.harness
    && session.invocation.runtimeId === runtime.id
    && session.invocation.runtimeFingerprint === fingerprintRuntime(runtime)
    && session.invocation.model === runtime.model
    && session.invocation.reasoning === (runtime.reasoning ?? null)
    && session.invocation.sandbox === (runtime.sandbox ?? null);
  const canContinue = runtime.capabilities.continuation === true;
  // A node continuing its own earlier session keeps it. A phase sibling's
  // session is reused only when the contract opts in (`phaseSessionReuse`):
  // measured 2026-09-20 over 21 runs with both kinds of turn, a turn opened
  // on a sibling's session cost 1.87x the fresh one at the same request
  // count -- it began with 200k tokens of context instead of 45k and re-read
  // them on every request -- while the rotation below hands the sibling's
  // structured summary to a fresh session whose first request is already 90%
  // served from the shared prefix cache.
  const ownSession = session !== undefined && session.nodeId === node.id;
  if (identityMatches && canContinue && (ownSession || contract.phaseSessionReuse === true)) {
    return { prompt, continuationId: session.invocation.continuationId ?? null, mode: "reuse" };
  }
  // A harness that cannot continue at all, or a session picked up from a
  // different phase-sibling node whose identity does not match this one, has
  // no native continuity: the fresh attempt carries the prior nodes'
  // structured summaries forward instead of starting blind.
  if (session && (!canContinue || session.nodeId !== node.id)) {
    return {
      prompt: phaseHandoffPrompt(contract, node, state, runDir, role),
      continuationId: null,
      mode: "rotate",
    };
  }
  // A capable harness continuing its own node whose identity merely drifted
  // (the run directory moved, or a runtime edge) still gets the caller's own
  // prompt — already carrying the node's bounded "Previous attempt" section —
  // in a fresh session, never a synthesized handoff.
  return { prompt, continuationId: null, mode: session ? "rotate" : "fresh" };
}

/**
 * Continuation ids a live invocation is already driving, anywhere in the run.
 *
 * This is what makes concurrent nodes of one phase safe, and it is read from
 * the persisted ledger rather than from an in-memory registry so a controller
 * that took over a run inherits the claims instead of racing them.
 *
 * @param {ValidatedContract} contract
 * @param {NodeSnapshot} currentState
 * @param {string} runDir
 * @returns {Set<string>}
 */
function claimedContinuations(contract, currentState, runDir) {
  /** @type {Set<string>} */
  const claimed = new Set();
  for (const candidate of contract.nodes) {
    let state = candidate.id === currentState.id ? currentState : null;
    if (!state) {
      try { state = validateNodeSnapshot(readJson(join(runDir, "nodes", `${candidate.id}.json`)), candidate); } catch { continue; }
    }
    for (const invocation of state.invocations ?? []) {
      if (invocation.status === "active" && invocation.continuationId) claimed.add(invocation.continuationId);
    }
  }
  return claimed;
}

/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} currentState
 * @param {string} runDir
 * @param {"worker"|"judge"} role
 * @returns {{nodeId: string, invocation: Invocation}[]}
 */
function phaseSessionCandidates(contract, node, currentState, runDir, role) {
  /** @type {{nodeId: string, invocation: Invocation}[]} */
  const candidates = [];
  const claimed = claimedContinuations(contract, currentState, runDir);
  for (const candidate of contract.nodes) {
    if (candidate.phase !== node.phase) continue;
    let state = candidate.id === currentState.id ? currentState : null;
    if (!state) {
      try { state = validateNodeSnapshot(readJson(join(runDir, "nodes", `${candidate.id}.json`)), candidate); } catch { continue; }
    }
    for (const invocation of state.invocations ?? []) {
      if (invocation.role !== role || invocation.planPhase !== node.phase || !invocation.continuationId) continue;
      if (invocation.nodeId !== candidate.id || invocation.attempt !== state.attempt || invocation.workspace !== state.worktree?.path) continue;
      // One provider session, one live turn. With `maxParallel` above one,
      // two nodes of a phase can be dispatched in the same tick, and without
      // this both would hand the same continuation id to their own provider
      // process. The claim is read from the persisted ledger, which the
      // in-tick dispatch already wrote for the node that went first.
      if (claimed.has(invocation.continuationId)) continue;
      candidates.push({ nodeId: candidate.id, invocation });
    }
  }
  return candidates.sort((left, right) => {
    const leftStarted = Date.parse(left.invocation.startedAt);
    const rightStarted = Date.parse(right.invocation.startedAt);
    if (leftStarted !== rightStarted) return leftStarted - rightStarted;
    const leftUpdated = Date.parse(left.invocation.updatedAt);
    const rightUpdated = Date.parse(right.invocation.updatedAt);
    if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
    return left.invocation.id.localeCompare(right.invocation.id);
  });
}

/** @param {RuntimeSnapshot} runtime @returns {string} */
export function fingerprintRuntime(runtime) {
  const executable = providerCommand(runtime, "").executable;
  return createHash("sha256").update(stableJson({ runtime, executable })).digest("hex");
}

/** @param {ValidatedContract} contract @param {ValidatedNode} node @param {NodeSnapshot} state @param {string} runDir @param {"worker"|"judge"} role @returns {string} */
function phaseHandoffPrompt(contract, node, state, runDir, role) {
  const summaries = phaseSessionCandidates(contract, node, state, runDir, role)
    .map(({ nodeId }) => {
      const candidate = contract.nodes.find((item) => item.id === nodeId);
      let snapshot = null;
      try { snapshot = readJson(join(runDir, "nodes", `${nodeId}.json`)); } catch {
        // ENOENT or unreadable snapshot: this prior node contributes no summary.
      }
      const result = snapshot?.result;
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? /** @type {Record<string, unknown>} */ (result)
        : null;
      const summary = typeof record?.summary === "string" ? record.summary : null;
      return summary && candidate ? `${candidate.id}: ${boundedUtf8(summary, 1024)}` : null;
    })
    .filter(Boolean)
    .slice(-8);
  const handoff = [
    `Continue phase ${node.phase} as the ${role} agent in a fresh provider session.`,
    "Prior structured node summaries:",
    summaries.length ? summaries.map((summary) => `- ${summary}`).join("\n") : "- (none)",
    "Current closed task packet:",
    boundedUtf8(node.prompt, 48 * 1024),
  ].join("\n\n");
  return boundedUtf8(handoff, 60 * 1024);
}
