/**
 * The process half every Faberun harness runner shares: one prompt read from
 * stdin, one JSONL transcript written to fd 1. Kept apart from
 * `runner-transcript.mjs` because that module runs inside the controller and
 * this one inside the spawned runner process.
 */

import { writeSync } from "node:fs";

/**
 * Whole-line writes to fd 1: `process.exit` cannot lose an unfinished write.
 *
 * @param {Record<string, unknown>} event
 */
export function emit(event) {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  for (let written = 0; written < line.length; ) written += writeSync(1, line, written);
}

/** @returns {Promise<string>} */
export async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
