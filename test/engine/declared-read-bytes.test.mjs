import "../scoped-home.mjs";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { declaredReadBytes, startWorker } from "../../src/engine/dispatch.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { configureCampaignReserve, readCampaignReserve, RESERVE_DIR } from "../../src/campaign/reserve.mjs";
import { CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { campaignTree, runsRoot } from "../../src/run/paths.mjs";
import { createRunRef, gitHead } from "../../src/repo/worktree.mjs";
import { CONTRACT_VERSION, harnessCapabilities } from "../../src/harnesses/index.mjs";
import { SPAWN_WAIT_FACTOR, fixture, packet, waitForValue, writeContract } from "../helpers.mjs";
import { writeExecutable } from "../write-executable.mjs";
import { nodeState } from "../runner-helpers.mjs";

// The declared weight of a node's readFiles at dispatch time, recorded on the
// node snapshot as `declaredReadBytes`: the worker prompt lists these paths
// and the worker reads them itself, so their combined byte size is the one
// quantity the controller can measure about a packet's reference load.
//
// The file also carries the dispatch side of the optional campaign reserve
// (ADR 0011): every new paid dispatch is admitted through the campaign's
// balance before the provider starts, its hold settles against the real
// charge, an unconfigured campaign gains no reserve at all, and a campaign
// record that is present but cannot be read or validated refuses the new
// dispatch closed -- fail-closed (ADR 0011), with an error distinct from
// `reserve_insufficient`, because a broken record is not evidence that the
// reserve is unconfigured. The runtime fixtures declare their pricing so the
// fake providers' token counts price into exact dollars and every balance
// assertion is exact.
//
// The full-run tests share one fake provider and run concurrently inside one
// `describe({ concurrency: true })`. Measured 2026-10-01 at the gate: the
// concurrent file completes in 48.2s under its 120s packet budget, each full
// run costs 11-26s on this host, and a serial file of five runs was killed
// mid-file at 60.04s with two runs still queued -- the shared-provider
// concurrency is what keeps the file inside its budget. The fake multiplexes
// its behaviors on prompt text alone -- the preflight marker, the judge
// prefix, and each fixture's own runs path, which every worker prompt carries
// in its worktree and canonical-result paths -- so concurrently running
// fixtures cannot read each other's prompts, and `FABERUN_CODEX_BIN` is read
// at spawn time, so one shared binary serves all of them.

/** Token pricing that makes every counter cost 1 USD per million tokens. */
const DOLLAR_PER_MTOK = { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, cachedInputPerMTok: 1_000_000 };

test("declaredReadBytes counts a missing declared file as zero rather than throwing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-declared-read-bytes-missing-"));
  writeFileSync(join(workspace, "present.txt"), "12345");
  mkdirSync(join(workspace, "nested"));
  writeFileSync(join(workspace, "nested", "child.txt"), "1234567");
  assert.equal(
    declaredReadBytes(["present.txt", "missing.txt", "nested/child.txt"], workspace),
    5 + 7,
  );
  assert.equal(declaredReadBytes([], workspace), 0);
});

test("startWorker fails closed when the campaign record cannot be read, parking the node without a paid call or a hold", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-corrupt-unit-"));
  // The run id is the fresh directory's basename: attempt worktrees are keyed
  // by run id under the temp root this test hands to `startWorker`, so a fixed
  // id collides with the worktree and branch a previous invocation left at
  // `<tmp>/worktrees/<id>/build.1`. The basename is unique per invocation and
  // passes `requireId`, and the campaign id follows it so no fixture state is
  // shared across invocations.
  const runId = basename(directory);
  const campaignId = `${runId}-campaign`;
  writeContract(directory, fixture({ id: runId, campaignId }));
  // Every attempt branch is cut from `refs/faberun/<runId>/run`, so the
  // dispatch under test cannot create its worktree without the run ref.
  createRunRef(directory, runId, gitHead(directory));
  const campaignPath = campaignTree(directory, campaignId);
  // The balance is high enough that cost alone can never refuse this dispatch:
  // the unreadable record must be the only thing that can.
  configureCampaignReserve(campaignPath, 100);
  // Parses as a launch-time record, unparseable by admission time -- exactly
  // the mid-run change the gate must not wave through on the validation the
  // launch performed.
  writeFileSync(join(campaignPath, CAMPAIGN_FILE), "{not json");

  /** @type {any} */
  const contract = {
    id: runId,
    cwd: directory,
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
    nodes: [corruptUnitNode()],
  };
  const state = corruptRecordState(runId, campaignId);
  const running = new Map();
  /** @type {any} */
  const lock = { assert() {} };
  startWorker(contract, corruptUnitNode(), state, mkdtempSync(join(tmpdir(), "reserve-corrupt-rundir-")), running, "Implement it", lock, new Map(), campaignPath);

  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "campaign_record_unreadable", state.error?.message);
  assert.equal(state.phase, "worker");
  assert.equal(state.invocations?.length, 1, "the refused worker dispatch never became a provider call");
  assert.equal(running.size, 0, "no provider process was started");
  assert.equal(existsSync(join(campaignPath, RESERVE_DIR)), false, "the refused admission took no hold and created no reserve state");
});

describe("full dispatch runs", { concurrency: true }, () => {
  /** @type {Record<string, {directory: string, path: string, campaignPath: string}>} */
  const shared = /** @type {Record<string, {directory: string, path: string, campaignPath: string}>} */ ({});
  const previousCodexBin = process.env.FABERUN_CODEX_BIN;

  before(() => {
    shared.recorded = buildRecordedFixture();
    shared.refuses = buildRefusesFixture();
    shared.judge = buildJudgeFixture();
    process.env.FABERUN_CODEX_BIN = sharedCodexFake(shared);
  });
  after(() => {
    if (previousCodexBin === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previousCodexBin;
  });

  test("a dispatch records declared read bytes and an unconfigured campaign gains no reserve", async () => {
    const result = await runContract(shared.recorded.path);
    const state = nodeState(result);
    assert.equal(state.status, "done", state.error?.message);
    assert.equal(state.declaredReadBytes, 37 + 101);

    // The campaign record exists and is readable, and carries no `reserveUsd`:
    // the dispatch ran the pre-reserve path untouched, and no reserve
    // directory, lock, or state file was created beside the record.
    const status = readCampaignReserve(shared.recorded.campaignPath);
    assert.equal(status.armed, false);
    assert.deepEqual(status.reservations, []);
    assert.equal(existsSync(join(shared.recorded.campaignPath, RESERVE_DIR)), false, "no reserve directory, lock, or state file exists");
  });

  test("an armed reserve refuses only the new call it cannot cover; the call already running continues", async () => {
    const { directory, path, campaignPath } = shared.refuses;
    const outcome = await (async () => {
      const run = runContract(path);
      try {
        // Both calls admitted while both were in flight: unknown costs, nothing held.
        const overlapping = /** @type {import("../../src/campaign/reserve.mjs").ReserveStatus} */ (await waitForValue(() => {
          const status = readCampaignReserve(campaignPath);
          return status.reservations.length === 2 && status.reservations.every((entry) => entry.status === "held") ? status : null;
        }, 30_000 * SPAWN_WAIT_FACTOR));
        assert.ok(overlapping.reservations.every((entry) => entry.costUsd === null), "an in-flight call with no measured cost keeps unknown exposure");
      } finally {
        // The fake providers poll for this file; whatever the assertions above
        // found, the run must never be left waiting on it.
        writeFileSync(join(runsRoot(directory), "provider-release"), "go");
      }
      // The one await in this test with no internal bound, capped: a host that
      // stalls the controller mid-settlement would otherwise hold the whole
      // file open until the runner is killed from outside. The cap is far
      // beyond the seconds this run takes on an idle machine, so only a
      // genuine stall trips it.
      let stallTimer = null;
      try {
        return await Promise.race([
          run,
          new Promise((resolve, reject) => {
            stallTimer = setTimeout(() => reject(new Error("the run never settled: the host stalled or a dispatch is wedged")), 300_000 * SPAWN_WAIT_FACTOR);
          }),
        ]);
      } finally {
        if (stallTimer !== null) clearTimeout(stallTimer);
        // A stalled run outlives this test; mark it handled so its eventual
        // settlement cannot surface as an unhandled rejection in a later test.
        run.catch(() => {});
      }
    })();

    const build = nodeState(outcome, "build");
    const slow = nodeState(outcome, "slow");
    assert.equal(build.status, "blocked");
    assert.equal(build.error?.code, "reserve_insufficient", build.error?.message);
    assert.equal(build.attempt, 2, "the refusal is a new attempt the balance would not admit");
    assert.equal(build.invocations?.length, 1, "the refused attempt never became a provider call");
    assert.equal(slow.status, "done", slow.error?.message);
    assert.equal(slow.invocations?.length, 1, "the call that was already running ran to completion untouched");

    const status = readCampaignReserve(campaignPath);
    assert.equal(status.heldUsd, 0, "a refused admission holds nothing");
    assert.equal(status.chargedUsd, 24, "both admitted calls reconciled their real charges");
    assert.equal(status.availableUsd, -9, "the reserve is not an absolute ceiling: settled charges pass it");
    assert.equal(status.unknownExposureCount, 0, "both exposures were reconciled, not forgotten");
    const settled = status.reservations.map((entry) => [entry.status, entry.chargedUsd, entry.lateChargeUsd]).sort();
    assert.deepEqual(settled, [["charged", 12, null], ["charged", 12, null]], "each unknown-exposure admission charged exactly its real cost with no late difference");
  });

  test("a judge dispatch holds what the worker just cost and a late charge can exceed the reservation", async () => {
    const { path, campaignPath } = shared.judge;
    const outcome = await runContract(path);
    const state = nodeState(outcome);
    assert.equal(state.status, "done", state.error?.message);

    const status = readCampaignReserve(campaignPath);
    assert.equal(status.reservations.length, 2);
    const [worker, judge] = status.reservations;
    assert.equal(worker.costUsd, null, "the worker was a first dispatch: unknown exposure");
    assert.equal(worker.status, "charged");
    assert.equal(worker.chargedUsd, 81);
    assert.equal(judge.node, "build");
    assert.equal(judge.costUsd, 81, "the judge admission held what the worker's call had just cost");
    assert.equal(judge.status, "charged");
    assert.equal(judge.chargedUsd, 162, "the judge's real charge, priced above its hold");
    assert.equal(judge.lateChargeUsd, 81, "the part of the charge that passed the reservation is recorded");
    assert.equal(status.heldUsd, 0);
    assert.equal(status.availableUsd, 7);
  });
});

/** @returns {{directory: string, path: string, campaignPath: string}} */
function buildRecordedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "runner-declared-read-bytes-"));
  const first = "a".repeat(37);
  const second = "b".repeat(101);
  writeFileSync(join(directory, "first.txt"), first);
  writeFileSync(join(directory, "second.txt"), second);
  const path = writeContract(directory, fixture({
    id: "declared-read-bytes-run",
    campaignId: "declared-read-bytes-campaign",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["first.txt", "second.txt"] }), gate: false }],
  }));
  return { directory, path, campaignPath: campaignTree(directory, "declared-read-bytes-campaign") };
}

/** @returns {{directory: string, path: string, campaignPath: string}} */
function buildRefusesFixture() {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-refuse-"));
  const path = writeContract(directory, fixture({
    id: "reserve-refuses-new-call",
    campaignId: "reserve-dispatch-refuse",
    maxParallel: 2,
    pollIntervalMs: 10,
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna", pricing: DOLLAR_PER_MTOK },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, pricing: DOLLAR_PER_MTOK },
    },
    nodes: [
      { id: "slow", type: "backend", taskPacket: packet(), gate: false },
      // Attempt 1 completes and is charged 12 USD; its red verification asks
      // for a revision, and the balance cannot hold that attempt's cost again.
      { id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }), gate: false },
    ],
  }));
  const campaignPath = campaignTree(directory, "reserve-dispatch-refuse");
  // A first attempt costs 12 USD here; after both charge, 3 USD cannot hold a
  // retry estimated at 12 again.
  configureCampaignReserve(campaignPath, 15);
  return { directory, path, campaignPath };
}

/** @returns {{directory: string, path: string, campaignPath: string}} */
function buildJudgeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-judge-"));
  const path = writeContract(directory, fixture({
    id: "reserve-judge-late-charge",
    campaignId: "reserve-dispatch-judge",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      // The judge's tokens cost twice the worker's, so the judge's real
      // charge lands above the hold its admission took.
      luna: { harness: "codex", model: "gpt-5.6-luna", pricing: DOLLAR_PER_MTOK },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, pricing: { inputPerMTok: 2_000_000, outputPerMTok: 2_000_000, cachedInputPerMTok: 2_000_000 } },
    },
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      gate: { failOn: ["critical"] },
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
    }],
  }));
  const campaignPath = campaignTree(directory, "reserve-dispatch-judge");
  configureCampaignReserve(campaignPath, 250);
  return { directory, path, campaignPath };
}

/**
 * One fake provider serving every concurrent full run, keyed on prompt text
 * alone. The preflight hello is answered by every runtime; judge prompts (only
 * the judge fixture ever dispatches one) get a passing verdict at the judge
 * fixture's heavier usage; the refuses fixture's workers park on its release
 * file; every other worker completes, at the judge fixture's heavier usage
 * when the prompt belongs to that fixture.
 *
 * @param {Record<string, {directory: string}>} shared
 * @returns {string} the executable path to point `FABERUN_CODEX_BIN` at
 */
function sharedCodexFake(shared) {
  const refusesRoot = runsRoot(shared.refuses.directory);
  const judgeRoot = runsRoot(shared.judge.directory);
  const path = join(mkdtempSync(join(tmpdir(), "runner-shared-codex-")), "fake-codex-shared.mjs");
  const source = `import { existsSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  if (process.argv.includes("--version")) {
    console.log("fake-codex 1.0.0");
    return;
  }
  if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
    console.log(JSON.stringify({type:"thread.started",thread_id:"preflight-hello"}));
    const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:hello}}));
    console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));
    return;
  }
  console.log(JSON.stringify({type:"thread.started",thread_id:"fake-thread"}));
  if (prompt.startsWith("Review node")) {
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({verdict:"pass",maxSeverity:"none",summary:"judge completed from reserve",findings:[]})}}));
    console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:80,output_tokens:1,cached_input_tokens:0}}));
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (prompt.includes(${JSON.stringify(refusesRoot)})) {
    writeFileSync(${JSON.stringify(join(refusesRoot, "provider-started"))}, "started");
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(join(refusesRoot, "provider-release"))})) return;
      clearInterval(timer);
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"done",summary:"worker complete",verification:[],artifacts:[],missingContext:[]})}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
    }, 5);
    return;
  }
  const judgeFixture = prompt.includes(${JSON.stringify(judgeRoot)});
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"done",summary:"worker complete",verification:[],artifacts:[],missingContext:[]})}}));
  console.log(JSON.stringify({type:"turn.completed",usage:judgeFixture ? {input_tokens:80,output_tokens:1,cached_input_tokens:0} : {input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
  if (judgeFixture) setTimeout(() => process.exit(0), 200);
});
`;
  return writeExecutable(path, source);
}

/** @returns {any} the node the corrupt-record unit test dispatches */
function corruptUnitNode() {
  return {
    id: "build",
    type: "backend",
    phase: "phase-0",
    gate: false,
    taskPacket: packet(),
  };
}

/**
 * The full node-snapshot shape the engine persists, as the corrupt-record
 * refusal test's starting point: `startWorker` parks this state with a write,
 * so it has to arrive complete rather than trimmed. `invocations` carries one
 * closed, already-priced worker call, and stays at exactly that one when the
 * refusal is done.
 *
 * @param {string} runId the fixture's unique per-invocation run id
 * @param {string} campaignId the fixture's matching campaign id
 * @returns {any}
 */
function corruptRecordState(runId, campaignId) {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    schemaVersion: 3,
    contractVersion: CONTRACT_VERSION,
    id: "build",
    type: "backend",
    sourceIdentity: { kind: "node", contractId: runId, nodeId: "build" },
    packetHash: "a".repeat(64),
    status: "pending",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    judgeFailures: 0,
    runtime: { id: "worker", harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", capabilities: harnessCapabilities({ harness: "claude" }) },
    blockedBy: [],
    startedAt: at,
    updatedAt: at,
    result: null,
    gate: null,
    error: null,
    invocations: [{
      id: "inv-worker",
      pid: 4242,
      processGroupId: null,
      processStartToken: null,
      harness: "claude",
      phase: "worker",
      role: "worker",
      runId,
      campaignId,
      planPhase: "phase-0",
      runtimeFingerprint: "worker",
      model: "claude-sonnet-5",
      reasoning: null,
      sandbox: null,
      continuationId: null,
      continuationMode: "fresh",
      promptPath: null,
      stdoutPath: null,
      stderrPath: null,
      executable: null,
      startedAt: at,
      updatedAt: at,
      deadlineAt: at,
      closedAt: at,
      exitCode: 0,
      signal: null,
      status: "closed",
      costUsd: 50,
    }],
  };
}
