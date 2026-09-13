/**
 * `next`: one line per active campaign, ranked specific before generic, never
 * mutating state and never crashing on an unreadable artifact. These tests
 * build run directories by hand — node snapshots are plain JSON that `next`
 * parses tolerantly, so no controller or provider has to run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { computeNextItems, renderNext, renderNextJson } from "../../src/report/next.mjs";

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/** @param {string} prefix @returns {string} */
function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {string} dir @returns {string} */
function runsDirOf(dir) {
  return join(dir, ".runs");
}

/** @param {string} runsDir @param {string} id @returns {string} */
function addCampaign(runsDir, id) {
  return initializeCampaign(runsDir, { campaignId: id, goal: "goal" }).path;
}

/** @param {string} runsDir @param {string} runId @param {string} nodeId @param {Record<string, unknown>|string} value */
function writeNode(runsDir, runId, nodeId, value) {
  const nodeDir = join(runsDir, runId, "nodes");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, `${nodeId}.json`), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

/** @param {string} runsDir @param {string} runId */
function writeLiveLock(runsDir, runId) {
  writeFileSync(join(runsDir, runId, "controller.lock"), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    processStartToken: null,
    startedAt: new Date().toISOString(),
    hostname: "test",
  })}\n`);
}

/** @param {string} dir @returns {{path: string, content: string}[]} */
function snapshot(dir) {
  /** @type {{path: string, content: string}[]} */
  const entries = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push({ path: path.slice(dir.length + 1), content: readFileSync(path, "utf8") });
    }
  };
  if (existsSync(dir)) walk(dir);
  return entries;
}

test("prints one line per active campaign, ranked specific before generic", () => {
  const dir = makeDir("runner-next-rank-");
  const runsDir = runsDirOf(dir);

  const blocked = addCampaign(runsDir, "blocked");
  registerRun(blocked, "run-blocked");
  writeNode(runsDir, "run-blocked", "build", {
    id: "build", status: "blocked",
    result: { status: "blocked_context", summary: "missing context", verification: [], artifacts: [], missingContext: ["missing.txt"] },
  });

  const live = addCampaign(runsDir, "live");
  registerRun(live, "run-live");
  writeNode(runsDir, "run-live", "build", { id: "build", status: "running" });
  writeLiveLock(runsDir, "run-live");

  const terminal = addCampaign(runsDir, "terminal");
  registerRun(terminal, "run-terminal");
  writeNode(runsDir, "run-terminal", "build", { id: "build", status: "done" });
  appendJournal(terminal, {
    type: "retrospective", eventId: "r1", at: new Date().toISOString(), sessionId: "codex-1", text: "shipped",
  });

  const expected = [
    `blocked: node build blocked on context: missing context; needs missing.txt · resume ${join(runsDir, "run-blocked")} --answer build=<answer-file> [template]`,
    `terminal: all 1 linked runs terminal; retrospective recorded · campaign close terminal --cwd ${dir}`,
    "live: run run-live live; nothing to do",
  ].join("\n") + "\n";
  assert.equal(renderNext(runsDir, dir), expected);
});

test("an empty .runs/ prints exactly one line saying nothing needs anyone", () => {
  const dir = makeDir("runner-next-empty-");
  mkdirSync(runsDirOf(dir), { recursive: true });
  assert.equal(renderNext(runsDirOf(dir), dir), "nothing needs anyone\n");
});

test("rank 1 reports resume for a non-terminal node with no live controller", () => {
  const dir = makeDir("runner-next-resume-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "resume"), "run-resume");
  writeNode(runsDir, "run-resume", "build", { id: "build", status: "running" });

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 1);
  assert.equal(item.command, `resume ${join(runsDir, "run-resume")}`);
  assert.equal(item.runnable, true);
});

test("rank 3 reports the findings command for an exhausted node with gate findings", () => {
  const dir = makeDir("runner-next-findings-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "findings"), "run-findings");
  writeNode(runsDir, "run-findings", "build", {
    id: "build", status: "exhausted",
    gate: { findings: [{ severity: "critical", description: "broken", evidence: "test failed" }] },
  });

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 3);
  assert.equal(item.command, `findings ${join(runsDir, "run-findings")}`);
  assert.equal(item.runnable, true);
});

test("rank 4 reports the status command and error code for a failed node", () => {
  const dir = makeDir("runner-next-failed-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "failed"), "run-failed");
  writeNode(runsDir, "run-failed", "build", { id: "build", status: "failed", error: { code: "deliberate_failure", message: "boom" } });

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 4);
  assert.equal(item.command, `status ${join(runsDir, "run-failed")}`);
  assert.match(item.reason, /deliberate_failure/u);
});

test("rank 5 without a retrospective reports the note template, not runnable", () => {
  const dir = makeDir("runner-next-close-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "closing"), "run-closing");
  writeNode(runsDir, "run-closing", "build", { id: "build", status: "done" });

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 5);
  assert.equal(item.runnable, false);
  assert.match(item.reason, /no retrospective note/u);
  assert.equal(item.command, "campaign note closing --session-id <session-id> --kind retrospective --text <text>");
});

test("a torn node snapshot reports rank 4 and never falls through to rank 5", () => {
  const dir = makeDir("runner-next-torn-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "torn"), "run-torn");
  writeNode(runsDir, "run-torn", "build", "{ not json");

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 4);
  assert.match(item.reason, /node build snapshot unreadable/u);
  assert.match(item.reason, /build\.json\)/u);
  assert.equal(item.command, `status ${join(runsDir, "run-torn")}`);
  assert.equal(item.runnable, true);
});

test("a corrupt campaign.json is its own rank-4 line, not skipped", () => {
  const dir = makeDir("runner-next-corrupt-");
  const runsDir = runsDirOf(dir);
  addCampaign(runsDir, "good");
  mkdirSync(join(runsDir, "campaigns", "bad"), { recursive: true });
  writeFileSync(join(runsDir, "campaigns", "bad", "campaign.json"), "{ not json");

  const items = computeNextItems(runsDir, dir);
  assert.equal(items[0].campaign, "bad");
  assert.equal(items[0].rank, 4);
  assert.match(items[0].reason, /campaign bad unreadable/u);
  assert.equal(items[0].command, "");
  assert.equal(items[0].runnable, false);
});

test("arguments containing spaces are single-quoted in the rendered command", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-next space-"));
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "spaced"), "run-spaced");
  writeNode(runsDir, "run-spaced", "build", { id: "build", status: "running" });

  const runDir = join(runsDir, "run-spaced");
  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 1);
  assert.equal(item.command, `resume '${runDir}'`);
});

test("human and --json outputs derive from the same computed list", () => {
  const dir = makeDir("runner-next-shared-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "shared"), "run-shared");
  writeNode(runsDir, "run-shared", "build", { id: "build", status: "failed", error: { code: "x", message: "x" } });

  const items = computeNextItems(runsDir, dir);
  const textLines = renderNext(runsDir, dir).trim().split("\n");
  /** @type {{schemaVersion: number, items: {campaign: string, rank: number, reason: string, command: string, runnable: boolean}[]}} */
  const payload = JSON.parse(renderNextJson(runsDir, dir));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(textLines.length, items.length);
  assert.equal(payload.items.length, items.length);
  assert.deepEqual(payload.items.map((entry) => entry.campaign), items.map((entry) => entry.campaign));
  const item = payload.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["campaign", "command", "rank", "reason", "runnable"]);
  assert.equal(item.rank, 4);
  assert.equal(item.runnable, true);
});

test("running next mutates nothing, including .runs/status.json", () => {
  const dir = makeDir("runner-next-mutate-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "m"), "run-m");
  writeNode(runsDir, "run-m", "build", { id: "build", status: "failed", error: { code: "boom", message: "boom" } });
  writeFileSync(join(runsDir, "status.json"), `{"schemaVersion":1,"run":"run-m"}\n`);

  const before = snapshot(dir);
  renderNext(runsDir, dir);
  renderNextJson(runsDir, dir);
  assert.deepEqual(snapshot(dir), before);
});

test("the next command is dispatched with zero positionals, --cwd and --json", () => {
  const dir = makeDir("runner-next-cli-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "cli-campaign"), "run-cli");
  writeNode(runsDir, "run-cli", "build", { id: "build", status: "running" });

  const text = spawnSync(process.execPath, [CLI, "next", "--cwd", dir], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /cli-campaign: run run-cli has a non-terminal node and no live controller/u);

  const json = spawnSync(process.execPath, [CLI, "next", "--cwd", dir, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).schemaVersion, 1);

  const positional = spawnSync(process.execPath, [CLI, "next", "some-run"], { encoding: "utf8" });
  assert.equal(positional.status, 2, "next takes no positional arguments");
});
