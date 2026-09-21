import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { livenessState } from "../../src/engine/lifecycle.mjs";
import { NON_FAILOVER_CODES, buildRouting, classifyTransition, planRoute } from "../../src/engine/backoff.mjs";
import { routeRuntimeForState } from "../../src/engine/failover.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { getHarness } from "../../src/harnesses/index.mjs";
import { fakeCodex, fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { fixture as contractFixture } from "../contract/helpers.mjs";
import { nodeState, fakeClaudeLike, flagValue } from "../runner-helpers.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// The other half of routing.test.mjs: what happens when a provider is spent --
// the declared one-hop edge, the announced reset, and the refusals.

test("the attempt deadlines left NON_FAILOVER_CODES, so a second failure takes the normal hop", () => {
  for (const code of ["wall_clock_timeout", "stall_timeout", "progress_stalled"]) {
    assert.equal(NON_FAILOVER_CODES.has(code), false, `${code} is eligible for the failover that follows its one auto_retry`);
    assert.equal(
      classifyTransition({ status: "failed", error: { code, message: "deadline" } }).reason,
      "provider",
      `${code} is the node's own deadline and never buys a network wait`,
    );
  }
});

test("a streaming provider that ends without its terminator buys a network wait, not an outright failure", () => {
  // Recorded live: dsh cut a node mid-run with `STREAM_CLOSED` / "SSE stream
  // ended without [DONE]". Neither the code nor the message matched anything,
  // so the node failed and needed a hand-issued resume -- a transport cut is
  // the definition of try-again.
  for (const error of [
    { code: "STREAM_CLOSED", message: "SSE stream ended without [DONE]" },
  ]) {
    assert.equal(
      classifyTransition({ status: "failed", error }).reason,
      "network_backoff",
      `${error.code}/${error.message} is a cut transport and earns the bounded same-runtime wait`,
    );
  }
});

test("quota exhaustion with no declared fallback leaves the node exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-no-fallback-quota-"));
  const exhausted = fakeCodex(directory, "quota-429");
  const path = writeContract(directory, fixture({
    id: "no-fallback-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "mid", judge: "mid" },
    runtimes: {
      mid: { harness: "codex", model: "mid", executable: exhausted, costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", runtime: "mid", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "exhausted", "a runtime with no declared fallback has nowhere to hop");
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["mid"]);
});

test("quota exhaustion routes through the declared failover edge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-quota-failover-"));
  const primary = fakeCodex(directory, "quota-429");
  const backup = fakeCodex(directory, "pass");
  const path = writeContract(directory, fixture({
    id: "quota-failover-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { harness: "codex", model: "primary", executable: primary, fallback: "backup" },
      backup: { harness: "codex", model: "backup", executable: backup },
    },
    nodes: [{ id: "build", type: "backend", runtime: "primary", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["primary", "backup"]);
  assert.equal(state.routing?.history?.length ?? 0, 1);
  assert.equal(state.routing?.history?.[0]?.nextRuntime, "backup");
  assert.equal(state.routing?.history?.[0]?.errorCode, "quota_exhausted");
  const first = state.invocations?.[0];
  assert.ok(first, "first invocation exists");
  const settlement = JSON.parse(readFileSync(join(result.runDir, "operations", `${first.id}.settlement.json`), "utf8"));
  assert.equal(settlement.error?.code, "quota_exhausted");
});

test("liveness state reports paused_quota only while a provider backoff is pending and failed once exhaustion is terminal", async () => {
  // A quota reset announced inside the node's deadline holds its node pending
  // on a future backoffUntil, so liveness must report paused_quota for that
  // shape and only that shape. Terminal exhaustion with no failover route
  // derives failed even when the error is quota-flavored: the run is not
  // waiting for a provider to come back, it is over.
  //
  // Carve-out: the codex harness's turn.failed quota branch never threads the
  // provider's resetAt into the envelope's error (harnesses are out of scope
  // for this phase), so a fake codex cannot make classifyTransition see a
  // reset window and exercise this end to end through runContract. This
  // exercises livenessState directly against the exact shape the runner
  // persists for a pending phase parked on a future routing backoff.
  const pendingWithActiveBackoff = /** @type {Map<string, import("../../src/contract/index.mjs").NodeSnapshot>} */ (new Map([["build", {
    status: "pending",
    phase: "worker",
    routing: { currentOverride: { role: "worker", backoffUntil: new Date(Date.now() + 60_000).toISOString() } },
  }]]));
  assert.equal(livenessState(pendingWithActiveBackoff), "paused_quota");

  const pendingWithElapsedBackoff = /** @type {Map<string, import("../../src/contract/index.mjs").NodeSnapshot>} */ (new Map([["build", {
    status: "pending",
    phase: "worker",
    routing: { currentOverride: { role: "worker", backoffUntil: new Date(Date.now() - 1_000).toISOString() } },
  }]]));
  assert.notEqual(livenessState(pendingWithElapsedBackoff), "paused_quota");

  const terminalDirectory = mkdtempSync(join(tmpdir(), "runner-liveness-terminal-"));
  const quotaPrimary = fakeCodex(terminalDirectory, "quota-429");
  const terminalPath = writeContract(terminalDirectory, fixture({
    id: "liveness-quota-terminal-run",
    pollIntervalMs: 10,
    timeoutSec: 5,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: { primary: { harness: "codex", model: "primary", executable: quotaPrimary } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const terminalResult = await runContract(terminalPath);
  const terminalState = nodeState(terminalResult);
  assert.equal(terminalState.status, "exhausted", terminalState.error?.message);
  assert.equal(terminalState.error?.code, "quota_exhausted");
  assert.equal(
    livenessState(terminalResult.states),
    "failed",
    "terminal quota exhaustion without a failover route reports failed, never a live quota pause",
  );
});

test("reuses one worker continuation per ordered phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-reuse-"));
  const requestLog = join(runsRoot(directory), "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-reuse-run",
    phaseSessionReuse: true,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-thread"]);
  assert.deepEqual(result.states.get("second")?.invocations?.map((invocation) => invocation.continuationMode), ["reuse"]);
  const usageRecords = readFileSync(join(result.runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(usageRecords.length, 2);
  for (const record of usageRecords) {
    assert.deepEqual(
      record.session,
      { turns: 1, toolCalls: 0, requests: 1, contextFirst: 2, contextMax: 2, contextLast: 2, contextSum: 2, completed: true },
      "the per-request ledger is persisted with the usage: one completed exec-jsonl run is one request",
    );
  }
});

test("does not reuse a phase continuation after a runtime identity change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-runtime-identity-"));
  const requestLog = join(runsRoot(directory), "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-runtime-identity-run",
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { harness: "exec-jsonl", model: "same-model", vendor: "primary-vendor", executable },
      backup: { harness: "exec-jsonl", model: "same-model", vendor: "backup-vendor", executable },
    },
    nodes: [
      { id: "first", type: "backend", phase: "implementation", runtime: "primary", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", runtime: "backup", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null]);
  // The runtime identity changed between the two nodes, so the second worker
  // carries the prior node's structured summary forward instead of reusing
  // its session.
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
  assert.match(requests[1].prompt, /Prior structured node summaries/u);
});

test("two concurrent nodes of one phase never drive the same continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-concurrent-"));
  const requestLog = join(runsRoot(directory), "concurrent-requests.jsonl");
  const executable = join(directory, "concurrent-wrapper.mjs");
  // Every turn answers with the same continuation id, so a scheduler that
  // handed one session to two live nodes would show it in the request log.
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("concurrent-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ continuationId: request.continuationId }) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "done", verification: [], artifacts: [], missingContext: [] }), continuationId: "shared-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-concurrent-run",
    maxParallel: 3,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "concurrent-model", vendor: "exec-jsonl-worker", executable } },
    // Three unordered nodes of one phase: the shape validation used to refuse
    // outright, and the shape `maxParallel` exists for.
    nodes: [
      { id: "alpha", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "beta", type: "backend", phase: "implementation", taskPacket: packet({ objective: "Second" }), gate: false },
      { id: "gamma", type: "backend", phase: "implementation", taskPacket: packet({ objective: "Third" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  for (const id of ["alpha", "beta", "gamma"]) assert.equal(result.states.get(id)?.status, "done", id);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(requests.length, 3);
  const continued = requests.filter((request) => request.continuationId === "shared-thread");
  assert.ok(continued.length <= 1, `the shared session was handed to ${continued.length} turns; at most one may claim it`);
});

test("selects the latest phase continuation by invocation chronology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-chronology-"));
  const requestLog = join(runsRoot(directory), "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  const continuationId = request.continuationId ? request.continuationId + "-next" : "phase-1";
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", verification: [], artifacts: [], missingContext: [] }), continuationId, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-chronology-run",
    phaseSessionReuse: true,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
    nodes: [
      { id: "third", type: "backend", phase: "implementation", dependsOn: ["second"], taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, "phase-1", "phase-1-next"]);
});

test("Claude phase reuse passes the first explicit session through --resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-claude-phase-reuse-"));
  const fake = fakeClaudeLike(directory);
  const path = writeContract(directory, fixture({
    id: "claude-phase-reuse-run",
    phaseSessionReuse: true,
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, "session-1"]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "reuse");
});

test("a completed phase without a continuation ID remains a fresh invocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-id-"));
  const fake = fakeClaudeLike(directory, { emitSessionId: false });
  const path = writeContract(directory, fixture({
    id: "phase-no-id-run",
    runtimeDefaults: { worker: "provider", judge: "provider" },
    runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
    ],
  }));
  const result = await runContract(path);
  const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
  assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "fresh");
});

test("a non-continuing runtime gets a deterministic fresh phase handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-no-continuation-"));
  const fake = fakeClaudeLike(directory);
  const adapter = getHarness("claude");
  const previous = adapter.capabilities.continuation;
  adapter.capabilities.continuation = false;
  try {
    const path = writeContract(directory, fixture({
      id: "phase-no-continuation-run",
      runtimeDefaults: { worker: "provider", judge: "provider" },
      runtimes: { provider: { harness: "claude", model: "test-model", permissionMode: "bypassPermissions", executable: fake.executable } },
      nodes: [
        { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
        { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet(), gate: false },
      ],
    }));
    const result = await runContract(path);
    const requests = readFileSync(fake.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => flagValue(request.args, "--resume")), [null, null]);
    assert.equal(result.states.get("second")?.invocations?.[0]?.continuationMode, "rotate");
    assert.match(requests[1].prompt, /fresh provider session/u);
  } finally {
    adapter.capabilities.continuation = previous;
  }
});

test("blocks downstream nodes after a failed dependency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dependency-"));
  const path = writeContract(directory, fixture({
    id: "dependency-run",
    pollIntervalMs: 10,
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ objective: "Fail" }), gate: false },
      { id: "second", type: "backend", taskPacket: packet({ objective: "Never run" }), dependsOn: ["first"], gate: false },
    ],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = fakeCodex(directory, "worker-fail");
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result, "first").status, "failed");
    assert.equal(nodeState(result, "second").status, "blocked");
    const artifact = /** @type {{nodes: Array<{id: string, error: {code: string}, blockedBy?: string[]}>}} */ (JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8")));
    assert.equal(artifact.nodes.length, 2);
    const blockedNode = artifact.nodes.find((node) => node.id === "second");
    assert.ok(blockedNode, "blocked node recorded in the artifact");
    assert.equal(blockedNode.error.code, "dependency_failed");
    assert.deepEqual(blockedNode.blockedBy, ["first"]);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});

test("worker invocations send no tool policy to a harness that cannot enforce it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tool-policy-"));
  const marker = join(runsRoot(directory), "tool-policy-request.json");
  const provider = join(directory, "policy-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("policy-provider 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(marker)}, input);
    const result = JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 }, costUsd: null }));
  });
}
`);
  chmodSync(provider, 0o755);
  const path = writeContract(directory, fixture({
    id: "tool-policy-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  assert.equal(nodeState(result).status, "done");
  const request = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(
    "toolPolicy" in request,
    false,
    "an adapter without an enforceable hook surface receives no policy to pretend with; enforcement lives on the claude-compatible --settings boundary",
  );
});

test("finalVerification runs on the phase-terminal node and not on its dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-terminal-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-terminal-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    nodes: [
      { id: "build", type: "backend", taskPacket: packet(), gate: false },
      { id: "ship", type: "backend", taskPacket: packet({ objective: "Ship it" }), dependsOn: ["build"], gate: false },
    ],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(result.ok, true);
  const build = nodeState(result, "build");
  const ship = nodeState(result, "ship");
  assert.equal(build.status, "done");
  assert.equal(ship.status, "done");
  assert.equal(build.verification?.commands?.length, 1, "a node with a dependant runs only its packet verification");
  assert.equal(ship.verification?.commands?.length, 2, "the phase-terminal node also runs the contract finalVerification");
  assert.deepEqual(ship.verification?.commands?.[1].argv, [process.execPath, "-e", "process.exit(0)"]);
});

test("a failing finalVerification stops the phase-terminal node before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-fail-run",
    pollIntervalMs: 10,
    finalVerification: [{ argv: [process.execPath, "-e", "process.exit(3)"] }],
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { maxRevisions: 0 } }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "final verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.equal(state.verification?.passed, false);
  assert.equal(state.verification?.commands?.[0].passed, true, "the packet verification still passed");
  assert.equal(state.verification?.commands?.[1].passed, false);
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("a contract without finalVerification leaves controller verification untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-final-verification-absent-"));
  const path = writeContract(directory, fixture({
    id: "final-verification-absent-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(nodeState(result).verification?.commands?.length, 1);
});

test("a phase sibling's session is rotated by default: fresh session, structured summary in the prompt, no continuation id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-phase-rotate-"));
  const requestLog = join(runsRoot(directory), "phase-requests.jsonl");
  const executable = join(directory, "phase-wrapper.mjs");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) console.log("phase-wrapper 1.0.0");
else { let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => {
  const request = JSON.parse(input); appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: JSON.stringify({ status: "done", summary: "phase complete", verification: [], artifacts: [], missingContext: [] }), continuationId: request.continuationId || "phase-thread", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, costUsd: null }));
}); }
`);
  chmodSync(executable, 0o755);
  const path = writeContract(directory, fixture({
    id: "phase-rotate-run",
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "phase-model", vendor: "exec-jsonl-worker", executable } },
    nodes: [
      { id: "first", type: "backend", phase: "implementation", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", phase: "implementation", dependsOn: ["first"], taskPacket: packet({ objective: "Continue it" }), gate: false },
    ],
  }));
  const result = await runContract(path);
  assert.equal(result.ok, true);
  const requests = readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.continuationId), [null, null], "the sibling's session id is not handed on");
  assert.deepEqual(result.states.get("second")?.invocations?.map((invocation) => invocation.continuationMode), ["rotate"]);
  assert.match(String(requests[1].prompt), /Continue phase implementation as the worker agent in a fresh provider session/u);
  assert.match(String(requests[1].prompt), /first: phase complete/u, "the prior node's structured summary travels in the prompt, not its transcript");
});

// R14: successive attempts and revisions of the same node prefer the previous
// attempt's runtime while it stays healthy, and yield to the remaining rules
// when it does not.

/** @param {string} prefix @returns {import("../../src/contract/index.mjs").ValidatedContract} */
function affinityContract(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-contract-`));
  writeFileSync(join(directory, "README.md"), "read me\n");
  return validateContract(contractFixture({
    id: `${prefix}-contract`,
    cwd: directory,
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "alpha", judge: "gamma" },
    runtimes: {
      alpha: { harness: "codex", model: "alpha", vendor: "alpha-vendor", fallback: "beta" },
      beta: { harness: "codex", model: "beta", vendor: "beta-vendor" },
      gamma: { harness: "codex", model: "gamma", vendor: "gamma-vendor" },
      delta: { harness: "codex", model: "delta", vendor: "beta-vendor" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"] }), gate: false }],
  }), join(directory, "contract.json"));
}

/**
 * @param {{assignments?: {worker: string, judge: string}, availability?: Record<string, {available: boolean, exhaustedUntil: string|null, reason: string}>, invocations?: {phase: string, runtimeId: string}[], override?: {role: string, runtime: string, reason: string}|null}} [overrides]
 * @returns {any}
 */
function affinityState(overrides = {}) {
  const { assignments = { worker: "alpha", judge: "gamma" }, availability = {}, invocations = [], override = null } = overrides;
  return {
    id: "build",
    status: "running",
    phase: "worker",
    revisions: 0,
    invocations,
    routing: { history: [], currentOverride: override, assignments, availability },
  };
}

test("attempt affinity yields to correctness", () => {
  const contract = affinityContract("affinity-yields");
  const node = contract.nodes[0];
  const ready = { available: true, exhaustedUntil: null, reason: "ready" };
  const later = { available: false, exhaustedUntil: new Date(Date.now() + 60_000).toISOString(), reason: "quota" };
  const spent = { available: false, exhaustedUntil: new Date(Date.now() - 1_000).toISOString(), reason: "quota" };

  // The previous attempt's runtime outranks the frozen assignment while the
  // catalogue calls it healthy: it is the one holding the node's context.
  const held = affinityState({
    availability: { alpha: ready, beta: ready },
    invocations: [{ phase: "worker", runtimeId: "alpha" }, { phase: "worker", runtimeId: "beta" }],
  });
  assert.equal(routeRuntimeForState(contract, node, held, "worker").id, "beta");

  // An exhausted previous runtime yields: availability outranks affinity and
  // the assignment decides.
  const exhausted = affinityState({
    availability: { alpha: ready, beta: later },
    invocations: [{ phase: "worker", runtimeId: "beta" }],
  });
  assert.equal(routeRuntimeForState(contract, node, exhausted, "worker").id, "alpha");

  // Exhaustion that has already been waited out holds no longer: the runtime
  // is healthy again, and unknown must not look rested works the other way —
  // a spent exhaustion must not look active.
  const rested = affinityState({
    availability: { alpha: ready, beta: spent },
    invocations: [{ phase: "worker", runtimeId: "beta" }],
  });
  assert.equal(routeRuntimeForState(contract, node, rested, "worker").id, "beta");

  // No catalogue record at all is not evidence of exhaustion: the snapshot's
  // catalogue copy is often empty outright, and the runtime demonstrably just
  // ran. Only a record that refuses admission yields.
  const unrecorded = affinityState({
    availability: { alpha: ready },
    invocations: [{ phase: "worker", runtimeId: "beta" }],
  });
  assert.equal(routeRuntimeForState(contract, node, unrecorded, "worker").id, "beta");

  // A judge whose previous runtime shares the vendor of the worker that ran
  // the node yields to the assignment: vendor distinction outranks affinity.
  const collided = affinityState({
    availability: { delta: ready },
    invocations: [
      { phase: "worker", runtimeId: "beta" },
      { phase: "judge", runtimeId: "delta" },
    ],
  });
  assert.equal(routeRuntimeForState(contract, node, collided, "judge").id, "gamma");

  // A vendor-distinct previous judge runtime holds.
  const distinct = affinityState({
    availability: { delta: ready },
    invocations: [
      { phase: "worker", runtimeId: "alpha" },
      { phase: "judge", runtimeId: "delta" },
    ],
  });
  assert.equal(routeRuntimeForState(contract, node, distinct, "judge").id, "delta");

  // The role-matched override is already an affinity outcome — a reset hold
  // or the failover edge — and outranks the invocation record.
  const overridden = affinityState({
    availability: { alpha: ready, beta: ready },
    invocations: [{ phase: "worker", runtimeId: "beta" }],
    override: { role: "worker", runtime: "alpha", reason: "quota resets" },
  });
  assert.equal(routeRuntimeForState(contract, node, overridden, "worker").id, "alpha");

  // A first attempt has no previous runtime and resolves exactly as before.
  const first = affinityState({ availability: { alpha: ready } });
  assert.equal(routeRuntimeForState(contract, node, first, "worker").id, "alpha");
});

test("the routing override records whether attempt affinity held or yielded", () => {
  const contract = affinityContract("affinity-reason");
  const node = contract.nodes[0];
  const error = { code: "quota_exhausted", message: "usage limit" };
  const state = affinityState({ invocations: [{ phase: "worker", runtimeId: "alpha" }] });
  const now = Date.parse("2026-09-04T06:00:00.000Z");

  const reset = /** @type {const} */ ({ kind: "reset", at: "2026-09-04T12:00:00.000Z", reason: "quota_reset" });
  const resetRoute = buildRouting(state, {
    role: "worker", error, current: "alpha",
    plan: planRoute(contract, node, state, "worker", error, "alpha", reset),
    schedule: reset, status: "failed", now,
  });
  assert.match(/** @type {any} */ (resetRoute.override).reason, /attempt-affinity held: alpha keeps the node's context for the retry/u);

  const failover = /** @type {const} */ ({ kind: "failover", reason: "provider" });
  const failoverRoute = buildRouting(state, {
    role: "worker", error, current: "alpha",
    plan: planRoute(contract, node, state, "worker", error, "alpha", failover),
    schedule: failover, status: "failed", now,
  });
  assert.match(/** @type {any} */ (failoverRoute.override).reason, /attempt-affinity yielded: alpha reported quota_exhausted/u);
  assert.equal(/** @type {any} */ (failoverRoute.override).runtime, "beta", "the edge still goes to the declared fallback");
});
