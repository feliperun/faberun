import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerRun } from "../../src/campaign/index.mjs";
import { campaignDir } from "../../src/campaign/layout.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { PROGRESS_MESSAGE_MAX_BYTES, renderRunProgress } from "../../src/report/progress.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";

/**
 * @param {Record<string, unknown>[]} nodeSpecs each carrying at least id, phase, status
 * @returns {{runDir: string}}
 */
function makeRun(nodeSpecs) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-progress-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodeSpecs.map((spec) => ({ id: spec.id, type: "backend", taskPacket: packet(), gate: false, phase: spec.phase })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, ".runs", "report-progress");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: nodeSpecs[0]?.startedAt ?? "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  for (const spec of nodeSpecs) {
    const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((node) => node.id === spec.id));
    // `spec.phase` is the campaign phase group, already baked into the
    // contract node above; the raw snapshot's own `phase` is the node's
    // execution phase (`worker`/`judge`/`complete`, a disjoint enum) and is
    // derived from its status here unless a test overrides it explicitly.
    const { id, phase: _campaignPhase, ...overrides } = spec;
    const status = /** @type {string} */ (spec.status ?? "pending");
    const snapshotPhase = overrides.phase ?? (["done", "no-op", "canceled", "blocked", "failed", "exhausted", "stalled"].includes(status) ? "complete" : "worker");
    writeFileSync(join(runDir, "nodes", `${id}.json`), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id,
      type: planNode.type,
      sourceIdentity: planNode.sourceIdentity,
      packetHash: planNode.packetHash,
      status: "pending",
      phase: snapshotPhase,
      attempt: 1,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      result: null,
      gate: null,
      error: null,
      ...overrides,
    }, null, 2)}\n`);
  }
  return { runDir };
}

/** @param {string} summary */
const doneResult = (summary) => ({ status: "done", summary, verification: [], artifacts: [], missingContext: [] });

test("a three-node run with two settled nodes renders the percentages, the count and the next node", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("first node shipped the schema") },
    { id: "two", phase: "p", status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z", result: doneResult("second node shipped the migration") },
    { id: "three", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "two", status: "done", attempt: 1 });
    assert.match(message, /\[\+\] campaign test-campaign · phase p · node two/u);
    assert.match(message, /2\/3 nodes done · 67% done · 33% left/u);
    assert.match(message, /this node: 2m00s/u);
    assert.match(message, /phase estimate: ~1m30s remaining \(from 2 settled nodes\)/u);
    assert.match(message, /next: three/u);
    assert.match(message, /worker says: second node shipped the migration/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the estimate ignores a running node's partial span", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("first node done") },
    // A running node's own elapsed span, if it were folded into the mean,
    // would push the estimate to roughly two hours; it must not appear.
    { id: "two", phase: "p", status: "running", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T02:01:00.000Z" },
    { id: "three", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /phase estimate: ~2m00s remaining \(from 1 settled node\)/u);
    assert.doesNotMatch(message, /h\d/u, "no hour-scale estimate leaked in from the running node's partial span");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an unpriced judge renders as unpriced with its tokens", () => {
  const { runDir } = makeRun([
    {
      id: "one",
      phase: "p",
      status: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      result: doneResult("done"),
      invocations: [
        {
          id: "inv-worker", pid: 1, processGroupId: null, processStartToken: null, harness: "codex", phase: "worker", planPhase: "p", runtimeFingerprint: "codex/gpt-5.6-luna",
          runId: "report-progress", campaignId: "test-campaign", nodeId: "one", model: "gpt-5.6-luna", reasoning: null,
          sandbox: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", deadlineAt: "2026-01-01T00:10:00.000Z",
          closedAt: "2026-01-01T00:01:00.000Z", signal: null, role: "worker", continuationMode: "fresh", status: "closed",
          promptPath: "prompt.txt", stdoutPath: "stdout.txt", stderrPath: "stderr.txt", executable: "codex", exitCode: 0,
          usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 }, costUsd: 0.01, continuationId: null,
        },
        {
          id: "inv-judge", pid: 2, processGroupId: null, processStartToken: null, harness: "agy", phase: "judge", planPhase: "p", runtimeFingerprint: "agy/gemini-3.1-pro-high",
          runId: "report-progress", campaignId: "test-campaign", nodeId: "one", model: "gemini-3.1-pro-high", reasoning: null,
          sandbox: null, startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:30.000Z", deadlineAt: "2026-01-01T00:10:00.000Z",
          closedAt: "2026-01-01T00:01:30.000Z", signal: null, role: "judge", continuationMode: "fresh", status: "closed",
          promptPath: "prompt.txt", stdoutPath: "stdout.txt", stderrPath: "stderr.txt", executable: "agy", exitCode: 0,
          usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 }, costUsd: null, continuationId: null,
        },
      ],
    },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /judge unpriced \(in 1k · out 300 · cache -\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an attention event renders the command that unblocks it", () => {
  const { runDir } = makeRun([
    {
      id: "build",
      phase: "p",
      status: "blocked",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      result: { status: "blocked_context", summary: "missing config", verification: [], artifacts: [], missingContext: ["missing.txt"] },
    },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "attention", runId: "report-progress", nodeId: "build", status: "blocked" });
    assert.match(message, new RegExp(`decide: answer node build's missing context \\(needs missing\\.txt\\) → resume ${runDir} --answer build=<answer-file>`, "u"));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the campaign total sums cost across every linked run, not just this phase's", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("done") },
  ]);
  const runsDir = dirname(runDir);
  const campaignPath = campaignDir(runsDir, "test-campaign");
  registerRun(campaignPath, "report-progress");
  writeFileSync(join(runDir, "usage.jsonl"), `${JSON.stringify({ costUsd: 0.02 })}\n`);

  // A prior phase's own run, linked to the same campaign, its usage.jsonl the
  // only place its spend lives once its own run directory is otherwise gone.
  const priorPhaseRunDir = join(runsDir, "phase-one");
  mkdirSync(priorPhaseRunDir, { recursive: true });
  writeFileSync(join(priorPhaseRunDir, "usage.jsonl"), `${JSON.stringify({ costUsd: 0.05 })}\n`);
  registerRun(campaignPath, "phase-one");

  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /campaign total \$0\.070000/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a message whose worker summary is enormous stays under the ceiling with the rest of the blocks intact", () => {
  const hugeSummary = "x".repeat(4000);
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult(hugeSummary) },
    { id: "two", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.ok(Buffer.byteLength(message, "utf8") <= PROGRESS_MESSAGE_MAX_BYTES);
    assert.match(message, /1\/2 nodes done · 50% done · 50% left/u);
    assert.match(message, /this node: 1m00s/u);
    assert.match(message, /next: two/u);
    assert.match(message, /worker says: x+…/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
