/**
 * The resilience class: the engine's failure-policy table exercised, not
 * documented.
 *
 * Every case — spec, recording and expectation — is generated here from the
 * table's own declaration: AUTO_RETRY_CODES (src/engine/lifecycle.mjs) and
 * NON_FAILOVER_CODES (src/engine/backoff.mjs) are the two places the engine
 * declares which failures earn which recovery, so a code the engine starts
 * or stops classifying gains or loses its case without this file being
 * edited; a hand-written copy of the table would only document it. Each case
 * replays its injected failure through the same deterministic machinery the
 * `deterministic` class runs (evals/deterministic/D01 is the shape: same
 * contract layout, same recordings map, same `expected.nodes` comparison)
 * and expects the node to settle under its own code with no routing edge
 * spent. The runner's `--assert-no-model` is the no-provider proof: it
 * refuses any non-replay runtime and strips every provider binary, so a
 * recovery path that reached for a real provider fails to spawn instead of
 * passing.
 *
 * The recordings are written to a fresh temp case directory per call rather
 * than checked in: a replay recording is consumed line by line, so the
 * auto-retry family's failure has to be recorded twice — once for the first
 * attempt, once for the retry's re-invocation — and a shared static file
 * could not carry each case's own code on both lines.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NON_FAILOVER_CODES } from "../src/engine/backoff.mjs";
import { AUTO_RETRY_CODES } from "../src/engine/lifecycle.mjs";

/** The replay runtime every case injects its failure class into. */
const INJECTED_RUNTIME = "replay-worker";

/**
 * The attempt-deadline codes whose automatic retry is seal-gated: lifecycle.mjs
 * grants their retry only when phase 5b sealed non-empty work before the kill,
 * and a replayed failure produces nothing to seal. Their case therefore parks
 * on the first attempt, while the rest of the auto-retry family spends its one
 * retry and parks on the second. That set is module-private in
 * src/engine/lifecycle.mjs, so this mirrors its members as of 2026-09-21 —
 * and the mirror is load-bearing in both directions: an un-gated timeout would
 * re-invoke into a recording it does not have and park under a foreign code,
 * and a gated retry would stop at one attempt, each failing its case.
 *
 * @typedef {"auto_retry"|"non_failover"} FailureFamily
 */
const SEAL_GATED_TIMEOUT_CODES = new Set(["stall_timeout", "wall_clock_timeout"]);

/**
 * The failure classes the engine actually declares, with the policy family
 * each one belongs to. The families differ in what recovery the node is
 * owed — one bounded retry on the runtime it already warmed, or none at
 * all — and in nothing the case asserts: both must settle under their own
 * code and reach for nothing.
 *
 * @returns {{family: FailureFamily, code: string}[]}
 */
function declaredFailureClasses() {
  return [
    ...[...AUTO_RETRY_CODES].map((code) => ({ family: /** @type {FailureFamily} */ ("auto_retry"), code })),
    ...[...NON_FAILOVER_CODES].map((code) => ({ family: /** @type {FailureFamily} */ ("non_failover"), code })),
  ];
}

/**
 * How many times the injected failure is recorded, which is also the attempt
 * count the case expects: two for a failure whose retry re-invokes the
 * runtime, one for every failure the policy settles without one.
 *
 * @param {{family: FailureFamily, code: string}} failureClass
 * @returns {number}
 */
function recordedAttempts({ family, code }) {
  return family === "auto_retry" && !SEAL_GATED_TIMEOUT_CODES.has(code) ? 2 : 1;
}

/**
 * @param {string} code
 * @returns {string}
 */
function injectedRecordingLine(code) {
  return `${JSON.stringify({
    envelope: {
      status: "failed",
      result: null,
      continuationId: null,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 },
      costUsd: null,
      error: { code, message: `injected failure class ${code} (resilience eval)` },
    },
    files: [],
  })}\n`;
}

/**
 * @param {FailureFamily} family
 * @param {string} code
 * @returns {string}
 */
function provesOf(family, code) {
  if (family === "non_failover") {
    return `a ${code} failure is the run's own doing: the node parks under its own code without buying a retry or a failover hop, and no recovery path reaches a provider`;
  }
  if (SEAL_GATED_TIMEOUT_CODES.has(code)) {
    return `a ${code} failure's one automatic retry is seal-gated: with no sealed work to re-cut, the node parks under its own code on the first attempt, reaching no provider`;
  }
  return `a ${code} failure earns exactly one automatic retry on the runtime already warmed — the recording carries the failure twice, so the retry re-invokes it and the node parks under its own code, having spent no failover edge and reached no provider`;
}

/**
 * @param {{family: FailureFamily, code: string}} failureClass
 * @param {string} caseDir the temp directory the recording is written into
 * @returns {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}}
 */
function resilienceCase({ family, code }, caseDir) {
  const dashed = code.replaceAll("_", "-");
  const attempts = recordedAttempts({ family, code });
  const filename = `${dashed}.jsonl`;
  writeFileSync(join(caseDir, filename), Array.from({ length: attempts }, () => injectedRecordingLine(code)).join(""));
  return {
    caseDir,
    spec: {
      id: `R19-${dashed}`,
      title: `injected ${code} settles under its own code`,
      proves: provesOf(family, code),
      contract: {
        schemaVersion: 3,
        contractVersion: "0.3.0",
        id: `r19-${dashed}`,
        campaignId: "r19-resilience",
        goal: `exercise the ${code} recovery path without reaching a provider`,
        runtimeDefaults: { worker: INJECTED_RUNTIME },
        runtimes: {
          [INJECTED_RUNTIME]: {
            harness: "replay",
            model: "replay-worker-model",
            vendor: "replay-worker-vendor",
            config: {},
          },
        },
        nodes: [
          {
            id: "build",
            type: "backend",
            phase: "build",
            taskPacket: {
              mode: "execution",
              objective: "write output.txt",
              instructions: ["Write output.txt"],
              readFiles: ["contract.json"],
              writeFiles: ["output.txt"],
              symbols: [],
              decisions: [],
              nonGoals: [],
              verification: [{ argv: ["true"] }],
            },
            gate: false,
          },
        ],
      },
      recordings: { [INJECTED_RUNTIME]: filename },
      injection: { runtime: INJECTED_RUNTIME, code },
    },
    expected: {
      nodes: {
        build: {
          status: "failed",
          errorCode: code,
          revisions: 0,
          runtimeIds: Array.from({ length: attempts }, () => INJECTED_RUNTIME),
          routingHistoryLength: 0,
          integratedHead: false,
        },
      },
    },
  };
}

/**
 * The resilience class's cases: one per failure class the engine declares,
 * in declaration order (auto-retry codes, then non-failover codes). Throws
 * when the tables declare nothing, by the same rule that makes
 * `casesOfClass` throw on an empty selection: a scheduled run that exercised
 * nothing and exited green is exactly the silent failure this class exists
 * to keep off the nightly schedule.
 *
 * @returns {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}[]}
 */
export function resilienceCases() {
  const classes = declaredFailureClasses();
  if (classes.length === 0) {
    throw new Error("the failure policy declares no failure classes; the resilience class has nothing to exercise");
  }
  const caseDir = mkdtempSync(join(tmpdir(), "faberun-eval-resilience-"));
  return classes.map((failureClass) => resilienceCase(failureClass, caseDir));
}
