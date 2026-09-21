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
 */
import { Buffer } from "node:buffer";
import { VERIFICATION_LIMITS, compactVerification, resolveVerificationCwd, validateVerificationCommands } from "../contract/verification.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { processStartToken } from "../run/lock.mjs";
import { randomUUID } from "node:crypto";
import { runMutation } from "./mutation.mjs";
import { spawn } from "node:child_process";
import { killTarget, spawnInvocation } from "../host/platform.mjs";
/** @typedef {import("../contract/verification.mjs").VerificationOptions} VerificationOptions */

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
 * @returns {Record<string, string|undefined>}
 */
function verificationEnv(command) {
  const names = new Set([...(command.env ?? []), ...VERIFICATION_ENV_BASE_NAMES]);
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
/**
 * Run every declared command `repeat` times inside the workspace.
 *
 * @param {unknown} commands
 * @param {string} baseCwd
 * @param {VerificationOptions} options
 * @returns {Promise<VerificationResult>}
 */
export async function runVerification(commands, baseCwd, options = {}) {
  const validated = validateVerificationCommands(commands);
  /** @type {VerificationCommandResult[]} */
  const results = [];
  for (const [commandIndex, command] of validated.entries()) {
    const result = command.mutation
      ? await runMutationCommand(command, baseCwd, commandIndex, options)
      : await runRepeatedCommand(command, baseCwd, commandIndex, options);
    results.push(result);
    if (options.logDir) {
      mkdirSync(options.logDir, { recursive: true });
      writeFileSync(`${options.logDir}/verification-${results.length}.json`, `${JSON.stringify(compactVerification({ passed: result.passed, commands: [result] }))}\n`, { mode: 0o600 });
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
 * @param {VerificationOptions} options
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
 * @param {VerificationOptions} options
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
 * @param {VerificationOptions} options
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
