/**
 * The provider gate: a standalone program the controller spawns in the worker's
 * place, which holds the provider process until the controller writes the
 * release file. It exists so the controller can record an operation intent
 * before a single token is spent -- the gate is already the running process and
 * its pid is already persisted, so a crash between spawn and release leaves a
 * recoverable record rather than an unknown effect.
 *
 * It is spawned by path (`spawn(process.execPath, [gate.mjs])`), not imported,
 * and it talks to its parent only through the environment:
 *   FABERUN_GATE_CONFIG        the invocation to run, as JSON
 *   FABERUN_GATE_RELEASE       the file whose appearance releases it
 *   FABERUN_GATE_PARENT_PID    the controller it must not outlive
 *   FABERUN_GATE_PARENT_TOKEN  that pid's start token, so a reused pid
 *                                     is not mistaken for a live controller
 *
 * Until 2026-09-11 this was a `String.raw` template inside node.mjs, spawned
 * with `node -e`. As a real file it is covered by `npm run check` and by
 * `tsc` -- which found eleven type errors in it on the first run, none of them
 * reachable while the code was a string -- and it shows up in a stack trace.
 *
 * Nothing here is exported for a caller: this file is a program. Every name
 * below is module-local.
 *
 * It also exits when the release file's directory is gone (measured
 * 2026-09-16: gate processes from a prior day's test runs, spawned into a
 * temp directory the failed test never cleaned up, were still alive and
 * waiting for a release file that could now never appear), and it keeps
 * asking both of those questions after the provider starts, not only before.
 */
import { existsSync, readFileSync, statSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { NOTIFY_ENV_NAMES } from "../notify/index.mjs";
import { killTarget, spawnInvocation } from "../host/platform.mjs";

/** @typedef {{executable: string, args: string[], cwd: string, promptTransport: "stdin"|"argv", harness: string, env: Record<string, string|null>|null, stdoutPath: string, stderrPath: string}} GateConfig */

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** @type {GateConfig} */
const config = JSON.parse(readFileSync(requiredEnv("FABERUN_GATE_CONFIG"), "utf8"));
const releasePath = requiredEnv("FABERUN_GATE_RELEASE");
const parentPid = Number(process.env.FABERUN_GATE_PARENT_PID);
const parentToken = process.env.FABERUN_GATE_PARENT_TOKEN || null;
const maxLogBytes = 512 * 1024;

/**
 * @param {number} pid
 * @returns {string|null}
 */
function startToken(pid) {
  if (process.platform !== "linux" || !pid) return null;
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8").trim();
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

/** @returns {boolean} */
function parentAlive() {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error
      && /** @type {{code: unknown}} */ (error).code === "EPERM";
  }
  return !parentToken || process.platform !== "linux" || startToken(parentPid) === parentToken;
}

/** @type {import("node:child_process").ChildProcess|null} */
let provider = null;
let inputEnded = config.promptTransport !== "stdin";
/** @type {Buffer[]} */
const pendingInput = [];
if (config.promptTransport === "stdin") {
  process.stdin.on("data", (chunk) => {
    if (provider) provider.stdin?.write(chunk);
    else pendingInput.push(chunk);
  });
  process.stdin.on("end", () => {
    inputEnded = true;
    if (provider) provider.stdin?.end();
  });
}

/** @param {NodeJS.Signals} signal */
function killGroup(signal) {
  try {
    // `killTarget` reads the negative pid as the group on POSIX and as the tree
    // to walk on Windows, which has no group to signal.
    killTarget(-process.pid, signal);
  } catch {
    // ESRCH: the process group is already gone, so there is nothing to signal.
  }
}

function stopProvider() {
  try {
    // The tree, not the process: on Windows a harness installed as a `.cmd` is
    // reached through the command interpreter, so the provider this gate holds
    // is `cmd.exe` and the harness is its child. Killing the one it spawned
    // leaves the other running — measured 2026-09-20, as stranded `node`
    // processes outliving a suite that had already stopped waiting for them.
    if (provider?.pid) killTarget(provider.pid, "SIGTERM");
  } catch {
    // No provider yet, or it already exited: a failed SIGTERM needs no action.
  }
  setTimeout(() => killGroup("SIGKILL"), 100).unref();
}

/**
 * Providers write directly into the log files: a provider with non-blocking
 * stdout (EAGAIN on a full pipe) must never die because the controller's event
 * loop is briefly busy. Cap the files to the last maxLogBytes afterwards.
 *
 * @param {string} path
 * @param {boolean} [preservePrefix]
 */
function capLog(path, preservePrefix = false) {
  try {
    const size = statSync(path).size;
    if (size <= maxLogBytes) return;
    if (preservePrefix) {
      const prefixLimit = Math.min(64 * 1024, maxLogBytes - 1);
      const prefix = Buffer.alloc(prefixLimit);
      const prefixFd = openSync(path, "r");
      readSync(prefixFd, prefix, 0, prefixLimit, 0);
      closeSync(prefixFd);
      const prefixEnd = prefix.lastIndexOf(10);
      if (prefixEnd >= 0) {
        const tailLimit = maxLogBytes - prefixEnd - 1;
        const tail = Buffer.alloc(tailLimit);
        const tailFd = openSync(path, "r");
        readSync(tailFd, tail, 0, tailLimit, size - tailLimit);
        closeSync(tailFd);
        const tailStart = tail.indexOf(10);
        const suffix = tailStart >= 0 ? tail.subarray(tailStart + 1) : Buffer.alloc(0);
        const out = openSync(path, "w");
        writeSync(out, Buffer.concat([prefix.subarray(0, prefixEnd + 1), suffix]));
        closeSync(out);
        return;
      }
    }
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxLogBytes);
    readSync(fd, buffer, 0, maxLogBytes, size - maxLogBytes);
    closeSync(fd);
    const out = openSync(path, "w");
    writeSync(out, buffer);
    closeSync(out);
  } catch {
    // Best-effort cap: any filesystem error leaves the log uncapped, which is safe.
  }
}

/** @returns {Record<string, string|undefined>} */
function childEnv() {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  // Worker providers are not a notification surface: strip every controller-only
  // transport after the harness overlay so no harness can reintroduce one. The
  // list lives in `notify/index.mjs`, not here: this line once named
  // FABERUN_NOTIFY_BIN alone, and on 2026-09-21 a worker that inherited
  // FABERUN_NOTIFY_SESSION ran this repository's suite, whose fixture
  // controllers woke the operator's live session seven times in minutes.
  for (const name of NOTIFY_ENV_NAMES) delete merged[name];
  return merged;
}

process.on("SIGTERM", () => stopProvider());
process.on("SIGINT", () => stopProvider());

/** @returns {boolean} */
function releaseDirectoryGone() {
  return !existsSync(dirname(releasePath));
}

/**
 * How often the gate re-asks its two liveness questions once the provider is
 * running. Before release the tick below asks them every 10ms, because it is
 * also polling for the release file; after release it used to stop asking
 * entirely, leaving the provider's own exit as the gate's only remaining
 * liveness check. A controller that died without cleaning up, or a run
 * directory deleted underneath a live attempt, therefore left the provider
 * running with nobody watching -- the stranded-process shape ADR 0010
 * describes, in the one window the pre-release check does not cover.
 *
 * A second, not ten milliseconds: this watches a provider that runs for
 * minutes, and three syscalls a second is the whole cost of never stranding
 * one.
 */
const WATCHDOG_INTERVAL_MS = 1_000;

const timer = setInterval(() => {
  if (!parentAlive()) { clearInterval(timer); stopProvider(); return; }
  if (releaseDirectoryGone()) { clearInterval(timer); stopProvider(); return; }
  if (!existsSync(releasePath)) return;
  clearInterval(timer);
  const watchdog = setInterval(() => {
    if (parentAlive() && !releaseDirectoryGone()) return;
    clearInterval(watchdog);
    stopProvider();
  }, WATCHDOG_INTERVAL_MS);
  const stdoutFd = openSync(config.stdoutPath, "wx", 0o600);
  const stderrFd = openSync(config.stderrPath, "wx", 0o600);
  const invocation = spawnInvocation(config.executable, config.args, { cwd: config.cwd });
  provider = spawn(invocation.command, invocation.args, {
    cwd: config.cwd,
    env: childEnv(),
    stdio: [config.promptTransport === "stdin" ? "pipe" : "ignore", stdoutFd, stderrFd],
    ...invocation.options,
  });
  if (config.promptTransport === "stdin") {
    for (const chunk of pendingInput) provider.stdin?.write(chunk);
    pendingInput.length = 0;
    if (inputEnded) provider.stdin?.end();
  }
  provider.once("error", () => process.exitCode = 127);
  provider.once("close", (code) => {
    clearInterval(watchdog);
    capLog(config.stdoutPath, config.harness === "codex");
    capLog(config.stderrPath);
    process.exit(code ?? 1);
  });
}, 10);
