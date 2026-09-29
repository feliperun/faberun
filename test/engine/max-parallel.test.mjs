/**
 * `maxParallel` is the run's promise about how much it will run at once, and
 * an operator plans capacity around it. The dispatch loop honours it for the
 * dispatches it makes itself; this file covers the dispatch it does not make,
 * the next attempt a node's own settlement starts after a red verification or
 * a judge rejection.
 *
 * Measured 2026-09-21 on run state-location-and-routing-economics-13: with
 * `maxParallel: 1` declared in the contract and in the run's persisted
 * contract.json, `declare-routing-strategy` (pid 7717, attempt 1) and
 * `measure-repeated-packet-bytes` (pid 10471, attempt 2 after a revision)
 * were both alive at once -- the revision was started by a background
 * settlement while the sibling held the run's only slot.
 *
 * The workers themselves record the run's concurrency: every invocation
 * appends its own start and end to one append-only ledger, so the assertion
 * reads what processes actually overlapped rather than what a snapshot
 * happened to say at one instant.
 *
 * The second case measures the same freed slot with the judge instead of the
 * revision: a settlement that releases a judge starts that process itself,
 * through `startJudge`, with no slot check at all -- not the run's
 * `maxParallel`, not the runtime's `maxConcurrent`. The counts it records are
 * the R7 experiment: whether a run whose only slot a sibling already holds can
 * still find itself running a second provider process.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { SPAWN_WAIT_FACTOR, fixture, packet, waitForValue, writeContract } from "../helpers.mjs";
import { writeExecutable } from "../write-executable.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

/**
 * A provider stand-in that reports its own lifetime. Each worker invocation
 * appends `start <node>` when it begins and `end <node>` when it finishes, so
 * the ledger is an ordered record of overlapping processes; a node named in
 * `hold` stays alive until the release file exists, which is what keeps a
 * sibling provably running while another node's settlement decides what to do
 * next.
 *
 * @param {string} directory
 * @param {string} ledger
 * @param {string} release
 * @param {string} hold
 * @returns {string}
 */
function ledgerProvider(directory, ledger, release, hold) {
  const path = join(directory, "fake-codex-ledger.mjs");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const node = process.env.FABERUN_NODE_ID ?? "unknown";
    appendFileSync(${JSON.stringify(ledger)}, \`start \${node}\\n\`);
    const finish = () => {
      const text = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
      const resultPath = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1] ?? null;
      if (resultPath) writeFileSync(resultPath, text);
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      appendFileSync(${JSON.stringify(ledger)}, \`end \${node}\\n\`);
    };
    if (node !== ${JSON.stringify(hold)}) {
      finish();
      return;
    }
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      finish();
    }, 5);
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The most workers the ledger ever shows alive at the same time.
 *
 * @param {string} ledger
 * @returns {number}
 */
function peakConcurrency(ledger) {
  let live = 0;
  let peak = 0;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (line.startsWith("start ")) live += 1;
    if (line.startsWith("end ")) live -= 1;
    peak = Math.max(peak, live);
  }
  return peak;
}

test("a revision the settlement earned waits for the slot the contract declares", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-max-parallel-"));
  // Outside the repository the run builds worktrees from: nothing the workers
  // write to coordinate this test belongs in a checkout the scope gate reads.
  const scratch = mkdtempSync(join(tmpdir(), "runner-max-parallel-scratch-"));
  const ledger = join(scratch, "worker-ledger");
  const release = join(scratch, "release-second");
  const verifyGate = join(scratch, "release-first-verification");
  const failedOnce = join(scratch, "first-verification-failed-once");
  writeFileSync(ledger, "");
  // `first`'s own verification, in its own child process: it blocks until the
  // test releases it and then fails, once. Blocking is what makes the sibling
  // dispatch (the freed slot of R3) land before the settlement decides, and
  // the marker is what lets the revision's own verification pass so the run
  // finishes either way.
  const verifyScript = `const fs=require("node:fs");
if (fs.existsSync(${JSON.stringify(failedOnce)})) process.exit(0);
while (!fs.existsSync(${JSON.stringify(verifyGate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
fs.writeFileSync(${JSON.stringify(failedOnce)}, "");
process.exit(2);`;
  const path = writeContract(directory, fixture({
    id: "max-parallel-revision-run",
    pollIntervalMs: 10,
    maxParallel: 1,
    nodes: [
      {
        id: "first",
        type: "backend",
        taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", verifyScript], timeoutSec: 60 }] }),
        gate: false,
      },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }));
  const runDir = runDirectory(directory, "max-parallel-revision-run");
  const firstSnapshotPath = join(runDir, "nodes", "first.json");
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = ledgerProvider(scratch, ledger, release, "second");
  const outcome = runContract(path);
  try {
    // `second` holds the run's only slot from here until the release file is
    // written, so anything that starts meanwhile is a second live worker.
    await waitForValue(() => (readFileSync(ledger, "utf8").includes("start second") ? "running" : null), 30_000 * SPAWN_WAIT_FACTOR, 10);
    writeFileSync(verifyGate, "release\n");
    // Whichever way the run answers, it answers here: the ledger shows
    // `first`'s revision started on top of `second` (the defect), or `first`
    // is back in the scheduler's queue waiting for the slot (the fix).
    await waitForValue(() => {
      if (readFileSync(ledger, "utf8").split("\n").filter((line) => line === "start first").length > 1) return "dispatched";
      if (!existsSync(firstSnapshotPath)) return null;
      const state = JSON.parse(readFileSync(firstSnapshotPath, "utf8"));
      return state.status === "pending" && state.revisions === 1 ? "queued" : null;
    }, 30_000, 10);
  } finally {
    writeFileSync(release, "release\n");
  }
  const result = await outcome;
  if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
  else process.env.FABERUN_CODEX_BIN = previous;
  const first = result.states.get("first");
  assert.equal(first?.status, "done", first?.error?.message);
  assert.equal(first?.attempt, 2, "the red verification earned its revision");
  assert.equal(first?.revisions, 1);
  assert.equal(result.states.get("second")?.status, "done", result.states.get("second")?.error?.message);
  assert.equal(peakConcurrency(ledger), 1, `maxParallel is 1, so no two workers may be alive at once:\n${readFileSync(ledger, "utf8")}`);
});

/**
 * A provider stand-in that records, for every invocation it runs, the runtime
 * it was launched as, the role it ran and the node it ran for, and that holds
 * one node's turn open until a release file exists. One script per runtime,
 * because the runtime identity is an `executable` per runtime and not a
 * dispatch-time argument a fixture may read off reliably.
 *
 * The three extra kinds of prompt every fixture in this suite has to know stay
 * separate: a liveness hello is answered and never counted -- it is not an
 * attempt, and counting it would report concurrency the run never had -- while
 * a judge is recognised by the prompt `judgePrompt` builds, exactly as
 * `test/helpers.mjs` recognises one, and answers with a verdict instead of a
 * worker result.
 *
 * @param {string} directory
 * @param {string} runtime
 * @param {string} ledger
 * @param {string} release
 * @param {string} hold
 * @returns {string} the path to spawn
 */
function runtimeLedgerProvider(directory, runtime, ledger, release, hold) {
  // `writeExecutable`, not a shebang this file chmods itself: on Windows a
  // shebang is not a program, so a runtime declared with this executable would
  // answer no version there and never run.
  return writeExecutable(join(directory, `fake-codex-${runtime}.mjs`), `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
      console.log(JSON.stringify({type:"thread.started",thread_id:"preflight-hello"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"preflight hello answered"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));
      return;
    }
    const judge = prompt.includes("Review node");
    const node = judge ? /Review node (\\S+)/.exec(prompt)?.[1] ?? "unknown" : process.env.FABERUN_NODE_ID ?? "unknown";
    const role = judge ? "judge" : "worker";
    const record = (event) => appendFileSync(${JSON.stringify(ledger)}, \`\${event} ${runtime} \${role} \${node}\\n\`);
    record("start");
    const finish = () => {
      const text = judge
        ? JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "the review found no blocking finding", findings: [] })
        : JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
      const resultPath = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1] ?? null;
      if (!judge && resultPath) writeFileSync(resultPath, text);
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      record("end");
    };
    if (node !== ${JSON.stringify(hold)}) { finish(); return; }
    // The held node's turn is released by the test's own file, and by nothing
    // else: a hard-killed test leaves a process polling a file nobody will
    // ever write, so the hold is bounded as well. The bound is longer than
    // every deadline the test itself waits on, so it can only end a hold the
    // test has already stopped having an opinion about.
    const deadline = Date.now() + 120000;
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) return;
      clearInterval(timer);
      finish();
    }, 5);
  });
}
`);
}

/**
 * What one ledger shows: the largest number of provider processes alive at one
 * instant, over all invocations and broken down by the role and the runtime
 * each one ran as. A `start` line per invocation and an `end` line per exit
 * make every overlap a fact of the record; nothing here reads a snapshot that
 * happened to be taken while the processes were alive.
 *
 * @param {string} ledger
 * @returns {{peak: number, byRole: Record<string, number>, byRuntime: Record<string, number>}}
 */
function concurrencyByRoleAndRuntime(ledger) {
  /** @type {Record<string, number>} */
  const byRole = {};
  /** @type {Record<string, number>} */
  const byRuntime = {};
  /** @type {Record<string, number>} */
  const liveByRole = {};
  /** @type {Record<string, number>} */
  const liveByRuntime = {};
  let live = 0;
  let peak = 0;
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    if (!line) continue;
    const [event, runtime, role] = line.split(" ");
    const delta = event === "start" ? 1 : -1;
    live += delta;
    liveByRole[role] = (liveByRole[role] ?? 0) + delta;
    liveByRuntime[runtime] = (liveByRuntime[runtime] ?? 0) + delta;
    byRole[role] = Math.max(byRole[role] ?? 0, liveByRole[role]);
    byRuntime[runtime] = Math.max(byRuntime[runtime] ?? 0, liveByRuntime[runtime]);
    peak = Math.max(peak, live);
  }
  return { peak, byRole, byRuntime };
}

test("measuring R7: a judge released while a sibling holds the run's only slot runs alongside it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-slot-"));
  // Outside the repository the run builds worktrees from: nothing the
  // invocations write to coordinate this test belongs in a checkout the scope
  // gate reads.
  const scratch = mkdtempSync(join(tmpdir(), "runner-judge-slot-scratch-"));
  const ledger = join(scratch, "invocation-ledger");
  const release = join(scratch, "release-second");
  const verificationGate = join(scratch, "release-first-verification");
  writeFileSync(ledger, "");
  // `first`'s own verification, in its own child process: it blocks until this
  // test says the sibling holds the slot, which is what makes the sequence a
  // signal rather than a wait -- the judge `first` earns cannot start before
  // `second` provably did.
  const gateScript = `const fs=require("node:fs");while(!fs.existsSync(${JSON.stringify(verificationGate)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}`;
  const path = writeContract(directory, fixture({
    id: "judge-slot-measured-run",
    pollIntervalMs: 10,
    maxParallel: 1,
    runtimes: {
      // One runtime per role, each capped at one attempt, so the record below
      // answers both bounds the contract declares: the run's `maxParallel` and
      // the runtime's own `maxConcurrent`.
      w: { harness: "codex", model: "gpt-5.6-luna", reasoning: "xhigh", maxConcurrent: 1, executable: runtimeLedgerProvider(scratch, "w", ledger, release, "second") },
      j: { harness: "codex", model: "gpt-5.6-sol", reasoning: "xhigh", config: { model_provider: "deepseek" }, maxConcurrent: 1, executable: runtimeLedgerProvider(scratch, "j", ledger, release, "second") },
    },
    runtimeDefaults: { worker: "w", judge: "j" },
    nodes: [
      {
        id: "first",
        type: "backend",
        taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", gateScript], timeoutSec: 60 }] }),
        definitionOfDone: [{ id: "quality", text: "the change is the one the packet asked for", judgment: true, reason: "no command decides whether the change is the requested one" }],
        gate: { review: "blocking", failOn: ["major", "critical"] },
      },
      // Pinned to the judge's runtime, so the slot `second` takes is the very
      // runtime the released judge lands on.
      { id: "second", type: "backend", runtime: "j", taskPacket: packet(), gate: false },
    ],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  // Each runtime's own `executable` is what this run must launch, and the
  // binary override outranks it.
  delete process.env.FABERUN_CODEX_BIN;
  const outcome = runContract(path);
  try {
    // `second` proves it holds the run's only slot before `first`'s
    // verification is released; only then can the judge `first` earned start.
    await waitForValue(() => (readFileSync(ledger, "utf8").includes("start j worker second") ? "running" : null), 30_000 * SPAWN_WAIT_FACTOR, 10);
    writeFileSync(verificationGate, "release\n");
    await waitForValue(() => (readFileSync(ledger, "utf8").includes("start j judge first") ? "dispatched" : null), 30_000 * SPAWN_WAIT_FACTOR, 10);
  } finally {
    writeFileSync(release, "release\n");
  }
  const result = await outcome;
  if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
  else process.env.FABERUN_CODEX_BIN = previous;
  assert.equal(result.states.get("first")?.status, "done", result.states.get("first")?.error?.message);
  assert.equal(result.states.get("second")?.status, "done", result.states.get("second")?.error?.message);
  // The measurement, per role and per runtime: `first`'s judge ran while
  // `second`'s worker still held the run's only slot, so two provider
  // processes were alive at once under `maxParallel: 1`, both on the runtime
  // whose `maxConcurrent` is also 1. No two workers ever overlapped: the
  // loop's own dispatch keeps that promise, and the revision path checks the
  // run's slot before it starts one (`applyRejection`). The excess is the
  // judge. `finalizeClosedJobs` calls `startJudge` directly, and neither that
  // function nor the scheduler's per-runtime admission stands in front of it,
  // so the slot the freed worker gave away is spent twice.
  //
  // The counts confirm the race, they do not refute it. The correction --
  // admission before every spawn, judge, re-ask, revision and failover alike
  // -- is phase 5's R7, and it is not this test's to make: the dispatch path
  // is outside this phase's closed context. This record is the target that
  // correction has to flip.
  assert.deepEqual(concurrencyByRoleAndRuntime(ledger), { peak: 2, byRole: { worker: 1, judge: 1 }, byRuntime: { w: 1, j: 2 } }, readFileSync(ledger, "utf8"));
});
