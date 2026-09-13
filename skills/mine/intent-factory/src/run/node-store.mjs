/**
 * The one place that knows where a node's snapshot lives on disk
 * (`<runDir>/nodes/<nodeId>.json`). Everything that persists or reads a node
 * snapshot goes through here so the path itself has a single owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "../util.mjs";
import { writeRunTextWithDiskPressureRetry } from "./disk-gc.mjs";
import { validateNodeSnapshot } from "../contract/snapshot.mjs";

/** @typedef {ReturnType<typeof import("./lock.mjs").acquire>} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */

const NODES_DIR_NAME = "nodes";

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {string}
 */
export function nodeSnapshotPath(runDir, nodeId) {
  return join(runDir, NODES_DIR_NAME, `${nodeId}.json`);
}

/**
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {LockHandle|null} [lock]
 */
export function writeNodeSnapshot(runDir, state, lock = null) {
  lock?.assert();
  validateNodeSnapshot(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) throw new Error("node snapshot exceeds 131072 bytes");
  writeRunTextWithDiskPressureRetry(runDir, nodeSnapshotPath(runDir, state.id), `${serialized}\n`);
}

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @returns {Record<string, unknown>}
 */
export function readNodeSnapshot(runDir, nodeId) {
  return JSON.parse(readFileSync(nodeSnapshotPath(runDir, nodeId), "utf8"));
}

/**
 * File names (`<nodeId>.json`) of every node snapshot persisted in this run.
 * A run directory with no `nodes/` yet reads as empty, not ENOENT.
 *
 * @param {string} runDir
 * @returns {string[]}
 */
export function listNodeSnapshots(runDir) {
  try {
    return readdirSync(join(runDir, NODES_DIR_NAME)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}
