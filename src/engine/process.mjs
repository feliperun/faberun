/**
 * One provider invocation as an operating-system fact: spawn it behind the gate,
 * watch its transcript grow, decide it has stalled, and take it down.
 *
 * Everything here is about the process and its files -- pids, process groups,
 * start tokens, log tails, stall clocks. Nothing here knows what a node is, what
 * a judge decides, or when a run is done. That separation is the point: a stuck
 * provider is killed by the same code whatever it was asked to do.
 */
import { boundedRegion, monitorInvocation } from "./transcript.mjs";
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorCode, errorMessage } from "../util.mjs";
import { fileURLToPath } from "node:url";
import { harnessCapabilities, normalizeProviderResult, providerCommand } from "../harnesses/index.mjs";
import { latestTimeoutSec } from "./backoff.mjs";
import { seedPricing } from "./pricing-seed.mjs";
import { attemptWorkspace, sealAttempt } from "../repo/worktree.mjs";

import { invocationOwned, processGroupAlive, processStartTokenMatches } from "./process-identity.mjs";
import { processStartToken } from "../run/lock.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendJsonl, writeJsonAtomic } from "../run/store.mjs";
import { writeNodeSnapshot } from "../run/node-store.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../contract/index.mjs").Usage} Usage */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {ProviderEnvelope & {costProvenance?: "priced"}} PricedEnvelope */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {{prompt: string|null, stdout: string, stderr: string}} PathSet */
/** @typedef {{id: string, pid: number, processGroupId: number|null, processStartToken: string|null, harness: string, runtimeId: string|null, runtimeFingerprint?: string, revision?: number, phase: string, promptPath: string|null, stdoutPath: string, stderrPath: string, startedAt: string, deadlineAt: string|null, updatedAt: string, closedAt: string|null, exitCode: number|null, signal: string|null, status: "active"|"closed"|"terminated", executable: string, snapshotPath?: string, usage?: Usage, usageEstimated?: boolean, costUsd?: number|null, costProvenance?: "priced", runId?: string, campaignId?: string, nodeId?: string, attempt?: number, workspace?: string, worktreeBranch?: string|null, worktreeBaseSha?: string|null, planPhase?: string, role?: "worker"|"judge", model?: string, reasoning?: string|null, sandbox?: string|null, continuationId?: string|null, continuationMode?: "fresh"|"reuse"|"rotate", session?: import("../harnesses/session-metrics.mjs").SessionLedger|null}} Invocation */
/** @typedef {{pid: number|null, processGroupId?: number|null, processStartToken?: string|null}} InvocationProbe */
/** @typedef {{child: ChildProcess, contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, runtime: HarnessRuntime & {id: string|null}, cwd: string, paths: PathSet, phase: string, invocation: Invocation, startedAt: string, startedTicks: bigint, progressTicks: bigint, lastOutputAt: number, closed: boolean, exitCode: number|null, signal: string|null, spawnError: Error|null, terminating: Promise<void>|null, gateConfigPath: string, gateReleasePath: string, scopeBaseline?: unknown, scopeChecked?: boolean, scopeViolation?: boolean, resultMaterialization?: boolean, recoveryBaseline?: unknown, observeTimer?: ReturnType<typeof setInterval>, monitorOffset?: number, monitorParser?: import("../harnesses/session-metrics.mjs").SessionMetricsParser, lastEventCount?: number, observedOnce?: boolean, onClose?: (invocation: Invocation) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} Job */
/** @typedef {{graceMs?: number, killGraceMs?: number, escalate?: boolean, runDir?: string, kill?: (pid: number, signal: string|number) => unknown, child?: ChildProcess|null}} TerminateOptions */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GRACE_MS = 2_000;
const GATE_PATH = join(HERE, "gate.mjs");
/**
 * @param {{contract: ValidatedContract, node: ValidatedNode, state: NodeSnapshot, runtime: HarnessRuntime & {id: string|null}, prompt: string, paths: PathSet, phase: string, workspace?: string, commandOptions?: import("../harnesses/index.mjs").CommandOptions, onInvocation: (invocation: Invocation, job: Job) => void, onInvocationUpdate?: (invocation: Invocation) => void, onProgress?: (state: NodeSnapshot) => void}} args
 * @returns {Job}
 */
export function startProcess({ contract, node, state, runtime, prompt, paths, phase, workspace = contract.cwd, commandOptions = {}, onInvocation, onInvocationUpdate, onProgress }) {
  const command = providerCommand(runtime, prompt, commandOptions);
  if (paths.prompt) writeFileSync(paths.prompt, prompt, { flag: "wx", mode: 0o600 });
  const gateConfigPath = `${paths.prompt}.gate.json`;
  const gateReleasePath = `${paths.prompt}.gate.release`;
  writeJsonAtomic(gateConfigPath, {
    cwd: workspace,
    executable: command.executable,
    args: command.args,
    promptTransport: command.promptTransport,
    harness: runtime.harness,
    env: command.env ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  });
  let child;
  try {
    child = spawn(process.execPath, [GATE_PATH], {
      cwd: workspace,
      env: {
        ...process.env,
        FABERUN_GATE_CONFIG: gateConfigPath,
        FABERUN_GATE_RELEASE: gateReleasePath,
        FABERUN_GATE_PARENT_PID: String(process.pid),
        FABERUN_GATE_PARENT_TOKEN: processStartToken(process.pid) ?? "",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch (error) {
    cleanupGate({ gateConfigPath, gateReleasePath });
    throw error;
  }
  const startedAt = new Date().toISOString();
  const timeoutSec = latestTimeoutSec(state, node.timeoutSec ?? contract.timeoutSec);
  /** @type {Invocation} */
  const invocation = {
    id: randomUUID(),
    pid: /** @type {number} */ (child.pid),
    processGroupId: process.platform === "win32" ? null : /** @type {number} */ (child.pid),
    processStartToken: processStartToken(/** @type {number} */ (child.pid)),
    harness: runtime.harness,
    runtimeId: runtime.id ?? null,
    revision: state.revisions ?? 0,
    phase,
    promptPath: paths.prompt ?? null,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    startedAt,
    deadlineAt: Number.isFinite(timeoutSec) ? new Date(Date.parse(startedAt) + timeoutSec * 1_000).toISOString() : null,
    updatedAt: startedAt,
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: command.executable,
  };
  /** @type {Job} */
  const job = {
    child,
    contract,
    node,
    state,
    runtime,
    cwd: workspace,
    paths,
    phase,
    invocation,
    startedAt,
    startedTicks: process.hrtime.bigint(),
    progressTicks: process.hrtime.bigint(),
    lastOutputAt: 0,
    closed: false,
    exitCode: null,
    signal: null,
    spawnError: null,
    terminating: null,
    gateConfigPath,
    gateReleasePath,
    onInvocationUpdate,
    onProgress,
  };
  child.once("error", (error) => {
    job.spawnError = error;
    job.closed = true;
    closeInvocation(job);
  });
  child.once("close", (exitCode, signal) => {
    job.exitCode = exitCode;
    job.signal = signal;
    job.closed = true;
    closeInvocation(job);
  });
  try {
    if (typeof onInvocation !== "function") throw new Error("durable invocation persistence callback is required");
    onInvocation(invocation, job);
    signalGate(job.gateReleasePath);
    if (command.promptTransport === "stdin") {
      child.stdin.on("error", () => {});
      child.stdin.end(command.input);
    }
    job.observeTimer = setInterval(() => observeInvocation(job), 25);
    job.observeTimer.unref?.();
  } catch (error) {
    void terminateInvocation(invocation, { graceMs: 100, killGraceMs: 500 }).catch(() => {});
    cleanupGate(job);
    throw error;
  }
  process.stdout.write(`[node] ${node.id} running · ${phase} · ${runtime.id}\n`);
  return job;
}
/**
 * @param {Job} job
 */
function closeInvocation(job) {
  if (job.observeTimer) clearInterval(job.observeTimer);
  job.observeTimer = undefined;
  job.invocation = /** @type {Invocation} */ ({
    ...job.invocation,
    updatedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    exitCode: job.exitCode,
    signal: job.signal,
    status: "closed",
  });
  job.onClose?.(job.invocation);
  cleanupGate(job);
}
/**
 * Observe a bounded prefix while the provider is live. Harness normalizers know
 * how to recognize a continuation-start event without runner-specific parsing.
 *
 * @param {Job} job
 */
function observeInvocation(job) {
  if (job.closed || job.invocation.continuationId) return;
  try {
    const monitored = monitorInvocation(job);
    if (!monitored.continuationId) return;
    job.invocation = {
      ...job.invocation,
      continuationId: monitored.continuationId,
      updatedAt: new Date().toISOString(),
    };
    job.onInvocationUpdate?.(job.invocation);
  } catch {
    // monitorInvocation already swallows its own IO, so the only thing left that
    // can throw here is the caller's onInvocationUpdate: observing a continuation
    // id must not be able to kill the job that is being observed.
  }
}
/**
 * @param {string} path
 */
function signalGate(path) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${Date.now()}\n`, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * @param {Job|{gateConfigPath: string, gateReleasePath: string}} job
 */
function cleanupGate(job) {
  for (const path of [job.gateConfigPath, job.gateReleasePath]) {
    try { unlinkSync(path); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
/**
 * @param {Job|undefined} job
 * @param {TerminateOptions} options
 * @returns {Promise<void>}
 */
export async function terminateProcess(job, options = {}) {
  if (!job) return;
  if (job.terminating) return job.terminating;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  job.terminating = (async () => {
    const invocation = job.invocation;
    if (!invocationOwned(invocation, { child: job.child })) {
      noteUnverifiableIdentity(job, invocation);
      return;
    }
    if (!signalInvocation(invocation, "SIGTERM", { child: job.child, kill: options.kill })) return;
    if (await waitForJobTermination(job, invocation, graceMs)) return;
    if (options.escalate !== false && process.platform !== "win32") {
      if (!signalInvocation(invocation, "SIGKILL", { child: job.child, kill: options.kill })) return;
    }
    if (await waitForJobTermination(job, invocation, options.killGraceMs ?? graceMs)) return;
    throw new Error(`provider invocation ${invocation.id} did not terminate`);
  })();
  try {
    await job.terminating;
  } finally {
    job.terminating = null;
  }
}
/**
 * @param {InvocationProbe & {id?: string}|undefined} invocation
 * @param {TerminateOptions} options
 * @returns {Promise<void>}
 */
export async function terminateInvocation(invocation, options = {}) {
  if (!invocation) return;
  if (!invocationOwned(invocation, options)) {
    if (options.runDir && invocationAlive(invocation)) recordIdentityUnverifiable(options.runDir, invocation);
    return;
  }
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  if (!signalInvocation(invocation, "SIGTERM", options)) return;
  if (await waitForInvocationDeath(invocation, graceMs)) return;
  if (options.escalate !== false && process.platform !== "win32") {
    if (!signalInvocation(invocation, "SIGKILL", options)) return;
  }
  if (!await waitForInvocationDeath(invocation, options.killGraceMs ?? graceMs)) {
    throw new Error(`provider invocation ${invocation.id} did not terminate`);
  }
}
/**
 * The timeout codes whose attempt workspace is sealed before the provider is
 * killed. Every other retry path already cuts the next attempt from the
 * previous attempt's seal (`dispatch.mjs`'s `sealPreviousAttempt`); without
 * sealing here, a timeout parks with an empty seal and the recorded work is
 * abandoned in a worktree the next attempt never reads.
 */
const SEAL_BEFORE_KILL_CODES = new Set(["wall_clock_timeout", "stall_timeout"]);

/**
 * How long a `SIGSTOP`ped process group is given to actually stop before the
 * seal begins. The stop is asynchronous; this bounded settle keeps the seal
 * from racing a provider that has not yet been suspended. It is deliberately
 * short: the seal's own git timeout is the outer bound.
 */
const QUIESCE_SETTLE_MS = 50;

/**
 * The stall threshold one invocation is judged by: the runtime's own declared
 * `stallTimeoutSec`, else the contract value. Validation guarantees a present
 * runtime value is a positive finite number (`contract/runtime.mjs`), and the
 * contract value is positive by construction, so this always returns a usable
 * number.
 *
 * @param {unknown} runtime
 * @param {ValidatedContract} contract
 * @returns {number}
 */
export function stallTimeoutSecFor(runtime, contract) {
  const declared = /** @type {{stallTimeoutSec?: unknown}} */ (runtime ?? {}).stallTimeoutSec;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : contract.stallTimeoutSec;
}

/**
 * Freeze the provider process group so it cannot write while the attempt is
 * sealed. Returns true when a `SIGSTOP` was sent. On win32 there is no
 * process-group stop, so the seal races a live writer and the bounded git
 * timeout is what keeps it from hanging.
 *
 * @param {InvocationProbe & {id?: string}} invocation
 * @param {{child?: ChildProcess|null}} [options]
 * @returns {boolean}
 */
function quiesceInvocation(invocation, options = {}) {
  if (process.platform === "win32" || !invocationOwned(invocation, options)) return false;
  const target = invocation.processGroupId ?? invocation.pid;
  if (target === null || target === undefined) return false;
  try {
    process.kill(-target, "SIGSTOP");
    return true;
  } catch (error) {
    if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") throw error;
    return false;
  }
}

/**
 * Release a process group frozen by `quiesceInvocation` so the subsequent
 * `terminateProcess` signal can be delivered. A stopped process holds `SIGTERM`
 * pending until it is continued, so this must run before the kill.
 *
 * @param {InvocationProbe & {id?: string}} invocation
 */
function resumeInvocation(invocation) {
  if (process.platform === "win32") return;
  const target = invocation.processGroupId ?? invocation.pid;
  if (target === null || target === undefined) return;
  try {
    process.kill(-target, "SIGCONT");
  } catch (error) {
    // ESRCH: the group is already gone. EPERM: it is not one this user owns, so
    // there is nothing to resume.
    if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") throw error;
  }
}

/**
 * The pre-termination seam, filled: on `wall_clock_timeout` and `stall_timeout`
 * quiesce the provider, seal the attempt worktree, and only then let the caller
 * terminate it, so the next attempt is cut from the seal. The seal is bounded
 * by the same git timeout every synchronous git call uses
 * (`GIT_SYNC_TIMEOUT_MS`, overridable with `FABERUN_GIT_TIMEOUT_MS`);
 * when the provider holds `index.lock` or the seal otherwise fails, the
 * declared outcome is to skip the seal, record `worktree.sealError`, and let
 * the termination proceed — never to hang. An attempt with nothing to seal is
 * left with no `sealedSha`, so phase 2's automatic retry parks it as before.
 *
 * @param {Job} job
 * @param {{code: string, message: string}} timeout
 * @returns {Promise<void>}
 */
export async function sealBeforeTerminate(job, timeout) {
  if (!SEAL_BEFORE_KILL_CODES.has(timeout.code)) return;
  const path = attemptWorkspace(job.state);
  if (!path || !job.state.worktree?.branch || !job.state.worktree.baseSha) return;
  const runDir = dirname(dirname(job.paths.stdout));
  const quiesced = quiesceInvocation(job.invocation, { child: job.child });
  try {
    if (quiesced) await new Promise((resolve) => setTimeout(resolve, QUIESCE_SETTLE_MS));
    const sealed = sealAttempt({
      repo: job.contract.cwd,
      path,
      baseSha: job.state.worktree.baseSha,
      runId: job.contract.id,
      nodeId: job.node.id,
      attempt: job.state.attempt,
    });
    job.state.worktree = {
      ...job.state.worktree,
      status: "ready",
      commit: sealed.sha,
      // An empty seal is not work: leaving `sealedSha` unset keeps the
      // timeout codes on the parking path phase 2 requires.
      ...(sealed.empty ? {} : { sealedSha: sealed.sha }),
      sealError: null,
    };
    writeNodeSnapshot(runDir, job.state);
  } catch (error) {
    job.state.worktree = {
      ...job.state.worktree,
      sealError: errorMessage(error),
    };
    writeNodeSnapshot(runDir, job.state);
  } finally {
    if (quiesced) resumeInvocation(job.invocation);
  }
}

/**
 * @param {ValidatedContract} contract
 * @param {Map<string, Job>} running
 * @param {(job: Job, outcome: "exhausted"|"stalled", error: {code: string, message: string}) => Promise<void>} onTimeout
 * @param {(job: Job) => Promise<void>|void} [onProgress]
 * @param {(job: Job, timeout: {code: string, message: string}) => Promise<void>|void} [onBeforeTerminate] invoked before the kill; defaults to the phase 5b seal
 */
export async function detectStalls(contract, running, onTimeout, onProgress, onBeforeTerminate = sealBeforeTerminate) {
  const now = process.hrtime.bigint();
  for (const [nodeId, job] of running) {
    const budgetSec = latestTimeoutSec(job.state, job.node.timeoutSec ?? contract.timeoutSec);
    if (elapsedSeconds(job.startedTicks, now) >= budgetSec) {
      const timeout = {
        code: "wall_clock_timeout",
        message: `${job.phase} ran longer than ${budgetSec}s`,
      };
      await onBeforeTerminate(job, timeout);
      await terminateProcess(job);
      running.delete(nodeId);
      await onTimeout(job, "exhausted", timeout);
      continue;
    }
    // Progress is a provider event, not an mtime: a streamed turn that keeps
    // calling tools is alive even when it writes no workspace file, and a
    // buffered harness (zcode's `--json`) writes its whole transcript only at
    // exit, so its mtime proves nothing. A harness that never streams is
    // stall-tracked only when its runtime declares its own threshold; otherwise
    // the wall clock above is the only budget it is held to.
    const streaming = harnessCapabilities(job.runtime).streamsOutput;
    const declaredStall = typeof (/** @type {{stallTimeoutSec?: unknown}} */ (job.runtime)?.stallTimeoutSec) === "number";
    if (!streaming && !declaredStall) continue;
    const stallTimeoutSec = stallTimeoutSecFor(job.runtime, contract);
    if (streaming) {
      const monitored = monitorInvocation(job);
      const events = monitored.turns + monitored.toolCalls;
      if (events !== job.lastEventCount || job.observedOnce !== true) {
        job.lastEventCount = events;
        job.progressTicks = now;
        // `lastOutputAt` is the supervised controller's provider-progress
        // signal (scheduler.mjs): keep it advancing for an event that counts
        // as liveness, not only for an mtime that no longer does.
        job.lastOutputAt = Date.now();
      }
    } else if (job.observedOnce !== true) {
      job.progressTicks = now;
      job.lastOutputAt = Date.now();
    }
    job.observedOnce = true;
    if (elapsedSeconds(job.progressTicks, now) < stallTimeoutSec) continue;
    const timeout = {
      code: "stall_timeout",
      message: `no provider progress for ${stallTimeoutSec}s`,
    };
    await onBeforeTerminate(job, timeout);
    await terminateProcess(job);
    running.delete(nodeId);
    await onTimeout(job, "stalled", timeout);
  }
}
/**
 * @param {InvocationProbe|undefined} invocation
 * @returns {boolean}
 */
export function invocationAlive(invocation) {
  if (!invocation?.pid || !Number.isInteger(invocation.pid)) return false;
  let leaderAlive = false;
  try {
    process.kill(invocation.pid, 0);
    leaderAlive = true;
  } catch (error) {
    leaderAlive = errorCode(error) === "EPERM";
  }
  if (leaderAlive) return processStartTokenMatches(invocation);
  if (!processGroupAlive(invocation.processGroupId ?? null)) return false;
  return processStartTokenMatches(invocation);
}
/**
 * @param {{stdoutPath: string}} invocation
 * @param {HarnessRuntime} runtime
 * @param {import("../harnesses/index.mjs").NormalizeOptions} options
 * @returns {PricedEnvelope|null}
 */
export function invocationResult(invocation, runtime, options = {}) {
  try {
    const stdout = boundedRegion(invocation.stdoutPath);
    const envelope = normalizeProviderResult(runtime, stdout, options.exitCode ?? 0, options.signal ?? null, options);
    // Price before returning: recovery threads this envelope through its own
    // RecoveryOutcome objects, so the priced fields must be final here rather
    // than recomputed by any caller.
    const priced = priceUsage(runtime, envelope.usage, envelope.costUsd);
    return { ...envelope, costUsd: priced.costUsd, costProvenance: priced.costProvenance };
  } catch {
    return null;
  }
}
/** @typedef {{inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number}} RuntimePricing */
/**
 * Price one invocation's canonical counters against the runtime's declared
 * rates. Pure: it reads no clock, disk, or process, and a harness-reported
 * cost -- including a reported zero -- is returned untouched, never re-derived,
 * because provider evidence always wins.
 *
 * A cost is `priced` only when every one of the three counters is a number and
 * every one of those counters has a declared rate. A missing counter is a
 * missing measurement, not a zero contribution, so it keeps the whole record
 * `unknown` (`costUsd: null`) rather than understating it.
 *
 * When the runtime declares no pricing of its own, the rates fall back to the
 * vendored models.dev snapshot (`pricing-seed.mjs`) keyed by the runtime's
 * model, and a seed-priced invocation is exactly as `priced` as an
 * operator-declared one; a model the seed does not know stays unknown.
 *
 * It lives beside `invocationResult`, the second source point, rather than in
 * `run/usage.mjs`, which re-exports it: that module already imports this one,
 * so defining it here is what keeps the two source points acyclic.
 *
 * @param {unknown} runtime
 * @param {Usage|undefined} usage
 * @param {number|null|undefined} reportedCostUsd
 * @returns {{costUsd: number|null, costProvenance: "priced"|undefined}}
 */
export function priceUsage(runtime, usage, reportedCostUsd) {
  if (typeof reportedCostUsd === "number") return { costUsd: reportedCostUsd, costProvenance: undefined };
  const declaredRuntime = /** @type {{pricing?: RuntimePricing, model?: string}|null|undefined} */ (runtime);
  const pricing = declaredRuntime?.pricing ?? seedPricing(declaredRuntime?.model);
  if (!pricing) return { costUsd: null, costProvenance: undefined };
  /** @type {[number|null|undefined, number|undefined][]} */
  const terms = [
    [usage?.inputTokens, pricing.inputPerMTok],
    [usage?.cacheReadInputTokens, pricing.cachedInputPerMTok],
    [usage?.outputTokens, pricing.outputPerMTok],
  ];
  let total = 0;
  for (const [counter, rate] of terms) {
    if (typeof counter !== "number" || typeof rate !== "number") return { costUsd: null, costProvenance: undefined };
    total += counter * rate;
  }
  return { costUsd: total / 1_000_000, costProvenance: "priced" };
}
/**
 * Signal the invocation's process group only when ownership is proven. Never
 * throws: ESRCH is gone, EPERM is a group this user cannot signal and therefore
 * never spawned, and both mean the caller must treat the invocation as already
 * gone rather than crash the drive loop.
 *
 * @param {InvocationProbe & {id?: string}} invocation
 * @param {string} signal
 * @param {{child?: ChildProcess|null, kill?: (pid: number, signal: string|number) => unknown}} [options]
 * @returns {boolean} whether a signal was delivered
 */
function signalInvocation(invocation, signal, options = {}) {
  if (!invocationOwned(invocation, options)) return false;
  const pid = invocation.pid;
  if (pid === null || pid === undefined) return false;
  const target = process.platform === "win32" ? pid : -(invocation.processGroupId ?? pid);
  const kill = options.kill ?? process.kill;
  try {
    kill(target, signal);
    return true;
  } catch {
    // ESRCH: the process or group is already gone. EPERM: a group this user
    // cannot signal is not one this controller spawned. Neither is a controller
    // failure, so neither may escape as an exception.
    return false;
  }
}
/**
 * Record that a signal was withheld because ownership could not be proven, but
 * only while the raw probe still sees a leader or group: a genuinely gone
 * process needs no line.
 *
 * @param {Job} job
 * @param {InvocationProbe} invocation
 */
function noteUnverifiableIdentity(job, invocation) {
  if (!invocationAlive(invocation)) return;
  recordIdentityUnverifiable(runDirForJob(job), invocation);
}
/**
 * A job's log directory is `<runDir>/logs`, so two dirnames recover the run.
 *
 * @param {Job} job
 * @returns {string|null}
 */
function runDirForJob(job) {
  const stdout = job.paths?.stdout;
  return typeof stdout === "string" ? dirname(dirname(stdout)) : null;
}
/**
 * @param {string|null} runDir
 * @param {InvocationProbe} invocation
 */
function recordIdentityUnverifiable(runDir, invocation) {
  if (!runDir) return;
  try {
    appendJsonl(join(runDir, "events.jsonl"), {
      type: "invocation_identity_unverifiable",
      at: new Date().toISOString(),
      invocationId: /** @type {{id?: string}} */ (invocation).id ?? null,
      pid: invocation.pid,
      processGroupId: invocation.processGroupId ?? null,
    });
  } catch {
    // The line is diagnostic; a failed append must never turn "we declined to
    // signal an unverified group" into a controller crash.
  }
}
/**
 * @param {Job} job
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForJobClose(job, timeoutMs) {
  if (job.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const previous = job.onClose;
    job.onClose = (invocation) => {
      previous?.(invocation);
      clearTimeout(timer);
      resolve(true);
    };
  });
}
/**
 * @param {Job} job
 * @param {Invocation} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForJobTermination(job, invocation, timeoutMs) {
  const [closed, dead] = await Promise.all([
    waitForJobClose(job, timeoutMs),
    waitForInvocationDeath(invocation, timeoutMs),
  ]);
  return closed && dead;
}
/**
 * @param {InvocationProbe} invocation
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForInvocationDeath(invocation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!invocationAlive(invocation)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !invocationAlive(invocation);
}
/**
 * @param {bigint} fromTicks
 * @param {bigint} toTicks
 * @returns {number}
 */
function elapsedSeconds(fromTicks, toTicks) {
  return Number(toTicks - fromTicks) / 1e9;
}
/**
 * @param {string} runDir
 * @param {string} nodeId
 * @param {string} phase
 * @param {number} attempt
 * @returns {PathSet}
 */
export function logPaths(runDir, nodeId, phase, attempt) {
  const base = `${nodeId}.${attempt}.${phase}`;
  let stem = base;
  /**
   * @param {string} candidate
   * @returns {boolean}
   */
  const occupied = (candidate) => ["prompt", "jsonl", "err"].some((suffix) => existsSync(join(runDir, "logs", `${candidate}.${suffix}`)));
  for (let generation = 2; occupied(stem); generation += 1) stem = `${base}.r${generation}`;
  return {
    prompt: join(runDir, "logs", `${stem}.prompt`),
    stdout: join(runDir, "logs", `${stem}.jsonl`),
    stderr: join(runDir, "logs", `${stem}.err`),
  };
}
