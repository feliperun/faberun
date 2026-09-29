import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startServer } from "../../src/web/server.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";
const CAMPAIGN_ID = "api-campaign";
const RUN_ID = "api-run";
const TOKEN = "web-api-test-bearer-1a2b3c4d5e6f7788";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const PAUSE_CODE = "operator_paused";

/**
 * Stands in for the runner CLI: records the argv it was handed and, for the two
 * verbs a pause and a resume delegate to, makes the state change those verbs
 * make in the engine — `cancel` writes the durable `cancel.request.json` and
 * settles the run's nodes canceled, `resume` consumes the request and leaves
 * the node running. `FAKE_CLI_HOLD_PAUSE=1` keeps the request, which is the
 * window a real `resume --detach` has between spawning its controller and the
 * controller consuming the request.
 */
const FAKE_CLI_SOURCE = [
  'import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const argv = process.argv.slice(2);',
  'const runDir = process.env.FAKE_CLI_RUN_DIR;',
  'const statusPath = join(runDir, "status.json");',
  'const requestPath = join(runDir, "cancel.request.json");',
  'const settled = (node, status) => ({ ...node, status });',
  'appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(argv)}\\n`);',
  'if (argv[0] === "cancel") {',
  '  writeFileSync(requestPath, JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid }));',
  '  const current = JSON.parse(readFileSync(statusPath, "utf8"));',
  '  writeFileSync(statusPath, JSON.stringify({ ...current, nodes: current.nodes.map((node) => settled(node, "canceled")) }));',
  '}',
  'if (argv[0] === "resume" && process.env.FAKE_CLI_HOLD_PAUSE !== "1") {',
  '  if (existsSync(requestPath)) unlinkSync(requestPath);',
  '  const current = JSON.parse(readFileSync(statusPath, "utf8"));',
  '  writeFileSync(statusPath, JSON.stringify({ ...current, nodes: current.nodes.map((node) => settled(node, "running")) }));',
  '}',
].join("\n");

test("web routes shell out", async () => {
  const world = makeWorld();
  const server = await openServer(world);
  try {
    assert.equal((await server.post(`/api/campaigns/${CAMPAIGN_ID}/note`, { kind: "constraint", text: "hold the line" })).body.ok, true);
    assert.equal((await server.post(`/api/campaigns/${CAMPAIGN_ID}/decisions/q-1`, { text: "ship it" })).body.ok, true);
    assert.equal((await server.post(`/api/seats/${CAMPAIGN_ID}/switch`, { harness: "codex" })).body.ok, true);
    // Every write fired the CLI and only the CLI: three calls later, no state
    // file the engine owns has changed by one byte (ADR-0034).
    assert.deepEqual(stateSnapshot(world), world.stateBefore, "a write route touched state directly");
    assert.deepEqual(readArgvs(world), [
      ["campaign", "note", CAMPAIGN_ID, "--session-id", "web", "--kind", "constraint", "--text", "hold the line"],
      ["campaign", "resolve", CAMPAIGN_ID, "--session-id", "web", "--question-id", "q-1", "--text", "ship it"],
      ["seat", "switch", CAMPAIGN_ID, "--harness", "codex"],
    ]);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a panel pause records the durable pause and cancels the run in flight", async () => {
  const world = makeWorld();
  const server = await openServer(world);
  try {
    const first = await server.post(`/api/campaigns/${CAMPAIGN_ID}/pause`);
    assert.equal(first.status, 200);
    assert.equal(first.body.action, "applied");
    // The run-level half: the engine's own pause request, the marker the chain
    // honours before it recovers a run.
    assert.equal(existsSync(join(world.runDir, "cancel.request.json")), true, "the run carries a requested pause");
    // The campaign-level half: the attention the chain consults before it
    // dispatches, recovers or advances, which survives a restart of either process.
    const record = JSON.parse(readFileSync(world.campaignJson, "utf8"));
    assert.equal(record.attention.code, PAUSE_CODE);
    assert.match(record.attention.message, new RegExp(RUN_ID, "u"));
    assert.deepEqual(readArgvs(world), [["cancel", world.runDir]]);

    // Repeating is safe: no second cancel, no rewritten record, and the answer
    // says nothing was needed instead of reporting an empty success as an action.
    const again = await server.post(`/api/campaigns/${CAMPAIGN_ID}/pause`);
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, true);
    assert.equal(again.body.action, "none");
    assert.match(again.body.reason, /already paused/u);
    assert.deepEqual(readArgvs(world), [["cancel", world.runDir]]);
    assert.deepEqual(JSON.parse(readFileSync(world.campaignJson, "utf8")).attention, record.attention);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a pause with no run in flight still records the durable pause", async () => {
  const world = makeWorld({ nodeStatus: "done" });
  const server = await openServer(world);
  try {
    const paused = await server.post(`/api/campaigns/${CAMPAIGN_ID}/pause`);
    assert.equal(paused.body.action, "applied");
    assert.deepEqual(paused.body.steps.map((/** @type {{command: string}} */ step) => step.command), ["campaign pause"]);
    const record = JSON.parse(readFileSync(world.campaignJson, "utf8"));
    assert.equal(record.attention.code, PAUSE_CODE);
    assert.equal(existsSync(world.cliLog), false, "nothing was in flight, so nothing spawned");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a panel resume continues the paused run, clears the campaign pause and arms its watchdog", async () => {
  const world = makeWorld();
  const server = await openServer(world);
  try {
    assert.equal((await server.post(`/api/campaigns/${CAMPAIGN_ID}/pause`)).body.action, "applied");
    const resumed = await server.post(`/api/campaigns/${CAMPAIGN_ID}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.action, "applied");
    assert.deepEqual(resumed.body.steps.map((/** @type {{command: string}} */ step) => step.command), [
      `resume ${RUN_ID} --detach`,
      "campaign unpark",
      `supervise ${RUN_ID} --detach`,
    ]);
    // The engine's resume consumed the requested pause, so the run is running
    // again rather than parked on a request nobody is waiting for.
    assert.equal(existsSync(join(world.runDir, "cancel.request.json")), false);
    assert.equal(JSON.parse(readFileSync(world.statusJson, "utf8")).nodes[0].status, "running");
    // The campaign pause is cleared, with the journal event the clearing writes.
    assert.equal("attention" in JSON.parse(readFileSync(world.campaignJson, "utf8")), false, "the campaign pause was cleared");
    const unparked = readJournalLines(world).filter((entry) => entry.type === "campaign.unparked");
    assert.equal(unparked.length, 1);
    assert.equal(unparked[0].code, PAUSE_CODE);
    assert.deepEqual(readArgvs(world), [
      ["cancel", world.runDir],
      ["resume", world.runDir, "--detach"],
      ["supervise", world.runDir, "--detach"],
    ]);

    // Repeating is safe: the pause is gone and no run carries a request, so the
    // answer is `none` with the reason, not an empty success dressed as an action.
    const again = await server.post(`/api/campaigns/${CAMPAIGN_ID}/resume`);
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, true);
    assert.equal(again.body.action, "none");
    assert.match(again.body.reason, /no requested pause/u);
    assert.equal(readArgvs(world).length, 3);
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a resume whose run has not consumed the pause answers pending and keeps the campaign paused", async () => {
  const world = makeWorld();
  const server = await openServer(world);
  process.env.FAKE_CLI_HOLD_PAUSE = "1";
  try {
    assert.equal((await server.post(`/api/campaigns/${CAMPAIGN_ID}/pause`)).body.action, "applied");
    const pending = await server.post(`/api/campaigns/${CAMPAIGN_ID}/resume`);
    assert.equal(pending.status, 409);
    assert.equal(pending.body.ok, false);
    assert.equal(pending.body.action, "pending");
    assert.match(pending.body.reason, /has not consumed its requested pause/u);
    assert.deepEqual(pending.body.steps.map((/** @type {{command: string}} */ step) => step.command), [`resume ${RUN_ID} --detach`]);
    assert.equal(
      JSON.parse(readFileSync(world.campaignJson, "utf8")).attention.code,
      PAUSE_CODE,
      "a pause that is not consumed yet is not cleared",
    );

    // Once the controller has consumed it, the same call completes.
    delete process.env.FAKE_CLI_HOLD_PAUSE;
    const applied = await server.post(`/api/campaigns/${CAMPAIGN_ID}/resume`);
    assert.equal(applied.body.action, "applied");
    assert.equal("attention" in JSON.parse(readFileSync(world.campaignJson, "utf8")), false);
  } finally {
    delete process.env.FAKE_CLI_HOLD_PAUSE;
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("a closed campaign is refused by pause and resume before the CLI", async () => {
  const world = makeWorld({ campaignStatus: "closed" });
  const server = await openServer(world);
  try {
    for (const path of ["pause", "resume"]) {
      const refused = await server.post(`/api/campaigns/${CAMPAIGN_ID}/${path}`);
      assert.equal(refused.status, 400, path);
      assert.match(refused.body.error, new RegExp(`campaign is closed: ${CAMPAIGN_ID}`, "u"), path);
    }
    // The fake CLI creates its log on first invocation, so its absence is the
    // proof that neither refusal spawned anything.
    assert.equal(existsSync(world.cliLog), false, "a refused route must not reach the CLI");
    assert.deepEqual(stateSnapshot(world), world.stateBefore, "a refusal touched state");
  } finally {
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("an unknown campaign is refused before the CLI, and the refusal names no path", async () => {
  const world = makeWorld();
  const server = await openServer(world);
  try {
    // `note` and `decisions` used to hand the id straight to the CLI, whose
    // own refusal quotes the absolute directory it looked in — handing a
    // caller the server's filesystem layout for an id that does not exist.
    /** @type {[string, Record<string, string>][]} */
    const writes = [
      ["/api/campaigns/no-such-campaign/note", { kind: "constraint", text: "hold" }],
      ["/api/campaigns/no-such-campaign/decisions/q-1", { text: "ship" }],
    ];
    for (const [path, body] of writes) {
      const refused = await server.post(path, body);
      assert.equal(refused.status, 404, path);
      assert.match(refused.body.error, /unknown campaign: no-such-campaign/u, path);
      assert.equal(JSON.stringify(refused.body).includes(world.runsDir), false, `${path} leaked the runs directory`);
    }
    // The fake CLI creates its log on first invocation, so its absence is the
    // proof that neither refusal spawned anything.
    assert.equal(existsSync(world.cliLog), false, "a refused route must not reach the CLI at all");
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
  const server = await openServer(world);
  try {
    for (const forbidden of ["replan", "plan", "contract", "routing", "gate"]) {
      const response = await fetch(`${server.base}/api/campaigns/${CAMPAIGN_ID}/${forbidden}`, { method: "POST", headers: AUTH });
      assert.equal(response.status, 404, `POST ${forbidden} must not exist`);
    }
    assert.equal((await fetch(`${server.base}/api/campaigns/${CAMPAIGN_ID}/replan`, { headers: AUTH })).status, 404, "GET replan must not exist either");
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
  const server = await openServer(world);
  try {
    /** @param {number} after */
    const page = async (after) => /** @type {any} */ (await (await fetch(`${server.base}/api/campaigns/${CAMPAIGN_ID}/events?after=${after}`, { headers: AUTH })).json());
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
    assert.equal((await fetch(`${server.base}/api/campaigns/${CAMPAIGN_ID}/events?after=9999999`, { headers: AUTH })).status, 400, "a cursor beyond the journal is refused");
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

/** @param {{journalPath: string}} world @returns {Record<string, any>[]} */
function readJournalLines(world) {
  return readFileSync(world.journalPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** @param {{cliLog: string}} world @returns {string[][]} */
function readArgvs(world) {
  if (!existsSync(world.cliLog)) return [];
  return readFileSync(world.cliLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @returns {Promise<{base: string, post: (path: string, body?: Record<string, unknown>) => Promise<{status: number, body: any}>, close: () => void}>}
 */
async function openServer(world) {
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, cliEntry: world.fakeCli });
  const base = `http://127.0.0.1:${/** @type {{address: () => {port: number}}} */ (server).address().port}`;
  return {
    base,
    post: async (path, body = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    close: () => server.close(),
  };
}

/**
 * A campaign with one linked run, an operator brief, a seeded journal, and a
 * fake CLI that records argv and applies the transitions `cancel` and `resume`
 * make to the run.
 *
 * @param {{nodeStatus?: string, campaignStatus?: string}} [options]
 * @returns {{directory: string, runsDir: string, tokenFile: string, cliLog: string, fakeCli: string, journalPath: string, campaignJson: string, statusJson: string, runDir: string, stateBefore: {campaign: string, journal: string, status: string}}}
 */
function makeWorld({ nodeStatus = "running", campaignStatus = "active" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-webapi-"));
  const tokenFile = join(directory, "dashboard.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const runsDir = runsRoot(directory);
  const campaignPath = join(runsDir, "campaigns", CAMPAIGN_ID);
  mkdirSync(campaignPath, { recursive: true });
  const campaignJson = join(campaignPath, "campaign.json");
  writeJson(campaignJson, { id: CAMPAIGN_ID, goal: "Ship the remote surface", status: campaignStatus, linkedRunIds: [RUN_ID], createdAt: NOW, updatedAt: NOW });
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
    nodes: [{ id: "alpha", status: nodeStatus, attempt: 1, errorCode: null, blockedBy: [] }],
  });
  const cliLog = join(directory, "argv.jsonl");
  const fakeCli = join(directory, "fake-cli.mjs");
  writeFileSync(fakeCli, FAKE_CLI_SOURCE);
  process.env.FAKE_CLI_LOG = cliLog;
  process.env.FAKE_CLI_RUN_DIR = runDir;
  const world = { directory, runsDir, tokenFile, cliLog, fakeCli, journalPath, campaignJson, statusJson, runDir, stateBefore: stateSnapshot({ journalPath, campaignJson, statusJson }) };
  return world;
}
