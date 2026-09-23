import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaHeldRuntimes, runningPerRuntime, runtimeHasCapacity } from "../../src/engine/capacity.mjs";
import { validateRuntime } from "../../src/contract/runtime.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const LATER = new Date(NOW + 60_000).toISOString();
const EARLIER = new Date(NOW - 60_000).toISOString();

/** @param {Record<string, unknown>} routing @returns {any} */
function stateWith(routing) {
  return { id: "n", status: "pending", phase: "worker", routing };
}

test("a runtime's maxConcurrent is a positive integer or refused", () => {
  assert.equal(validateRuntime("two", { harness: "codex", model: "m", maxConcurrent: 2 }).maxConcurrent, 2);
  assert.equal(validateRuntime("none", { harness: "codex", model: "m" }).maxConcurrent, undefined, "absent means only maxParallel bounds it");
  assert.throws(() => validateRuntime("bad", { harness: "codex", model: "m", maxConcurrent: 0 }), /maxConcurrent/u);
  assert.throws(() => validateRuntime("bad", { harness: "codex", model: "m", maxConcurrent: 1.5 }), /maxConcurrent/u);
});

test("capacity: live attempts are counted per runtime and a full runtime refuses one more", () => {
  const running = [{ runtime: { id: "a" } }, { runtime: { id: "a" } }, { runtime: { id: "b" } }, { runtime: { id: null } }];
  const counts = runningPerRuntime(running);
  assert.deepEqual([...counts.entries()], [["a", 2], ["b", 1]], "a job with no runtime id counts for nobody");
  const contract = /** @type {any} */ ({ runtimes: { a: { maxConcurrent: 2 }, b: { maxConcurrent: 2 }, c: {} } });
  assert.equal(runtimeHasCapacity("a", contract, counts, new Set()), false, "at its limit");
  assert.equal(runtimeHasCapacity("b", contract, counts, new Set()), true, "under its limit");
  assert.equal(runtimeHasCapacity("c", contract, counts, new Set()), true, "no limit declared");
  assert.equal(runtimeHasCapacity("c", contract, counts, new Set(["c"])), false, "a quota hold refuses regardless of the limit");
});

test("quota hold: a node waiting out an exhaustion on the same runtime holds it for its siblings; nothing else does", () => {
  const exhaustedWait = stateWith({
    history: [{ at: EARLIER, role: "worker", runtime: "sonnet", status: "exhausted", errorCode: "quota_exhausted" }],
    currentOverride: { at: EARLIER, role: "worker", runtime: "sonnet", nextRuntime: "sonnet", reason: "reset", backoffUntil: LATER },
  });
  assert.deepEqual([...quotaHeldRuntimes([exhaustedWait], NOW)], ["sonnet"]);
  const expired = stateWith({
    history: [{ at: EARLIER, role: "worker", runtime: "sonnet", status: "exhausted", errorCode: "quota_exhausted" }],
    currentOverride: { at: EARLIER, role: "worker", runtime: "sonnet", nextRuntime: "sonnet", reason: "reset", backoffUntil: EARLIER },
  });
  assert.deepEqual([...quotaHeldRuntimes([expired], NOW)], [], "an elapsed backoff holds nothing");
  const hop = stateWith({
    history: [{ at: EARLIER, role: "worker", runtime: "sonnet", status: "exhausted", errorCode: "quota_exhausted" }],
    currentOverride: { at: EARLIER, role: "worker", runtime: "flash", nextRuntime: "flash", reason: "failover", backoffUntil: LATER },
  });
  assert.deepEqual([...quotaHeldRuntimes([hop], NOW)], [], "a hop to another runtime is that node's own wait, not a hold on the target");
  const networkWait = stateWith({
    history: [{ at: EARLIER, role: "worker", runtime: "sonnet", status: "failed", errorCode: "network_backoff" }],
    currentOverride: { at: EARLIER, role: "worker", runtime: "sonnet", nextRuntime: "sonnet", reason: "network", backoffUntil: LATER },
  });
  assert.deepEqual([...quotaHeldRuntimes([networkWait], NOW)], [], "a network wait is not a quota statement about the runtime");
  assert.deepEqual([...quotaHeldRuntimes([stateWith({ history: [], currentOverride: null }), /** @type {any} */ ({ id: "x" })], NOW)], []);
});

/**
 * An exec-jsonl worker that records when each attempt starts and ends and
 * holds the turn open for a while, so overlapping attempts are observable.
 *
 * @param {string} directory
 * @param {string} log
 * @returns {string}
 */
function sleepyWrapper(directory, log) {
  const executable = join(directory, "sleepy-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("sleepy-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: "start", at: Date.now() }) + "\\n");
  setTimeout(() => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: "end", at: Date.now() }) + "\\n");
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] }), continuationId: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
  }, 400);
}); }
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** @param {string} log @returns {number} the largest number of attempts open at one instant */
function peakConcurrency(log) {
  const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .sort((left, right) => left.at - right.at || (left.event === "end" ? -1 : 1));
  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.event === "start" ? 1 : -1;
    peak = Math.max(peak, open);
  }
  return peak;
}

/** @param {number|undefined} maxConcurrent @returns {Promise<number>} */
async function peakWith(maxConcurrent) {
  const directory = mkdtempSync(join(tmpdir(), "runner-capacity-"));
  const log = join(runsRoot(directory), "attempts.jsonl");
  const executable = sleepyWrapper(directory, log);
  const path = writeContract(directory, fixture({
    id: `capacity-${maxConcurrent ?? "unbounded"}`,
    maxParallel: 3,
    pollIntervalMs: 50,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "m", vendor: "exec-jsonl-worker", executable, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) } },
    nodes: ["one", "two", "three"].map((id) => ({ id, type: "backend", phase: "implementation", taskPacket: packet({ objective: `Do ${id}` }), gate: false })),
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true, `run ${maxConcurrent ?? "unbounded"} completed`);
  return peakConcurrency(log);
}

test("maxConcurrent bounds a runtime below maxParallel: three independent nodes run one at a time on a runtime that allows one", async () => {
  assert.equal(await peakWith(1), 1, "never two attempts open on the runtime at once");
  assert.ok(await peakWith(undefined) >= 2, "without the runtime bound the same plan overlaps under maxParallel 3");
});
