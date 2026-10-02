import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { judgePrompt } from "../../src/engine/prompts.mjs";
import { renderPreviousAttemptSection } from "../../src/engine/retry.mjs";
import { fakeCodex, fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, notifications, withBrokenGateCodex } from "../runner-helpers.mjs";
import { renderFindings } from "../../src/report/render.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

test("fails deterministic verification before the judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-fail-"));
  const path = writeContract(directory, fixture({
    id: "verification-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }), gate: {} }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.ok(state.error, "verification failure records an error");
  assert.equal(state.error.code, "verification_failed");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.ok(state.verification, "verification state persisted");
  assert.ok(state.verification.commands, "verification commands persisted");
  // Default repeat is 1: the last worker attempt's single command run replaces
  // the phase state.
  assert.equal(state.verification.commands[0].attempts.length, 1);
  assert.equal(state.verification.completed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  assert.equal(state.verification.attempts.length, 1);
  assert.equal(new Set(state.verification.attempts.map((attempt) => attempt.invocationId)).size, 1);
  assert.ok(state.verification.attempts.every((attempt) => attempt.status === "failed" && Number.isInteger(attempt.pid) && (process.platform === "win32" ? attempt.processGroupId === null : Number.isInteger(attempt.processGroupId)))); // guard-exempt: host-layout a process group is POSIX; Windows publishes none and kills by pid
  assert.equal(state.attempt, 2);
  assert.equal(state.revisions, 1);
  assert.ok(state.gate, "verification failure still records a gate");
  assert.equal(state.gate.verdict, "fail");
  assert.equal(state.gate.maxSeverity, "critical");
  assert.match(state.gate.findings[0].evidence, /exit=2/u);
});

test("a retried attempt continues from the previous attempt's sealed worktree instead of a fresh cut from the integration head", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-continue-sealed-"));
  const path = writeContract(directory, fixture({
    id: "continue-sealed-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ writeFiles: ["README.md", "carried.txt"], verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "continuation-carries-file", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.attempt, 2);
  assert.equal(state.revisions, 1);
  assert.equal(state.worktree?.previousAttempt, 1, "the second attempt's worktree records which sealed attempt it continues");
  assert.ok(state.worktree?.path && existsSync(state.worktree.path), "the exhausted attempt keeps its worktree for inspection");
  assert.equal(
    readFileSync(join(state.worktree.path, "carried.txt"), "utf8"),
    "attempt-1\n",
    "attempt 2 began from attempt 1's sealed edit rather than a fresh cut from the integration head",
  );
});

test("oversized judge prompt fails before judge spawn or persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-prompt-cap-"));
  const path = writeContract(directory, fixture({
    id: "judge-prompt-cap-run",
    pollIntervalMs: 10,
    // The judge must be required (a judgment item) for the prompt cap to bite:
    // a purely mechanical Definition of Done now settles without a judge.
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: /** @type {import("../../src/contract/definition-of-done.mjs").DefinitionOfDoneItem[]} */ ([
        { id: "huge-0", text: "x".repeat(2 * 1024), judgment: true },
        ...Array.from({ length: 40 }, (_, index) => ({ id: `huge-${index + 1}`, text: "y".repeat(2 * 1024), proof: { kind: "command", ref: "true" } })),
      ]),
      taskPacket: packet(),
      gate: {},
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.ok(state.error, "judge prompt cap records an error");
  assert.equal(state.error.code, "judge_prompt_too_large");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0);
});

test("skips the judge when every Definition of Done item is mechanical", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-mechanical-gate-out-"));
  const script = join(outDir, "mechanical-proof.mjs");
  const marker = join(outDir, "proved.txt");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "proved");\n`);
  const fake = join(directory, "mechanical-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("mechanical-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "marker", text: "marker file exists", proof: { kind: "command", ref: `"${process.execPath}" "${script}"` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "the mechanical gate records a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge invocation for a purely mechanical Definition of Done");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
  assert.equal(readFileSync(marker, "utf8"), "proved", "the mechanical proof command ran in the contract workspace");
});

test("invokes the judge with the deterministic checklist when a judgment item exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judgment-gate-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judgment-gate-out-"));
  writeFileSync(join(directory, "proved.txt"), "proved");
  const promptPath = join(outDir, "judge-prompt.txt");
  const fake = join(directory, "judgment-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("judgment-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    writeFileSync(${JSON.stringify(promptPath)}, request.prompt);
    const result = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "quality passes", findings: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judgment-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "marker file exists", proof: { kind: "path", ref: "proved.txt" } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 1, "the judgment item invokes the judge");
  assert.equal(existsSync(join(result.runDir, "logs", "build.1.judge.jsonl")), true, "judge protocol events are persisted");
  const prompt = readFileSync(promptPath, "utf8");
  assert.match(prompt, /Judgment items — arbitrate only these:\n- \[quality\]/u);
  assert.match(prompt, /Deterministic items — already proven by the controller/u);
  assert.match(prompt, /- \[proved\] PASS — marker file exists \(proof: path proved\.txt\)/u);
  assert.match(prompt, /do not re-arbitrate them/u);
  assert.match(prompt, /Arbitrate only the judgment items/u);
});

test("a failing mechanical proof rejects the worker generation without any judge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-mechanical-fail-"));
  const fake = join(directory, "mechanical-fail-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("mechanical-fail-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "mech" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "mech", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "mechanical-fail-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "must-pass", text: "the check passes", proof: { kind: "command", ref: `"${process.execPath}" -e ${JSON.stringify("process.exit(3)")}` } }],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "mechanical_gate_failed");
  assert.equal(state.revisions, 1, "a failing mechanical proof consumes a bounded revision like deterministic verification");
  assert.equal(state.attempt, 2);
  assert.equal(state.gate?.verdict, "fail");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "no judge was ever invoked");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")));
});

test("an uncited judge rejection re-asks once then blocks attention without consuming a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

/** A judge that poisons its own workspace when `FABERUN_JUDGE_POISON` is set, and answers cleanly otherwise -- one provider for both halves of the write-detection test. @param {string} directory @returns {string} */
function judgeWorkspaceWriteProvider(directory) {
  const fake = join(directory, "judge-write-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const judge = JSON.parse(input).prompt.startsWith("Review node");
  if (judge && process.env.FABERUN_JUDGE_POISON) writeFileSync("poison.txt", "x\\n");
  const result = judge ? JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "looks fine", findings: [] })
    : JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "c", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  return fake;
}
/** @param {string} directory @param {string} id @param {string} fake @returns {string} */
function judgeWorkspaceWriteContract(directory, id, fake) {
  return writeContract(directory, fixture({
    id, pollIntervalMs: 10, runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      // The provider env is the allowlist `worker-env.mjs` builds, so the
      // poison switch only reaches the judge when the judge runtime names it.
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake, envPassthrough: ["FABERUN_JUDGE_POISON"] },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { review: "blocking", failOn: ["major", "critical"] }, definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }] }],
  }));
}

test("a judge that writes into its own workspace is blocked as a judge_protocol defect, and one that writes nothing still settles as before", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-writes-"));
  const fake = judgeWorkspaceWriteProvider(directory);
  const previousPoison = process.env.FABERUN_JUDGE_POISON;
  process.env.FABERUN_JUDGE_POISON = "1";
  const poisoned = await runContract(judgeWorkspaceWriteContract(directory, "judge-writes-run", fake));
  previousPoison === undefined ? delete process.env.FABERUN_JUDGE_POISON : (process.env.FABERUN_JUDGE_POISON = previousPoison);
  const poisonedState = nodeState(poisoned);
  assert.equal(poisonedState.status, "blocked", poisonedState.error?.message);
  assert.equal(poisonedState.phase, "judge"); assert.equal(poisonedState.error?.code, "judge_protocol");
  assert.match(poisonedState.error?.message ?? "", /poison\.txt/u);
  assert.equal(poisonedState.gate, null, "the judge's own verdict is never adopted once its write is caught");
  assert.ok(notifications(poisoned.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
  const clean = await runContract(judgeWorkspaceWriteContract(directory, "judge-clean-run", fake));
  const cleanState = nodeState(clean);
  assert.equal(clean.ok, true, cleanState.error?.message);
  assert.equal(cleanState.status, "done"); assert.equal(cleanState.gate?.verdict, "pass");
});

test("skips the judge for an empty Definition of Done checklist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-empty-dod-gate-"));
  const judgeCalls = join(runsRoot(directory), "empty-dod-judge-calls.txt");
  const fake = join(directory, "empty-dod-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("empty-dod-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    appendFileSync(${JSON.stringify(judgeCalls)}, "x\\n");
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "unexpected-judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: "not a structured judge result", continuationId: "unexpected-judge", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "empty-dod-gate-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [],
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(result.ok, true);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.revisions, 0);
  assert.equal(state.gate?.verdict, "pass", "an empty checklist settles mechanically with a green verdict");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 0, "an empty Definition of Done never invokes the judge");
  assert.ok(!readdirSync(join(result.runDir, "logs")).some((name) => name.includes("judge")), "no judge protocol events for an empty Definition of Done");
  assert.ok(!existsSync(judgeCalls), "the judge provider is never spawned for an empty Definition of Done");
});

test("an uncited fail below the gate failOn threshold is a judge protocol failure, not a pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-below-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptOne = join(outDir, "judge-prompt-1.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  // A minor verdict sits below every failOn set a blocking review may declare,
  // so an uncited minor rejection isolates the protocol rule from the threshold.
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "minor", summary: "minor but uncited", findings: [{ severity: "minor", description: "the work needs rework", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-below-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-below-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(promptOne)} : ${JSON.stringify(promptTwo)}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-below-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(state.attempt, 1);
  assert.equal(state.gate?.verdict, "fail", "the below-threshold verdict is recorded");
  assert.equal(state.gate?.maxSeverity, "minor", "an uncited fail below failOn is a protocol failure, not a pass");
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "the bounded re-ask still applies below the failOn threshold");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});

test("a judge protocol re-ask over a mixed checklist neither reruns mechanical proofs nor consumes a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-uncited-mixed-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const proofRuns = join(outDir, "proof-runs.txt");
  const proofScript = join(outDir, "counting-proof.mjs");
  // Passes on its first execution and fails on every later one, so a re-ask
  // that reran it would turn the mechanical gate red instead of blocking.
  writeFileSync(proofScript, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(proofRuns)}, "x\\n");\nprocess.exit(readFileSync(${JSON.stringify(proofRuns)}, "utf8").trim().split("\\n").filter(Boolean).length > 1 ? 1 : 0);\n`);
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "uncited-mixed-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("uncited-mixed-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(join(outDir, "judge-prompt-2.txt"))}, request.prompt);
    const result = ${JSON.stringify(uncited)};
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = writeContract(directory, fixture({
    id: "judge-uncited-mixed-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [
        { id: "proved", text: "the proof command runs", proof: { kind: "command", ref: `"${process.execPath}" "${proofScript}"` } },
        { id: "quality", text: "the result is high quality", judgment: true },
      ],
      taskPacket: packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_protocol");
  assert.equal(state.revisions, 0, "the judge protocol failure never consumes a worker revision");
  assert.equal(state.attempt, 1);
  const judges = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judges.length, 2, "exactly one bounded judge re-ask before attention");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal(readFileSync(proofRuns, "utf8").trim().split("\n").filter(Boolean).length, 1, "the mechanical proof runs exactly once and is not rerun by the re-ask");
  assert.match(readFileSync(join(outDir, "judge-prompt-2.txt"), "utf8"), /already proven by the controller/u);
});

test("preserves the worker report when the judge provider fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-fail-"));
  const path = writeContract(directory, fixture({
    id: "judge-fail-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { review: "blocking", failOn: ["major", "critical"] } }],
  }));
  const result = await withFakeCodex(directory, "judge-fail", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.equal((state.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "the bounded judge retry plus the one automatic retry before blocking");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
});

test("a judge whose tool host is disabled never yields a verdict and blocks as judge_unavailable after one retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-tool-host-"));
  const path = writeContract(directory, fixture({
    id: "judge-tool-host-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { review: "blocking", failOn: ["major", "critical"] } }],
  }));
  const result = await withFakeCodex(directory, "judge-tool-host-disabled", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked", `unexpected status: ${state.status} ${state.error?.message ?? ""}`);
  assert.equal(state.phase, "judge");
  assert.equal(state.error?.code, "judge_unavailable");
  assert.match(state.error?.message ?? "", /code-mode host is disabled/u);
  assert.equal(state.gate, null, "no fabricated verdict is ever adopted");
  const judgeInvocations = (state.invocations ?? []).filter((invocation) => invocation.phase === "judge");
  assert.equal(judgeInvocations.length, 3, "the bounded judge retry plus the one automatic retry after the first tool-host failure");
  assert.ok(notifications(result.runDir).some((event) => event.type === "attention" && event.errorCode === "judge_unavailable"));
});

test("bounds gate retries and reports exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-retry-"));
  const path = writeContract(directory, fixture({
    id: "retry-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  assert.equal(result.ok, false);
  assert.equal(nodeState(result).status, "exhausted");
  assert.equal(nodeState(result).attempt, 2);
});

test("findings renders exhausted gate findings ready for a fix node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-"));
  const path = writeContract(directory, fixture({
    id: "findings-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const result = await withBrokenGateCodex(directory, () => runContract(path));
  const rendered = renderFindings(result.runDir);
  assert.match(rendered, /## build/u);
  assert.match(rendered, /\[critical\] broken/u);
  assert.match(rendered, /Evidence: test failed/u);
});

test("a finished run with non-done nodes writes a findings.json handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-artifact-"));
  const path = writeContract(directory, fixture({
    id: "findings-artifact-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "The requested behavior works and is reviewed.", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 0 },
    }],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = fakeCodex(directory, "critical");
  try {
    const result = await runContract(path);
    const artifact = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
    assert.equal(artifact.run, "findings-artifact-run");
    assert.equal(artifact.goal, "Prove the runner works");
    assert.match(artifact.summary, /1 exhausted/u);
    assert.equal(artifact.nodes.length, 1);
    const node = artifact.nodes[0];
    assert.equal(node.id, "build");
    assert.equal(node.status, "exhausted");
    assert.equal(node.error.code, "revision_cap");
    assert.equal(node.gate.maxSeverity, "critical");
    assert.equal(node.gate.findings[0].evidence, "test failed");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
});

test("a fully done run writes no findings.json", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-findings-clean-"));
  const path = writeContract(directory, fixture({ id: "findings-clean-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(result).status, "done");
  assert.equal(existsSync(join(result.runDir, "findings.json")), false);
});

/**
 * R24: the judge prompt carries the newest operator answer as a blocking
 * judgment item, read from the same `Previous attempt` section the worker read.
 * R25: it also carries the reserved owner decisions with the packet's coverage.
 */
test("an unmet operator answer fails the review", () => {
  const previousAttempt = /** @type {string} */ (renderPreviousAttemptSection(/** @type {any} */ ({ attempt: 1, executionOverrides: [{ kind: "operator-answer", at: "2026-01-01T00:00:00.000Z", reason: "operator answered", text: "answer" }] })));
  const node = /** @type {any} */ ({ id: "build", taskPacket: packet(), definitionOfDone: [] });
  const prompt = judgePrompt(node, "worker complete", { previousAttempt });
  assert.match(prompt, /Operator answer:\nanswer[\s\S]*unmet answer is a blocking finding/u, "the answer is a blocking judgment item");
  const without = judgePrompt(node, "worker complete", { previousAttempt: "## Previous attempt\n\nAttempt 1 failed; this is attempt 2. The packet is unchanged." });
  assert.doesNotMatch(without, /Operator answer:/u, "no answer carries no blocking criterion");
});
test("a reserved owner decision taken by the worker fails the review", () => {
  const node = /** @type {any} */ ({ id: "build", taskPacket: packet(), definitionOfDone: [] });
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Reserved owner decisions with no coverage in the decisions above:\n- license\n- pricing\n- branding\n- publication\n- third-party data[\s\S]*A diff that takes an owner decision with no coverage is a blocking finding: fail/u);
  const covered = judgePrompt(/** @type {any} */ ({ ...node, taskPacket: packet({ decisions: ["license: MIT"] }) }), "worker complete");
  const uncovered = covered.slice(covered.indexOf("Reserved owner decisions with no coverage"), covered.indexOf("A diff that takes an owner decision"));
  assert.doesNotMatch(uncovered, /license/u, "a covered decision is not failed by the judge");
  assert.match(uncovered, /pricing/u, "an uncovered decision is still failed by the judge");
});

// F5 aux admission: the judge a settlement starts itself is a dispatch like
// any other -- it takes the runtime's own slot ceiling, and a refusal defers
// it to the scheduler instead of overlapping two judges on one runtime.
test("the settlement's own judge waits for the judge runtime's slot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-slot-"));
  const runDir = runDirectory(directory, "judge-slot-run");
  const concurrencyLog = join(runsRoot(directory), "judge-slot-concurrency.jsonl");
  const alphaJudgeStarted = join(runsRoot(directory), "judge-slot-alpha-judge-started");
  const provider = join(directory, "judge-slot-provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("judge-slot 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "slot-hello" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }));
    return;
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "slot-thread" }));
  if (!prompt.startsWith("Review node")) {
    if (prompt.includes("Beta work")) {
      // Beta's worker holds until alpha's judge is provably live, so beta's
      // settlement decides its judge against the full runtime.
      const deadline = Date.now() + 120_000;
      while (!existsSync(${JSON.stringify(alphaJudgeStarted)}) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }));
    return;
  }
  const node = prompt.startsWith("Review node alpha") ? "alpha" : "beta";
  appendFileSync(${JSON.stringify(concurrencyLog)}, JSON.stringify({ event: "start", node }) + "\\n");
  if (node === "alpha") {
    writeFileSync(${JSON.stringify(alphaJudgeStarted)}, "started\\n");
    // Hold the judge live until beta's settlement has judged against this
    // full runtime: either its judge was deferred to pending, or (the gate
    // regressed) the sibling's own judge already started beside this one.
    const deadline = Date.now() + 120_000;
    for (;;) {
      let settled = false;
      try {
        const snapshot = JSON.parse(readFileSync(${JSON.stringify(join(runDir, "nodes", "beta.json"))}, "utf8"));
        settled = snapshot.status === "pending" && snapshot.phase === "judge";
      } catch {}
      if (settled) break;
      let starts = 0;
      try {
        starts = readFileSync(${JSON.stringify(concurrencyLog)}, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.event === "start").length;
      } catch {}
      if (starts >= 2) break;
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  appendFileSync(${JSON.stringify(concurrencyLog)}, JSON.stringify({ event: "end", node }) + "\\n");
  const verdict = JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 1, cached_input_tokens: 0 } }));
});
`);
  chmodSync(provider, 0o755);
  const judged = (id, objective) => ({
    id,
    type: "backend",
    taskPacket: packet({ objective }),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
    gate: { review: "blocking", failOn: ["major", "critical"] },
  });
  const path = writeContract(directory, fixture({
    id: "judge-slot-run",
    pollIntervalMs: 10,
    maxParallel: 2,
    runtimeDefaults: { worker: "wide", judge: "single" },
    runtimes: {
      wide: { harness: "codex", model: "wide", executable: provider, maxConcurrent: 2 },
      single: { harness: "codex", model: "single", config: { model_provider: "deepseek" }, executable: provider, maxConcurrent: 1 },
    },
    nodes: [judged("alpha", "Alpha work"), judged("beta", "Beta work")],
  }));
  const result = await runContract(path);
  const alpha = nodeState(result, "alpha");
  const beta = nodeState(result, "beta");
  assert.equal(alpha.status, "done", alpha.error?.message);
  assert.equal(beta.status, "done", beta.error?.message);
  assert.equal((beta.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((beta.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 1, "the deferred judge ran exactly once");
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const verdicts = events.filter((event) => event.type === "aux.admission");
  assert.equal(verdicts.length, 1, "the refusal the deferral is gated on is recorded once");
  assert.equal(verdicts[0].role, "judge");
  assert.equal(verdicts[0].runtime, "single");
  assert.equal(verdicts[0].admitted, false);
  const lines = readFileSync(concurrencyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let live = 0;
  let depth = 0;
  for (const line of lines) {
    live += line.event === "start" ? 1 : -1;
    depth = Math.max(depth, live);
  }
  assert.equal(depth, 1, `two judge invocations overlapped on the maxConcurrent 1 runtime: ${JSON.stringify(lines)}`);
  assert.equal(lines.filter((line) => line.event === "start").length, 2, "both judges ran, one after the other");
  assert.ok(
    lines.findIndex((line) => line.event === "start" && line.node === "beta") > lines.findIndex((line) => line.event === "end" && line.node === "alpha"),
    "beta's judge started only after alpha's judge released the runtime",
  );
});

