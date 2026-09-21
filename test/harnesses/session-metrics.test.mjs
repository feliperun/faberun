import test from "node:test";
import assert from "node:assert/strict";
import { SessionMetricsParser, liveInputTokens, liveSessionMetrics, liveUsage } from "../../src/harnesses/session-metrics.mjs";

test("live metering reads cumulative Codex usage from a growing transcript", () => {
  const stream = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.completed", usage: { input_tokens: 400, output_tokens: 10 } },
    { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 30 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(liveInputTokens("codex", stream), 1200);
  assert.equal(liveInputTokens("codex", `${stream}\n{"type":"turn.compl`), 1200, "partial trailing line is ignored");
  assert.equal(liveInputTokens("codex", "not json at all"), 0);
});

test("live metering separates and weights cached reads like the campaign ledger", () => {
  const stream = [
    { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 10 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(liveUsage("codex", stream), { inputTokens: 200, cacheReadInputTokens: 1800 }, "uncached and cached components");
  assert.equal(liveInputTokens("codex", stream, 0.1), 380, "cached reads count at the weighted rate");
  assert.equal(liveInputTokens("codex", stream), 2000, "default weight meters the raw total");
  const allCache = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1800, cached_input_tokens: 1800 } });
  assert.equal(liveInputTokens("codex", allCache, 0.1), 180, "fully cached input meters at the weighted rate");
});

test("live metering sums per-request Claude usage and prefers the terminal total", () => {
  const partial = [
    { type: "assistant", message: { usage: { input_tokens: 100 } } },
    { type: "assistant", message: { usage: { input_tokens: 250 } } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(liveInputTokens("claude", partial), 350, "mid-run sum of per-request usage");
  const terminal = `${partial}\n${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 320 } })}`;
  assert.equal(liveInputTokens("claude", terminal), 320, "terminal session total wins");
  assert.equal(liveInputTokens("exec-jsonl", partial), 0, "completion-only harnesses meter as zero mid-run");
});

test("live session metrics expose only what each harness's events prove", () => {
  const codexEvents = [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 300 } },
    { type: "item.completed", item: { type: "tool_call" } },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 700 } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "done" }) } },
    { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 900 } },
  ];
  const codex = codexEvents.map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("codex", codex),
    { turns: 3, cacheReadInputTokens: 900, toolCalls: 2, completed: true },
    "Codex turn completions, cumulative cache-read maximum, tool items, and the terminal turn that ends with the result message",
  );
  const midSession = codexEvents.slice(0, 6).map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("codex", midSession),
    { turns: 2, cacheReadInputTokens: 700, toolCalls: 2, completed: false },
    "a turn.completed that does not end with the result-carrying message is not a completed invocation",
  );
  assert.deepEqual(
    liveSessionMetrics("codex", `${codex}\n{"type":"turn.compl`),
    { turns: 3, cacheReadInputTokens: 900, toolCalls: 2, completed: true },
    "a partial trailing line is ignored",
  );
  const claude = [
    { type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 40 }, content: [{ type: "tool_use" }, { type: "tool_use" }, { type: "text", text: "working" }] } },
    { type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20 }, content: [] } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("claude", claude),
    { turns: 2, cacheReadInputTokens: 60, toolCalls: 2, completed: false },
    "assistant turns, summed per-request cache reads, and tool_use blocks",
  );
  const terminal = `${claude}\n${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 15, cache_read_input_tokens: 90 } })}`;
  assert.deepEqual(
    liveSessionMetrics("claude", terminal),
    { turns: 2, cacheReadInputTokens: 90, toolCalls: 2, completed: true },
    "the terminal session total wins over the mid-run sum and the result record folds completion",
  );
  const execJsonl = JSON.stringify({ schemaVersion: 1, type: "run.completed", result: "ok", continuationId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 7 }, costUsd: null });
  assert.deepEqual(
    liveSessionMetrics("exec-jsonl", execJsonl),
    { turns: 1, cacheReadInputTokens: 7, toolCalls: 0, completed: true },
    "the protocol carries no tool events, so only a completed run proves a turn",
  );
  assert.deepEqual(liveSessionMetrics("codex", "not json at all"), { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false }, "malformed input meters as zero");
  assert.deepEqual(liveSessionMetrics("agy", codex), { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false }, "unsupported harnesses meter as zero");
});

test("live metering has no zcode transcript: usage settles from the terminal envelope", () => {
  assert.deepEqual(
    liveSessionMetrics("zcode", JSON.stringify({ sessionId: "s", response: "ok", usage: { inputTokens: 5 } })),
    { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: false },
    "the single-JSON output is only parseable at process end, so mid-run metering reads zero",
  );
});

test("dsh and agy session events are metered: turns, tool calls, cache reads and completion", () => {
  // Before 2026-09-20 both harnesses metered zero events while declaring
  // streamsOutput, which made the stall detector a wall-clock cutoff for them.
  const dsh = [
    { type: "dsh.started", sessionId: "s" },
    { type: "dsh.tool", name: "read", target: "src/a.mjs" },
    { type: "dsh.message", text: "working", usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 900 } },
    { type: "dsh.tool", name: "bash", target: "npm test" },
    { type: "dsh.message", text: "{\"status\":\"done\"}", usage: { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 1100 } },
  ];
  const live = dsh.map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("dsh", live),
    { turns: 2, cacheReadInputTokens: 2000, toolCalls: 2, completed: false },
    "one turn per assistant message, one tool call per forwarded tool/call, cache reads summed per message",
  );
  assert.deepEqual(liveUsage("dsh", live), { inputTokens: 220, cacheReadInputTokens: 2000 }, "mid-run usage is the per-message sum");
  const terminal = `${live}\n${JSON.stringify({ type: "dsh.completed", sessionId: "s", result: "{\"status\":\"done\"}", usage: { inputTokens: 220, outputTokens: 45, cacheReadInputTokens: 2000 } })}`;
  assert.deepEqual(
    liveSessionMetrics("dsh", terminal),
    { turns: 2, cacheReadInputTokens: 2000, toolCalls: 2, completed: true },
    "the terminal event folds completion and its session total wins",
  );
  assert.deepEqual(
    liveSessionMetrics("dsh", JSON.stringify({ type: "dsh.failed", sessionId: "s", kind: "error", error: { code: "x", message: "y" }, usage: null })),
    { turns: 0, cacheReadInputTokens: 0, toolCalls: 0, completed: true },
    "a failed turn is a complete one",
  );
  const agy = [
    { event: "init", conversation_id: "c" },
    { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
    { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response" } },
    { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 15000, output_tokens: 90, cache_read_tokens: 3000 } } },
    { event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "view_file" } },
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "view_file" } },
    { event: "step_update", step_update: { step_index: 3, state: "ERROR", step_type: "tool", tool_name: "run_command" } },
    { event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "agent_response", usage: { input_tokens: 16000, output_tokens: 20, cache_read_tokens: 18000 } } },
  ];
  const agyLive = agy.map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(
    liveSessionMetrics("agy", agyLive),
    { turns: 2, cacheReadInputTokens: 21000, toolCalls: 2, completed: false },
    "agent responses reaching DONE are turns; tool steps reaching DONE or ERROR are tool calls; ACTIVE updates count nothing",
  );
  assert.deepEqual(liveUsage("agy", agyLive), { inputTokens: 31000, cacheReadInputTokens: 21000 }, "mid-run usage is the per-response sum");
  const agyTerminal = `${agyLive}\n${JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "ok", usage: { input_tokens: 31000, output_tokens: 110, cache_read_tokens: 25000 } } })}`;
  assert.deepEqual(
    liveSessionMetrics("agy", agyTerminal),
    { turns: 2, cacheReadInputTokens: 25000, toolCalls: 2, completed: true },
    "the result event folds completion and its session total wins",
  );
  assert.deepEqual(liveUsage("agy", agyTerminal), { inputTokens: 31000, cacheReadInputTokens: 25000 });
});

test("the per-request ledger records how many requests a turn made and how its context grew", () => {
  const claude = new SessionMetricsParser("claude");
  claude.push([
    { type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 40 }, content: [{ type: "tool_use" }] } },
    { type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 120 }, content: [] } },
    { type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 60 }, content: [] } },
    { type: "result", result: "ok", usage: { input_tokens: 17, cache_read_input_tokens: 220 } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  claude.flush();
  assert.deepEqual(
    claude.session(),
    { turns: 3, toolCalls: 1, requests: 3, contextFirst: 55, contextMax: 125, contextLast: 62, contextSum: 242, completed: true },
    "context is uncached input (cache writes included) plus cache reads, per request; the result record is a total, not a request",
  );
  const codex = new SessionMetricsParser("codex");
  codex.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 300 } }));
  codex.flush();
  assert.deepEqual(
    codex.session(),
    { turns: 1, toolCalls: 0, requests: null, contextFirst: null, contextMax: null, contextLast: null, contextSum: null, completed: false },
    "codex usage is cumulative per turn, not per request, so the request fields stay null rather than inventing a shape",
  );
  const dsh = new SessionMetricsParser("dsh");
  dsh.push([
    { type: "dsh.message", text: "a", usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 900 } },
    { type: "dsh.message", text: "b" },
    { type: "dsh.message", text: "c", usage: { inputTokens: 120, outputTokens: 1, cacheReadInputTokens: 1000 } },
  ].map((event) => JSON.stringify(event)).join("\n"));
  dsh.flush();
  assert.deepEqual(dsh.session(), { turns: 3, toolCalls: 0, requests: 2, contextFirst: 1000, contextMax: 1120, contextLast: 1120, contextSum: 2120, completed: false }, "a message without usage is a turn but not a counted request");
});
