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
} from "../../src/web/app.mjs";

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
 * @param {{longLog?: boolean}} [options]
 * @returns {{directory: string, runsDir: string, tokenFile: string}}
 */
function makeWorld({ longLog = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-dashboard-"));
  const tokenFile = join(directory, "dashboard.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const runsDir = join(directory, ".runs");

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
  const contracts = [contractFor("alpha", alphaNodes), contractFor("beta", betaNodes), contractFor("gamma", gammaNodes)];
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: CAMPAIGN_ID, goal: "Ship the dashboard rewrite", contracts });

  /** @param {string} phaseId @param {{id: string, snapshot?: Record<string, unknown>}[]} nodes */
  const writeRun = (phaseId, nodes) => {
    const runDir = join(runsDir, phaseId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeJson(join(runDir, "run.json"), { schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, pid: process.pid, processStartToken: null, startedAt: NOW, sourceIdentity: { kind: "run" } });
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
  writeFileSync(logPath, longLog ? `${"x".repeat(80)}\n`.repeat(6_000) : "line one\nline two\n");
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

test("the drill-down detail reads the worker log, verification, diff, prompt, error code and revisions", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID, runId: "alpha", nodeId: "a1" }));
    const detail = snapshot.detail;
    assert.deepEqual(detail.log.lines, ["line one", "line two"]);
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

test("the campaign chain names the campaign and draws one box per phase, each by its human name with the id as a secondary mark", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    assert.equal(campaignHeadingText(snapshot.progress), `${CAMPAIGN_ID} · ${snapshot.progress.goal}`);
    const stages = chainStages(snapshot.progress, "active");
    const svg = renderChainSvg(stages);
    for (const phase of snapshot.progress.phases) {
      assert.match(svg, new RegExp(`data-phase="${phase.contractId}"`, "u"));
      assert.match(svg, new RegExp(`>${phase.name}<`, "u"), `${phase.contractId} is shown by its human name, not the id alone`);
      assert.match(svg, new RegExp(`>${phase.contractId}<`, "u"), `${phase.contractId} still appears as the secondary mono mark`);
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
    id: "right", status: "exhausted", attempt: 2, dependsOn: ["root"], runtime: "claude/claude-sonnet-5",
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

test("the selectors render with the campaigns this repository holds", () => {
  const world = makeWorld();
  try {
    const snapshot = /** @type {any} */ (buildSnapshot(world.runsDir, { campaignId: CAMPAIGN_ID }));
    const options = campaignOptionsHtml(snapshot.campaigns, snapshot.selectedCampaignId);
    assert.match(options, new RegExp(`value="${CAMPAIGN_ID}"`, "u"));
    assert.match(options, /Ship the dashboard rewrite/u);
    assert.match(options, /selected/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});
