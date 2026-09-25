import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAssignments } from "../../src/engine/runtime-discovery.mjs";
import { runtimeAssignments } from "../../src/engine/assignment.mjs";
import { planRoute } from "../../src/engine/backoff.mjs";
import { handleProviderExhaustion } from "../../src/engine/lifecycle.mjs";
import { runtimeSnapshot } from "../../src/engine/failover.mjs";
import {
  JUDGE_USAGE_WINDOW_LIMIT_PERCENT,
  initialJudgeListState,
  nextListJudge,
  resolveJudgeList,
  selectListJudge,
} from "../../src/engine/judge-list.mjs";
import { availabilityKey, recordRefusal } from "../../src/run/availability.mjs";
import { recordUsageWindows, usageAccountOf } from "../../src/run/usage-windows.mjs";
import { getHarness } from "../../src/harnesses/index.mjs";
import { writeUserConfig } from "../../src/host/config.mjs";
import { snapshot as nodeSnapshotFixture } from "../contract/helpers.mjs";

/**
 * A worker plus a six-entry judge list: one shares the worker's provider (R18
 * always skips it), two are `codex` -- one for a recorded refusal, one for a
 * spent usage window, both readable only through a real `harness`/`model`
 * pair -- and three are distinct providers the run can hop to in turn.
 *
 * @type {Record<string, {harness: string, model: string, vendor: string, executable: string}>}
 */
const RUNTIMES = {
  worker: { harness: "dsh", model: "deepseek-flash", vendor: "deepseek", executable: "/nonexistent/dsh" },
  "dsh-same": { harness: "dsh", model: "deepseek-other", vendor: "deepseek", executable: "/nonexistent/dsh-same" },
  "codex-sol": { harness: "codex", model: "gpt-6-sol", vendor: "openai", executable: "/nonexistent/codex-sol" },
  "codex-luna": { harness: "codex", model: "gpt-6-luna", vendor: "openai", executable: "/nonexistent/codex-luna" },
  "claude-opus": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic", executable: "/nonexistent/claude-opus" },
  "zcode-glm": { harness: "zcode", model: "glm-5.3-flash", vendor: "zhipu", executable: "/nonexistent/zcode-glm" },
  "agy-gemini": { harness: "agy", model: "gemini-3.8-flash-low", vendor: "google", executable: "/nonexistent/agy-gemini" },
};

const LIST = ["dsh-same", "codex-sol", "codex-luna", "claude-opus", "zcode-glm", "agy-gemini"];

/** @param {string} id @returns {string} */
function keyOf(id) {
  const runtime = RUNTIMES[id];
  return availabilityKey({ harness: runtime.harness, model: runtime.model, executable: getHarness(runtime.harness).executable(runtime) });
}

test("the judge is the first eligible entry of the list and falls back hop by hop", () => {
  const now = Date.now();

  // --- precedence: the contract's own list wins over the machine default,
  // exactly as runtimeDefaults.worker already wins over config.worker.
  assert.deepEqual(resolveJudgeList({ judges: ["a", "b"] }, { judges: ["c"] }), ["a", "b"]);
  assert.deepEqual(resolveJudgeList({}, { judges: ["c"] }), ["c"]);
  assert.equal(resolveJudgeList({}, null), undefined);

  // --- seed the durable stores the initial pick must read: codex-sol is
  // refused, codex-luna's account is over the usage-window limit.
  recordRefusal(keyOf("codex-sol"), { reason: "quota_exhausted", exhaustedUntil: new Date(now + 900_000).toISOString() }, now);
  const account = /** @type {string} */ (usageAccountOf(RUNTIMES["codex-luna"]));
  recordUsageWindows(account, [{ window: "seven_day", usedPercent: JUDGE_USAGE_WINDOW_LIMIT_PERCENT + 5, resetsAt: new Date(now + 86_400_000).toISOString() }], now);

  const contract = /** @type {any} */ ({ runtimes: RUNTIMES });
  const initial = selectListJudge(contract, LIST, "worker", { now });
  assert.equal(initial.chosen, "claude-opus", "the first entry neither same-provider, refused, nor over budget");
  assert.deepEqual(initial.skipped, [
    { id: "dsh-same", reason: "same provider as the worker: deepseek" },
    { id: "codex-sol", reason: "recorded refusal: quota_exhausted" },
    { id: "codex-luna", reason: `usage window seven_day at ${JUDGE_USAGE_WINDOW_LIMIT_PERCENT + 5}%, above ${JUDGE_USAGE_WINDOW_LIMIT_PERCENT}%` },
  ]);

  // --- composeAssignments reads an omitted judge from the list before its own
  // single config.judge preference and strongest-candidate default; the
  // callback here is exactly what engine/assignment.mjs wires in production.
  /** @type {Record<string, import("../../src/contract/index.mjs").JudgeListState>} */
  const judgeListStates = {};
  const listJudge = (/** @type {{id: string}} */ node, /** @type {string} */ workerId) => {
    const state = initialJudgeListState(contract, LIST, workerId, now);
    judgeListStates[node.id] = state;
    return state;
  };
  const composed = composeAssignments(
    /** @type {any} */ ({ runtimes: RUNTIMES, runtimeDefaults: { worker: "worker" }, nodes: [{ id: "build", gate: { enabled: true } }] }),
    {},
    { listJudge },
  );
  assert.deepEqual(composed.build, { worker: "worker", judge: "claude-opus" });
  assert.equal(judgeListStates.build.chosen, "claude-opus");

  // --- the same wiring end to end through runtimeAssignments, with the list
  // declared only on the machine config this time (the contract carries
  // none): the config's own list still governs the omitted judge.
  writeUserConfig(process.env, { schemaVersion: 1, harnesses: [], judges: LIST, updatedAt: new Date(now).toISOString() });
  const nodesContract = {
    cwd: process.cwd(),
    runtimeDefaults: { worker: "worker" },
    runtimes: RUNTIMES,
    nodes: [{ id: "build", runtime: undefined, gate: { enabled: true, runtime: undefined } }],
  };
  return runtimeAssignments(/** @type {any} */ (nodesContract)).then((plan) => {
    assert.equal(plan.assignments.build.judge, "claude-opus", "the config's own judges list governs when the contract declares none");
    assert.equal(plan.decisions.build.judge.strategy, "judge-list");
    assert.match(plan.decisions.build.judge.reason, /judge list: chose claude-opus/u);
    const initialJudgeList = /** @type {import("../../src/contract/index.mjs").JudgeListState} */ (plan.judgeListStates.build);
    assert.equal(initialJudgeList.chosen, "claude-opus");

    // --- hop by hop: claude-opus is refused mid-run, then zcode-glm is too --
    // two refusals in a row move two hops, never returning to a runtime
    // already refused, and the evidence keeps every skip along the way.
    let judgeListState = initialJudgeList;
    recordRefusal(keyOf("claude-opus"), { reason: "quota_exhausted", exhaustedUntil: new Date(now + 900_000).toISOString() }, now + 1_000);
    judgeListState = nextListJudge(contract, judgeListState, "worker", now + 1_000);
    assert.equal(judgeListState.chosen, "zcode-glm", "hop 1: the next eligible entry after claude-opus");

    // --- the same route decision (`planRoute`, backoff.mjs) a real judge
    // exhaustion drives, at this same hop: a list-driven judge hops without
    // hitting the declared one-hop cap, because the assignment is composed,
    // exactly like the existing dynamic-tier fallback it stands in for.
    const nodeState = {
      revisions: 0,
      invocations: [],
      routing: {
        history: [],
        currentOverride: null,
        assignments: { worker: "worker", judge: "claude-opus", composedWorker: false, composedJudge: true },
        judgeList: initialJudgeList,
      },
    };
    const route = planRoute(
      contract,
      /** @type {any} */ ({}),
      /** @type {any} */ (nodeState),
      "judge",
      { code: "provider_exhausted", message: "quota" },
      "claude-opus",
      { kind: "failover", reason: "provider" },
      now + 1_000,
      null,
      { judgeListState },
    );
    assert.equal(route.blocked, null, "a list hop is not the one-hop cap: the judge assignment is composed");
    assert.equal(route.nextRuntime, "zcode-glm");
    assert.deepEqual(route.judgeList, judgeListState);

    recordRefusal(keyOf("zcode-glm"), { reason: "quota_exhausted", exhaustedUntil: new Date(now + 900_000).toISOString() }, now + 2_000);
    judgeListState = nextListJudge(contract, judgeListState, "worker", now + 2_000);
    assert.equal(judgeListState.chosen, "agy-gemini", "hop 2: two refusals in a row moved two hops");

    const skippedIds = judgeListState.skipped.map((entry) => entry.id);
    assert.ok(skippedIds.includes("claude-opus") && skippedIds.includes("zcode-glm"), "the evidence names every skip, including each hop's refusal");
    // The refusal each hop just recorded is also why that entry joined the
    // excluded set (`nextListJudge`), so its own eligibility pass reports it
    // as already attempted this run -- never returning to one already
    // refused -- rather than re-deriving the refusal it was just given.
    assert.ok(judgeListState.skipped.some((entry) => entry.id === "claude-opus" && entry.reason === "already attempted this run"));
    assert.ok(judgeListState.skipped.some((entry) => entry.id === "zcode-glm" && entry.reason === "already attempted this run"));
    // dsh-same, codex-sol and codex-luna were never eligible in the first
    // place and stay excluded on every later hop -- never returning to one
    // already refused (or, here, never eligible at all).
    assert.ok(skippedIds.includes("dsh-same"));
    // An entry skipped for cause keeps its real reason across every later
    // hop's re-derivation, never relabelled "already attempted this run" --
    // only an id that was itself chosen and then failed earns that label.
    assert.ok(
      judgeListState.skipped.filter((entry) => entry.id === "dsh-same").every((entry) => entry.reason === "same provider as the worker: deepseek"),
    );
  });
});

test("an exhausted judge list blocks the node instead of falling through to config.judge or the strongest candidate", () => {
  const contract = /** @type {any} */ ({
    runtimes: RUNTIMES,
    runtimeDefaults: { worker: "worker" },
    nodes: [{ id: "build", gate: { enabled: true } }],
  });
  /** @type {Record<string, import("../../src/contract/index.mjs").JudgeListState>} */
  const judgeListStates = {};
  // dsh-same is the only entry on this list, and shares the worker's
  // provider, so the list is exhausted for every candidate on the first pass.
  // The callback returns the whole pick (not just `chosen`), exactly what
  // `engine/assignment.mjs` wires in production, so `composeAssignments`
  // itself -- not just this test's own map -- can name the skip in its error.
  const listJudge = (/** @type {{id: string}} */ node, /** @type {string} */ workerId) => {
    const state = initialJudgeListState(contract, ["dsh-same"], workerId);
    judgeListStates[node.id] = state;
    return state;
  };
  assert.throws(
    () => composeAssignments(contract, {}, { config: { schemaVersion: 1, harnesses: [], judge: "codex-sol", updatedAt: new Date().toISOString() }, listJudge }),
    (/** @type {Error} */ error) => /runtime_assignment_judge_unavailable/u.test(error.message)
      // The thrown error names the entry and its reason directly: an operator
      // reading an aborted run has no other trace of the list, since this
      // constructor throws before `runtimeAssignments` ever returns its own
      // `judgeListStates` record.
      && /dsh-same: same provider as the worker: deepseek/u.test(error.message),
    "an exhausted list must not fall through to config.judge, even though one is set, and the error names the skip",
  );
  // The evidence survives the throw in the caller's own side-channel too.
  assert.equal(judgeListStates.build.chosen, null);
  assert.deepEqual(judgeListStates.build.skipped, [{ id: "dsh-same", reason: "same provider as the worker: deepseek" }]);
});

test("a judge list exhausted mid-run persists the last pass's skip evidence instead of a stale chosen", () => {
  // A single-entry list: codex-sol is the only judge, currently running, and
  // this very failure is the last hop this list has.
  const contract = /** @type {any} */ ({ runtimes: RUNTIMES });
  const runDir = mkdtempSync(join(tmpdir(), "runner-judge-list-exhaustion-"));
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const state = /** @type {any} */ (nodeSnapshotFixture({
    phase: "judge",
    status: "running",
    runtime: runtimeSnapshot(contract, "codex-sol"),
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "worker", judge: "codex-sol", composedWorker: false, composedJudge: true },
      judgeList: { list: ["codex-sol"], chosen: "codex-sol", skipped: [] },
    },
  }));
  const node = /** @type {any} */ ({ id: "build" });
  const envelope = /** @type {any} */ ({ status: "failed", error: { code: "provider_exhausted", message: "quota" } });
  handleProviderExhaustion(contract, runDir, node, state, "judge", envelope, "codex-sol", /** @type {any} */ (null), new Map(), "campaign-path");
  // `judge_list_exhausted` is not `runtime_tier_exhausted`, so this went
  // through the branch that used to write no routing at all -- the persisted
  // node must still show the refused judge joining the excluded set and no
  // entry left to pick, not the stale `chosen: "codex-sol"` it started with.
  assert.equal(state.status, "exhausted");
  assert.equal(state.error?.code, "judge_list_exhausted");
  assert.deepEqual(state.routing?.judgeList, {
    list: ["codex-sol"],
    chosen: null,
    skipped: [{ id: "codex-sol", reason: "already attempted this run" }],
  });
});

test("a list-governed hop replaces a judge's own declared runtime.fallback edge instead of following it", () => {
  const runtimes = {
    ...RUNTIMES,
    // claude-opus declares its own static fallback, to a runtime the list
    // would never pick (dsh-same shares the worker's provider) -- proof that
    // the list, not this edge, drives the hop.
    "claude-opus": { ...RUNTIMES["claude-opus"], fallback: "dsh-same" },
  };
  const contract = /** @type {any} */ ({ runtimes });
  const judgeListState = { list: LIST, chosen: "zcode-glm", skipped: [] };
  const nodeState = {
    revisions: 0,
    invocations: [],
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "worker", judge: "claude-opus", composedWorker: false, composedJudge: true },
      judgeList: judgeListState,
    },
  };
  const route = planRoute(
    contract,
    /** @type {any} */ ({}),
    /** @type {any} */ (nodeState),
    "judge",
    { code: "provider_exhausted", message: "quota" },
    "claude-opus",
    { kind: "failover", reason: "provider" },
    Date.now(),
    null,
    { judgeListState },
  );
  assert.equal(route.nextRuntime, "zcode-glm", "the list's own pick wins over claude-opus's declared fallback (dsh-same)");
  assert.equal(route.blocked, null);
});

test("a judge list exhausted mid-run blocks with judge_list_exhausted, not the declared-fallback cycle check", () => {
  const contract = /** @type {any} */ ({ runtimes: RUNTIMES });
  const exhaustedState = {
    list: LIST,
    chosen: null,
    skipped: LIST.map((id) => ({ id, reason: "same provider as the worker: deepseek" })),
  };
  const nodeState = {
    revisions: 0,
    invocations: [],
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "worker", judge: "zcode-glm", composedWorker: false, composedJudge: true },
      judgeList: exhaustedState,
    },
  };
  const route = planRoute(
    contract,
    /** @type {any} */ ({}),
    /** @type {any} */ (nodeState),
    "judge",
    { code: "provider_exhausted", message: "quota" },
    "zcode-glm",
    { kind: "failover", reason: "provider" },
    Date.now(),
    null,
    { judgeListState: exhaustedState },
  );
  assert.equal(route.nextRuntime, "zcode-glm", "no edge remains, so the route stays put");
  assert.equal(route.blocked?.code, "judge_list_exhausted");
});

test("a judge refused on an earlier hop stays excluded after an earlier list entry becomes eligible again", () => {
  const now = Date.now();
  const runtimes = {
    worker: RUNTIMES.worker,
    early: { harness: "agy", model: "gemini-3.8-flash-low", vendor: "google", executable: "/nonexistent/agy-early" },
    late: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic", executable: "/nonexistent/claude-late" },
  };
  const contract = /** @type {any} */ ({ runtimes });
  /** @param {"early"|"late"} id */
  const key = (id) => availabilityKey({ harness: runtimes[id].harness, model: runtimes[id].model, executable: getHarness(runtimes[id].harness).executable(runtimes[id]) });

  // `early` is briefly refused, so the initial pick lands on `late`.
  recordRefusal(key("early"), { reason: "quota_exhausted", exhaustedUntil: new Date(now + 500).toISOString() }, now);
  let state = initialJudgeListState(contract, ["early", "late"], "worker", now);
  assert.equal(state.chosen, "late");

  // `late` refuses once `early`'s refusal has expired: the hop goes back up
  // the list to `early`, and the evidence still names `late` as attempted.
  state = nextListJudge(contract, state, "worker", now + 1_000);
  assert.equal(state.chosen, "early");
  assert.deepEqual(state.skipped, [{ id: "late", reason: "already attempted this run" }]);

  // `early` refuses too: both entries have run and failed, so the list is
  // exhausted rather than returning to `late`.
  state = nextListJudge(contract, state, "worker", now + 2_000);
  assert.equal(state.chosen, null);
  assert.deepEqual(state.skipped.map((entry) => entry.id), ["early", "late"]);
});
