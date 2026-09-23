/**
 * The provider transcript as the controller reads it: bounded tail reads at
 * settlement, incremental observation while the provider runs (the liveness
 * signal and the per-request ledger), and the drain at close. Separate from
 * process.mjs, which owns the process itself -- spawn, gate, kill, seal --
 * because reading the log never touches the process, and because process.mjs
 * crossed the 800-line ceiling carrying both jobs.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { SessionMetricsParser } from "../harnesses/session-metrics.mjs";
import { errorCode } from "../util.mjs";
import { join } from "node:path";

/** @typedef {import("./process.mjs").Job} Job */

const MAX_PROVIDER_LOG_BYTES = 512 * 1024;
/** Fixed-size read for incremental transcript observation. */
const MONITOR_CHUNK_BYTES = 64 * 1024;
/** Per-observation read budget: one tick never blocks on a huge backlog. */
const MONITOR_CALL_BUDGET_BYTES = 1024 * 1024;
/** Settlement drain bound: 64 budgets is 64 MiB, above the largest stored transcript (25.8 MB, measured 2026-09-20). */
const MONITOR_DRAIN_CALLS = 64;

/**
 * Observe the transcript incrementally: read only the bytes appended since
 * the last observation, in fixed-size chunks folded into a parser whose
 * retained state never scales with the unread length — so the metrics
 * survive both a transcript that outgrows any fixed window and an
 * already-large transcript on the first call after a controller restart.
 * The gate caps the log only at close, so byte offsets stay valid while the
 * provider is live. Only newline-terminated records are evidence; a
 * trailing partial record stays unconsumed for the next observation. The
 * generic metrics are zero for a provider that does not expose them.
 *
 * @param {Job} job
 * @returns {{continuationId: string|null, turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}}
 */
export function monitorInvocation(job) {
  try {
    const parser = job.monitorParser ?? (job.monitorParser = new SessionMetricsParser(job.runtime.harness));
    const size = statSync(job.paths.stdout).size;
    let offset = job.monitorOffset ?? 0;
    let budget = MONITOR_CALL_BUDGET_BYTES;
    if (size > offset) {
      const fd = openSync(job.paths.stdout, "r");
      try {
        const chunk = Buffer.alloc(MONITOR_CHUNK_BYTES);
        while (offset < size && budget > 0) {
          const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset, budget), offset);
          if (read <= 0) break;
          parser.push(chunk.subarray(0, read));
          offset += read;
          budget -= read;
        }
      } finally {
        closeSync(fd);
      }
      job.monitorOffset = offset;
    }
    return { continuationId: parser.continuationId, ...parser.metrics() };
  } catch {
    return { continuationId: null, turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false };
  }
}

/**
 * Drain what the live monitor has not read yet and return the per-request
 * ledger the transcript proves. Called at settlement, before any outcome is
 * decided: the gate caps the log to its last 512 KiB at close, so the head of
 * a long turn -- the requests that show how its context grew -- survives only
 * in what the monitor folded while the provider was alive (measured
 * 2026-09-20: 132 of 715 stored logs sit exactly at the cap). A harness the
 * monitor never observed (no live stream) is read here from offset zero.
 *
 * @param {Job} job
 * @returns {import("../harnesses/session-metrics.mjs").SessionLedger}
 */
export function sessionLedger(job) {
  for (let call = 0; call < MONITOR_DRAIN_CALLS; call += 1) {
    const before = job.monitorOffset ?? 0;
    monitorInvocation(job);
    if ((job.monitorOffset ?? 0) === before) break;
  }
  const parser = job.monitorParser ?? (job.monitorParser = new SessionMetricsParser(job.runtime.harness));
  parser.flush();
  return parser.session();
}

/**
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string}
 */
export function boundedRegion(path, maxBytes = MAX_PROVIDER_LOG_BYTES) {
  try {
    return dropPartialLogLine(readFileSync(`${path}.tail`, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(maxBytes);
    readSync(fd, bytes, 0, maxBytes, size - maxBytes);
    return dropPartialLogLine(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readBoundedTail(path, maxBytes = 512 * 1024) {
  try {
    try { return dropPartialLogLine(readFileSync(`${path}.tail`, "utf8")); } catch (tailError) {
      if (errorCode(tailError) !== "ENOENT") throw tailError;
    }
    const size = statSync(path).size;
    if (size <= maxBytes) return readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(maxBytes);
      readSync(fd, bytes, 0, maxBytes, size - maxBytes);
      return dropPartialLogLine(bytes.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function dropPartialLogLine(value) {
  const newline = String(value).indexOf("\n");
  return newline < 0 ? "" : String(value).slice(newline + 1);
}

/**
 * Newest write inside the attempt's provider log dir, 0 when nothing is there
 * yet. The CLI lays its session logs out as files (it may nest a directory),
 * so the scan walks three levels and reads only mtimes — never contents,
 * which is the monitor's job for streaming harnesses and nobody else's.
 * Every stat failure is an ordinary not-yet: a dir with nothing readable in
 * it proves no liveness, which is exactly the right answer.
 *
 * Cheap enough to run on every tick: measured 2026-09-22 on macOS, a dir of
 * 250 files across two levels scans in 0.80 ms, against the 1000 ms default
 * `pollIntervalMs` — so the cost is under a tenth of a percent of one job's
 * poll, and the scan reads no bytes.
 *
 * @param {string} dir
 * @param {number} [depth]
 * @returns {number}
 */
export function latestLogWriteMs(dir, depth = 0) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3) newest = Math.max(newest, latestLogWriteMs(path, depth + 1));
      continue;
    }
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      // Raced a rotation or a permission change: this entry proves nothing,
      // the rest of the scan still does.
    }
  }
  return newest;
}
