import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { nodeState, notifications, withCodexBinary } from "../runner-helpers.mjs";

// The two escapes the judge write check used to have (lifecycle.mjs's
// judgeWorkspaceWrites failing open on a comparison throw, and the check
// running only after the failed/exhausted branches had already acted): one
// case per escape, plus the advisory-gate half of the same invariant.

/** A judge provider that edits `.gitignore` -- a `snapshot_ignore_changed` comparison throw, not an ordinary write -- and then returns a clean pass verdict. @param {string} directory @returns {string} */
function judgeIgnoreEditProvider(directory) {
  const fake = join(directory, "judge-ignore-edit-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const judge = prompt.startsWith("Review node");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  if (judge) {
    writeFileSync(".gitignore", "poison-ignore\\n");
    const result = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "looks fine", findings: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }));
});
`);
  chmodSync(fake, 0o755);
  return fake;
}

/** A judge provider that writes an ordinary file into its own workspace and then, unconditionally, fails its own turn -- the shape a bounded re-dispatch used to launder because the second attempt's fresh baseline already carried the write. @param {string} directory @returns {string} */
function judgeWriteThenFailProvider(directory) {
  const fake = join(directory, "judge-write-then-fail-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const judge = prompt.startsWith("Review node");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  if (judge) {
    writeFileSync("poison.txt", "x\\n");
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "judge provider crashed" } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }));
});
`);
  chmodSync(fake, 0o755);
  return fake;
}

/** A judge provider that writes an ordinary file into its own workspace and then returns a clean pass verdict. @param {string} directory @returns {string} */
function judgeWriteThenPassProvider(directory) {
  const fake = join(directory, "judge-write-then-pass-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const judge = prompt.startsWith("Review node");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  if (judge) {
    writeFileSync("poison.txt", "x\\n");
    const result = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "looks fine", findings: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }));
});
`);
  chmodSync(fake, 0o755);
  return fake;
}

test("a judge workspace comparison that throws (an edited ignore source) blocks the node instead of adopting the verdict it computed anyway", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-ignore-edit-"));
  const path = writeContract(directory, fixture({
    id: "judge-ignore-edit-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withCodexBinary(judgeIgnoreEditProvider(directory), () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.match(state.error?.message ?? "", /snapshot_ignore_changed/u, "the comparison's own failure reason is named, not swallowed");
  assert.equal(state.gate, null, "the pass verdict the judge computed anyway is never adopted");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 1, "the throw is caught on the first invocation, no re-dispatch");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

test("a judge that writes and then fails its provider is caught on the first attempt, never laundered through the bounded re-dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-write-then-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-write-then-fail-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await withCodexBinary(judgeWriteThenFailProvider(directory), () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.match(state.error?.message ?? "", /poison\.txt/u);
  assert.equal(state.gate, null);
  assert.equal(
    (state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length,
    1,
    "the write is caught before the failed-provider branch's bounded re-dispatch ever runs a second judge invocation",
  );
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

test("an advisory gate does not settle a judge's own write as done", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-write-advisory-"));
  const path = writeContract(directory, fixture({
    id: "judge-write-advisory-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      gate: { review: "advisory" },
    }],
  }));
  const result = await withCodexBinary(judgeWriteThenPassProvider(directory), () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.notEqual(state.status, "done", "an advisory gate must not settle a judge write as done");
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.gate, null, "the clean pass verdict the judge computed anyway is never adopted, advisory or not");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});
