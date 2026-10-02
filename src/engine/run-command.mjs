/**
 * Running a verification command and bounding what comes back.
 *
 * The controller runs each command itself, in the attempt workspace, with a
 * deliberately narrow environment (`VERIFICATION_ENV_BASE_NAMES`): a worker must
 * not be able to make a suite pass by exporting something. Output is captured
 * head-and-tail rather than whole, because a fuzz log will happily fill a disk,
 * and the process is killed by group so a test runner's children die with it.
 *
 * The schema for what may be run lives in `contract/verification.mjs`; this is
 * only the doing.
 *
 * A pass interrupted mid-list restarts every command on resume (review
 * 2026-09-29: an interrupted verification re-runs the whole list, and the
 * engine's own suite costs 1035-1058s per full pass — `VERIFICATION_LIMITS.maxTimeoutSec`).
 * Each completed command therefore also writes a checkpoint beside its log,
 * `checkpoint-<ordinal>.json`: the identity hash of everything the proof
 * depends on — workspace tree fingerprint, validated command, exact child
 * environment, dependency-inputs hash — plus the bounded result. A resumed
 * pass serves a checkpoint only when that identity is unchanged and the tree
 * actually carried a fingerprint; any difference forces re-execution. A
 * mutation entry is the explicit invalidation policy: it is never checkpointed
 * and never served, because its proof is a function of the tree it breaks and
 * restores, so a reused record could certify a tree that no longer exists.
 */
import { Buffer } from "node:buffer";
import { VERIFICATION_LIMITS, commandCheckpointIdentity, compactVerification, parseCommandCheckpoint, resolveVerificationCwd, validateVerificationCommands } from "../contract/verification.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { processStartToken } from "../run/lock.mjs";
import { createHash, randomUUID } from "node:crypto";
import { runMutation } from "./mutation.mjs";
import { SANDBOX_BLOCKED_WRITE } from "../contract/worker-result.mjs";
import { isAbsolute, join, resolve } from "node:path";
import { isContained } from "../util.mjs";
import { spawn } from "node:child_process";
import { killTarget, spawnInvocation } from "../host/platform.mjs";
import { gitIdentity } from "../repo/source-identity.mjs";
/** @typedef {import("../contract/verification.mjs").VerificationOptions} VerificationOptions */

/**
 * The run-level options plus the sandbox mode the caller knows. The mode is not
 * part of the shared verification contract: it is controller environment, read
 * here only to name a refusal the command itself cannot.
 *
 * @typedef {VerificationOptions & {sandboxMode?: string|null}} RunVerificationOptions
 */

/**
 * The named classification of a `workspace-write` refusal outside the worktree,
 * carrying the mode that caused it and the path that was denied.
 *
 * @typedef {{classification: "sandbox_blocked_write", mode: string, path: string}} SandboxBlockedWrite
 */

/**
 * A bounded attempt result plus the controller's sandbox classification, which
 * rides beside the captured output only when a refusal was recognized.
 *
 * @typedef {VerificationAttemptResult & {attempt: number, sandboxBlockedWrite?: SandboxBlockedWrite}} SandboxAwareAttemptResult
 */

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {import("../contract/verification.mjs").VerificationAttempt} VerificationAttempt */
/** @typedef {import("../contract/verification.mjs").VerificationAttemptResult} VerificationAttemptResult */
/** @typedef {import("../contract/verification.mjs").VerificationCommand} VerificationCommand */
/** @typedef {import("../contract/verification.mjs").VerificationCommandResult} VerificationCommandResult */
/** @typedef {import("../contract/verification.mjs").VerificationResult} VerificationResult */

// Verification children receive only the declared environment-variable names
// plus a minimal base set needed to spawn a process. Ambient controller
// variables (including secrets) must never leak into verification commands.
const VERIFICATION_ENV_BASE_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

/**
 * @param {VerificationCommand} command
 * @returns {Record<string, string>}
 */
function verificationEnv(command) {
  const names = new Set([...(command.env ?? []), ...VERIFICATION_ENV_BASE_NAMES]);
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// `workspace-write` denies a toolchain's cache in `$HOME` and the tool reports
// a read-only filesystem: observed 2026-09-22 with Zig under `dsh`,
// `manifest_create ReadOnlyFileSystem` before its first source file. The
// sandbox, not the command, is the cause, so the controller names it. `EROFS`
// and the POSIX message cover the same refusal from other runners.
const SANDBOX_READ_ONLY_PATTERN = /ReadOnlyFileSystem|EROFS|read-only file system/iu;
// A denied path is usually quoted (`unable to load '/path': ReadOnlyFileSystem`)
// or bare after the operation name; either way it is absolute, since only an
// effect outside the worktree gets refused.
const ABSOLUTE_PATH_PATTERNS = Object.freeze([/['"]((?:[A-Za-z]:[\\/]|\/)[^'"]+)['"]/gu, /((?:[A-Za-z]:[\\/]|\/)[^\s'",;:)\]]+)/gu]);

/**
 * Classify a failed command whose output names a read-only-filesystem refusal
 * outside the worktree, under `workspace-write`. Returns null for any other
 * mode, a refusal inside the worktree, or output with no path to name.
 *
 * @param {{text?: string, workspace: string, mode?: string|null}} args
 * @returns {SandboxBlockedWrite|null}
 */
export function classifySandboxBlockedWrite({ text, workspace, mode }) {
  if (mode !== "workspace-write" || typeof text !== "string") return null;
  const lines = text.split(/\r?\n/u);
  const markerLines = lines.filter((line) => SANDBOX_READ_ONLY_PATTERN.test(line));
  if (markerLines.length === 0) return null;
  // Prefer a path the refusal line itself names; fall back to any path in the
  // output, since `manifest_create ReadOnlyFileSystem` can put the path on a
  // neighbouring line.
  for (const line of [...markerLines, ...lines]) {
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const candidate = match[1];
        const path = isAbsolute(candidate) ? candidate : resolve(workspace, candidate);
        if (!isContained(workspace, path)) return { classification: SANDBOX_BLOCKED_WRITE, mode, path };
      }
    }
  }
  return null;
}
/**
 * Everything one pass needs to decide checkpoint reuse, cached per pass: the
 * tree fingerprint per command cwd (one bounded `gitIdentity` each, paid only
 * when a checkpoint directory is in play) and the dependency-inputs hash (the
 * packet's writeFiles do not change during a pass; a mutation entry restores
 * them in `finally`).
 *
 * @typedef {{trees: Map<string, string|null>, dependencyHash: string|undefined}} CheckpointCaches
 */

/**
 * A hash over the dependency inputs a proof is about: the packet's writeFiles,
 * the mutation sample's input. ReadFiles and every other tracked or untracked
 * source ride inside the tree fingerprint instead; installed dependencies that
 * git ignores (a mid-attempt `npm ci`) are covered only when the packet
 * declares them here — a known bound, not a solved one.
 *
 * @param {string} baseCwd
 * @param {string[]} writeFiles
 * @returns {string}
 */
function dependencyInputsHash(baseCwd, writeFiles) {
  const hash = createHash("sha256");
  for (const path of [...new Set(writeFiles)].sort()) {
    hash.update(`${path}\0`);
    try {
      hash.update(readFileSync(resolve(baseCwd, path)));
    } catch {
      // ENOENT or a non-file: the mutation sampler skips the same paths, so a
      // missing dependency input hashes as missing rather than failing the pass.
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The pre-run identity of one command's proof, plus whether the tree gave a
 * fingerprint to compare at all: a workspace that is not a git repository has
 * no tree identity, so its checkpoints never serve.
 *
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {RunVerificationOptions} options
 * @param {CheckpointCaches} caches
 * @returns {{identity: string, reusable: boolean}}
 */
function checkpointIdentity(command, baseCwd, options, caches) {
  const workspace = resolveVerificationCwd(baseCwd, command.cwd ?? ".");
  let treeFingerprint = caches.trees.get(workspace);
  if (treeFingerprint === undefined) {
    treeFingerprint = gitIdentity(workspace).dirtyTreeFingerprint;
    caches.trees.set(workspace, treeFingerprint);
  }
  if (caches.dependencyHash === undefined) {
    caches.dependencyHash = dependencyInputsHash(baseCwd, options.writeFiles ?? []);
  }
  return {
    identity: commandCheckpointIdentity({ treeFingerprint, command, env: verificationEnv(command), dependencyHash: caches.dependencyHash }),
    reusable: treeFingerprint !== null,
  };
}

/**
 * The recorded result for this ordinal, served only when the checkpoint
 * validates, the tree carried a fingerprint, and the identity is unchanged.
 * Every read or parse failure lands on re-execution: a corrupted checkpoint is
 * never a verdict on the command and never fatal to the pass.
 *
 * @param {string} logDir
 * @param {number} ordinal
 * @param {{identity: string, reusable: boolean}} identity
 * @returns {VerificationCommandResult|null}
 */
function servedCheckpoint(logDir, ordinal, identity) {
  try {
    const parsed = parseCommandCheckpoint(JSON.parse(readFileSync(join(logDir, `checkpoint-${ordinal}.json`), "utf8")));
    if (!identity.reusable || parsed.identity !== identity.identity) return null;
    return parsed.result;
  } catch {
    // ENOENT is the no-checkpoint case; every other failure (corrupt JSON, a
    // record past its bounds) fails closed to a re-run for the same reason.
    return null;
  }
}
/**
 * Run every declared command `repeat` times inside the workspace.
 *
 * @param {unknown} commands
 * @param {string} baseCwd
 * @param {RunVerificationOptions} options
 * @returns {Promise<VerificationResult>}
 */
export async function runVerification(commands, baseCwd, options = {}) {
  const validated = validateVerificationCommands(commands);
  /** @type {VerificationCommandResult[]} */
  const results = [];
  /** @type {CheckpointCaches|null} */
  const checkpoints = options.logDir ? { trees: new Map(), dependencyHash: undefined } : null;
  for (const [commandIndex, command] of validated.entries()) {
    // Identity before the run: a checkpoint records the tree, environment and
    // dependency inputs the proof was made against, which are the pre-run ones.
    const identity = checkpoints && !command.mutation
      ? checkpointIdentity(command, baseCwd, options, checkpoints)
      : null;
    const reused = identity
      ? servedCheckpoint(/** @type {string} */ (options.logDir), results.length + 1, identity)
      : null;
    const result = reused ?? await (command.mutation
      ? runMutationCommand(command, baseCwd, commandIndex, options)
      : runRepeatedCommand(command, baseCwd, commandIndex, options));
    results.push(result);
    if (options.logDir) {
      mkdirSync(options.logDir, { recursive: true });
      const compacted = compactVerification({ passed: result.passed, commands: [result] });
      writeFileSync(`${options.logDir}/verification-${results.length}.json`, `${JSON.stringify(compacted)}\n`, { mode: 0o600 });
      // A mutation entry records no checkpoint (the invalidation policy in the
      // header); an argv past the persisted bounds compacts to no command, and
      // its unreadable record simply fails closed to a re-run on resume.
      if (identity) {
        writeFileSync(`${options.logDir}/checkpoint-${results.length}.json`, `${JSON.stringify({ identity: identity.identity, result: compacted })}\n`, { mode: 0o600 });
      }
    }
  }
  return { passed: results.every((result) => result.passed), commands: results };
}
/**
 * The ordinary case: run the argv `repeat` times and pass when every attempt does.
 *
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {number} commandIndex
 * @param {RunVerificationOptions} options
 * @returns {Promise<VerificationCommandResult>}
 */
async function runRepeatedCommand(command, baseCwd, commandIndex, options) {
  /** @type {VerificationAttemptResult[]} */
  const attempts = [];
  const repeat = command.repeat ?? 1;
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const result = await runCommand(command, baseCwd, command.cwd ?? ".", attempt, options.signal, options, commandIndex);
    if (signalDeathRetry(result, options.signal)) {
      attempts.push({ ...result, signalDeath: true });
      attempts.push(await runCommand(command, baseCwd, command.cwd ?? ".", attempt, options.signal, options, commandIndex));
    } else {
      attempts.push(result);
    }
  }
  const passed = attempts.filter((item) => !item.signalDeath).every((item) => item.passed);
  return { ...command, cwd: resolveVerificationCwd(baseCwd, command.cwd ?? "."), passed, attempts };
}
/**
 * Whether an attempt died from a signal the controller itself did not send.
 * `terminateGroup` only fires from the timeout and abort paths below, so a
 * `signal` with neither set is evidence of an external kill (OOM, an operator
 * `kill`, a flaky sandbox) rather than a verdict on the command under test,
 * and gets one retry instead of failing the node outright.
 *
 * @param {VerificationAttemptResult} result
 * @param {AbortSignal|undefined} signal
 * @returns {boolean}
 */
function signalDeathRetry(result, signal) {
  return Boolean(result.signal) && !result.timedOut && !signal?.aborted;
}
/**
 * The mutation case: the entry passes on the mutant-kill fraction, and every
 * attempt is a real run of the same argv against one broken file.
 *
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {number} commandIndex
 * @param {RunVerificationOptions} options
 * @returns {Promise<VerificationCommandResult>}
 */
async function runMutationCommand(command, baseCwd, commandIndex, options) {
  const commandCwd = command.cwd ?? ".";
  const outcome = await runMutation(command, baseCwd, {
    writeFiles: options.writeFiles ?? [],
    run: (attempt) => runCommand(command, baseCwd, commandCwd, attempt, options.signal, options, commandIndex),
  });
  return { ...command, cwd: resolveVerificationCwd(baseCwd, commandCwd), passed: outcome.passed, attempts: outcome.attempts };
}
/**
 * @param {VerificationCommand} command
 * @param {string} baseCwd
 * @param {string} commandCwd
 * @param {number} attempt
 * @param {AbortSignal|undefined} signal
 * @param {RunVerificationOptions} options
 * @param {number} commandIndex
 * @returns {Promise<VerificationAttemptResult>}
 */
function runCommand(command, baseCwd, commandCwd, attempt, signal, options, commandIndex) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const stdout = boundedTail(VERIFICATION_LIMITS.stdoutBytes);
    const stderr = boundedTail(VERIFICATION_LIMITS.stderrBytes);
    let settled = false;
    let timedOut = false;
    /** @type {import("node:child_process").ChildProcess|null} */
    let child = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {(() => void)|null} */
    let abortHandler = null;
    /** @type {VerificationAttempt|null} */
    let identity = null;
    let completionReported = false;
    /**
     * @param {number|null} exitCode
     * @param {string|null} signalName
     * @param {Error|null} error
     */
    const finish = (exitCode, signalName, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      if (child?.pid && !error && !signalName && !timedOut) terminateGroup(child);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      /** @type {SandboxAwareAttemptResult} */
      const result = {
        attempt,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Math.round(durationMs * 100) / 100,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signalName ?? null,
        timedOut,
        error: error ? String(error.message ?? error) : null,
        passed: !error && !timedOut && exitCode === 0 && !signalName,
      };
      // The controller's own sandbox mode bounds where a toolchain may write;
      // a caller may name it, and a controller launched under `dsh` inherits it
      // in `DSH_PERMISSION_MODE`. Only `workspace-write` classifies.
      if (!result.passed) {
        const sandboxBlockedWrite = classifySandboxBlockedWrite({
          text: `${result.stdout}\n${result.stderr}`,
          workspace: resolve(baseCwd, commandCwd),
          mode: options?.sandboxMode ?? process.env.DSH_PERMISSION_MODE ?? null,
        });
        if (sandboxBlockedWrite) result.sandboxBlockedWrite = sandboxBlockedWrite;
      }
      if (!completionReported && identity) {
        completionReported = true;
        try { options?.onAttemptComplete?.({ ...identity, status: result.passed ? "closed" : "failed", completedAt: new Date().toISOString(), result }); } catch {
          // Notification callback: any error it throws must not change the recorded result.
        }
      }
      resolveResult(result);
    };
    /**
     * The timeout and abort paths settle here, never on `close`: a grandchild
     * that escaped the process group can hold the stdout pipe open forever, so
     * waiting for `close` would park the loop's critical path on a process that
     * will never report. Kill the group, destroy the pipes, and settle now.
     *
     * @param {"timeout"|"abort"} reason
     */
    const settleFromTimer = (reason) => {
      if (settled) return;
      timedOut = reason === "timeout";
      if (child?.pid) terminateGroup(child);
      try { child?.stdout?.destroy(); } catch {
        // The stream already closed; destroying it again is a no-op.
      }
      try { child?.stderr?.destroy(); } catch {
        // The stream already closed; destroying it again is a no-op.
      }
      finish(null, null, reason === "abort" ? new Error("verification command aborted") : null);
    };
    try {
      const cwd = resolveVerificationCwd(baseCwd, commandCwd);
      const startedAt = new Date().toISOString();
      identity = {
        invocationId: randomUUID(), commandIndex, attempt, pid: null, processStartToken: null, processGroupId: null,
        startedAt, deadlineAt: new Date(Date.parse(startedAt) + (command.timeoutSec ?? 120) * 1_000).toISOString(), status: "active",
      };
      options?.onAttemptStart?.({ ...identity });
      const env = verificationEnv(command);
      // A verification command names a binary the same way a harness runtime
      // does, and on Windows `npm test` is `npm.cmd`: the invocation, not the
      // raw argv, is what can actually be spawned there.
      const invocation = spawnInvocation(command.argv[0], command.argv.slice(1), { cwd });
      child = spawn(invocation.command, invocation.args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], ...invocation.options });
      const pid = child.pid ?? null;
      let paused = false;
      if (process.platform !== "win32" && pid) {
        try { process.kill(-pid, "SIGSTOP"); paused = true; } catch {
          // ESRCH: the child may have exited between spawn and the stop; not pausing is safe.
        }
      }
      Object.assign(identity, { pid, processStartToken: processStartToken(pid), processGroupId: process.platform === "win32" ? null : pid });
      options?.onAttemptSpawn?.({ ...identity });
      if (paused && pid) {
        try { process.kill(-pid, "SIGCONT"); } catch {
          // ESRCH: the child is already gone, so there is nothing to resume.
        }
      }
      const childStdout = /** @type {import("node:stream").Readable} */ (child.stdout);
      const childStderr = /** @type {import("node:stream").Readable} */ (child.stderr);
      childStdout.on("data", (chunk) => stdout.add(chunk));
      childStderr.on("data", (chunk) => stderr.add(chunk));
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signalName) => finish(code, signalName));
      abortHandler = () => settleFromTimer("abort");
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
    } catch (error) {
      if (child?.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGCONT"); } catch {
          // ESRCH: best-effort resume of a paused child that may already be gone.
        }
      }
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
    }
    if (child && !settled) timer = setTimeout(() => settleFromTimer("timeout"), (command.timeoutSec ?? 120) * 1_000);
  });
}
/**
 * @param {import("node:child_process").ChildProcess} child
 */
function terminateGroup(child) {
  try {
    killTarget(process.platform === "win32" ? /** @type {number} */ (child.pid) : -/** @type {number} */ (child.pid), "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {
      // ESRCH: the group kill failed and the leader was already gone.
    }
  }
  setTimeout(() => {
    try {
      killTarget(process.platform === "win32" ? /** @type {number} */ (child.pid) : -/** @type {number} */ (child.pid), "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch {
        // ESRCH: the SIGKILL fallback found no leader left to kill.
      }
    }
  }, 100).unref();
}
/**
 * @param {number} maxBytes
 */
function boundedTail(maxBytes) {
  let value = Buffer.alloc(0);
  return {
    /**
     * @param {string|Buffer} chunk
     */
    add(chunk) {
      value = Buffer.concat([value, Buffer.from(chunk)]);
      if (value.length > maxBytes) {
        let start = value.length - maxBytes;
        while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
        value = value.subarray(start);
      }
    },
    value: () => value.toString("utf8"),
  };
}
