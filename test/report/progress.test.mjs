import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { authoredContractDigest, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { campaignDir, CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { harnessCapabilities } from "../../src/harnesses/index.mjs";
import { PROGRESS_MESSAGE_MAX_BYTES, renderCampaignProgress, renderRunProgress } from "../../src/report/progress.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

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
  const runDir = runDirectory(directory, "report-progress");
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

/**
 * A campaign with one contract per phase spec: each contract's own file
 * written to disk and listed in the campaign's manifest, in the order given
 * (a spec with `manifest: false` is left out of the manifest -- the measured
 * defect this file tests is a manifest holding fewer contracts than the
 * campaign has linked runs, because the orchestrator replaces the manifest's
 * entry each phase). A phase spec with `hasRun: true` also gets a run
 * directory -- the contract's own persisted copy, run metadata and one
 * snapshot per node -- and is registered in the campaign record; one without
 * it stays a manifest entry the campaign has never launched.
 *
 * @param {string} campaignId
 * @param {{id: string, phaseId: string, goal?: string, hasRun: boolean, manifest?: boolean, nodes: {id: string, dependsOn?: string[], snapshot?: Record<string, unknown>}[]}[]} phaseSpecs
 * @param {{at?: string}} [options]
 * @returns {{directory: string, runsDir: string, campaignPath: string}}
 */
function makeCampaign(campaignId, phaseSpecs, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-campaign-progress-"));
  const runsDir = runsRoot(directory);
  const at = options.at ?? "2026-01-01T00:00:00.000Z";
  /** @param {{id: string, phaseId: string, goal?: string, nodes: {id: string, dependsOn?: string[]}[]}} phaseSpec */
  const contractValue = (phaseSpec) => ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: phaseSpec.id,
    campaignId,
    goal: phaseSpec.goal ?? `Goal for ${phaseSpec.id}`,
    cwd: ".",
    nodes: phaseSpec.nodes.map((node) => ({ id: node.id, phase: phaseSpec.phaseId, dependsOn: node.dependsOn ?? [] })),
  });
  const contracts = phaseSpecs
    .filter((phaseSpec) => phaseSpec.manifest !== false)
    .map((phaseSpec) => {
      const contractPath = join(directory, `${phaseSpec.id}.contract.json`);
      writeFileSync(contractPath, `${JSON.stringify(contractValue(phaseSpec), null, 2)}\n`);
      return { path: contractPath, digest: authoredContractDigest(contractPath) };
    });
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId, goal: "Prove the roll-up", contracts, at });
  for (const phaseSpec of phaseSpecs) {
    if (!phaseSpec.hasRun) continue;
    const runDir = join(runsDir, phaseSpec.id);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(contractValue(phaseSpec), null, 2)}\n`);
    writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      pid: process.pid,
      processStartToken: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      sourceIdentity: { kind: "run" },
    }, null, 2)}\n`);
    for (const node of phaseSpec.nodes) {
      writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify({
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        id: node.id,
        type: "backend",
        status: "pending",
        phase: "worker",
        attempt: 1,
        revisions: 0,
        startedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        result: null,
        gate: null,
        error: null,
        ...node.snapshot,
      }, null, 2)}\n`);
    }
    registerRun(campaignPath, phaseSpec.id, at);
  }
  return { directory, runsDir, campaignPath };
}

test("a campaign with three contracts where one has no run reports three phases, the first two counted and the third not started", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-one", [
    { id: "phase-a", phaseId: "phase-a-first-write", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
    { id: "phase-b", phaseId: "phase-b", hasRun: true, nodes: [{ id: "b1", dependsOn: ["a1"], snapshot: { status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("b1 done") } }] },
    { id: "phase-c", phaseId: "phase-c", hasRun: false, nodes: [{ id: "c1", dependsOn: ["b1"] }] },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-one"));
    assert.equal(progress.phases.length, 3);
    assert.equal(progress.phases[0].name, "Phase a first write");
    assert.equal(progress.phases[0].goal, "Goal for phase-a");
    assert.equal(progress.phases[0].counts.settled, 1);
    assert.equal(progress.phases[1].counts.settled, 1);
    assert.deepEqual(progress.phases[1].nodes[0].dependsOn, ["a1"]);
    assert.equal(progress.phases[2].runId, null);
    assert.equal(progress.phases[2].counts.total, 1);
    assert.equal(progress.phases[2].nodes[0].status, "not_started");
    assert.deepEqual(progress.phases[2].nodes[0].dependsOn, ["b1"]);
    assert.equal(progress.counts.settled, 2);
    assert.equal(progress.counts.total, 3);
    assert.equal(progress.percentDone, 67);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the campaign percentage ignores a running node", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-two", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [
        { id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } },
        { id: "a2", snapshot: { status: "running", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" } },
      ],
    },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-two"));
    assert.equal(progress.counts.settled, 1);
    assert.equal(progress.counts.total, 2);
    assert.equal(progress.percentDone, 50);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unpriced judge survives the campaign roll-up, with its log path and tokens kept", () => {
  /** @param {Record<string, unknown>} overrides */
  const invocation = (overrides) => ({
    pid: 1, processGroupId: null, processStartToken: null, planPhase: "p",
    runId: "phase-a", campaignId: "rollup-campaign-three", nodeId: "one",
    reasoning: null, sandbox: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
    deadlineAt: "2026-01-01T00:10:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", signal: null,
    continuationMode: "fresh", status: "closed", promptPath: "prompt.txt", stderrPath: "stderr.txt", exitCode: 0, continuationId: null,
    ...overrides,
  });
  const { directory, runsDir } = makeCampaign("rollup-campaign-three", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [
        {
          id: "one",
          snapshot: {
            status: "done",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            result: doneResult("done"),
            invocations: [
              invocation({ id: "inv-worker", harness: "codex", phase: "worker", model: "gpt-5.6-luna", role: "worker", executable: "codex", stdoutPath: "stdout-worker.txt", usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 }, costUsd: 0.01 }),
              invocation({ id: "inv-judge", harness: "agy", phase: "judge", model: "gemini-3.1-pro-high", role: "judge", executable: "agy", stdoutPath: "stdout-judge.txt", usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 }, costUsd: null }),
            ],
          },
        },
      ],
    },
  ]);
  // The campaign's per-role usage reads the ledger each run persists -- the
  // same records the campaign total sums its money from -- not the snapshots.
  writeFileSync(join(runsDir, "phase-a", "usage.jsonl"), `${JSON.stringify({ role: "worker", inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0, costUsd: 0.01 })}\n${JSON.stringify({ role: "judge", inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0, costUsd: null })}\n`);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-three"));
    assert.equal(progress.costByRole.judge.costProvenance, "unpriced");
    assert.equal(progress.costByRole.judge.costUsd, null);
    assert.equal(progress.costByRole.judge.inputTokens, 1200);
    assert.equal(progress.costByRole.worker.costUsd, 0.01);
    assert.equal(progress.newestSettledNode.summary, "done");
    const node = progress.phases[0].nodes[0];
    assert.equal(node.workerLogPath, "stdout-worker.txt");
    assert.deepEqual(node.judgeLogPaths, ["stdout-judge.txt"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a node worked by one runtime and judged by another reports both, each under its own name", () => {
  // The exact shape of the defect this guards: `state.runtime` is the last
  // *dispatched* runtime, which for a gated node is the judge's -- here the
  // worker ran on codex/gpt-5.6-luna and the judge on agy/gemini-3.1-pro-high,
  // so a roll-up reading `snapshot.runtime` alone would report the judge as
  // though it had done the worker's job.
  const campaignId = "rollup-campaign-runtimes";
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-campaign-runtime-"));
  const runsDir = runsRoot(directory);
  const contractPath = join(directory, "phase-a.contract.json");
  writeFileSync(join(directory, "contract.json"), "{}");
  const contractValue = fixture({
    id: "phase-a",
    campaignId,
    nodes: [{ id: "one", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] }, phase: "phase-a" }],
  });
  writeFileSync(contractPath, `${JSON.stringify(contractValue, null, 2)}\n`);
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const { path: campaignPath } = initializeCampaign(runsDir, {
    campaignId,
    goal: "Prove the roll-up carries both runtimes",
    contracts: [{ path: contractPath, digest: authoredContractDigest(contractPath) }],
  });
  const runDir = join(runsDir, "phase-a");
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
  const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((node) => node.id === "one"));
  /** @param {Record<string, unknown>} overrides */
  const invocation = (overrides) => ({
    pid: 1, processGroupId: null, processStartToken: null, planPhase: "phase-a",
    runId: "phase-a", campaignId, nodeId: "one", reasoning: null, sandbox: null,
    deadlineAt: "2026-01-01T00:10:00.000Z", signal: null, continuationMode: "fresh", status: "closed",
    promptPath: "prompt.txt", stderrPath: "stderr.txt", exitCode: 0, continuationId: null,
    runtimeFingerprint: `${overrides.harness}/${overrides.model}`,
    ...overrides,
  });
  writeFileSync(join(runDir, "nodes", "one.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "one",
    type: planNode.type,
    sourceIdentity: planNode.sourceIdentity,
    packetHash: planNode.packetHash,
    status: "done",
    phase: "complete",
    attempt: 1,
    revisions: 0,
    // The last-dispatched runtime, the judge's -- the field this node's own
    // roll-up must stop reading for "who worked this node".
    runtime: { id: "agy", harness: "agy", model: "gemini-3.1-pro-high", capabilities: harnessCapabilities({ harness: "agy" }) },
    blockedBy: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:30.000Z",
    result: doneResult("done"),
    gate: { verdict: "pass", maxSeverity: "none", summary: "looks good", findings: [] },
    error: null,
    invocations: [
      invocation({ id: "inv-worker", harness: "codex", phase: "worker", model: "gpt-5.6-luna", role: "worker", executable: "codex", stdoutPath: "stdout-worker.txt", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", closedAt: "2026-01-01T00:01:00.000Z", usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 }, costUsd: 0.01 }),
      invocation({ id: "inv-judge", harness: "agy", phase: "judge", model: "gemini-3.1-pro-high", role: "judge", executable: "agy", stdoutPath: "stdout-judge.txt", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:30.000Z", closedAt: "2026-01-01T00:01:30.000Z", usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 }, costUsd: 0.02 }),
    ],
  }, null, 2)}\n`);
  registerRun(campaignPath, "phase-a");
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, campaignId));
    const node = progress.phases[0].nodes[0];
    assert.equal(node.workerRuntime, "codex/gpt-5.6-luna");
    assert.equal(node.judgeRuntime, "agy/gemini-3.1-pro-high");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a node with no gate reports no judge runtime rather than repeating the worker's", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-no-gate", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [{
        id: "one",
        snapshot: {
          status: "done",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          result: doneResult("done"),
          runtime: { harness: "codex", model: "gpt-5.6-luna" },
          invocations: [{
            id: "inv-worker", pid: 1, processGroupId: null, processStartToken: null, harness: "codex", phase: "worker", planPhase: "p",
            runId: "phase-a", campaignId: "rollup-campaign-no-gate", nodeId: "one", model: "gpt-5.6-luna", reasoning: null, sandbox: null,
            startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", deadlineAt: "2026-01-01T00:10:00.000Z",
            closedAt: "2026-01-01T00:01:00.000Z", signal: null, role: "worker", continuationMode: "fresh", status: "closed",
            promptPath: "prompt.txt", stdoutPath: "stdout-worker.txt", stderrPath: "stderr.txt", executable: "codex", exitCode: 0,
            usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 }, costUsd: 0.01, continuationId: null,
          }],
        },
      }],
    },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-no-gate"));
    const node = progress.phases[0].nodes[0];
    assert.equal(node.judgeRuntime, null, "no judge invocation ever ran, so there is no judge runtime to report");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the campaign next action carries its command", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-four", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [{
        id: "build",
        snapshot: {
          status: "blocked",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          result: { status: "blocked_context", summary: "missing config", verification: [], artifacts: [], missingContext: ["missing.txt"] },
        },
      }],
    },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-four"));
    const runDir = join(runsDir, "phase-a");
    assert.equal(progress.nextAction.command, `resume ${runDir} --answer build=<answer-file>`);
    assert.equal(progress.nextAction.runnable, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a phase whose nodes are one done and one blocked reports done below total and is not reported finished", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-five", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [
        { id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } },
        { id: "a2", snapshot: { status: "blocked", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z" } },
      ],
    },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-five"));
    // Both nodes have stopped moving on their own (SETTLED), but only one of
    // them actually finished (SUCCESS): `settled` reaching `total` is not the
    // same fact as `done` reaching it, and a page that only reads `settled`
    // would draw this phase as finished.
    assert.equal(progress.phases[0].counts.done, 1);
    assert.equal(progress.phases[0].counts.settled, 2);
    assert.equal(progress.phases[0].counts.total, 2);
    assert.ok(progress.phases[0].counts.done < progress.phases[0].counts.total, "the phase is not reported finished");
    assert.equal(progress.counts.done, 1);
    assert.equal(progress.percentDone, 50, "the percentage counts done, not settled");
    // Both nodes have stopped moving on their own, so no time is left to
    // wait on -- even though only one of them finished.
    assert.equal(progress.time.remaining, "complete");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a campaign whose journal decisions mention many requirement ids reports no declared ids for a phase, because the scrape is gone", () => {
  const { directory, runsDir, campaignPath } = makeCampaign("rollup-campaign-six", [
    { id: "phase-a", phaseId: "phase-a-first-write", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
  ]);
  appendJournal(campaignPath, {
    type: "decision",
    at: "2026-01-01T00:00:30.000Z",
    eventId: randomUUID(),
    sessionId: "session-1",
    decisionId: "phase-decomposition",
    text: "phase-a-first-write (phase-a) covers R1, R2, R3, R4, R5, R6, R7, R8 and R9 in one sentence, the way a phase decomposition decision reads before a frozen plan carries requirement ids on the phase itself",
  });
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-six"));
    assert.deepEqual(progress.phases[0].declaredRequirementIds, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a campaign whose manifest holds one contract and whose linkedRunIds holds several reports every phase, happened then next", () => {
  // The measured defect (2026-09-18): this campaign's manifest held 1
  // contract while linkedRunIds held 22 -- the orchestrator replaces the
  // manifest's entry each phase, so a roll-up that walks the manifest alone
  // reports one phase where the campaign has run many.
  const { directory, runsDir } = makeCampaign("rollup-campaign-queue", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, manifest: false, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 shipped the resolver") } }] },
    { id: "phase-b", phaseId: "phase-b", hasRun: true, manifest: false, nodes: [{ id: "b1", snapshot: { status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("b1 shipped the isolation") } }] },
    { id: "phase-c", phaseId: "phase-c", hasRun: false, nodes: [{ id: "c1", dependsOn: ["b1"] }] },
  ]);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-queue"));
    assert.equal(progress.phases.length, 3);
    // What happened first, in the order the record registered it; what has
    // not started last, in manifest order.
    assert.deepEqual(progress.phases.map((/** @type {any} */ phase) => phase.runId), ["phase-a", "phase-b", null]);
    assert.equal(progress.phases[0].name, "Phase a");
    assert.equal(progress.phases[0].goal, "Goal for phase-a");
    // What each phase delivered, in the worker's own words.
    assert.equal(progress.phases[0].newestSettledNode.summary, "a1 shipped the resolver");
    assert.equal(progress.phases[1].newestSettledNode.summary, "b1 shipped the isolation");
    assert.equal(progress.phases[2].nodes[0].status, "not_started");
    assert.equal(progress.phases[2].newestSettledNode, null);
    assert.equal(progress.counts.done, 2);
    assert.equal(progress.counts.settled, 2);
    assert.equal(progress.counts.total, 3);
    assert.equal(progress.percentDone, 67);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a linked run whose directory is gone is still a phase, reported as gone rather than dropped", () => {
  const { directory, runsDir, campaignPath } = makeCampaign("rollup-campaign-gone", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
  ]);
  // Linked, then pruned: the record remembers the run, nothing else does.
  registerRun(campaignPath, "phase-pruned");
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-gone"));
    assert.equal(progress.phases.length, 2);
    const gone = progress.phases[1];
    assert.equal(gone.runId, "phase-pruned");
    assert.equal(gone.name, "Phase pruned");
    assert.equal(gone.recordGone, true);
    assert.deepEqual(gone.counts, { done: 0, settled: 0, total: 0 });
    assert.equal(gone.newestSettledNode, null);
    // A phase of unknown size hides no work: the readable counts stand.
    assert.equal(progress.counts.total, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the campaign's per-role usage reads every linked run's ledger and keeps the three token kinds apart", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-tokens", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
    { id: "phase-b", phaseId: "phase-b", hasRun: true, nodes: [{ id: "b1", snapshot: { status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("b1 done") } }] },
  ]);
  // Two runs' ledgers, the worker priced in both and the judge priced in
  // neither. The magnitudes are chosen so a reader that folded cache-read
  // into input, or the two roles into one number, fails these assertions.
  writeFileSync(join(runsDir, "phase-a", "usage.jsonl"), `${JSON.stringify({ role: "worker", inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 3000, costUsd: 0.02 })}\n${JSON.stringify({ role: "judge", inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 5000, costUsd: null })}\n`);
  writeFileSync(join(runsDir, "phase-b", "usage.jsonl"), `${JSON.stringify({ role: "worker", inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 1500, costUsd: 0.01 })}\n`);
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-tokens"));
    assert.equal(progress.costByRole.worker.inputTokens, 150);
    assert.equal(progress.costByRole.worker.outputTokens, 15);
    assert.equal(progress.costByRole.worker.cacheReadInputTokens, 4500);
    assert.equal(progress.costByRole.worker.costUsd, 0.03);
    // A role with no declared price reports its tokens and says unpriced.
    assert.equal(progress.costByRole.judge.costProvenance, "unpriced");
    assert.equal(progress.costByRole.judge.costUsd, null);
    assert.equal(progress.costByRole.judge.inputTokens, 1000);
    assert.equal(progress.costByRole.judge.cacheReadInputTokens, 5000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the campaign's elapsed runs from the record's start and its remaining estimate comes from settled spans alone", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-time", [
    {
      id: "phase-a",
      phaseId: "phase-a",
      hasRun: true,
      nodes: [
        { id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T01:00:00.000Z", updatedAt: "2026-01-01T02:30:00.000Z", result: doneResult("a1 done") } },
        // A running node's own 4h partial elapsed, if it were folded into
        // the mean, would push the estimate far past the settled span.
        { id: "a2", snapshot: { status: "running", startedAt: "2026-01-01T02:30:00.000Z", updatedAt: "2026-01-01T06:30:00.000Z" } },
      ],
    },
  ], { at: "2026-01-01T00:00:00.000Z" });
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-time", Date.parse("2026-01-02T00:00:00.000Z")));
    assert.equal(progress.time.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(progress.time.elapsed, "24h00m");
    assert.equal(progress.time.remaining, "~1h30m remaining (from 1 settled node)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the remaining estimate is absent, not zero, when no node has settled", () => {
  const { directory, runsDir } = makeCampaign("rollup-campaign-no-settled", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "running", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z" } }] },
  ], { at: "2026-01-01T00:00:00.000Z" });
  try {
    const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-no-settled", Date.parse("2026-01-01T01:00:00.000Z")));
    assert.equal(progress.time.elapsed, "1h00m");
    assert.equal(progress.time.remaining, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a manifest contract whose authored file is gone is left out and the linked phases still answer", () => {
  // The measured state that aborted the previous attempt (2026-09-19, seven
  // real campaigns): the orchestrator replaces the manifest entry each phase
  // and its cleanup takes the authored file with it, so the one manifest
  // contract left names a phase whose run is already linked -- and one
  // unguarded read of the missing file cost the page all four answers.
  const { directory, runsDir } = makeCampaign("rollup-campaign-gone-manifest", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
    { id: "phase-b", phaseId: "phase-b", hasRun: true, manifest: false, nodes: [{ id: "b1", snapshot: { status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("b1 done") } }] },
    // A queued contract whose authored file is also gone: never launched, so
    // the unreadable manifest entry is the only place that phase was named.
    { id: "phase-c", phaseId: "phase-c", hasRun: false, nodes: [{ id: "c1", dependsOn: ["b1"] }] },
  ]);
  rmSync(join(directory, "phase-a.contract.json"), { force: true });
  rmSync(join(directory, "phase-c.contract.json"), { force: true });
  const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-gone-manifest"));
  assert.deepEqual(progress.phases.map((/** @type {any} */ phase) => phase.runId), ["phase-a", "phase-b"]);
  assert.equal(progress.phases[0].newestSettledNode.summary, "a1 done");
  assert.equal(progress.counts.done, 2);
  assert.equal(progress.counts.total, 2);
  assert.equal(progress.percentDone, 100);
  assert.equal(progress.time.remaining, "complete");
});

test("a partly priced role reports the dollars on record with provenance partial, and the roll-up carries the campaign total", () => {
  // Measured 2026-09-18 on two real campaigns: worker and judge each partly
  // priced, $3.69 and $6.80 of recorded spend rendering as null money with
  // no campaign total anywhere on the page.
  const { runsDir } = makeCampaign("rollup-campaign-partial-money", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("a1 done") } }] },
    { id: "phase-b", phaseId: "phase-b", hasRun: true, nodes: [{ id: "b1", snapshot: { status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("b1 done") } }] },
  ]);
  // One priced worker invocation and one not -- the mixed ledger that used
  // to erase the role's money entirely. The amounts are binary-exact so the
  // sums assert on arithmetic, not on float rounding.
  writeFileSync(join(runsDir, "phase-a", "usage.jsonl"), `${JSON.stringify({ role: "worker", inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, costUsd: 0.25 })}\n${JSON.stringify({ role: "worker", inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, costUsd: null })}\n`);
  writeFileSync(join(runsDir, "phase-b", "usage.jsonl"), `${JSON.stringify({ role: "worker", inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, costUsd: 0.5 })}\n`);
  const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-partial-money"));
  assert.equal(progress.costByRole.worker.costProvenance, "partial", "the provenance still names the gap the sum cannot close");
  assert.equal(progress.costByRole.worker.costUsd, 0.75);
  assert.equal(progress.costByRole.worker.inputTokens, 160);
  // A role with no invocation on record at all still reports no money.
  assert.equal(progress.costByRole.judge.costProvenance, "none");
  assert.equal(progress.costByRole.judge.costUsd, null);
  assert.equal(progress.costTotalUsd, 0.75);
});

test("a closed campaign's elapsed stops at the record's closedAt, not at the wall clock", () => {
  const { runsDir } = makeCampaign("rollup-campaign-closed", [
    { id: "phase-a", phaseId: "phase-a", hasRun: true, nodes: [{ id: "a1", snapshot: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:30:00.000Z", result: doneResult("a1 done") } }] },
  ], { at: "2026-01-01T00:00:00.000Z" });
  // Close the campaign the way `closeCampaign` writes the record.
  const recordPath = join(campaignDir(runsDir, "rollup-campaign-closed"), CAMPAIGN_FILE);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.status = "closed";
  record.closedAt = "2026-01-01T05:00:00.000Z";
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  // Eight days later the page still reports the five hours the campaign ran.
  const progress = JSON.parse(renderCampaignProgress(runsDir, "rollup-campaign-closed", Date.parse("2026-01-09T00:00:00.000Z")));
  assert.equal(progress.time.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(progress.time.elapsed, "5h00m");
  assert.equal(progress.time.remaining, "complete");
});
