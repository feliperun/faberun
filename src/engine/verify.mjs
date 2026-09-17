/**
 * Verification the controller runs itself, in the attempt workspace, after the
 * worker says it is done.
 *
 * The worker is also told to run these commands, and its word is not the proof:
 * the controller re-runs them and persists each attempt, because a worker that
 * claims a passing suite it never ran is exactly the failure this exists to
 * catch. `recoverVerificationAttempts` reads back what a crashed controller had
 * already proved, so a resume does not pay for the same suite twice.
 */
import { attemptWorkspace } from "../repo/worktree.mjs";
import { boundedUtf8, errorMessage } from "../util.mjs";
import { compactVerification } from "../contract/verification.mjs";
import { finalVerificationCommands, phaseTerminalNode, sharedVerificationCommands } from "../contract/final-verification.mjs";
import { join } from "node:path";
import { listNodeSnapshots, readNodeSnapshot } from "../run/node-store.mjs";
import { SETTLED } from "./prompts.mjs";
import { terminateInvocation } from "./process.mjs";
import { writeNode } from "./state.mjs";
import { runVerification } from "./run-command.mjs";

/** @typedef {import("../repo/integrate.mjs").CandidateEvidence} CandidateEvidence */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationCommand} VerificationCommand */
/** @typedef {import("../contract/index.mjs").VerificationState} VerificationState */
/** @typedef {{index: number, total: number, argv: string}} VerificationProgress */

/**
 * The sibling phase-terminal node ids already settled, read straight off
 * disk: every node snapshot is persisted from the run's first tick (see
 * `runContract`), so a node still `pending` reads back honestly, not as
 * missing. `finalVerificationCommands` uses this to decide, at the moment a
 * phase-terminal node's own verification runs, whether it is the one that
 * closes the phase -- recomputed fresh on every call, so a retried node sees
 * its siblings' current status each time, not a decision frozen from an
 * earlier attempt.
 *
 * @param {string} runDir
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @returns {Set<string>}
 */
function settledSiblingIds(runDir, contract, node) {
  const ids = new Set();
  for (const name of listNodeSnapshots(runDir)) {
    const id = name.slice(0, -".json".length);
    if (id === node.id) continue;
    const sibling = contract.nodes.find((candidate) => candidate.id === id);
    if (!sibling || !phaseTerminalNode(contract, sibling)) continue;
    const snapshot = /** @type {{status?: string}} */ (readNodeSnapshot(runDir, id));
    if (SETTLED.has(/** @type {string} */ (snapshot.status))) ids.add(id);
  }
  return ids;
}

/**
 * The bounded `k/n · argv` shape a running node's status surfaces while a
 * verification command is in flight: the command's 1-based position among
 * every command this pass runs, and its argv joined and bounded so a long
 * command line can never threaten the node snapshot's byte ceiling.
 *
 * @param {number} index 1-based position of the command now running
 * @param {number} total command count in this verification pass
 * @param {string[]|undefined} argv
 * @returns {VerificationProgress}
 */
export function verificationProgress(index, total, argv) {
  return { index, total, argv: boundedUtf8((argv ?? []).join(" "), 120) };
}
/**
 * @param {VerificationAttemptResult|null|undefined} result
 * @returns {VerificationAttemptResult}
 */
function boundedVerificationAttemptResult(result) {
  return {
    passed: Boolean(result?.passed),
    stdout: boundedUtf8(result?.stdout ?? "", 2 * 1024),
    stderr: boundedUtf8(result?.stderr ?? "", 2 * 1024),
    error: result?.error ? boundedUtf8(result.error, 2 * 1024) : null,
    exitCode: Number.isInteger(result?.exitCode) ? result?.exitCode ?? null : null,
    signal: result?.signal ?? null,
    timedOut: Boolean(result?.timedOut),
    durationMs: Number.isFinite(result?.durationMs) ? result?.durationMs ?? null : null,
  };
}
/**
 * @param {NodeSnapshot} state
 * @returns {import("../contract/index.mjs").VerificationAttempt[]}
 */
function verificationAttemptRecords(state) {
  if (!state.verification || !Array.isArray(state.verification.attempts)) {
    state.verification = { passed: false, commands: [], completed: false, attempts: [] };
  }
  return state.verification.attempts ?? [];
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @param {VerificationAttempt} attempt
 * @param {VerificationProgress} [progress] the running command's `k/n · argv`
 *   shape; omitted on completion, since a following `onAttemptStart` replaces
 *   it or the pass's final rewrite of `state.verification` drops it
 */
function persistVerificationAttempt(runDir, state, lock, attempt, progress) {
  const attempts = verificationAttemptRecords(state);
  const index = attempts.findIndex((item) => item.invocationId === attempt.invocationId);
  if (index >= 0) attempts[index] = { ...attempts[index], ...attempt };
  else attempts.push({ ...attempt, completedAt: attempt.completedAt ?? null, result: attempt.result ?? null });
  state.verification ??= { passed: false, commands: [], completed: false, attempts: [] };
  state.verification.attempts = attempts.slice(-16);
  if (progress) {
    /** @type {VerificationState & {progress?: VerificationProgress}} */
    (state.verification).progress = progress;
  }
  writeNode(runDir, state, lock);
}
/**
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<import("../contract/index.mjs").VerificationState>}
 */
export async function executeControllerVerification(contract, runDir, node, state, lock) {
  if (state.verification?.completed === true) return /** @type {import("../contract/index.mjs").VerificationState} */ (state.verification);
  state.verification = {
    passed: false,
    commands: [],
    completed: false,
    attempts: [...(state.verification?.attempts ?? [])],
  };
  writeNode(runDir, state, lock);
  const workspace = attemptWorkspace(state) ?? contract.cwd;
  const commands = [...node.taskPacket.verification, ...sharedVerificationCommands(contract), ...finalVerificationCommands(contract, node, settledSiblingIds(runDir, contract, node))];
  /** @param {VerificationAttempt} attempt @returns {VerificationProgress} */
  const progressFor = (attempt) => verificationProgress(attempt.commandIndex + 1, commands.length, /** @type {VerificationCommand|undefined} */ (commands[attempt.commandIndex])?.argv);
  try {
    const result = await runVerification(commands, workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.verification`),
      writeFiles: node.taskPacket.writeFiles ?? [],
      onAttemptStart: (attempt) => persistVerificationAttempt(runDir, state, lock, attempt, progressFor(attempt)),
      onAttemptSpawn: (attempt) => persistVerificationAttempt(runDir, state, lock, attempt, progressFor(attempt)),
      onAttemptComplete: (attempt) => persistVerificationAttempt(runDir, state, lock, {
        ...attempt,
        result: boundedVerificationAttemptResult(attempt.result),
      }),
    });
    state.verification = {
      ...compactVerification(result),
      completed: true,
      attempts: verificationAttemptRecords(state),
    };
  } catch (error) {
    // A rebuilt object, not a spread of the prior one: a thrown error can land
    // between an `onAttemptStart` and the matching `onAttemptComplete`, and the
    // stale `progress` that start wrote must not survive into the terminal record.
    state.verification = {
      passed: false,
      commands: state.verification?.commands ?? [],
      completed: true,
      error: boundedUtf8(errorMessage(error), 4 * 1024),
      attempts: verificationAttemptRecords(state),
    };
  }
  writeNode(runDir, state, lock);
  return state.verification;
}
/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
export async function recoverVerificationAttempts(runDir, state, lock) {
  const active = (state.verification?.attempts ?? []).filter((attempt) => attempt.status === "active");
  if (!active.length) return;
  for (const attempt of active) {
    if (attempt.pid) {
      try {
    await terminateInvocation({
      id: attempt.invocationId,
      pid: attempt.pid,
      processGroupId: attempt.processGroupId,
      processStartToken: attempt.processStartToken,
    }, { graceMs: 500, killGraceMs: 1_000, runDir });
      } catch (error) {
        throw new Error(`verification attempt ${attempt.invocationId} could not be terminated: ${errorMessage(error)}`);
      }
    }
    persistVerificationAttempt(runDir, state, lock, {
      ...attempt,
      status: "crashed",
      completedAt: new Date().toISOString(),
      result: { passed: false, stdout: "", stderr: "", error: "verification controller interrupted", exitCode: null, signal: null, timedOut: false, durationMs: null },
    });
  }
  state.verification = { ...state.verification, completed: false, passed: false };
  delete state.verification.error;
  writeNode(runDir, state, lock);
}
/**
 * Re-run, once, exactly the candidate commands that failed here but passed in
 * the attempt's own recorded verification, same argv and same position. A
 * candidate whose *every* failure disagrees with the attempt this way is
 * evidence about the two worktrees' environment rather than about the work --
 * `candidateOnlyFailures` (judge-gate.mjs) already names that disagreement in
 * the rejection it phrases, and this is what earns the candidate one
 * independent confirmation before the node pays for a defect that may not be
 * its own. A candidate with even one failure that also failed in the attempt
 * is not purely divergent, so nothing is retried and the failure stands.
 *
 * `run` is the one side-effecting seam, injected so this stays unit-testable
 * without a workspace or a git repository.
 *
 * @param {import("../contract/verification.mjs").VerificationResult} result the candidate's verification result
 * @param {{commands?: Array<{argv?: string[], passed?: boolean}>}|null|undefined} attemptEvidence the attempt's own recorded verification
 * @param {(indexes: number[]) => Promise<import("../contract/verification.mjs").VerificationCommandResult[]>} run re-runs exactly the commands at `indexes`, returning their results in that order
 * @returns {Promise<import("../contract/verification.mjs").VerificationResult & {retried?: number[]}>}
 */
export async function retryDivergentCandidateCommands(result, attemptEvidence, run) {
  const commands = result?.commands ?? [];
  const failedIndexes = commands.reduce((indexes, command, index) => {
    if (!command.passed) indexes.push(index);
    return indexes;
  }, /** @type {number[]} */ ([]));
  if (!failedIndexes.length) return result;
  const attemptCommands = attemptEvidence?.commands ?? [];
  const divergent = failedIndexes.every((index) => {
    const counterpart = attemptCommands[index];
    return counterpart?.passed === true && argvEqual(commands[index]?.argv, counterpart.argv);
  });
  if (!divergent) return result;
  const retried = await run(failedIndexes);
  const merged = [...commands];
  failedIndexes.forEach((index, position) => { merged[index] = retried[position]; });
  return { ...result, commands: merged, passed: merged.every((command) => command.passed), retried: failedIndexes };
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function argvEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}
/**
 * Marks whether the integration candidate's own verification pass is running
 * right now, nested inside the attempt's own already-completed verification
 * record rather than as a new node-snapshot field: that record's validator
 * (`validateVerificationSnapshot`) accepts extra keys, where the node
 * snapshot's own strict field list would reject one. Status surfaces read it
 * to tell "still verifying the sealed candidate" apart from "waiting on the
 * judge", which otherwise both read as whatever phase the attempt last
 * dispatched under.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} lock
 * @param {boolean} active
 */
function markCandidateVerification(runDir, state, lock, active) {
  state.verification = /** @type {VerificationState} */ ({ ...(state.verification ?? { passed: false, commands: [], completed: false }), candidate: active });
  writeNode(runDir, state, lock);
}
/**
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {string} workspace
 * @param {LockHandle|null} [lock]
 * @returns {Promise<import("../repo/integrate.mjs").CandidateEvidence>}
 */
export async function verifyCandidateWorkspace(contract, node, state, runDir, workspace, lock = null) {
  const commands = [...node.taskPacket.verification, ...sharedVerificationCommands(contract), ...finalVerificationCommands(contract, node, settledSiblingIds(runDir, contract, node))];
  markCandidateVerification(runDir, state, lock, true);
  try {
    const result = await runVerification(commands, workspace, {
      logDir: join(runDir, "logs", `${node.id}.${state.attempt}.candidate-verification`),
      writeFiles: node.taskPacket.writeFiles ?? [],
    });
    /** @type {import("../contract/verification.mjs").VerificationResult & {retried?: number[]}} */
    let settled = result;
    if (!result.passed) {
      settled = await retryDivergentCandidateCommands(result, state.verification, async (indexes) => {
        const subset = indexes.map((index) => commands[index]);
        const rerun = await runVerification(subset, workspace, {
          logDir: join(runDir, "logs", `${node.id}.${state.attempt}.candidate-retry`),
          writeFiles: node.taskPacket.writeFiles ?? [],
        });
        return rerun.commands;
      });
    }
    const compacted = compactVerification(settled);
    return settled.retried ? { ...compacted, retried: settled.retried } : compacted;
  } catch (error) {
    return { passed: false, error: boundedUtf8(errorMessage(error), 4 * 1024) };
  } finally {
    markCandidateVerification(runDir, state, lock, false);
  }
}
