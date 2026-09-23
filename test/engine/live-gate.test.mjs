import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { fakeCodex, fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

// The dispatch gate's live half: every routed runtime is asked one trivial
// prompt before any dispatch. Answered means answered -- a refusal is a
// hello that came back -- and only silence blocks.

/**
 * @param {string} runDir
 * @returns {any} the persisted gate evidence
 */
function envEvidence(runDir) {
  return JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8"));
}

/**
 * @param {string} runDir
 * @returns {any} the persisted state of the fixture's one node
 */
function nodeState(runDir) {
  return JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
}

/**
 * @template T
 * @param {string} seconds
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function withPreflightBudget(seconds, body) {
  const key = "FABERUN_PREFLIGHT_TIMEOUT_SEC";
  const previous = process.env[key];
  process.env[key] = seconds;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/**
 * A provider that answers the gate's liveness hello and then refuses the
 * work with a quota exhaustion: the shape of a real account that can still
 * speak but cannot spend.
 *
 * @returns {string}
 */
function quotaAfterHelloProvider() {
  const path = join(mkdtempSync(join(tmpdir(), "runner-gate-quota-")), "quota-after-hello.mjs");
  writeFileSync(path, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("quota-after-hello 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.includes("FABERUN_PREFLIGHT_OK")) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "preflight-hello" }));
      const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: hello } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Please try again at 12:58 PM" } }));
    process.exitCode = 1;
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The dead provider only this file may define: it reports a version, so the
 * static checks pass, and then answers nothing at all -- the gate's only
 * honest verdict about it is silence.
 *
 * @returns {string}
 */
function deadProvider() {
  const path = join(mkdtempSync(join(tmpdir(), "runner-gate-dead-")), "dead.mjs");
  writeFileSync(path, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("dead 1.0.0");
} else {
  setInterval(() => {}, 60_000);
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Silent until the release file appears: the operator fixing the host is
 * touching one file, after which the same executable answers both the hello
 * and the work.
 *
 * @param {string} release
 * @returns {string}
 */
function releasedProvider(release) {
  const path = join(mkdtempSync(join(tmpdir(), "runner-gate-released-")), "released.mjs");
  writeFileSync(path, `#!${process.execPath}
import { existsSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("released 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (!existsSync(${JSON.stringify(release)})) {
      setInterval(() => {}, 60_000);
      return;
    }
    const text = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "thread.started", thread_id: "released" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/** @param {string} id @returns {Record<string, unknown>} a one-runtime, one-node contract */
function singleRuntimeFixture(id) {
  return {
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "only", judge: "only" },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  };
}

test("a runtime that answers the live preflight passes the gate and the run dispatches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-gate-answer-"));
  const path = writeContract(directory, fixture({
    ...singleRuntimeFixture("live-gate-answer-run"),
    runtimes: { only: { harness: "codex", model: "only", executable: fakeCodex(directory, "pass") } },
  }));
  const runDir = runDirectory(directory, "live-gate-answer-run");
  const result = await runContract(path);
  const state = nodeState(runDir);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal((state.invocations ?? []).length, 1, "the hello never appears as a node invocation");
  // The evidence file is written on the passing side too, carrying the live
  // ProbeResults beside the static checks.
  const evidence = envEvidence(runDir);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.runtimes?.[0]?.live, true);
  assert.equal(evidence.runtimes?.[0]?.liveStatus, "done");
  assert.ok(result.ok);
});

test("a runtime that returns a refusal verdict also passes and the run dispatches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-gate-refusal-"));
  const path = writeContract(directory, fixture({
    ...singleRuntimeFixture("live-gate-refusal-run"),
    timeoutSec: 5,
    runtimes: { only: { harness: "codex", model: "only", executable: quotaAfterHelloProvider() } },
  }));
  const runDir = runDirectory(directory, "live-gate-refusal-run");
  await runContract(path);
  const state = nodeState(runDir);
  // The refusal is a verdict: the gate let the run onto the contract's only
  // runtime, and the runtime refused the work itself, on the contract.
  assert.equal(state.status, "exhausted", state.error?.message);
  assert.equal(state.error?.code, "quota_exhausted");
  assert.deepEqual((state.invocations ?? []).map((/** @type {any} */ invocation) => invocation.runtimeId), ["only"]);
  assert.equal(envEvidence(runDir).ok, true, "a quota refusal answered the hello, so the gate passed it");
});

test("a runtime that is silent blocks the run, named with cause unknown, and the evidence is written", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-gate-silent-"));
  const path = writeContract(directory, fixture({
    ...singleRuntimeFixture("live-gate-silent-run"),
    runtimes: { only: { harness: "codex", model: "only", executable: deadProvider() } },
  }));
  const runDir = runDirectory(directory, "live-gate-silent-run");
  await withPreflightBudget("2", async () => {
    await assert.rejects(runContract(path), (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "env_preflight_failed");
      assert.match(error.message, /\bonly\b/u, "the refusal names the silent runtime");
      assert.match(error.message, /cause unknown/u, "silence names no cause, so none is invented");
      return true;
    });
  });
  const evidence = envEvidence(runDir);
  assert.equal(evidence.ok, false);
  assert.equal(evidence.runtimes?.[0]?.liveStatus, "failed");
  assert.match(evidence.runtimes?.[0]?.detail ?? "", /preflight_timeout/u);
  const state = nodeState(runDir);
  assert.equal(state.status, "pending", "a blocked run never dispatched");
  assert.equal((state.invocations ?? []).length, 0);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const failure = /** @type {Record<string, unknown>|undefined} */ (events.find((event) => event.type === "run.env-preflight-failed"));
  assert.ok(failure, "the block is durable run evidence");
  assert.deepEqual(
    Object.keys(failure).sort(),
    ["at", "checks", "contractId", "contractVersion", "ok", "schemaVersion", "type"],
    "the event carries exactly its own fields; the live ProbeResults stay in env-preflight.json",
  );
  assert.equal(failure.runtimes, undefined);
});

test("a run the gate blocked stays materialized and resumable once the runtime answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-gate-resume-"));
  const release = join(runsRoot(directory), "gate-release");
  const path = writeContract(directory, fixture({
    ...singleRuntimeFixture("live-gate-resume-run"),
    runtimes: { only: { harness: "codex", model: "only", executable: releasedProvider(release) } },
  }));
  const runDir = runDirectory(directory, "live-gate-resume-run");
  await withPreflightBudget("2", async () => {
    await assert.rejects(runContract(path), (/** @type {Error & {code?: string}} */ error) => error.code === "env_preflight_failed");
  });
  assert.ok(existsSync(join(runDir, "contract.json")), "the run stays materialized for a resume");
  // The operator fixes the host: the same executable answers now.
  writeFileSync(release, "released\n");
  await resumeRun(runDir);
  const state = nodeState(runDir);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(envEvidence(runDir).ok, true, "the resume re-asked, and this time the runtime answered");
});
