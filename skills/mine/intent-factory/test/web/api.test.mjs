import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startServer } from "../../src/web/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";
const CAMPAIGN_ID = "api-campaign";
const RUN_ID = "api-run";
const TOKEN = "web-api-test-bearer-1a2b3c4d5e6f7788";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Stands in for the runner CLI: records the argv it was handed and exits 0 without touching state. */
const FAKE_CLI_SOURCE = 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);\n';

test("web routes shell out", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, cliEntry: world.fakeCli });
  try {
    const base = `http://127.0.0.1:${/** @type {{address: () => {port: number}}} */ (server).address().port}`;
    /** @param {string} path @param {Record<string, unknown>} [body] */
    const post = async (path, body = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) });
      return /** @type {any} */ (await response.json());
    };
    assert.equal((await post(`/api/campaigns/${CAMPAIGN_ID}/note`, { kind: "constraint", text: "hold the line" })).ok, true);
    assert.equal((await post(`/api/campaigns/${CAMPAIGN_ID}/decisions/q-1`, { text: "ship it" })).ok, true);
    assert.equal((await post(`/api/campaigns/${CAMPAIGN_ID}/pause`)).ok, true);
    assert.equal((await post(`/api/campaigns/${CAMPAIGN_ID}/resume`)).ok, true);
    assert.equal((await post(`/api/seats/${CAMPAIGN_ID}/switch`, { harness: "codex" })).ok, true);
    // Every write fired the CLI and only the CLI: five calls later, no state
    // file the engine owns has changed by one byte (ADR-0034).
    assert.deepEqual(stateSnapshot(world), world.stateBefore, "a write route touched state directly");
    const argvs = readFileSync(world.cliLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(argvs, [
      ["campaign", "note", CAMPAIGN_ID, "--session-id", "web", "--kind", "constraint", "--text", "hold the line"],
      ["campaign", "resolve", CAMPAIGN_ID, "--session-id", "web", "--question-id", "q-1", "--text", "ship it"],
      ["cancel", join(world.runsDir, RUN_ID)],
      ["resume", join(world.runsDir, RUN_ID), "--detach"],
      ["seat", "switch", CAMPAIGN_ID, "--harness", "codex"],
    ]);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("web server invokes no model", () => {
  const webDir = join(HERE, "..", "..", "src", "web");
  const sources = readdirSync(webDir).filter((name) => name.endsWith(".mjs")).map((name) => ({ name, text: readFileSync(join(webDir, name), "utf8") }));
  assert.ok(sources.length > 0, "src/web must have modules to check");
  let cliSpawns = 0;
  for (const { name, text } of sources) {
    assert.equal(/from "\.\.\/(harnesses|engine)\//u.test(text), false, `${name} imports the model-driving layers`);
    assert.equal(/spawn\(\s*(?!process\.execPath)/u.test(text), false, `${name} spawns something other than node itself`);
    cliSpawns += (text.match(/spawn\(process\.execPath/gu) ?? []).length;
  }
  assert.ok(cliSpawns > 0, "the write routes must spawn the runner CLI through node");
});

test("web has no replan route", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, cliEntry: world.fakeCli });
  try {
    const base = `http://127.0.0.1:${/** @type {{address: () => {port: number}}} */ (server).address().port}`;
    for (const forbidden of ["replan", "plan", "contract", "routing", "gate"]) {
      const response = await fetch(`${base}/api/campaigns/${CAMPAIGN_ID}/${forbidden}`, { method: "POST", headers: AUTH });
      assert.equal(response.status, 404, `POST ${forbidden} must not exist`);
    }
    assert.equal((await fetch(`${base}/api/campaigns/${CAMPAIGN_ID}/replan`, { headers: AUTH })).status, 404, "GET replan must not exist either");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("web event tail bounded", async () => {
  const world = makeWorld();
  const entries = Array.from({ length: 300 }, (_, index) => ({ type: "intent", eventId: `bulk-${index}`, at: NOW, sessionId: "seed", text: `entry ${index} ${"x".repeat(360)}` }));
  writeFileSync(world.journalPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  // a torn trailing line is the append in progress; it must never be delivered
  appendFileSync(world.journalPath, JSON.stringify({ ...entries[299], eventId: "torn" }).slice(0, 200));
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
  try {
    const base = `http://127.0.0.1:${/** @type {{address: () => {port: number}}} */ (server).address().port}`;
    /** @param {number} after */
    const page = async (after) => /** @type {any} */ (await (await fetch(`${base}/api/campaigns/${CAMPAIGN_ID}/events?after=${after}`, { headers: AUTH })).json());
    const first = await page(0);
    assert.ok(first.entries.length > 0, "the first page carries entries");
    assert.ok(first.entries.length < 300 && first.entries.length <= 100, "a client starting at zero does not drag the whole journal");
    assert.ok(Buffer.byteLength(JSON.stringify(first.entries), "utf8") <= 32 * 1024, "one page stays inside the byte window");
    const seen = [];
    let after = 0;
    for (;;) {
      const current = await page(after);
      assert.ok(current.entries.length <= 100, "entry cap holds on every page");
      assert.ok(Buffer.byteLength(JSON.stringify(current.entries), "utf8") <= 32 * 1024, "byte window holds on every page");
      seen.push(...current.entries);
      after = current.next;
      if (current.complete || current.entries.length === 0) break;
    }
    assert.deepEqual(seen.map((entry) => entry.eventId), entries.map((entry) => entry.eventId), "paging is lossless and in order");
    assert.equal((await fetch(`${base}/api/campaigns/${CAMPAIGN_ID}/events?after=9999999`, { headers: AUTH })).status, 400, "a cursor beyond the journal is refused");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

/** @param {string} path @param {unknown} value */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

/** The state a write route must never touch: campaign, journal and run status. @param {{journalPath: string, campaignJson: string, statusJson: string}} world */
function stateSnapshot(world) {
  return {
    campaign: readFileSync(world.campaignJson, "utf8"),
    journal: readFileSync(world.journalPath, "utf8"),
    status: readFileSync(world.statusJson, "utf8"),
  };
}

/**
 * A campaign with one in-flight run, an operator brief, a seeded journal, and
 * a fake CLI that records argv instead of executing the verb.
 *
 * @returns {{directory: string, runsDir: string, tokenFile: string, cliLog: string, fakeCli: string, journalPath: string, campaignJson: string, statusJson: string, stateBefore: {campaign: string, journal: string, status: string}}}
 */
function makeWorld() {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-webapi-"));
  const tokenFile = join(directory, "dashboard.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const runsDir = join(directory, ".runs");
  const campaignPath = join(runsDir, "campaigns", CAMPAIGN_ID);
  mkdirSync(campaignPath, { recursive: true });
  const campaignJson = join(campaignPath, "campaign.json");
  writeJson(campaignJson, { id: CAMPAIGN_ID, goal: "Ship the remote surface", status: "active", linkedRunIds: [RUN_ID], createdAt: NOW, updatedAt: NOW });
  const journalPath = join(campaignPath, "journal.jsonl");
  writeFileSync(journalPath, [
    JSON.stringify({ type: "campaign.initialized", eventId: "e-init", at: NOW }),
    JSON.stringify({ type: "open-question", eventId: "e-q1", at: NOW, sessionId: "seed", questionId: "q-1", text: "ship or hold?" }),
  ].join("\n") + "\n");
  writeFileSync(join(campaignPath, "operator-brief.md"), "# operator brief\n\nship or hold\n");
  const runDir = join(runsDir, RUN_ID);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const statusJson = join(runDir, "status.json");
  writeJson(statusJson, {
    schemaVersion: 1, run: RUN_ID, contractId: RUN_ID, campaignId: CAMPAIGN_ID, goal: "Ship the remote surface",
    usage: { costUsd: 0.5 },
    controller: { state: "active", pid: process.pid, since: NOW, lastTick: null },
    nodes: [{ id: "alpha", status: "running", attempt: 1, errorCode: null, blockedBy: [] }],
  });
  const cliLog = join(directory, "argv.jsonl");
  const fakeCli = join(directory, "fake-cli.mjs");
  writeFileSync(fakeCli, FAKE_CLI_SOURCE);
  process.env.FAKE_CLI_LOG = cliLog;
  const world = { directory, runsDir, tokenFile, cliLog, fakeCli, journalPath, campaignJson, statusJson, stateBefore: stateSnapshot({ journalPath, campaignJson, statusJson }) };
  return world;
}
