import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { HARNESS_STALL_TIMEOUT_SEC, validateRuntime } from "../../src/contract/runtime.mjs";
import { NON_FAILOVER_CODES, isTimeoutOrStall } from "../../src/engine/backoff.mjs";
import { detectStalls, sealBeforeTerminate, stallTimeoutSecFor, startProcess, terminateInvocation } from "../../src/engine/process.mjs";
import { AUTO_RETRY_CODES } from "../../src/engine/lifecycle.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { TIER_EXHAUSTION_CAP_REASON, TIER_EXHAUSTION_HOLD_CAP_MS, planResumeRetry } from "../../src/engine/retry.mjs";
import { createAttemptWorktree, createRunRef, git, removeWorktree } from "../../src/repo/worktree.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { SPAWN_WAIT_FACTOR, fixture, packet, waitForValue, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// Phase 5b: a timeout seals the attempt before it kills, stall progress is a
// provider event rather than an mtime, and the tier-exhaustion hold is capped.

/**
 * A repository, a campaign, a run directory, and a created run ref: the
 * minimum four things `createAttemptWorktree` and `sealBeforeTerminate` need.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {{directory: string, repo: string, runDir: string, contract: import("../../src/contract/index.mjs").ValidatedContract}}
 */
function makeRepoRun(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "seal-before-kill-"));
  const contractPath = writeContract(directory, fixture({ id: "seal-run", pollIntervalMs: 10, ...overrides }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const repo = contract.cwd;
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  createRunRef(repo, contract.id, head);
  const runDir = join(runsRoot(repo), "runs", contract.id);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });
  return { directory, repo, runDir, contract };
}

/**
 * @param {import("../../src/contract/index.mjs").ValidatedContract} contract
 * @param {import("../../src/contract/index.mjs").WorktreeState} worktree
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
 */
function snapshotFor(contract, worktree) {
  const node = contract.nodes[0];
  const now = new Date().toISOString();
  return validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: node.id,
    type: node.type,
    sourceIdentity: node.sourceIdentity,
    packetHash: node.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: now,
    updatedAt: now,
    result: null,
    gate: null,
    error: null,
    invocations: [],
    executionOverrides: [],
    verification: null,
    worktree,
    scope: {
      boundary: {
        schemaVersion: 1,
        files: [...(node.taskPacket.writeFiles ?? [])],
        roots: [...(node.taskPacket.writeRoots ?? [])],
        fileOrigins: [...(node.taskPacket.writeFiles ?? [])].map((literal) => ({ literal, paths: [literal] })),
        rootOrigins: [...(node.taskPacket.writeRoots ?? [])].map((literal) => ({ literal, paths: [literal] })),
      },
      changedPaths: [],
      unexpectedPaths: [],
      changedPathCount: 0,
      unexpectedPathCount: 0,
      truncated: false,
    },
  }, node);
}

/** @param {string} path @param {string} content @returns {void} */
function writeProvider(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/**
 * The two-attempt provider the seal e2e uses: the first turn writes sealed
 * work and hangs until the controller's deadline fires; the second completes.
 *
 * @param {string} directory
 * @returns {string} the provider executable
 */
function writeSealE2eProvider(directory) {
  const counter = join(runsRoot(directory), "seal-e2e-count");
  const provider = join(directory, "seal-e2e-provider.mjs");
  writeProvider(provider, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("seal-e2e 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  // The dispatch gate says hello before any dispatch. This fixture hangs on
  // its first call by design, so an uncounted hello would become that hang
  // and the gate would block a run the test expects to dispatch. The counter
  // therefore moved inside the handler: it counts turns, and the hello is
  // not one -- a real provider answers a liveness prompt before the turn
  // that goes quiet.
  if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "preflight-hello" }));
    const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: hello } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  let call = 1;
  try { call = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").length + 1; } catch {}
  appendFileSync(${JSON.stringify(counter)}, "x\\n");
  const judge = prompt.startsWith("Review node");
  const canonical = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1] ?? null;
  if (call === 1 && !judge) {
    writeFileSync("README.md", "attempt-1-sealed\\n");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "seal-thread" }));
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "still running after writing sealed work" } }));
    setInterval(() => {}, 60_000);
    return;
  }
  const text = JSON.stringify({ status: "done", summary: "attempt two complete", verification: [], artifacts: [], missingContext: [] });
  if (canonical) writeFileSync(canonical, text);
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0 } }));
});
`);
  return provider;
}

/** The filesystem layout a streaming stall visit needs, without a provider. */
/**
 * @param {string} transcript
 * @param {{id: string, harness: string, model: string, stallTimeoutSec?: number}} runtime
 * @returns {any}
 */
function stallJob(transcript, runtime) {
  const runDir = mkdtempSync(join(tmpdir(), "seal-stall-"));
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const stdout = join(runDir, "logs", "worker.jsonl");
  writeFileSync(stdout, transcript);
  const contract = { timeoutSec: 2_400, stallTimeoutSec: 300 };
  return /** @type {any} */ ({
    contract,
    node: { id: "build", timeoutSec: 2_400 },
    state: { id: "build", worktree: null },
    runtime,
    cwd: runDir,
    paths: { stdout, stderr: join(runDir, "logs", "worker.err"), prompt: null },
    phase: "worker",
    invocation: { id: "stall-job", pid: null, processGroupId: null },
    startedTicks: process.hrtime.bigint(),
    progressTicks: process.hrtime.bigint(),
    lastOutputAt: 0,
    closed: true,
    exitCode: null,
    signal: null,
    spawnError: null,
    terminating: null,
    gateConfigPath: "",
    gateReleasePath: "",
  });
}

/**
 * @param {any} job
 * @param {number} ageMs
 * @returns {void}
 */
function ageProgress(job, ageMs) {
  job.progressTicks = process.hrtime.bigint() - BigInt(Math.round(ageMs * 1e6));
}

// ---------------------------------------------------------------------------
// done-when 1 and 4: the seal is real and the next attempt is cut from it.
// ---------------------------------------------------------------------------

test("done-when 1 and 4: a wall-clock timeout seals, auto-retries on the same runtime, and the next attempt sees the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-seal-e2e-"));
  const provider = writeSealE2eProvider(directory);
  const contractPath = writeContract(directory, fixture({
    id: "seal-e2e-run",
    pollIntervalMs: 10,
    // The budget the hung attempt exhausts and the healthy retry has to fit
    // inside, so it has to cover a provider spawn under the suite's own
    // parallelism. Measured: 0.7s lost on Windows CI (2026-09-21) and under
    // parallel load on macOS (RM-056); 3s costs the test 3s and leaves
    // the retry four times the margin. `source-shape` bans a sub-second one.
    timeoutSec: 3 * SPAWN_WAIT_FACTOR,
    runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { harness: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  try {
    const result = await runContract(contractPath);
    const state = nodeState(result);
    assert.equal(state.status, "done", state.error?.message);
    assert.equal(state.attempt, 2, "the timeout spent exactly one automatic retry");
    assert.deepEqual((state.invocations ?? []).map((invocation) => invocation.runtimeId), ["luna", "luna"], "the retry stays on the runtime already warmed");
    assert.equal(state.worktree?.previousAttempt, 1, "the second attempt was cut from the first attempt's seal");
    const sealed = git(directory, ["show", "faberun/seal-e2e-run/build/1:README.md"]);
    assert.equal(sealed, "attempt-1-sealed", "the seal committed the work the timeout interrupted");
    const integrated = git(directory, ["show", "refs/faberun/seal-e2e-run/run:README.md"]);
    assert.equal(integrated, "attempt-1-sealed", "the sealed work survived into the next attempt and the run ref");
    const metadata = JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8"));
    assert.equal(metadata.autoRetries?.build?.code, "wall_clock_timeout", "the timeout consumed its one durable auto_retry");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});

test("done-when 1 and 4: a stall_timeout seals and auto-retries on the same runtime too", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-seal-stall-e2e-"));
  const provider = writeSealE2eProvider(directory);
  const contractPath = writeContract(directory, fixture({
    id: "seal-stall-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    // The same bet as the wall clock above: 0.4s lost under parallel load
    // on macOS (RM-056), and the retry has to stay inside this too.
    stallTimeoutSec: 2 * SPAWN_WAIT_FACTOR,
    runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { harness: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  try {
    const result = await runContract(contractPath);
    const state = nodeState(result);
    assert.equal(state.status, "done", state.error?.message);
    assert.equal(state.attempt, 2, "the stall spent exactly one automatic retry");
    assert.equal(state.worktree?.previousAttempt, 1, "the second attempt was cut from the stalled attempt's seal");
    assert.equal(git(directory, ["show", "faberun/seal-stall-run/build/1:README.md"]), "attempt-1-sealed", "the stall seal committed the work");
    assert.equal(git(directory, ["show", "refs/faberun/seal-stall-run/run:README.md"]), "attempt-1-sealed", "the sealed work survived into the run ref");
    const metadata = JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8"));
    assert.equal(metadata.autoRetries?.build?.code, "stall_timeout", "the stall consumed its one durable auto_retry");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});

// ---------------------------------------------------------------------------
// done-when 2: an unreachable seal is bounded, never a hang.
// ---------------------------------------------------------------------------

test("done-when 2: a sealed attempt holding index.lock records the bounded outcome instead of hanging", async () => {
  const { repo, runDir, contract } = makeRepoRun();
  const worktree = createAttemptWorktree({ repo, runDir, runId: contract.id, nodeId: "build", attempt: 1 });
  writeFileSync(join(worktree.path, "README.md"), "held\n");
  const gitDir = execFileSync("git", ["-C", worktree.path, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(join(gitDir, "index.lock"), "");
  const state = snapshotFor(contract, worktree);
  const job = /** @type {any} */ ({
    contract,
    node: contract.nodes[0],
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    cwd: worktree.path,
    paths: { stdout: join(runDir, "logs", "worker.jsonl"), stderr: join(runDir, "logs", "worker.err"), prompt: null },
    phase: "worker",
    invocation: { id: "lock-job", pid: null, processGroupId: null },
  });
  try {
    await sealBeforeTerminate(job, { code: "wall_clock_timeout", message: "held" });
    assert.equal(job.state.worktree?.sealedSha, undefined, "a failed seal leaves no sealed work to retry");
    assert.match(String(job.state.worktree?.sealError), /index\.lock|cannot|unable/iu, "the failure is recorded, not swallowed");
    const persisted = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(typeof persisted.worktree?.sealError, "string", "the bounded outcome is durable");
  } finally {
    try { execFileSync("rm", ["-f", join(gitDir, "index.lock")]); } catch {}
    removeWorktree(repo, worktree.path);
  }
});

// ---------------------------------------------------------------------------
// done-when 3: the hook, not the kill, is what seals.
// ---------------------------------------------------------------------------

test("done-when 3: the seal is committed before the kill, so a provider's dying deletion cannot erase it", async () => {
  const { directory, repo, runDir, contract } = makeRepoRun({ timeoutSec: 0.6 });
  const provider = join(directory, "order-provider.mjs");
  writeProvider(provider, `#!${process.execPath}
import { unlinkSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("order-provider 1.0.0"); process.exit(0); }
process.on("SIGTERM", () => { try { unlinkSync("README.md"); } catch {} ; process.exit(0); });
// The work is on disk before the provider touches stdin: a loaded host must
// not be able to run the seal before the work the seal captures exists.
writeFileSync("README.md", "ordered-seal\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "order-thread" }));
process.stdin.resume();
setInterval(() => {}, 60_000);
`);
  const worktree = createAttemptWorktree({ repo, runDir, runId: contract.id, nodeId: "build", attempt: 1 });
  const state = snapshotFor(contract, worktree);
  const runtime = { id: "luna", harness: "codex", model: "test" };
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const job = startProcess({
    contract,
    node: contract.nodes[0],
    state,
    runtime,
    prompt: "task",
    paths: {
      prompt: join(runDir, "logs", "worker.prompt"),
      stdout: join(runDir, "logs", "worker.jsonl"),
      stderr: join(runDir, "logs", "worker.err"),
    },
    phase: "worker",
    workspace: worktree.path,
    onInvocation: () => {},
  });
  try {
    // The provider writes README.md synchronously at startup and registers its
    // SIGTERM handler first, so the sealed content proves the work the seal
    // must capture is already on disk. Mere existence is not enough: the
    // fixture's base commit ships an empty README.md, so a poll on existence
    // returns before the provider has run and lets the seal race an unwritten
    // worktree. Bound the wait on the content instead of sleeping toward it.
    const readme = join(worktree.path, "README.md");
    const sealedWork = "ordered-seal\n";
    await waitForValue(() => (existsSync(readme) && readFileSync(readme, "utf8") === sealedWork ? true : null)).catch(() => {
      throw new Error(`the provider never wrote its sealed work to ${readme} before the seal could run`);
    });
    // Force the wall-clock budget elapsed instead of sleeping through it: this
    // test exercises the seal, not this machine's real-time performance.
    job.startedTicks = process.hrtime.bigint() - BigInt(Math.ceil((contract.timeoutSec + 1) * 1e9));
    await detectStalls(contract, new Map([["build", job]]), async () => {});
    const sealedSha = state.worktree?.sealedSha;
    assert.ok(sealedSha, "the timeout sealed a non-empty attempt");
    assert.equal(git(repo, ["show", `${sealedSha}:README.md`]), "ordered-seal", "the seal holds the work as it was before the kill");
    // The deletion is the provider running its own SIGTERM handler, which is
    // a POSIX proof: `taskkill /F` is the only ending Windows offers a
    // console process, so nothing runs there on the way out. The sealed
    // content asserted above is the ordering proof that holds on both.
    // guard-exempt: host-layout only a POSIX provider runs a dying handler
    if (process.platform !== "win32") assert.equal(existsSync(join(worktree.path, "README.md")), false, "the provider's SIGTERM handler deleted the live file after the seal, proving the seal landed first");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    try { await terminateInvocation(job.invocation, { graceMs: 25, killGraceMs: 500 }); } catch {}
    removeWorktree(repo, worktree.path);
  }
});

// ---------------------------------------------------------------------------
// done-when 5 and 6: tool events reset the stall clock; silence still stalls.
// ---------------------------------------------------------------------------

test("done-when 5: a tool event resets the stall clock even though no workspace file was written", async () => {
  const job = stallJob(`${JSON.stringify({ type: "item.completed", item: { type: "tool_call" } })}\n`, { id: "luna", harness: "codex", model: "test", stallTimeoutSec: 0.2 });
  job.observedOnce = true;
  job.lastEventCount = 0;
  ageProgress(job, 500);
  /** @type {unknown} */
  let timeout;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", job]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout, undefined, "the freshly observed tool event is progress, so the attempt is not stalled");
});

test("done-when 6: after a tool event, silence longer than the runtime threshold still stalls", async () => {
  const job = stallJob(`${JSON.stringify({ type: "item.completed", item: { type: "tool_call" } })}\n`, { id: "luna", harness: "codex", model: "test", stallTimeoutSec: 0.2 });
  job.observedOnce = true;
  job.lastEventCount = 1;
  ageProgress(job, 500);
  /** @type {{code: string}|undefined} */
  let timeout;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", job]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout?.code, "stall_timeout", "a first tool event must not disable stall detection forever");
});

// ---------------------------------------------------------------------------
// A long turn that transmits without closing a turn is alive, not stalled.
// ---------------------------------------------------------------------------

/** One codex reasoning record: neither a completed turn nor a tool call. */
const REASONING_RECORD = `${JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "still working" } })}\n`;

test("a turn still transmitting is not stalled, even when it closes no turn and calls no tool", async () => {
  const job = stallJob(REASONING_RECORD, { id: "luna", harness: "codex", model: "test", stallTimeoutSec: 0.2 });
  const contract = /** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 });
  // The first pass is the observation that records where the transcript stood.
  await detectStalls(contract, new Map([["build", job]]), async () => {});
  // The turn keeps reasoning: more records, still no turn.completed and no
  // tool call, so `turns + toolCalls` is unchanged from the pass above.
  appendFileSync(job.paths.stdout, `${REASONING_RECORD}${REASONING_RECORD}`);
  ageProgress(job, 500);
  /** @type {unknown} */
  let timeout;
  await detectStalls(contract, new Map([["build", job]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout, undefined, "bytes the provider streamed since the last pass are progress");
});

test("a turn that stops transmitting still stalls, so the bytes rule is not an amnesty", async () => {
  const job = stallJob(REASONING_RECORD, { id: "luna", harness: "codex", model: "test", stallTimeoutSec: 0.2 });
  const contract = /** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 });
  await detectStalls(contract, new Map([["build", job]]), async () => {});
  // Nothing appended this time: the transcript is exactly where it was.
  ageProgress(job, 500);
  /** @type {{code: string}|undefined} */
  let timeout;
  await detectStalls(contract, new Map([["build", job]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout?.code, "stall_timeout", "silence past the threshold is still a stall");
});

// ---------------------------------------------------------------------------
// done-when 7: per-runtime thresholds, their validation, fallback, and zcode.
// ---------------------------------------------------------------------------

test("done-when 7: a runtime's stallTimeoutSec is validated, falls back to the contract, and gives zcode a concrete value that stalls it", async () => {
  const zcode = validateRuntime("zcode-glm", { harness: "zcode", model: "glm-5.3" });
  assert.equal(HARNESS_STALL_TIMEOUT_SEC.zcode, 1_800, "the declared zcode value is concrete");
  assert.equal(zcode.stallTimeoutSec, 1_800, "zcode carries its declared threshold");
  assert.equal(stallTimeoutSecFor(zcode, /** @type {any} */ ({ stallTimeoutSec: 300 })), 1_800, "a runtime's own value outranks the contract");
  assert.equal(stallTimeoutSecFor({ id: "luna", harness: "codex", model: "m" }, /** @type {any} */ ({ stallTimeoutSec: 300 })), 300, "an absent value falls back to the contract");
  assert.throws(() => validateRuntime("bad", { harness: "codex", model: "m", stallTimeoutSec: 0 }), /stallTimeoutSec/u);
  assert.throws(() => validateRuntime("bad", { harness: "codex", model: "m", stallTimeoutSec: Number.NaN }), /stallTimeoutSec/u);

  // zcode declares no streamed output, so it is stall-tracked only because its
  // runtime carries the threshold above.
  const job = stallJob("", { id: "zcode-glm", harness: "zcode", model: "glm-5.3", stallTimeoutSec: zcode.stallTimeoutSec });
  job.observedOnce = true;
  ageProgress(job, (zcode.stallTimeoutSec + 1) * 1_000);
  /** @type {{code: string}|undefined} */
  let timeout;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", job]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout?.code, "stall_timeout", "zcode is stalled by its own declared value");
});

// ---------------------------------------------------------------------------
// done-when 7b: a buffered harness's provider log stream is a progress signal.
// ---------------------------------------------------------------------------

test("done-when 7b: a fresh write inside the provider log dir resets zcode's stall clock, and a silent log stalls it", async () => {
  // A log the CLI has just appended to is progress, even though stdout stays
  // at zero bytes for the whole buffered turn.
  const alive = stallJob("", { id: "zcode-glm", harness: "zcode", model: "glm-5.3", stallTimeoutSec: 0.2 });
  alive.logDir = join(dirname(alive.paths.stdout), "build.1.provider");
  mkdirSync(alive.logDir, { recursive: true });
  writeFileSync(join(alive.logDir, "session.jsonl"), `${JSON.stringify({ type: "message" })}\n`);
  alive.observedOnce = true;
  alive.lastLogWriteMs = 0;
  ageProgress(alive, 500);
  /** @type {unknown} */
  let timeout;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", alive]]), async (_job, _status, error) => { timeout = error; });
  assert.equal(timeout, undefined, "the log write is provider progress, not silence");
  assert.ok((alive.lastLogWriteMs ?? 0) > 0, "the seen watermark advanced with the write");

  // And a log dir nothing has written to since the watermark holds no
  // liveness: past the threshold with no new write is a stall.
  const silent = stallJob("", { id: "zcode-glm", harness: "zcode", model: "glm-5.3", stallTimeoutSec: 0.2 });
  silent.logDir = join(dirname(silent.paths.stdout), "build.1.provider");
  mkdirSync(silent.logDir, { recursive: true });
  writeFileSync(join(silent.logDir, "session.jsonl"), `${JSON.stringify({ type: "message" })}\n`);
  silent.observedOnce = true;
  // The watermark is the write this loop has already seen: the log's own
  // mtime, so no later scan can mistake the existing file for a new write.
  // (Not `Date.now() + N` — that bets on this machine's clock.)
  silent.lastLogWriteMs = statSync(join(silent.logDir, "session.jsonl")).mtimeMs;
  ageProgress(silent, 500);
  /** @type {{code: string}|undefined} */
  let stalled;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", silent]]), async (_job, _status, error) => { stalled = error; });
  assert.equal(stalled?.code, "stall_timeout", "a log dir is liveness only while writes keep arriving");

  // A dir that does not exist yet proves nothing either way: a buffered
  // runtime with a logDir but no log is tracked as silent, not crashed on.
  const bare = stallJob("", { id: "zcode-glm", harness: "zcode", model: "glm-5.3", stallTimeoutSec: 0.2 });
  bare.logDir = join(dirname(bare.paths.stdout), "absent.provider");
  bare.observedOnce = true;
  bare.lastLogWriteMs = 0;
  ageProgress(bare, 500);
  /** @type {{code: string}|undefined} */
  let bareTimeout;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300 }), new Map([["build", bare]]), async (_job, _status, error) => { bareTimeout = error; });
  assert.equal(bareTimeout?.code, "stall_timeout", "an absent log dir is not mistaken for progress");
});

// ---------------------------------------------------------------------------
// done-when 8: the tier-exhaustion hold is capped and its post-cap transition named.
// ---------------------------------------------------------------------------

/**
 * @param {"worker"|"judge"} role
 * @param {string|null} heldSince
 * @returns {any}
 */
function tierBlockedState(role, heldSince) {
  return {
    id: "build",
    status: "blocked",
    phase: role,
    updatedAt: heldSince,
    error: { code: "runtime_tier_exhausted", message: "no available runtime remains in tier 1" },
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "a", judge: "b" },
      tierExhaustionCycle: 0,
      tierExhaustion: { role, candidates: [{ runtimeId: "a", exhaustedUntil: null }] },
    },
  };
}

test("done-when 8: the tier-exhaustion hold is capped at its declared value, raises attention, and re-dispatches", () => {
  assert.ok(Number.isFinite(TIER_EXHAUSTION_HOLD_CAP_MS) && TIER_EXHAUSTION_HOLD_CAP_MS > 0, "the cap is a declared positive number");
  const contract = { nodes: [{ id: "build" }] };
  const capped = tierBlockedState("worker", new Date(Date.now() - TIER_EXHAUSTION_HOLD_CAP_MS - 1_000).toISOString());
  const cappedPlan = planResumeRetry(contract, new Map([["build", capped]]), {});
  assert.equal(cappedPlan.actions.get("build"), "retry", "the named post-cap transition re-dispatches on the current runtime");
  assert.equal(cappedPlan.attention.length, 1, "exceeding the cap raises attention");
  assert.equal(cappedPlan.attention[0]?.reason, TIER_EXHAUSTION_CAP_REASON, "the cap names the post-cap transition explicitly");

  const cappedJudge = tierBlockedState("judge", new Date(Date.now() - TIER_EXHAUSTION_HOLD_CAP_MS - 1_000).toISOString());
  assert.equal(planResumeRetry(contract, new Map([["build", cappedJudge]]), {}).actions.get("build"), "rejudge", "a judge-tier cap rejudges rather than re-running the worker");

  const fresh = tierBlockedState("worker", new Date().toISOString());
  assert.equal(planResumeRetry(contract, new Map([["build", fresh]]), {}).actions.get("build"), "hold", "a node under the cap still holds");
});

// ---------------------------------------------------------------------------
// done-when 9: the two stall spellings are one condition, outside failover.
// ---------------------------------------------------------------------------

test("done-when 9: stall_timeout and progress_stalled are unified and both leave NON_FAILOVER_CODES", () => {
  for (const code of ["stall_timeout", "progress_stalled"]) {
    assert.equal(isTimeoutOrStall({ code, message: code }), true, `${code} is a node deadline, never a dropped socket`);
    assert.equal(NON_FAILOVER_CODES.has(code), false, `${code} must be eligible for the failover that follows its one auto_retry`);
  }
  assert.equal(NON_FAILOVER_CODES.has("wall_clock_timeout"), false, "the wall-clock deadline left NON_FAILOVER_CODES too");
});

// ---------------------------------------------------------------------------
// maxTurns: a turn still making requests past the cap ends like a timeout.
// ---------------------------------------------------------------------------

test("a turn cap ends the attempt the way a timeout does: seal path, code turn_limit, exhausted, one automatic retry", async () => {
  const transcript = `${[1, 2, 3].map(() => JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0 } })).join("\n")}\n`;
  const job = stallJob(transcript, { id: "luna", harness: "codex", model: "test" });
  job.observedOnce = true;
  /** @type {{code: string, message: string}|undefined} */
  let limit;
  /** @type {string|undefined} */
  let status;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300, maxTurns: 2 }), new Map([["build", job]]), async (_job, outcome, error) => { status = outcome; limit = error; });
  assert.equal(limit?.code, "turn_limit");
  assert.equal(status, "exhausted", "the same outcome a wall-clock timeout gets, so the same recovery applies");
  assert.match(String(limit?.message), /3 provider requests/u);
  assert.equal(AUTO_RETRY_CODES.has("turn_limit"), true, "the cap earns the one automatic retry a timeout earns");
  const under = stallJob(transcript, { id: "luna", harness: "codex", model: "test" });
  under.observedOnce = true;
  /** @type {unknown} */
  let none;
  await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300, maxTurns: 10 }), new Map([["build", under]]), async (_job, _outcome, error) => { none = error; });
  assert.equal(none, undefined, "under the cap the observed requests are progress, nothing more");
});

// The ceiling used to arrive only as the kill. `maxTurns` was documented once
// in the whole set and not in the contract reference, so the author of the
// audit contract raised `timeoutSec` and `stallTimeoutSec` -- everything they
// knew existed -- and left this at its default; two Opus attempts at maximum
// effort were then cut mid-turn with `turn_limit`, after the cost was paid.
test("an attempt says once that it is nearing its request ceiling, before the ceiling ends it", async () => {
  /** @type {string[]} */
  const written = [];
  const write = process.stdout.write;
  process.stdout.write = /** @type {any} */ ((/** @type {unknown} */ chunk) => { written.push(String(chunk)); return true; });
  try {
    // Four requests against a ceiling of five: past 80%, under the cap.
    const transcript = `${[1, 2, 3, 4].map(() => JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0 } })).join("\n")}\n`;
    const job = stallJob(transcript, { id: "luna", harness: "codex", model: "test" });
    job.observedOnce = true;
    /** @type {unknown} */
    let ended;
    const contract = /** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300, maxTurns: 5 });
    await detectStalls(contract, new Map([["build", job]]), async (_job, _outcome, error) => { ended = error; });
    assert.equal(ended, undefined, "the warning is not a kill: the attempt keeps running");

    const warnings = written.filter((line) => line.includes("maxTurns"));
    assert.equal(warnings.length, 1, `exactly one warning: ${JSON.stringify(written)}`);
    assert.match(warnings[0], /4 of the attempt's maxTurns of 5 provider requests/u);
    assert.match(warnings[0], /raise maxTurns/u);

    // Said once per attempt, not once per tick: the operator reads it, and a
    // line repeated every poll is a line nobody reads.
    written.length = 0;
    await detectStalls(contract, new Map([["build", job]]), async () => {});
    assert.deepEqual(written.filter((line) => line.includes("maxTurns")), []);
  } finally {
    process.stdout.write = write;
  }
});

test("an attempt well under its ceiling says nothing about it", async () => {
  /** @type {string[]} */
  const written = [];
  const write = process.stdout.write;
  process.stdout.write = /** @type {any} */ ((/** @type {unknown} */ chunk) => { written.push(String(chunk)); return true; });
  try {
    const transcript = `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0 } })}\n`;
    const job = stallJob(transcript, { id: "luna", harness: "codex", model: "test" });
    job.observedOnce = true;
    await detectStalls(/** @type {any} */ ({ timeoutSec: 2_400, stallTimeoutSec: 300, maxTurns: 150 }), new Map([["build", job]]), async () => {});
    assert.deepEqual(written.filter((line) => line.includes("maxTurns")), []);
  } finally {
    process.stdout.write = write;
  }
});
