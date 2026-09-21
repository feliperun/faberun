import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { packetRepetitionByNode, packetRepetitionNote } from "../../src/report/packet-repetition.mjs";
import { renderReport } from "../../src/report/render.mjs";
import { renderFinalReport } from "../../src/report/final.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

/** @param {string} runDir @param {Record<string, string>} files runDir-relative path → content */
function writeFiles(runDir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(runDir, path, ".."), { recursive: true });
    writeFileSync(join(runDir, path), content);
  }
}

/** @param {string} promptPath @returns {Record<string, unknown>} */
const worker = (promptPath) => ({ role: "worker", promptPath });

test("successive attempts that re-send the same packet repeat every packet byte", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/one.txt": "same packet bytes", "prompts/two.txt": "same packet bytes" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker("prompts/one.txt"), worker("prompts/two.txt")] }]);
    // Two attempts carried 17 bytes each; the second re-sent the first's
    // 17 bytes identically.
    assert.deepEqual(repetition.get("one"), { attempts: 2, packetsRead: 2, packetBytes: 34, repeatedBytes: 17 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the repeated bytes are the common prefix the two packets share, nothing more", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    // Both 25 bytes; they share "HEAD\nnode build\nattempt " (24) and differ
    // only at the attempt counter's digit.
    writeFiles(runDir, { "prompts/one.txt": "HEAD\nnode build\nattempt 1", "prompts/two.txt": "HEAD\nnode build\nattempt 2" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker("prompts/one.txt"), worker("prompts/two.txt")] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 2, packetsRead: 2, packetBytes: 50, repeatedBytes: 24 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a missing middle packet pairs nothing: absent is never zero and no pair forms across the gap", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    // one.txt and three.txt are byte-identical on purpose: a reader that
    // paired across the missing middle attempt would count them as a
    // successive pair and report repetition where none was measured.
    writeFiles(runDir, { "prompts/one.txt": "alpha", "prompts/three.txt": "alpha" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker("prompts/one.txt"), worker("prompts/mid.txt"), worker("prompts/three.txt")] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 3, packetsRead: 2, packetBytes: 10, repeatedBytes: null });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node with a single attempt has no successive pair and measures no repetition", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/one.txt": "same packet bytes" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker("prompts/one.txt")] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 1, packetsRead: 1, packetBytes: 17, repeatedBytes: null });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("judge invocations are not attempts: the pair is the two workers', whatever the judge was sent", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/one.txt": "same packet bytes", "prompts/judge.txt": "JUDGE REVIEW PROMPT", "prompts/two.txt": "same packet bytes" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker("prompts/one.txt"), { role: "judge", promptPath: "prompts/judge.txt" }, worker("prompts/two.txt")] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 2, packetsRead: 2, packetBytes: 34, repeatedBytes: 17 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an invocation without a promptPath leaves the pair unmeasurable, its attempt still counted", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/two.txt": "same packet bytes" });
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [{ role: "worker" }, worker("prompts/two.txt")] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 2, packetsRead: 1, packetBytes: 17, repeatedBytes: null });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an absolute promptPath is taken as written", () => {
  const outside = mkdtempSync(join(tmpdir(), "faberun-report-packet-abs-"));
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    const absolute = join(outside, "packet.txt");
    writeFileSync(absolute, "same packet bytes");
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: [worker(absolute), worker(absolute)] }]);
    assert.deepEqual(repetition.get("one"), { attempts: 2, packetsRead: 2, packetBytes: 34, repeatedBytes: 17 });
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node with no invocations at all reports nothing, not zero", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    const repetition = packetRepetitionByNode(runDir, [{ id: "one", invocations: undefined }]);
    assert.deepEqual(repetition.get("one"), { attempts: 0, packetsRead: 0, packetBytes: null, repeatedBytes: null });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the note lists per node the repeated of the total, unmeasured where the packets are gone", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/one.txt": "HEAD\nnode build\nattempt 1", "prompts/two.txt": "HEAD\nnode build\nattempt 2" });
    const nodes = [
      { id: "measured", invocations: [worker("prompts/one.txt"), worker("prompts/two.txt")] },
      { id: "gone", invocations: [worker("prompts/gone-a.txt"), worker("prompts/gone-b.txt")] },
      { id: "single", invocations: [worker("prompts/one.txt")] },
    ];
    const note = packetRepetitionNote(packetRepetitionByNode(runDir, nodes));
    assert.equal(note, " · packet repeat across attempts: measured 24 of 50 · gone unmeasured");
    // A run where nothing has a successive pair adds nothing to the line.
    assert.equal(packetRepetitionNote(packetRepetitionByNode(runDir, [{ id: "single", invocations: [worker("prompts/one.txt")] }])), "");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the note marks a measurement that covers only some of the node's packets as partial", () => {
  const runDir = mkdtempSync(join(tmpdir(), "faberun-report-packet-"));
  try {
    writeFiles(runDir, { "prompts/one.txt": "HEAD\nnode build\nattempt 1", "prompts/two.txt": "HEAD\nnode build\nattempt 2" });
    const nodes = [{ id: "one", invocations: [worker("prompts/one.txt"), worker("prompts/two.txt"), worker("prompts/three.txt")] }];
    assert.equal(packetRepetitionNote(packetRepetitionByNode(runDir, nodes)), " · packet repeat across attempts: one 24 of 50 (partial)");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** @param {string} summary @returns {Record<string, unknown>} */
const doneResult = (summary) => ({ status: "done", summary, verification: [], artifacts: [], missingContext: [] });

test("report exposes repeated packet bytes between successive attempts", () => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-packet-wiring-"));
  const contractPath = writeContract(directory, fixture({
    nodes: [
      { id: "one", type: "backend", taskPacket: packet(), gate: false, phase: "p" },
      { id: "solo", type: "backend", taskPacket: packet(), gate: false, phase: "p" },
    ],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(directory, "report-packet");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  writeFiles(runDir, {
    "prompts/one.txt": "HEAD\nnode one\nattempt 1",
    "prompts/two.txt": "HEAD\nnode one\nattempt 2",
    "prompts/solo.txt": "HEAD\nnode solo\nattempt 1",
  });
  /** @param {string} id @param {string} promptPath @param {string} startedAt @returns {Record<string, unknown>} */
  const invocation = (id, promptPath, startedAt) => ({
    id, pid: 1, processGroupId: null, processStartToken: null, harness: "codex", phase: "worker", planPhase: "p",
    runtimeFingerprint: "codex/gpt-5.6-luna", runId: "report-packet", campaignId: "test-campaign", nodeId: "one",
    model: "gpt-5.6-luna", reasoning: null, sandbox: null, startedAt, updatedAt: startedAt,
    deadlineAt: "2026-01-01T00:10:00.000Z", closedAt: startedAt, signal: null, role: "worker",
    continuationMode: "fresh", status: "closed", promptPath, stdoutPath: "stdout.txt", stderrPath: "stderr.txt",
    executable: "codex", exitCode: 0, usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 },
    costUsd: 0.01, continuationId: null,
  });
  /**
   * @param {string} id @param {number} attempt @param {Record<string, unknown>[]} invocations
   * @returns {Record<string, unknown>}
   */
  const snapshot = (id, attempt, invocations) => {
    const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((node) => node.id === id));
    return {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id,
      type: planNode.type,
      sourceIdentity: planNode.sourceIdentity,
      packetHash: planNode.packetHash,
      status: "done",
      phase: "complete",
      attempt,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      result: doneResult("done"),
      gate: null,
      error: null,
      invocations,
    };
  };
  const snapshots = [
    snapshot("one", 2, [invocation("inv-one-1", "prompts/one.txt", "2026-01-01T00:00:00.000Z"), invocation("inv-one-2", "prompts/two.txt", "2026-01-01T00:01:00.000Z")]),
    // A single-attempt node sits beside it to prove it stays out of the note.
    snapshot("solo", 1, [invocation("inv-solo-1", "prompts/solo.txt", "2026-01-01T00:00:00.000Z")]),
  ];
  for (const state of snapshots) writeFileSync(join(runDir, "nodes", `${state.id}.json`), `${JSON.stringify(state, null, 2)}\n`);
  try {
    const report = renderReport(runDir);
    assert.match(report, / · packet repeat across attempts: one 22 of 46/u);
    assert.doesNotMatch(report, /packet repeat across attempts:.*solo/u);
    const states = /** @type {Map<string, import("../../src/contract/index.mjs").NodeSnapshot>} */ (new Map(snapshots.map((state) => [state.id, state])));
    assert.match(renderFinalReport(runDir, contract, states), / · packet repeat across attempts: one 22 of 46/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
