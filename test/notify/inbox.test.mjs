import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { appendInbox, noTransportWarning, readInbox, wakeCapabilityNotice, NOTIFY_NO_TRANSPORT_WARNING, NotifyQueue } from "../../src/notify/index.mjs";
import { enqueueCampaignNotification } from "../../src/engine/notify-queue.mjs";
import { environmentPreflight, notifyTransportCheck } from "../../src/host/preflight.mjs";
import { renderAgentSignalBlock, syncAgentSignal } from "../../src/repo/signal.mjs";
import { acquireWatchLock, watchCampaignWake } from "../../src/cli/campaign.mjs";
import { runProgress } from "../../src/engine/supervise.mjs";
import { SPAWN_WAIT_FACTOR, fixture, packet, writeContract, withEmptyPath, withFakeCodex, readStatus, waitForValue } from "../helpers.mjs";
import { RUNNER_CLI } from "../runner-helpers.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";

/** @param {string} prefix @returns {string} */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a run directory with the given node snapshots and no contract, so the
 * outcome is derived from the snapshots alone exactly as a sparse resume sees.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @param {Record<string, {status: string, error?: {code: string, message?: string}|null}>} nodes
 * @returns {string}
 */
function makeRunDir(runsDir, runId, nodes) {
  const runDir = join(runsDir, runId);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ startedAt: new Date(0).toISOString() }));
  for (const [id, node] of Object.entries(nodes)) {
    writeFileSync(join(runDir, "nodes", `${id}.json`), JSON.stringify({ id, status: node.status, error: node.error ?? null }));
  }
  return runDir;
}

test("done-when 1: a parked run appears in the managed block with its nodes, codes and resume command", () => {
  const directory = tempDir("inbox-signal-parked-");
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "c1", goal: "prove the block names parked work" });
  registerRun(path, "r1");
  const runDir = makeRunDir(runsDir, "r1", {
    build: { status: "blocked", error: { code: "provider_error", message: "boom" } },
    docs: { status: "done" },
  });
  writeFileSync(join(directory, "AGENTS.md"), "# repo\n");

  const block = renderAgentSignalBlock(runsDir);
  assert.match(block, /run `r1`: parked/u, block);
  assert.match(block, /`build:blocked provider_error`/u, block);
  assert.match(block, new RegExp(`resume \`node src/cli\\.mjs resume ${runDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\``, "u"), block);
  assert.equal(syncAgentSignal(runsDir), true);
  assert.match(readFileSync(join(directory, "AGENTS.md"), "utf8"), /parked/u);
});

test("done-when 2: a succeeded run renders as one line and the most recent attention entry renders", () => {
  const directory = tempDir("inbox-signal-succeeded-");
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "c2", goal: "prove the block is quiet about success" });
  registerRun(path, "r2");
  makeRunDir(runsDir, "r2", { build: { status: "done" } });
  appendInbox(runsDir, {
    type: "attention",
    campaignId: "c2",
    summary: "node build needs you · run r2 · judge_unavailable",
    dedupeKey: "attention:c2:r2:build",
  });

  const block = renderAgentSignalBlock(runsDir);
  const succeeded = block.split("\n").filter((line) => line.includes("run `r2`"));
  assert.equal(succeeded.length, 1, block);
  assert.match(succeeded[0], /succeeded \(1\/1 nodes\)/u);
  assert.doesNotMatch(succeeded[0], /parked/u);
  assert.match(block, /attention: node build needs you · run r2 · judge_unavailable/u);
});

test("a multi-line inbox summary (renderRunProgress's own shape) collapses to its first line in the managed signal block", () => {
  const directory = tempDir("inbox-signal-multiline-");
  const runsDir = runsRoot(directory);
  initializeCampaign(runsDir, { campaignId: "cm", goal: "prove the block stays single-line" });
  appendInbox(runsDir, {
    type: "attention",
    campaignId: "cm",
    summary: "node build needs you · run r1 · judge_unavailable\nthis node: 12s\nworker says: multi-line progress text",
    dedupeKey: "attention:cm:r1:build",
  });
  writeFileSync(join(directory, "AGENTS.md"), "# repo\n");

  const block = renderAgentSignalBlock(runsDir);
  const attentionLines = block.split("\n").filter((line) => line.includes("attention:"));
  assert.equal(attentionLines.length, 1, block);
  assert.equal(attentionLines[0], "  - attention: node build needs you · run r1 · judge_unavailable", block);
  assert.doesNotMatch(block, /worker says: multi-line progress text/u, "only the first line of a multi-line summary reaches the block; the rest lives in the inbox");
});

test("done-when 3: inbox entries match the schema, dedupe on the key, and survive concurrent appends", async () => {
  const runsDir = runsRoot(tempDir("inbox-schema-"));
  const first = appendInbox(runsDir, { type: "attention", campaignId: "c", summary: "one", dedupeKey: "k1" });
  const duplicate = appendInbox(runsDir, { type: "attention", campaignId: "c", summary: "two", dedupeKey: "k1" });
  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  const entries = readInbox(runsDir);
  assert.equal(entries.length, 1, "the declared key dedupes");
  assert.equal(entries[0].summary, "one", "first write wins");
  assert.deepEqual(
    Object.keys(entries[0]).sort(),
    ["at", "campaignId", "dedupeKey", "errorCode", "eventId", "nodeId", "runId", "schemaVersion", "status", "summary", "type"].sort(),
  );
  assert.equal(entries[0].eventId.length, 64, "eventId is the sha256 of the key");

  const indexPath = fileURLToPath(new URL("../../src/notify/index.mjs", import.meta.url));
  /** @param {string} prefix @returns {Promise<void>} */
  const writer = (prefix) => new Promise((resolve, reject) => {
    const script = `import { appendInbox } from ${JSON.stringify(pathToFileURL(indexPath).href)};
const runsDir = ${JSON.stringify(runsDir)};
for (let i = 0; i < 40; i += 1) {
  appendInbox(runsDir, { type: "attention", campaignId: "concurrent", summary: ${JSON.stringify(prefix)} + " " + i, dedupeKey: ${JSON.stringify(prefix)} + "-" + i });
}
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${prefix} exited ${code}`))));
  });
  await Promise.all([writer("a"), writer("b")]);

  const raw = readFileSync(join(runsDir, "inbox.jsonl"), "utf8").trim().split("\n");
  assert.equal(raw.length, 81, "80 concurrent appends plus the deduped first entry survive");
  for (const line of raw) JSON.parse(line);
  assert.equal(new Set(readInbox(runsDir).map((entry) => entry.dedupeKey)).size, 81);
});

test("done-when 4: campaign-level notifications are queued and delivered with no run active", async () => {
  const directory = tempDir("inbox-campaign-");
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "c4", goal: "queue campaign lines without a run" });

  const delivered = await enqueueCampaignNotification({
    runsDir,
    campaignPath: path,
    campaignId: "c4",
    dedupeKey: "watch:c4:idle:0",
    summary: "campaign-watch: c4 active but no run has been active for 20 min; dispatch the next step",
  });
  assert.equal(delivered, true);
  const inbox = readInbox(runsDir);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].campaignId, "c4");
  assert.equal(inbox[0].runId, null);

  const receipts = readFileSync(join(path, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "delivered");
  assert.equal(receipts[0].summary, inbox[0].summary);

  // The durable record also makes a second delivery a no-op.
  assert.equal(await enqueueCampaignNotification({ runsDir, campaignPath: path, campaignId: "c4", dedupeKey: "watch:c4:idle:0", summary: "duplicate" }), false);
  assert.equal(readFileSync(join(path, "notify.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("done-when 5: a restarted watcher does not re-deliver and a live watcher refuses to double-run", async () => {
  const directory = tempDir("inbox-watch-");
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "c5", goal: "one watcher per campaign" });
  registerRun(path, "r5");
  const runDir = makeRunDir(runsDir, "r5", { build: { status: "done" } });
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ nodes: [{ id: "build", status: "done" }], summary: "1/1 nodes" }));

  /** @type {{summary: string}[]} */
  const first = [];
  await watchCampaignWake(path, runsDir, { once: true, emit: () => {}, notify: (event) => { first.push(event); } });
  assert.equal(first.length, 1, "the terminal line is announced once");
  assert.match(first[0].summary, /campaign-watch: r5 terminal/u);
  assert.equal(existsSync(join(path, "watch.lock")), false, "the lock is released on exit");

  // A restart finds a stale lock (dead pid) and the durable inbox already
  // carrying the key, so it takes the lock over and sends nothing again.
  writeFileSync(join(path, "watch.lock"), JSON.stringify({ pid: 999_999, processStartToken: null, startedAt: new Date(0).toISOString() }));
  /** @type {{summary: string}[]} */
  const replay = [];
  await watchCampaignWake(path, runsDir, { once: true, emit: () => {}, notify: (event) => { replay.push(event); } });
  assert.deepEqual(replay, [], "a restarted watcher does not double-send");

  // A live watcher is durable, not in-process: the on-disk lock refuses a second one.
  const held = acquireWatchLock(path);
  const lockPath = join(path, "watch.lock");
  try {
    await assert.rejects(
      () => watchCampaignWake(path, runsDir, { once: true, emit: () => {}, notify: () => {} }),
      /already running/u,
    );
  } finally {
    held.release();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
});

test("done-when 6: unset transport warns and resolves to noTransport; --wake reports canWake false", async () => {
  assert.equal(noTransportWarning({}), NOTIFY_NO_TRANSPORT_WARNING);
  assert.equal(noTransportWarning({ FABERUN_NOTIFY_BIN: "something" }), null);

  const check = notifyTransportCheck({});
  assert.equal(check.name, "notify transport");
  assert.equal(check.advisory, true, "an unset transport is a warning, never a gate");
  assert.equal(check.detail, NOTIFY_NO_TRANSPORT_WARNING);
  // The dispatch gate itself is unchanged: the warning is rendered beside it.
  const report = environmentPreflight({ cwd: tempDir("inbox-preflight-"), runtimes: new Map(), env: {} });
  assert.deepEqual(report.checks.map((entry) => entry.name), ["disk", "git", "worktree", "runtime binaries"]);

  const contractDir = tempDir("inbox-preflight-cli-");
  const contractPath = writeContract(contractDir, fixture({ pollIntervalMs: 10 }));
  await withEmptyPath(() => {
    const result = spawnSync(process.execPath, [RUNNER_CLI, "preflight", contractPath, "--static"], {
      encoding: "utf8",
      // Force color off: the assertion below reads the literal `[warn]`
      // token, and an ambient FORCE_COLOR would split it with escape codes.
      env: { ...process.env, FABERUN_NOTIFY_BIN: "", FORCE_COLOR: "0" },
    });
    assert.match(result.stdout, /\[warn\] notify transport · no human notification transport/u);
  });

  const runDir = tempDir("inbox-notransport-");
  const previous = process.env.FABERUN_NOTIFY_BIN;
  delete process.env.FABERUN_NOTIFY_BIN;
  try {
    const queue = new NotifyQueue({ runDir, now: () => 1_700_000_000_000 });
    await queue.enqueue({ type: "run.terminal", runId: "r", done: 1, total: 1, dedupeKey: "run.terminal:r:0" });
  } finally {
    if (previous === undefined) delete process.env.FABERUN_NOTIFY_BIN;
    else process.env.FABERUN_NOTIFY_BIN = previous;
  }
  const receipt = JSON.parse(readFileSync(join(runDir, "notify.jsonl"), "utf8").trim());
  assert.equal(receipt.status, "no_transport", "the opt-in is preserved, not defaulted");

  assert.match(wakeCapabilityNotice("os-macos"), /canWake: false/u);
  assert.match(wakeCapabilityNotice("os-macos"), /--wake records to/u);
  assert.doesNotMatch(wakeCapabilityNotice("os-macos"), /session was woken/u);

  const doctor = spawnSync(process.execPath, [RUNNER_CLI, "doctor", "--cwd", tempDir("inbox-doctor-")], {
    encoding: "utf8",
    env: { ...process.env, FABERUN_NOTIFY_BIN: "" },
  });
  assert.match(doctor.stderr, new RegExp(NOTIFY_NO_TRANSPORT_WARNING.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("done-when 7: the foreground launch prints the warning once and the detached controller prints nothing", async () => {
  const directory = tempDir("inbox-launch-warn-");
  const contractPath = writeContract(directory, fixture({
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const runDir = runDirectory(directory, contract.id);
  const nodePath = join(runDir, "nodes", "build.json");
  const result = await withFakeCodex(directory, "pass", () => spawnSync(process.execPath, [RUNNER_CLI, "run", "--detach", contractPath], {
    encoding: "utf8",
    env: { ...process.env, FABERUN_NOTIFY_BIN: "" },
    timeout: 30_000,
  }));
  assert.equal(result.status, 0, result.stderr);
  // The parent is the foreground launcher; the detached controller's stdio is
  // discarded, so exactly one warning is observable through the real path.
  const occurrences = (result.stdout.match(/no human notification transport is configured/gu) ?? []).length;
  assert.equal(occurrences, 1, result.stdout);
  const pid = Number(/pid (\d+)/u.exec(result.stdout)?.[1] ?? 0);
  try {
    assert.equal(await waitForValue(() => (readStatus(nodePath) === "done" ? "done" : null), 20_000 * SPAWN_WAIT_FACTOR), "done");
  } finally {
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("the parked classification the block reads is phase 2's, not a second implementation", () => {
  const runsDir = runsRoot(tempDir("inbox-outcome-"));
  makeRunDir(runsDir, "r", { build: { status: "blocked", error: { code: "runtime_tier_exhausted" } } });
  assert.equal(runProgress(join(runsDir, "r")).runOutcome, "parked");
});
