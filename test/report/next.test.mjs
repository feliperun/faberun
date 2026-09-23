/**
 * `next`: one line per active campaign, ranked specific before generic, never
 * mutating state and never crashing on an unreadable artifact. These tests
 * build run directories by hand — node snapshots are plain JSON that `next`
 * parses tolerantly, so no controller or provider has to run.
 */
import "../scoped-home.mjs";
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
import { runsRoot } from "../../src/run/paths.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/** @param {string} prefix @returns {string} */
function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {string} dir @returns {string} */
function runsDirOf(dir) {
  return runsRoot(dir);
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

test("next prints the newest already-rendered message for an active campaign, read from the run's own notify.jsonl, never re-rendered", () => {
  const dir = makeDir("runner-next-message-");
  const runsDir = runsDirOf(dir);
  registerRun(addCampaign(runsDir, "with-message"), "run-message");
  writeNode(runsDir, "run-message", "build", { id: "build", status: "running" });
  const runDir = join(runsDir, "run-message");
  const older = { at: "2026-09-17T00:00:00.000Z", type: "node.terminal", summary: "stale line" };
  const newer = { at: "2026-09-18T00:00:00.000Z", type: "node.terminal", summary: "line one\nline two" };
  writeFileSync(join(runDir, "notify.jsonl"), `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`);

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.message, "line one\nline two", "the newest receipt by `at` wins, verbatim");

  const text = renderNext(runsDir, dir);
  assert.ok(text.includes("  line one\n  line two"), text);

  // --json keeps carrying structure, not prose: the message never joins the payload.
  const payload = JSON.parse(renderNextJson(runsDir, dir));
  assert.deepEqual(Object.keys(payload.items[0]).sort(), ["campaign", "command", "rank", "reason", "runnable"]);
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

test("a linked run with an empty nodes directory is rank 4, never rank 5", () => {
  const dir = makeDir("runner-next-empty-nodes-");
  const runsDir = runsDirOf(dir);
  const campaign = addCampaign(runsDir, "empty-nodes");
  registerRun(campaign, "run-terminal");
  writeNode(runsDir, "run-terminal", "build", { id: "build", status: "done" });
  registerRun(campaign, "run-empty");
  mkdirSync(join(runsDir, "run-empty", "nodes"), { recursive: true });

  const items = computeNextItems(runsDir, dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].rank, 4, "an empty run must never be counted as vacuous rank 5");
  assert.match(items[0].reason, /run run-empty has no recorded nodes yet/u);
  assert.equal(items[0].command, `status ${join(runsDir, "run-empty")}`);
  assert.equal(items[0].runnable, true);
});

test("a linked run directory absent from disk is rank 4, never rank 5", () => {
  const dir = makeDir("runner-next-missing-run-");
  const runsDir = runsDirOf(dir);
  const campaign = addCampaign(runsDir, "missing-run");
  registerRun(campaign, "run-terminal");
  writeNode(runsDir, "run-terminal", "build", { id: "build", status: "done" });
  registerRun(campaign, "run-missing");

  const items = computeNextItems(runsDir, dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].rank, 4, "a run that never wrote a snapshot must never be vacuous rank 5");
  assert.match(items[0].reason, /run run-missing has no recorded nodes yet/u);
  assert.equal(items[0].command, `status ${join(runsDir, "run-missing")}`);
  assert.equal(items[0].runnable, true);
});

test("a campaign with no linked runs still reports rank 5 unchanged", () => {
  const dir = makeDir("runner-next-zero-runs-");
  const runsDir = runsDirOf(dir);
  addCampaign(runsDir, "zero-runs");

  const item = computeNextItems(runsDir, dir)[0];
  assert.equal(item.rank, 5);
  assert.match(item.reason, /no linked runs/u);
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

test("arguments containing spaces are quoted in the rendered command", () => {
  // A run id can never carry a space (requireId in src/contract/assert.mjs
  // rejects it), and since R2 runDir no longer inherits the repository's own
  // path either — it hangs off $FABERUN_HOME instead. The one path segment
  // that can still legitimately carry a space is the home itself, the way an
  // operator's own home directory can.
  //
  // Which quote holds the path together is the reading shell's, not this
  // suite's: a POSIX shell takes the single one, cmd.exe reads it as a literal
  // character in the path and needs the double one.
  const quote = process.platform === "win32" ? '"' : "'";
  const previousHome = process.env.FABERUN_HOME;
  process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home space-"));
  try {
    const dir = makeDir("runner-next-");
    const runsDir = runsDirOf(dir);
    registerRun(addCampaign(runsDir, "spaced"), "run-spaced");
    writeNode(runsDir, "run-spaced", "build", { id: "build", status: "running" });

    const runDir = join(runsDir, "run-spaced");
    const item = computeNextItems(runsDir, dir)[0];
    assert.equal(item.rank, 1);
    assert.equal(item.command, `resume ${quote}${runDir}${quote}`);
  } finally {
    process.env.FABERUN_HOME = previousHome;
  }
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
