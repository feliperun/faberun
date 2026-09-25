/**
 * Who runs a node, and what a failed dependency costs its dependants.
 *
 * `runtimeAssignments` composes the worker/judge pair only for the roles a
 * contract left open, from the runtimes available right now -- which is why it
 * is called on a fresh run *and* on a resume, and why it lives in neither.
 * `blockDependents` walks the DAG forward from a terminal failure so a node
 * whose dependency died never dispatches at all.
 */
import { PARKED } from "./prompts.mjs";
import { composeAssignments, discoverRuntimes } from "./runtime-discovery.mjs";
import { readUserConfig } from "../host/config.mjs";
import { transition } from "./state.mjs";
import { initialJudgeListState, resolveJudgeList } from "./judge-list.mjs";

/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").JudgeListState} JudgeListState */

/**
 * Resolve role assignments once at run creation. Discovery is used only for
 * omitted roles; the resulting pair is persisted so resume is deterministic.
 * Alongside it, `decisions` records, for every assignment, the strategy that
 * was applied and the reason for the choice: `declared` with the declaring
 * field when the contract named the runtime -- an operator instruction
 * prevails over every strategy -- or the discovery ranking that composed an
 * omitted role. The record lives at this boundary, not on the persisted
 * assignment entries, because the snapshot's routing.allowlist still carries
 * the classified fields only (the same declared lag as the catalogue
 * observables); it widens when a reader needs the record durably.
 *
 * @param {ValidatedContract} contract
 * @returns {Promise<{assignments: Record<string, {worker: string, judge: string, composedWorker: boolean, composedJudge: boolean}>, decisions: Record<string, {worker: {strategy: string|null, reason: string}, judge: {strategy: string|null, reason: string}}>, availability: Record<string, import("./runtime-discovery.mjs").RuntimeAvailability>, judgeListStates: Record<string, JudgeListState|undefined>}>}
 */
export async function runtimeAssignments(contract) {
  const needsComposition = contract.nodes.some((node) =>
    (node.runtime === undefined && contract.runtimeDefaults?.worker === undefined)
    || (node.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined));
  const availability = needsComposition ? await discoverRuntimes(contract.runtimes, { cwd: contract.cwd }) : {};
  const config = readUserConfig(process.env);
  const list = resolveJudgeList(contract, config);
  /** @type {Record<string, JudgeListState|undefined>} */
  const judgeListStates = {};
  // R18: an omitted judge reads the ordered list, contract over machine
  // config, before `composeAssignments`' own single `config.judge` preference
  // and strongest-candidate default. The callback records the evidence
  // (`judgeListStates`) as a side effect and returns `undefined` only for a
  // node the list does not govern (its gate is disabled), which falls through
  // to those candidates unchanged; once the list governs, its pick is final --
  // the whole state, so an exhausted list's thrown error can still name every
  // skip, not just `chosen` (`null` when every entry was skipped), which
  // `composeAssignments` must not fall through either.
  const listJudge = list
    ? (/** @type {{id: string, gate: {enabled: boolean}}} */ node, /** @type {string} */ workerId) => {
      if (!node.gate.enabled) return undefined;
      const judgeListState = initialJudgeListState(contract, list, workerId);
      judgeListStates[node.id] = judgeListState;
      return judgeListState;
    }
    : undefined;
  const assignments = composeAssignments(contract, availability, { config, listJudge });
  /** @type {Record<string, {worker: {strategy: string|null, reason: string}, judge: {strategy: string|null, reason: string}}>} */
  const decisions = {};
  return {
    assignments: Object.fromEntries(Object.entries(assignments).map(([nodeId, assignment]) => {
      const node = contract.nodes.find((candidate) => candidate.id === nodeId);
      const composedWorker = node?.runtime === undefined && contract.runtimeDefaults?.worker === undefined;
      const composedJudge = Boolean(node?.gate.enabled && node.gate.runtime === undefined && contract.runtimeDefaults?.judge === undefined);
      // A judge the gate never asks for is no choice at all: no strategy
      // decided it, so none is recorded.
      const judgeSource = node?.gate.enabled && node.gate.runtime !== undefined
        ? "gate runtime"
        : contract.runtimeDefaults?.judge !== undefined ? "runtimeDefaults.judge" : null;
      const workerSource = node?.runtime !== undefined
        ? "node runtime"
        : contract.runtimeDefaults?.worker !== undefined ? "runtimeDefaults.worker" : null;
      // A list state exists only when the callback actually ran for this node
      // (composedJudge). An exhausted list (chosen null) never reaches this
      // point at all: composeAssignments throws before this map runs rather
      // than falling through to the discovery ranking.
      const fromList = judgeListStates[nodeId]?.chosen === assignment.judge;
      decisions[nodeId] = {
        worker: {
          strategy: composedWorker ? "cost" : workerSource !== null ? "declared" : null,
          reason: composedWorker ? "discovery: cheapest available runtime" : /** @type {string} */ (workerSource),
        },
        judge: {
          strategy: composedJudge ? (fromList ? "judge-list" : "priority") : judgeSource !== null ? "declared" : null,
          reason: composedJudge
            ? (fromList ? `judge list: chose ${assignment.judge}` : "discovery: strongest available runtime")
            : /** @type {string} */ (judgeSource ?? "no judge required"),
        },
      };
      return [nodeId, { ...assignment, composedWorker, composedJudge }];
    })),
    decisions,
    availability,
    judgeListStates,
  };
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 */
export function blockDependents(contract, runDir, states, lock) {
  for (const node of contract.nodes) {
    const state = states.get(node.id);
    if (!state) continue;
    if (state.status !== "pending") continue;
    // Only a parent that has parked blocks its dependants. A parent whose
    // automatic retry is still unspent is re-opened to `pending` before this
    // runs, so the dependants stay `pending`/`phase: "waiting"` until it parks.
    const blockedBy = node.dependsOn.filter((id) => PARKED.has(states.get(id)?.status ?? ""));
    if (blockedBy.length) transition(runDir, state, "blocked", { phase: "dependency", blockedBy, error: { code: "dependency_failed", message: `blocked by ${blockedBy.join(", ")}` } }, lock);
  }
}
