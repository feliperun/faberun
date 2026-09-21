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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, waitForValue, writeContract } from "../helpers.mjs";
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
    await waitForValue(() => (readFileSync(ledger, "utf8").includes("start second") ? "running" : null), 30_000, 10);
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
