import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { composeAssignments } from "../../src/engine/runtime-discovery.mjs";
import { runtimeAssignments } from "../../src/engine/assignment.mjs";
import { planRoute } from "../../src/engine/backoff.mjs";
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
    return state.chosen ?? undefined;
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
  });
});
