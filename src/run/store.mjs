import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { errorCode, sleepSync } from "../util.mjs";

const BOOTSTRAP_FILE = "bootstrap.json";
// Windows refuses to replace a file another process holds open: MoveFileEx
// answers EPERM (or EACCES, EBUSY) while a reader, an indexer or a virus
// scanner has the destination, where a POSIX rename replaces it regardless.
// Measured 2026-09-23 on Windows 11 with node 24: one process polling a file
// with readFileSync failed 882 of 2190 atomic writes onto it, and on CI that
// killed controllers mid-run (a heartbeat write threw out of driveRun). The
// retry and its bounds are graceful-fs's: back off 10 ms more per attempt up to
// 100 ms, and give up after 60 s.
const WINDOWS_RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_BUDGET_MS = 60_000;
const JSONL_RECOVERY_TAIL_BYTES = 64 * 1024;

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function readJson(path) {
  return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf8")));
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} path
 * @param {string} text
 */
export function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let committed = false;
  try {
    try {
      writeSync(fd, text, 0, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameReplacing(temporary, path);
    fsyncDirectory(dirname(path));
    committed = true;
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) {
      if (errorCode(cleanupError) !== "ENOENT") throw cleanupError;
    }
    throw error;
  } finally {
    if (!committed) {
      try { unlinkSync(temporary); } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function renameReplacing(from, to) {
  const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
  for (let backoff = 0; ; backoff = Math.min(backoff + 10, 100)) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const busy = process.platform === "win32" && WINDOWS_RENAME_BUSY.has(errorCode(error) ?? "");
      if (!busy || Date.now() >= deadline) throw error;
      sleepSync(backoff);
    }
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  recoverPartialJsonl(path);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} path
 */
function recoverPartialJsonl(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (size === 0) return;
  const window = Math.min(size, JSONL_RECOVERY_TAIL_BYTES);
  const fd = openSync(path, "r+");
  try {
    const buffer = Buffer.alloc(window);
    readSync(fd, buffer, 0, window, size - window);
    const tail = buffer.toString("utf8");
    if (tail.endsWith("\n")) return;
    const newline = tail.lastIndexOf("\n");
    const completeBytes = newline >= 0
      ? size - window + newline + 1
      : size <= JSONL_RECOVERY_TAIL_BYTES ? 0 : size - window;
    ftruncateSync(fd, completeBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} path
 */
export function fsyncDirectory(path) {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!(["EINVAL", "EPERM", "EISDIR"].includes(/** @type {string} */ (errorCode(error))))) throw error;
  }
}

/**
 * @param {string} runDir
 * @returns {string}
 */
export function bootstrapPath(runDir) {
  return join(runDir, BOOTSTRAP_FILE);
}

/**
 * @param {string} runDir
 * @param {string} nonce
 * @returns {string}
 */
export function bootstrapAttemptPath(runDir, nonce) {
  return join(runDir, `${BOOTSTRAP_FILE}.${nonce}`);
}

/**
 * @param {string} runDir
 * @param {string} nonce
 * @returns {string}
 */
export function bootstrapAckPath(runDir, nonce) {
  return join(runDir, `${BOOTSTRAP_FILE}.${nonce}.ack`);
}

/**
 * @param {string} runDir
 * @param {string|null} keepNonce
 */
export function cleanupBootstrapAttempts(runDir, keepNonce = null) {
  const prefix = `${BOOTSTRAP_FILE}.`;
  let names;
  try { names = readdirSync(runDir); } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !isBootstrapAttemptName(name)) continue;
    if (keepNonce && (name === `${prefix}${keepNonce}` || name === `${prefix}${keepNonce}.ack`)) continue;
    try { unlinkSync(join(runDir, name)); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isBootstrapAttemptName(name) {
  const rest = name.slice(`${BOOTSTRAP_FILE}.`.length);
  return /^[A-Za-z0-9-]{16,64}$/u.test(rest) || /^[A-Za-z0-9-]{16,64}\.ack$/u.test(rest);
}

