import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authoredContractDigest, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { buildSnapshot, snapshotSignature, startServer, tailJsonl } from "../../src/web/server.mjs";
import {
  campaignHeadingText,
  campaignOptionsHtml,
  chainStages,
  layoutNodes,
  renderChainSvg,
  renderDrilldownHtml,
  renderPhaseGraphSvg,
  renderSummaryBandHtml,
} from "../../src/web/app.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";
const CAMPAIGN_ID = "dash-campaign";
const TOKEN = "server-test-bearer-1a2b3c4d5e6f7788";
const AUTH = { authorization: `Bearer ${TOKEN}` };

test("tailJsonl returns the last complete entries and drops a torn line", () => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-dashboard-"));
  try {
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({ seq: index }));
    writeFileSync(join(directory, "j.jsonl"), `${lines.join("\n")}\n{\"seq\":\"tor`);
    const entries = tailJsonl(join(directory, "j.jsonl"), 5);
    assert.deepEqual(entries.map((entry) => entry.seq), [15, 16, 17, 18, 19]);
    assert.deepEqual(tailJsonl(join(directory, "missing.jsonl"), 5), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tailJsonl truncates by bytes and resumes at the next full line", () => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-dashboard-"));
  try {
    const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({ seq: index, pad: "x".repeat(40) }));
    writeFileSync(join(directory, "j.jsonl"), `${lines.join("\n")}\n`);
    const entries = tailJsonl(join(directory, "j.jsonl"), 1000, 400);
    assert.ok(entries.length < 50);
    assert.equal(entries.at(-1)?.seq, 49);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

/**
 * A campaign with three phase contracts: `alpha` (done, one settled node with
 * a worker log/prompt/verification/scope), `beta` (running, one node whose
 * two children of the same parent are siblings — the fixture the depth/row
 * tests need), and `gamma`, authored but never launched (`hasRun: false`).
 *
 * @param {{longLog?: boolean, wholeObjectLog?: boolean}} [options]
 * @returns {{directory: string, runsDir: string, tokenFile: string}}
 */
function makeWorld({ longLog = false, wholeObjectLog = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-dashboard-"));
  const tokenFile = join(directory, "dashboard.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const runsDir = runsRoot(directory);

  /** @param {string} phaseId @param {{id: string, dependsOn?: string[]}[]} nodes */
  const contractFor = (phaseId, nodes) => {
    const path = join(directory, `${phaseId}.contract.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id: phaseId,
      campaignId: CAMPAIGN_ID,
      goal: `Goal for ${phaseId}`,
      cwd: ".",
      nodes: nodes.map((node) => ({ id: node.id, phase: phaseId, dependsOn: node.dependsOn ?? [] })),
    }, null, 2)}\n`);
    return { path, digest: authoredContractDigest(path) };
  };

  const alphaNodes = [{ id: "a1" }];
  const betaNodes = [{ id: "root" }, { id: "left", dependsOn: ["root"] }, { id: "right", dependsOn: ["root"] }];
  const gammaNodes = [{ id: "g1" }];
  const contractsByPhase = { alpha: contractFor("alpha", alphaNodes), beta: contractFor("beta", betaNodes), gamma: contractFor("gamma", gammaNodes) };
  const contracts = Object.values(contractsByPhase);
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: CAMPAIGN_ID, goal: "Ship the dashboard rewrite", contracts });

  /**
   * @param {string} phaseId @param {{id: string, snapshot?: Record<string, unknown>}[]} nodes
   */
  const writeRun = (phaseId, nodes) => {
    const runDir = join(runsDir, phaseId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeJson(join(runDir, "run.json"), { schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, pid: process.pid, processStartToken: null, startedAt: NOW, sourceIdentity: { kind: "run" } });
    // A real run always carries this: scheduler.mjs writes a re-serialized
    // copy of the authored contract into its own run directory the moment a
    // run launches, and buildLinkedRunPhase (src/report/progress.mjs) reads
    // it from there, not from the manifest's own copy. Missing it here would
    // report recordGone for every fixture run, which no real launched run is.
    writeFileSync(join(runDir, "contract.json"), readFileSync(contractsByPhase[/** @type {keyof typeof contractsByPhase} */ (phaseId)].path));
    for (const node of nodes) {
      writeJson(join(runDir, "nodes", `${node.id}.json`), {
        schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, id: node.id, type: "backend",
        status: "pending", phase: "worker", attempt: 1, revisions: 0, startedAt: null, updatedAt: NOW, result: null, gate: null, error: null,
        ...node.snapshot,
      });
    }
    registerRun(campaignPath, phaseId);
    return runDir;
  };

  const logPath = join(runsDir, "alpha", "logs", "a1.1.worker.jsonl");
  const promptPath = join(runsDir, "alpha", "logs", "a1.1.worker.prompt");
  writeRun("alpha", [{
    id: "a1",
    snapshot: {
      status: "done", startedAt: NOW, updatedAt: LATER, costUsd: 1.5,
      runtime: { harness: "claude", model: "claude-sonnet-5" }, gate: null,
      invocations: [{ role: "worker", harness: "claude", model: "claude-sonnet-5", stdoutPath: logPath, promptPath }],
      scope: { changedPaths: ["README.md"], changedPathCount: 1, unexpectedPaths: [], unexpectedPathCount: 0 },
      verification: { passed: true, commands: [{ argv: ["npm", "run", "check"], passed: true, attempts: [{ durationMs: 120, stdout: "ok", stderr: "", passed: true }] }] },
    },
  }]);
  mkdirSync(join(runsDir, "alpha", "logs"), { recursive: true });
  // A worker transcript in the wire shape a stream-json harness writes: the
  // frames a reader needs (the Write tool call, the scope refusal, the
  // worker's own words, a plain engine guard line) beside the frames they do
  // not (session init, the result/usage frame).
  const transcriptLines = [
    JSON.stringify({ type: "system", subtype: "init", cwd: "/repo", session_id: "s-1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/src/resolve.mjs", content: "export const one = 1;" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "write denied: this path is outside the declared write scope" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The resolver now lives in one module." }] } }),
    "warn: lock file stale, assumed abandoned",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 12, output_tokens: 7 } }),
  ];
  // zcode's `--json` shape: one pretty-printed object dumped at exit, never
  // one record per line, so every physical line fails transcriptStep's own
  // per-line parse on its own.
  const wholeObjectLogText = JSON.stringify({
    sessionId: "sess_1", traceId: "trace_1", turnId: "turn_1",
    response: "The resolver now lives in one module.",
    usage: { inputTokens: 12, outputTokens: 7 },
  }, null, 2);
  writeFileSync(logPath, longLog ? `${"x".repeat(80)}\n`.repeat(6_000) : wholeObjectLog ? `${wholeObjectLogText}\n` : `${transcriptLines.join("\n")}\n`);
  writeFileSync(promptPath, longLog ? "Implement the dashboard rewrite. ".repeat(4_000) : "Implement the dashboard rewrite.");

  const betaRunDir = writeRun("beta", [
    { id: "root", snapshot: { status: "done", startedAt: NOW, updatedAt: LATER, result: { status: "done", summary: "root shipped", verification: [], artifacts: [], missingContext: [] } } },
    { id: "left", snapshot: { status: "running", startedAt: LATER, updatedAt: LATER } },
    { id: "right", snapshot: { status: "exhausted", startedAt: LATER, updatedAt: LATER, gate: { verdict: "fail", maxSeverity: "major", summary: "needs work", findings: [{ severity: "major", description: "desc", evidence: "ev" }] } } },
  ]);
  writeJson(join(betaRunDir, "status.json"), {
    schemaVersion: 1, run: "beta", contractId: "beta", campaignId: CAMPAIGN_ID, goal: "Goal for beta",
    usage: { costUsd: 0.4 }, controller: { state: "active", pid: process.pid, since: NOW, lastTick: null },
    identityWarnings: [], summary: "1 running · 1 exhausted",
    nodes: [
      { id: "root", status: "done", phase: "p", executionPhase: "complete", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 0, pendingHandoff: null, note: "shipped", scopeFindings: null, errorCode: null, blockedBy: [] },
      { id: "left", status: "running", phase: "p", executionPhase: "worker", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 1, revisions: 0, pendingHandoff: null, note: null, scopeFindings: null, errorCode: null, blockedBy: [] },
      { id: "right", status: "exhausted", phase: "p", executionPhase: "complete", runtime: "claude/claude-sonnet-5", continuation: "fresh", attempt: 2, revisions: 1, pendingHandoff: null, note: "gate fail (major) · needs work", scopeFindings: null, errorCode: "gate_failed", blockedBy: [] },
    ],
  });
  writeFileSync(join(betaRunDir, "events.jsonl"), `${JSON.stringify({ at: LATER, node: "right", from: "running", to: "exhausted" })}\n`);
  writeFileSync(join(betaRunDir, "notify.jsonl"), "");
  writeFileSync(join(betaRunDir, "usage.jsonl"), "");

  return { directory, runsDir, tokenFile };
}

test("buildSnapshot embeds the campaign roll-up, the campaign list and the parallel contract-path list", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
    assert.deepEqual(snapshot.campaigns.map((/** @type {any} */ c) => c.id), [CAMPAIGN_ID]);
    assert.equal(snapshot.progress.campaignId, CAMPAIGN_ID);
    assert.equal(snapshot.progress.phases.length, 3);
    assert.equal(snapshot.progress.phases[2].runId, null, "gamma was authored but never launched");
    assert.equal(snapshot.contractPaths.length, 3);
    assert.equal(snapshot.detail, null, "no node selected");
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the drill-down detail reads the transcript, verification, diff, prompt, error code and revisions", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "alpha", nodeId: "a1" }));
    const detail = snapshot.detail;
    assert.deepEqual(detail.transcript.steps.map((/** @type {any} */ step) => step.kind), ["tool", "error", "message", "note"], "the init and result frames are dropped, everything the worker did stays");
    assert.equal(detail.transcript.steps[0].label, "Write");
    assert.equal(detail.transcript.steps[0].detail, "/repo/src/resolve.mjs");
    assert.match(detail.transcript.steps[1].detail, /write denied: this path is outside the declared write scope/u);
    assert.match(detail.transcript.steps[2].detail, /The resolver now lives in one module\./u);
    assert.equal(detail.verification.commands[0].command, "npm run check");
    assert.equal(detail.diff.stat, "1 file changed");
    assert.match(detail.prompt, /Implement the dashboard rewrite/u);
    assert.equal(detail.errorCode, null);

    const failing = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "beta", nodeId: "right" }));
    assert.equal(failing.detail.errorCode, "gate_failed");
    assert.equal(failing.detail.revisions, 1);
    assert.equal(failing.detail.findings.findings[0].severity, "major");
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the transcript panel renders a tool call and the refusal it hit, and the raw JSONL never reaches the page", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "alpha", nodeId: "a1" }));
    // The wire format stays out of the payload's transcript itself.
    assert.doesNotMatch(JSON.stringify(snapshot.detail.transcript), /tool_use|session_id|input_tokens/u);
    const node = snapshot.progress.phases[0].nodes[0];
    const panel = renderDrilldownHtml(node, snapshot.detail, null);
    assert.match(panel, /<span class="pill progress">tool<\/span> <b>Write<\/b>/u);
    assert.match(panel, /\/repo\/src\/resolve\.mjs/u);
    assert.match(panel, /<div class="tstep error">[\s\S]*?write denied: this path is outside the declared write scope/u);
    assert.match(panel, /The resolver now lives in one module\./u);
    assert.doesNotMatch(panel, /"type":"tool_use"/u, "no raw JSON line is dumped into the panel");
    // The raw file itself stays one click away, named in the On-disk block.
    assert.match(panel, /worker transcript: [\s\S]*a1\.1\.worker\.jsonl/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a whole-file pretty-printed worker log (zcode's --json shape) renders its response, not one raw line per physical line", () => {
  const world = makeWorld({ wholeObjectLog: true });
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "alpha", nodeId: "a1" }));
    assert.deepEqual(snapshot.detail.transcript.steps.map((/** @type {any} */ step) => step.kind), ["message"], "one message step, not a note per physical line");
    assert.equal(snapshot.detail.transcript.steps[0].detail, "The resolver now lives in one module.");
    assert.doesNotMatch(JSON.stringify(snapshot.detail.transcript), /sessionId|traceId|inputTokens/u, "the wire fields never reach the payload");
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the payload stays under 200 KB with a long worker log", () => {
  const world = makeWorld({ longLog: true });
  try {
    const snapshot = buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "alpha", nodeId: "a1" });
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 200 * 1024);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("an unknown campaign id falls back to the active campaign instead of throwing", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: "no-such-campaign" }));
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("server serves the page, the css and js assets, a snapshot, and a 404 for an unknown route", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
  try {
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`, { headers: AUTH });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await page.text(), /Faberun/u);
    const css = await fetch(`${base}/app.css`, { headers: AUTH });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/u);
    const js = await fetch(`${base}/app.mjs`, { headers: AUTH });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/u);
    assert.doesNotMatch(await js.text(), /^import /mu, "the browser module imports nothing");
    const snapshot = /** @type {any} */ (await (await fetch(`${base}/api/snapshot?campaign=${CAMPAIGN_ID}`, { headers: AUTH })).json());
    assert.equal(snapshot.selectedCampaignId, CAMPAIGN_ID);
    assert.equal((await fetch(`${base}/nope`, { headers: AUTH })).status, 404);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the SSE endpoint emits an update when a phase run's status.json changes", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, pollMs: 40 });
  try {
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream?campaign=${CAMPAIGN_ID}`, { headers: AUTH });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @param {number} count */
    const readUpdates = async (count) => {
      const deadline = Date.now() + 5_000;
      while ((buffer.match(/^event: update$/gmu) ?? []).length < count) {
        if (Date.now() > deadline) throw new Error(`only ${(buffer.match(/^event: update$/gmu) ?? []).length} updates arrived`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stream read timed out")), 5_000)),
        ]);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUpdates(1);
    const statusPath = join(world.runsDir, "beta", "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    status.nodes[1].status = "done";
    writeFileSync(statusPath, JSON.stringify(status));
    await readUpdates(2);
    const datas = buffer.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const betaPhase = datas.at(-1).progress.phases.find((/** @type {any} */ phase) => phase.contractId === "beta");
    assert.equal(betaPhase.counts.settled, 2);
    await reader.cancel();
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("snapshotSignature changes when a node snapshot changes and is stable otherwise", () => {
  const world = makeWorld();
  try {
    const selection = { campaignId: CAMPAIGN_ID };
    const before = snapshotSignature(world.runsDir, selection);
    assert.equal(snapshotSignature(world.runsDir, selection), before);
    const nodePath = join(world.runsDir, "alpha", "nodes", "a1.json");
    const node = JSON.parse(readFileSync(nodePath, "utf8"));
    writeFileSync(nodePath, JSON.stringify({ ...node, updatedAt: "2026-01-01T00:09:00.000Z" }));
    assert.notEqual(snapshotSignature(world.runsDir, selection), before);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

// --- src/web/app.mjs: pure graph/layout functions, importable directly since
// they never touch a DOM global at module load time. ---

test("the campaign chain names the campaign and draws one box per phase, each by its human name", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    assert.equal(campaignHeadingText(snapshot.progress), `${CAMPAIGN_ID} · ${snapshot.progress.goal}`);
    const stages = chainStages(snapshot.progress, "active");
    const svg = renderChainSvg(stages);
    for (const phase of snapshot.progress.phases) {
      assert.match(svg, new RegExp(`data-phase="${phase.contractId}"`, "u"));
      assert.match(svg, new RegExp(`>${phase.name}<`, "u"), `${phase.contractId} is shown by its human name, not the id alone`);
      assert.doesNotMatch(svg, new RegExp(`>${phase.phase}<`, "u"), `${phase.contractId}'s id line is gone from the box; it lives in the phase head`);
    }
    const phaseBoxes = (svg.match(/data-phase="/gu) ?? []).length;
    assert.equal(phaseBoxes, stages.length, "one box per stage, including the phases");
    assert.equal(phaseBoxes, snapshot.progress.phases.length + 4, "intent, plan, every phase, integration and release");
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("two nodes sharing a parent and nothing else are emitted at the same depth, side by side", () => {
  const nodes = [
    { id: "root", dependsOn: [], status: "done" },
    { id: "left", dependsOn: ["root"], status: "running" },
    { id: "right", dependsOn: ["root"], status: "running" },
  ];
  const laidOut = layoutNodes(nodes);
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  assert.equal(byId.get("root")?.depth, 0);
  assert.equal(byId.get("left")?.depth, 1);
  assert.equal(byId.get("right")?.depth, 1);
  assert.notEqual(byId.get("left")?.row, byId.get("right")?.row, "siblings at the same depth still get distinct rows");

  const svg = renderPhaseGraphSvg({ nodes });
  assert.match(svg, /<svg/u);
  const leftMatch = /data-node="left"[\s\S]*?<rect x="(\d+)"/u.exec(svg);
  const rightMatch = /data-node="right"[\s\S]*?<rect x="(\d+)"/u.exec(svg);
  assert.ok(leftMatch && rightMatch);
  assert.equal(leftMatch?.[1], rightMatch?.[1], "same column (depth) for both siblings");
});

test("a phase with no run is drawn as not started", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    const stages = chainStages(snapshot.progress, "active");
    const gamma = stages.find((stage) => stage.id === "gamma");
    assert.equal(gamma?.state, "not_started");
    const svg = renderChainSvg(stages);
    assert.match(svg, /data-phase="gamma"[\s\S]*?not started/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the drill-down carries the error code of a failed node and links to its worker transcript", () => {
  const node = {
    id: "right", status: "exhausted", attempt: 2, dependsOn: ["root"], workerRuntime: "claude/claude-sonnet-5", judgeRuntime: "dsh/deepseek-flash",
    elapsedSpan: "1m00s", costUsd: 0.4, workerLogPath: "logs/right.2.worker.jsonl", judgeLogPaths: [],
    verificationRecordPath: "nodes/right.json", attemptBranch: "attempt/right-2", sealCommit: null,
  };
  const detail = { errorCode: "gate_failed", errorMessage: "needs work", revisions: 1, workerRuntime: { harness: "claude", model: "claude-sonnet-5" }, judgeRounds: [] };
  const html = renderDrilldownHtml(node, detail, "/repo/beta.contract.json");
  assert.match(html, /gate_failed/u);
  assert.match(html, /needs work/u);
  assert.match(html, /logs\/right\.2\.worker\.jsonl/u);
  assert.match(html, /attempt\/right-2/u);
  assert.match(html, /beta\.contract\.json/u);
});

test("the drill-down labels the worker's runtime and the judge's runtime as two separate facts", () => {
  const node = {
    id: "right", status: "done", attempt: 2, dependsOn: ["root"], workerRuntime: "claude/claude-sonnet-5", judgeRuntime: "dsh/deepseek-flash",
    elapsedSpan: "1m00s", costUsd: 0.4, workerLogPath: null, judgeLogPaths: [], verificationRecordPath: null, attemptBranch: null, sealCommit: null,
  };
  const html = renderDrilldownHtml(node, null, null);
  assert.match(html, /worker runtime[\s\S]*?claude\/claude-sonnet-5/u);
  assert.match(html, /judge runtime[\s\S]*?dsh\/deepseek-flash/u);
});

test("a node with no gate reports no judge runtime rather than repeating the worker's", () => {
  const node = {
    id: "solo", status: "done", attempt: 1, dependsOn: [], workerRuntime: "claude/claude-sonnet-5", judgeRuntime: null,
    elapsedSpan: null, costUsd: null, workerLogPath: null, judgeLogPaths: [], verificationRecordPath: null, attemptBranch: null, sealCommit: null,
  };
  const html = renderDrilldownHtml(node, null, null);
  const judgeRow = /<div class="drow"><div class="dlabel">judge runtime<\/div><div class="dvalue">([^<]*)<\/div><\/div>/u.exec(html);
  assert.ok(judgeRow);
  assert.equal(judgeRow[1], "–");
  assert.doesNotMatch(html, /judge runtime[\s\S]*?claude\/claude-sonnet-5/u, "the judge row never repeats the worker's runtime");
});

test("the error cell reads empty when nothing failed, and a note reads in its own full-width row", () => {
  const node = {
    id: "root", status: "done", attempt: 1, dependsOn: [], workerRuntime: "claude/claude-sonnet-5", judgeRuntime: null,
    elapsedSpan: "1m00s", costUsd: 0.1, workerLogPath: null, judgeLogPaths: [], verificationRecordPath: null, attemptBranch: null, sealCommit: null,
  };
  const detail = { errorCode: null, errorMessage: "gate fail (major) · needs work", revisions: 0, workerRuntime: null, judgeRounds: [] };
  const html = renderDrilldownHtml(node, detail, null);
  const errorRow = /<div class="drow"><div class="dlabel">error<\/div><div class="dvalue">([^<]*)<\/div><\/div>/u.exec(html);
  assert.ok(errorRow);
  assert.equal(errorRow[1], "–", "the error cell is empty when the node never failed");
  assert.match(html, /<section class="detailblock"><h4>Note<\/h4><p>gate fail \(major\) · needs work<\/p><\/section>/u);
});

test("the selectors render with the campaigns this repository holds, labelled by campaign id rather than its goal", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    const options = campaignOptionsHtml(snapshot.campaigns, snapshot.selectedCampaignId);
    assert.match(options, new RegExp(`value="${CAMPAIGN_ID}"`, "u"));
    assert.match(options, new RegExp(`>${CAMPAIGN_ID} `, "u"), "the option label leads with the campaign id");
    assert.doesNotMatch(options, /Ship the dashboard rewrite/u, "the goal sentence is not the option label");
    assert.match(options, /selected/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a phase box shows only what fits -- its name and its state -- and leaves the id and the goal to the phase head", () => {
  const progress = {
    phases: [{
      contractId: "state-location-and-routing-economics-1-run-path-resolver",
      phase: "1-run-path-resolver",
      runId: "state-location-and-routing-economics-1-run-path-resolver",
      name: "Run path resolver",
      goal: "one module resolves the run path, campaign and worktree",
      counts: { done: 1, settled: 1, total: 1 },
    }],
  };
  const stages = chainStages(progress, "active");
  const synthetic = stages.filter((stage) => stage.idMark === null);
  assert.deepEqual(synthetic.map((stage) => stage.id), ["intent", "plan", "integration", "release"]);
  const svg = renderChainSvg(stages);
  assert.match(svg, />Run path resolver</u, "the phase renders by its human name");
  assert.match(svg, /class="stage-state">active<\/text>/u, "the state line is the box's other half");
  assert.doesNotMatch(svg, />1-run-path-resolver</u, "the id line is gone from the box -- four truncated lines was the noise");
  assert.doesNotMatch(svg, /one module resolves/u, "the goal line is gone from the box; the open-phase head carries it untruncated");
  const chunks = svg.split(/(?=<g class="stage )/u);
  for (const stage of [...stages]) {
    const chunk = chunks.find((candidate) => candidate.includes(`data-phase="${stage.id}"`));
    assert.ok(chunk, `${stage.id} has its own box`);
    assert.equal((/** @type {string} */ (chunk).match(/<text /gu) ?? []).length, 2, `${stage.id} carries exactly its label and its state`);
  }
});

test("a phase holding a blocked, failed or exhausted node does not render as done", () => {
  const progress = {
    phases: [{
      contractId: "gate-and-write-check",
      phase: "gate-and-write-check",
      runId: "gate-and-write-check",
      name: "Gate and write check",
      goal: "the gate blocks an unverified write",
      counts: { done: 1, settled: 2, total: 2 },
    }],
  };
  const stages = chainStages(progress, "active");
  const phaseStage = /** @type {any} */ (stages.find((stage) => stage.id === "gate-and-write-check"));
  assert.notEqual(phaseStage.state, "done", "settled equalling total is not the same as done equalling total");
  const svg = renderChainSvg(stages);
  const chunk = /** @type {string} */ (svg.split(/(?=<g class="stage )/u).find((candidate) => candidate.includes('data-phase="gate-and-write-check"')));
  assert.match(chunk, /^<g class="stage active/u, "the box's own class is not done");
  assert.doesNotMatch(chunk, />done<\/text>/u, "the box's own state text does not read done");
});

/**
 * Every text element a box owns must lie inside that box's own rectangle —
 * the geometric check that catches an overprint (two lines at the same y)
 * and a clipping failure (text starting outside its box) alike, without
 * asserting anything about font metrics a test cannot measure.
 *
 * @param {string} svg
 * @returns {{x: number, y: number, width: number, height: number, texts: {x: number, y: number}[]}[]}
 */
function boxesWithOwnText(svg) {
  // Every box opens with `<g class="node …"` or `<g class="stage …"`, and
  // that class never nests (only its own `<clipPath>`/`<g clip-path>` do), so
  // splitting on that boundary hands each chunk exactly one box's own rect,
  // clip rect and text elements, with no risk of crossing into the next box.
  const chunks = svg.split(/(?=<g class="(?:node|stage) )/u).filter((chunk) => /^<g class="(?:node|stage) /u.test(chunk));
  return chunks.map((chunk) => {
    const rectMatch = /<rect x="(-?\d+(?:\.\d+)?)" y="(-?\d+(?:\.\d+)?)" width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/u.exec(chunk);
    const [, x, y, width, height] = /** @type {RegExpExecArray} */ (rectMatch).map(Number);
    const texts = [...chunk.matchAll(/<text x="(-?\d+(?:\.\d+)?)" y="(-?\d+(?:\.\d+)?)"/gu)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    return { x, y, width, height, texts };
  });
}

test("every text element in the chain band and the phase graph lies inside its own box's rectangle", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    const stages = chainStages(snapshot.progress, "active");
    const chainSvg = renderChainSvg(stages);
    const chainBoxes = boxesWithOwnText(chainSvg);
    assert.ok(chainBoxes.length > 0);
    for (const box of chainBoxes) {
      assert.ok(box.texts.length > 0, "every box owns at least one text element");
      for (const text of box.texts) {
        assert.ok(text.x >= box.x && text.x <= box.x + box.width, `text x ${text.x} lies within box [${box.x}, ${box.x + box.width}]`);
        assert.ok(text.y >= box.y && text.y <= box.y + box.height, `text y ${text.y} lies within box [${box.y}, ${box.y + box.height}]`);
      }
    }
    const betaPhase = snapshot.progress.phases.find((/** @type {any} */ phase) => phase.contractId === "beta");
    const nodeSvg = renderPhaseGraphSvg(betaPhase);
    const nodeBoxes = boxesWithOwnText(nodeSvg);
    assert.ok(nodeBoxes.length > 0);
    for (const box of nodeBoxes) {
      for (const text of box.texts) {
        assert.ok(text.x >= box.x && text.x <= box.x + box.width, `text x ${text.x} lies within box [${box.x}, ${box.x + box.width}]`);
        assert.ok(text.y >= box.y && text.y <= box.y + box.height, `text y ${text.y} lies within box [${box.y}, ${box.y + box.height}]`);
      }
    }
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a long node id is truncated to an ellipsis inside its own box rather than clipped mid-character", () => {
  const longId = "one-module-owns-the-run-path-and-the-centralization-guard-only-catches-a-literal-concatenation";
  const svg = renderPhaseGraphSvg({ nodes: [{ id: longId, dependsOn: [], status: "done" }] });
  const idMatch = /<text x="\d+" y="\d+" class="node-id mono">([^<]*)<\/text>/u.exec(svg);
  assert.ok(idMatch);
  assert.ok(idMatch[1].length < longId.length, "the rendered id is shorter than the raw id");
  assert.match(idMatch[1], /…$/u, "truncation ends in an ellipsis, not at a character count that happens to overflow");
});

test("a node box reads its id as the sentence it is, while selection keeps the raw id", () => {
  const svg = renderPhaseGraphSvg({ nodes: [{ id: "state-lives-under-the-home", dependsOn: [], status: "done" }] });
  assert.match(svg, />State lives under the home</u, "the hyphens become the sentence the id always was");
  assert.match(svg, /data-node="state-lives-under-the-home"/u, "selection still carries the raw id");
  assert.match(svg, /aria-label="node state-lives-under-the-home, done"/u);
});

/**
 * A roll-up carrying the four answers, in exactly the shape
 * `renderCampaignProgress` emits (src/report/progress.mjs) -- the fields the
 * summary band reads and nothing it invents.
 */
const ROLLUP = {
  campaignId: CAMPAIGN_ID,
  goal: "Ship the dashboard rewrite",
  counts: { done: 8, settled: 11, total: 13 },
  percentDone: 62,
  costByRole: {
    worker: { costUsd: 3.42, costProvenance: "priced", inputTokens: 6_900_000, outputTokens: 1_200_000, cacheReadInputTokens: 333_500_000, pricedInvocations: 5, unpricedInvocations: 0 },
    judge: { costUsd: null, costProvenance: "unpriced", inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: null, pricedInvocations: 0, unpricedInvocations: 2 },
  },
  costTotalUsd: 3.69,
  time: { startedAt: NOW, elapsed: "5h00m", remaining: "~1h30m remaining (from 11 settled nodes)" },
};

test("the summary band opens the page with the four answers, rendered from the roll-up that carries them", () => {
  const band = renderSummaryBandHtml(ROLLUP);
  // Question one: the campaign and the value it delivers.
  assert.match(band, /dash-campaign/u);
  assert.match(band, /Ship the dashboard rewrite/u);
  // Question two: progress as done over total, behind the notification's bar.
  assert.match(band, /8\/13 nodes done/u);
  assert.match(band, /38% left/u);
  assert.match(band, /class="progressfill" style="width:62%"/u);
  // Question three: cost with the token counts beside it, three kinds kept apart.
  assert.match(band, /worker \$3\.42/u);
  assert.match(band, /in 6\.9M · out 1\.2M · cache 333\.5M/u);
  assert.match(band, /campaign total \$3\.69/u);
  // Question four: elapsed, and the estimate of what is left, labelled as one.
  assert.match(band, /running 5h00m/u);
  assert.match(band, /~1h30m remaining \(from 11 settled nodes\)/u);
});

test("an unpriced role reads as unpriced in the summary band, never as a zero", () => {
  const band = renderSummaryBandHtml(ROLLUP);
  assert.match(band, /judge unpriced \(in 1\.2k · out 300 · cache –\)/u);
  assert.doesNotMatch(band, /judge \$0/u);
  // A role that never ran is a dash -- also never a fabricated zero.
  const idle = renderSummaryBandHtml({
    ...ROLLUP,
    costByRole: { ...ROLLUP.costByRole, judge: { costUsd: null, costProvenance: "none", inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, pricedInvocations: 0, unpricedInvocations: 0 } },
  });
  assert.match(idle, /judge –/u);
  assert.doesNotMatch(idle, /judge unpriced/u);
});

test("the summary band says the estimate is unknown when nothing has settled, and never prints one", () => {
  const band = renderSummaryBandHtml({ ...ROLLUP, time: { startedAt: NOW, elapsed: "0h05m", remaining: null } });
  assert.match(band, /running 0h05m/u);
  assert.match(band, /estimate unknown/u);
  assert.doesNotMatch(band, /remaining \(from/u);
});

// --- narrow-viewport layout: a test cannot measure a rendered pixel, so this
// asserts only what decides the outcome — that the document declares a
// device-width viewport, that the stylesheet (not the markup) carries the
// narrow-viewport rules, and that the same section order ships at every
// width — summary first, spec map last — so a narrow viewport is never
// served different HTML. ---

test("the page declares a device-width viewport, and the narrow-viewport layout is expressed in the stylesheet rather than in different markup", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
  try {
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${base}/`, { headers: AUTH })).text();
    assert.match(html, /<meta name="viewport" content="[^"]*width=device-width[^"]*">/u, "the document declares a device-width viewport");
    const sectionOrder = [...html.matchAll(/<section id="(\w+)"/gu)].map((match) => match[1]);
    assert.deepEqual(sectionOrder, ["summary", "chain", "phaseGraph", "drilldown", "specMap"], "the served markup keeps one section order regardless of viewport");

    const css = await (await fetch(`${base}/app.css`, { headers: AUTH })).text();
    const mediaIndex = css.indexOf("@media (max-width:");
    assert.ok(mediaIndex >= 0, "a narrow-viewport media query exists in the stylesheet");
    const narrowBody = css.slice(mediaIndex);
    assert.match(narrowBody, /\.specmap\s*\{[^}]*grid-template-columns:\s*1fr/u, "the narrow query collapses the spec map to a single column");
    const orderOf = (/** @type {string} */ selector) => Number(new RegExp(`${selector}\\s*\\{[^}]*order:\\s*(\\d+)`, "u").exec(narrowBody)?.[1]);
    assert.ok(orderOf("#summary") < orderOf("#phaseGraph"), "the summary band leads on a narrow viewport");
    assert.ok(orderOf("#phaseGraph") < orderOf("#chain"), "the open phase is ordered ahead of the campaign chain on a narrow viewport");
    assert.ok(orderOf("#chain") < orderOf("#specMap"), "the campaign chain is ordered ahead of the spec map on a narrow viewport");
    assert.ok(orderOf("#specMap") > orderOf("#drilldown"), "the spec map is ordered last on a narrow viewport");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("the spec map is present but not first: it ships collapsed and last, never greeting the reader", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
  try {
    const { port } = /** @type {{address: () => {port: number}}} */ (server).address();
    const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers: AUTH })).text();
    const sections = [...html.matchAll(/<section id="(\w+)"/gu)].map((match) => match[1]);
    assert.equal(sections.at(-1), "specMap", "the spec map is the page's last band");
    assert.notEqual(sections[0], "specMap", "the spec map is not the first thing on the page");
    assert.match(html, /id="specMapBody"/u, "the spec map is present, not removed");
    const detailsMatch = /<section id="specMap"[\s\S]*?<details class="specdetails">([\s\S]*?)<div id="specMapBody"/u.exec(html);
    assert.ok(detailsMatch, "the spec map body sits inside a collapsible details element");
    assert.doesNotMatch(/** @type {RegExpExecArray} */ (detailsMatch)[1], /\bopen\b/u, "the spec map ships collapsed by default");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});
