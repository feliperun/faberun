import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { declaredReadBytes } from "../../src/engine/dispatch.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { configureCampaignReserve, readCampaignReserve, RESERVE_DIR, RESERVE_STATE_FILE } from "../../src/campaign/reserve.mjs";
import { CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { campaignTree, runsRoot } from "../../src/run/paths.mjs";
import { SPAWN_WAIT_FACTOR, fixture, packet, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

// The declared weight of a node's readFiles at dispatch time, recorded on the
// node snapshot as `declaredReadBytes`: the worker prompt lists these paths
// and the worker reads them itself, so their combined byte size is the one
// quantity the controller can measure about a packet's reference load.
//
// The file also carries the dispatch side of the optional campaign reserve
// (ADR 0011): every new paid dispatch is admitted through the campaign's
// balance before the provider starts, its hold settles against the real
// charge, and an unconfigured campaign gains no reserve at all. The runtime
// fixtures declare their pricing so the fake providers' token counts price
// into exact dollars and every balance assertion is exact.

/** Token pricing that makes every counter cost 1 USD per million tokens. */
const DOLLAR_PER_MTOK = { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, cachedInputPerMTok: 1_000_000 };

test("dispatch records the summed byte size of the node's declared readFiles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-declared-read-bytes-"));
  const first = "a".repeat(37);
  const second = "b".repeat(101);
  writeFileSync(join(directory, "first.txt"), first);
  writeFileSync(join(directory, "second.txt"), second);
  const path = writeContract(directory, fixture({
    id: "declared-read-bytes-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["first.txt", "second.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.declaredReadBytes, first.length + second.length);
});

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

test("an armed reserve refuses only the new call it cannot cover; the call already running continues", async () => {
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
  // A first attempt costs 12 USD here; after it charges, 3 USD cannot hold a
  // retry estimated at 12 again.
  configureCampaignReserve(campaignPath, 15);

  const outcome = await withFakeCodex(directory, "wait-for-release", async () => {
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
    // The one await in this file with no internal bound: every provider here
    // parks on the release file, so a host that stalls the controller
    // mid-settlement would otherwise hold the whole file open until the
    // runner is killed from outside, with no verdict naming this test
    // (measured 2026-09-30: a gate run froze after integration's "prepared"
    // record and the file died to an external timeout). The cap is ~37x the
    // 8s this run takes on an idle machine, so only a genuine stall trips it.
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
  });

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
});

test("a dispatch under an armed reserve is admitted as unknown exposure and reconciles the real charge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-unknown-"));
  const path = writeContract(directory, fixture({
    id: "reserve-unknown-dispatch",
    campaignId: "reserve-dispatch-unknown",
    pollIntervalMs: 10,
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna", pricing: DOLLAR_PER_MTOK },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, pricing: DOLLAR_PER_MTOK },
    },
  }));
  const campaignPath = campaignTree(directory, "reserve-dispatch-unknown");
  configureCampaignReserve(campaignPath, 15);

  const outcome = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(outcome);
  assert.equal(state.status, "done", state.error?.message);

  const status = readCampaignReserve(campaignPath);
  assert.equal(status.armed, true);
  assert.equal(status.reservations.length, 1);
  const [reservation] = status.reservations;
  assert.equal(reservation.node, "build");
  assert.equal(reservation.runId, "reserve-unknown-dispatch");
  assert.equal(reservation.costUsd, null, "admission invented no number: the exposure stayed unknown until the charge arrived");
  assert.equal(reservation.status, "charged");
  assert.equal(reservation.chargedUsd, 12);
  assert.equal(reservation.lateChargeUsd, null);
  assert.equal(status.unknownExposureCount, 0, "the exposure was reconciled, not forgotten");
  assert.equal(status.availableUsd, 3);
});

test("an unconfigured campaign keeps its existing dispatch path and gains no reserve", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-unconfigured-"));
  const path = writeContract(directory, fixture({
    id: "reserve-unconfigured-dispatch",
    campaignId: "reserve-dispatch-unconfigured",
    pollIntervalMs: 10,
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna", pricing: DOLLAR_PER_MTOK },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, pricing: DOLLAR_PER_MTOK },
    },
  }));
  const campaignPath = campaignTree(directory, "reserve-dispatch-unconfigured");

  const outcome = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(nodeState(outcome).status, "done", nodeState(outcome).error?.message);
  assert.equal(existsSync(join(campaignPath, RESERVE_DIR)), false, "no reserve directory, lock, or state file exists");
  const status = readCampaignReserve(campaignPath);
  assert.equal(status.armed, false);
  assert.deepEqual(status.reservations, []);
});

test("a judge dispatch holds what the worker just cost and a late charge can exceed the reservation", async () => {
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

  const outcome = await withFakeCodex(directory, "judge-reserve-overrun", () => runContract(path));
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

test("a campaign record that turns unreadable fails the next new dispatch closed before the provider starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-reserve-corrupt-"));
  const path = writeContract(directory, fixture({
    id: "reserve-record-corrupt",
    campaignId: "reserve-dispatch-corrupt",
    pollIntervalMs: 10,
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna", pricing: DOLLAR_PER_MTOK },
      sol: { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, pricing: DOLLAR_PER_MTOK },
    },
    // Attempt 1 completes and is rejected, so the run re-dispatches it; that
    // re-dispatch's admission is where the record is read again.
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(1)"] }] }), gate: false }],
  }));
  const campaignPath = campaignTree(directory, "reserve-dispatch-corrupt");
  // Balance enough that cost alone can never refuse the revision: the record
  // must be the only thing that can.
  configureCampaignReserve(campaignPath, 250);

  const outcome = await withFakeCodex(directory, "wait-for-release", async () => {
    const run = runContract(path);
    try {
      // Attempt 1 is admitted and its provider parks on the release file; the
      // record turns unreadable while that admitted call is the one in flight
      // -- valid at launch, broken before the next admission reads it.
      await waitForValue(() => {
        const status = readCampaignReserve(campaignPath);
        return status.reservations.length === 1 && status.reservations[0].status === "held" ? status : null;
      }, 30_000 * SPAWN_WAIT_FACTOR);
      // Parses, but fails validation: status must be active or closed.
      writeFileSync(join(campaignPath, CAMPAIGN_FILE), JSON.stringify({ id: "reserve-dispatch-corrupt", goal: "corrupt the record mid-run", status: "paused", linkedRunIds: [] }));
    } finally {
      // The fake provider parks on this file; whatever the assertions above
      // found, the run must never be left waiting on it.
      writeFileSync(join(runsRoot(directory), "provider-release"), "go");
    }
    // The one await in this file with no internal bound, capped for the same
    // reason as the reserve_insufficient test above: a host that stalls the
    // controller mid-settlement would otherwise hold the whole file open
    // until the runner is killed from outside. The cap is far beyond the
    // seconds this run takes on an idle machine, so only a genuine stall
    // trips it.
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
  });

  const build = nodeState(outcome, "build");
  assert.equal(build.status, "blocked");
  assert.equal(build.error?.code, "campaign_record_unreadable", build.error?.message);
  assert.equal(build.attempt, 2, "the refusal is the revision attempt, never dispatched");
  assert.equal(build.invocations?.length, 1, "the refused attempt never became a provider call");

  // `readCampaignReserve` reads the record, which is corrupt by design, so
  // the hold is asserted off the reserve state file the admission writes to.
  const reserveState = JSON.parse(readFileSync(join(campaignPath, RESERVE_DIR, RESERVE_STATE_FILE), "utf8"));
  assert.equal(reserveState.reservations.length, 1, "the refused admission took no hold of its own");
  assert.equal(reserveState.reservations[0].costUsd, null, "the admitted call went in as unknown exposure");
  assert.equal(reserveState.reservations[0].status, "charged", "the admitted call reconciled; nothing is left held");
});
