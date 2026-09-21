/**
 * Recording and envelope builders shared by the replay tests, split out when
 * `replay.test.mjs` was cut into the adapter half and the whole-run half.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
export function envelope(overrides = {}) {
  return {
    status: "done",
    result: "ok",
    continuationId: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
    costUsd: null,
    error: null,
    ...overrides,
  };
}

/** @param {string} summary @returns {Record<string, unknown>} */
export function workerResult(summary) {
  return { status: "done", summary, verification: [], artifacts: [], missingContext: [] };
}

/** @param {string} directory @param {unknown[]} lines @param {string} [name] @returns {string} */
export function writeRecording(directory, lines, name = "recording.jsonl") {
  const path = join(directory, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/**
 * The runner spawns the replay executable by path, never through
 * process.execPath, so it must stay runnable as a file: mode 0o755 in git on
 * POSIX, and on Windows the shebang `spawnInvocation` reads to find the
 * interpreter, since that platform has no exec bit to carry.
 */
export const REPLAY_BIN = fileURLToPath(new URL("../../src/harnesses/replay/bin.mjs", import.meta.url));

/**
 * @returns {void}
 */
export function assertExecutable() {
  assert.ok(existsSync(REPLAY_BIN), "replay/bin.mjs must exist");
  // The exec bit is a POSIX fact and Windows has none. What makes the file
  // runnable there is the shebang `spawnInvocation` reads, so assert whichever
  // of the two this host actually runs it by — both are real, neither is the
  // other's stand-in.
  if (process.platform === "win32") {
    const shebang = readFileSync(REPLAY_BIN, "utf8").split(/\r?\n/u, 1)[0];
    assert.match(shebang, /^#!/u, "replay/bin.mjs must name the interpreter that runs it");
    return;
  }
  assert.notEqual(statSync(REPLAY_BIN).mode & 0o111, 0, "replay/bin.mjs must be executable (mode 0o755)");
}
