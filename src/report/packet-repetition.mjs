/**
 * Packet repetition between a node's successive attempts — the R16
 * measurement the deduplication decision waits for, and nothing more: this
 * module counts bytes; it never deduplicates or reshapes a payload.
 *
 * It is a module of its own because render.mjs sits at the repository's
 * 800-line ceiling (measured 2026-09-21: render.mjs 799, progress.mjs 724,
 * final.mjs 202): the renderers gain a single line each, the computation
 * lives here.
 *
 * A node's packet, per attempt, is the prompt file its worker invocation was
 * dispatched with (`invocation.promptPath`) — the only per-attempt packet
 * bytes a run persists. Paths resolve against the run directory; an absolute
 * path is taken as written. "Repeated" between two successive attempts is
 * their common byte prefix: the share a retry re-sends identically, the
 * number a deduplication or prefix-cache decision would act on. A packet
 * file that cannot be read leaves its attempt absent from the measurement —
 * absent is never zero — and `packetsRead` beside `attempts` is how a reader
 * sees the gap.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compactTokens } from "../util.mjs";

/**
 * @typedef {{attempts: number, packetsRead: number, packetBytes: number|null, repeatedBytes: number|null}} PacketRepetition
 * `packetBytes` sums the packets that were readable; `repeatedBytes` sums the
 * common prefix of each *adjacent* worker-invocation pair whose both packets
 * were readable — `null` when no pair was measurable. When `packetsRead` is
 * smaller than `attempts`, the totals cover only the packets still on disk.
 */

/**
 * Per node, from the invocation ledger alone, in contract order.
 *
 * @param {string} runDir
 * @param {{id: string, invocations?: unknown}[]} nodes
 * @returns {Map<string, PacketRepetition>}
 */
export function packetRepetitionByNode(runDir, nodes) {
  return new Map(nodes.map((node) => [node.id, packetRepetition(runDir, node.invocations)]));
}

/**
 * @param {string} runDir
 * @param {unknown} invocations
 * @returns {PacketRepetition}
 */
function packetRepetition(runDir, invocations) {
  const ledger = Array.isArray(invocations) ? /** @type {Record<string, unknown>[]} */ (invocations) : [];
  const workerPackets = ledger
    .filter((invocation) => /** @type {{role?: unknown}} */ (invocation)?.role === "worker")
    .map((invocation) => (typeof /** @type {{promptPath?: unknown}} */ (invocation).promptPath === "string"
      ? readPacket(runDir, /** @type {string} */ (/** @type {{promptPath?: unknown}} */ (invocation).promptPath))
      : null));
  let repeatedBytes = /** @type {number|null} */ (null);
  for (let index = 1; index < workerPackets.length; index += 1) {
    const previous = workerPackets[index - 1];
    const current = workerPackets[index];
    // A gap in the ledger's packets breaks the pair rather than pairing
    // across it: attempts i-1 and i+1 are not successive.
    if (previous === null || current === null) continue;
    repeatedBytes = (repeatedBytes ?? 0) + sharedPrefixBytes(previous, current);
  }
  const readable = workerPackets.filter((packetBytes) => packetBytes !== null);
  return {
    attempts: workerPackets.length,
    packetsRead: readable.length,
    packetBytes: readable.length ? readable.reduce((total, packet) => total + /** @type {Buffer} */ (packet).length, 0) : null,
    repeatedBytes,
  };
}

/**
 * @param {string} runDir
 * @param {string} promptPath
 * @returns {Buffer|null}
 */
function readPacket(runDir, promptPath) {
  try {
    return readFileSync(resolve(runDir, promptPath));
  } catch {
    // A prompt file the run no longer carries (pruned, or a fixture's
    // placeholder path) leaves that attempt absent from the measurement
    // rather than counted as zero bytes; `packetsRead` shows the gap.
    return null;
  }
}

/** @param {Buffer} left @param {Buffer} right @returns {number} */
function sharedPrefixBytes(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

/**
 * The report's one-line exposure, appended to a totals line: per node with
 * two or more attempts on record, the bytes its successive attempts re-sent
 * identically of the packet bytes those attempts carried. A node with a
 * single attempt has no successive pair and is rightly absent; a node whose
 * packets cannot be read says `unmeasured` rather than a zero; a node whose
 * measurement covers only some of its packets says `partial`.
 *
 * @param {Map<string, PacketRepetition>} repetition
 * @returns {string} "" when no node has a successive pair to expose
 */
export function packetRepetitionNote(repetition) {
  const parts = [];
  for (const [id, measured] of repetition) {
    if (measured.attempts < 2) continue;
    if (measured.repeatedBytes === null || measured.packetBytes === null) {
      parts.push(`${id} unmeasured`);
      continue;
    }
    const partial = measured.packetsRead < measured.attempts ? " (partial)" : "";
    parts.push(`${id} ${compactTokens(measured.repeatedBytes)} of ${compactTokens(measured.packetBytes)}${partial}`);
  }
  return parts.length ? ` · packet repeat across attempts: ${parts.join(" · ")}` : "";
}
