import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { exhaustedUntilOf, normalizeProviderAvailability, normalizeProviderResult } from "../../src/harnesses/index.mjs";

// How a Claude stream that ended short of an answer is classified: the
// controller's own turn cap, the subscription's session window, and the
// account's spend limit. Split from normalize.test.mjs when it passed the
// 800-line ceiling.

test("a Claude turn stopped by --max-turns is turn_limit, the controller's own cap, not a provider error", () => {
  const stdout = [
    { type: "system", subtype: "init", session_id: "s-1" },
    { type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 10 }, content: [] } },
    { type: "result", subtype: "error_max_turns", is_error: true, session_id: "s-1", num_turns: 2, usage: { input_tokens: 9, cache_read_input_tokens: 30 } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const envelope = normalizeProviderResult({ harness: "claude" }, stdout, 0, null);
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.error?.code, "turn_limit");
  assert.equal(envelope.continuationId, "s-1", "the session id survives for the retry's own decision");
  assert.deepEqual(envelope.usage, { inputTokens: 9, outputTokens: null, cacheReadInputTokens: 30 }, "the spend of the capped attempt is kept");
});

// Measured 2026-09-20 in the orchestration-arms campaign: the Claude
// subscription's five-hour window answered "You've hit your session limit ·
// resets 6:40pm (America/Sao_Paulo)", the stream settled as provider_error,
// and two faberun nodes burnt both attempts inside a minute instead of holding
// until the reset. The sentence names a wall-clock time and a zone, no date.
test("the Claude subscription's session limit is exhaustion, and its wall-clock reset becomes an instant", () => {
  const text = "You've hit your session limit · resets 6:40pm (America/Sao_Paulo)";
  const stream = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } });
  const envelope = normalizeProviderResult("claude", stream, 1, null);
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.error?.code, "quota_exhausted");
  // 17:00 in São Paulo (UTC-3): the reset is later the same day.
  assert.equal(exhaustedUntilOf(envelope, Date.parse("2026-09-20T20:00:00Z")), "2026-09-20T21:40:00.000Z");
  // 19:00 in São Paulo: the named time has passed, so it is tomorrow's.
  assert.equal(exhaustedUntilOf(envelope, Date.parse("2026-09-20T22:00:00Z")), "2026-09-21T21:40:00.000Z");
  const availability = normalizeProviderAvailability("claude", envelope);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, "quota_exhausted");
  assert.match(String(availability.exhaustedUntil), /^\d{4}-\d{2}-\d{2}T\d{2}:40:00\.000Z$/u, "a reset instant is derived even when read against the real clock");
  // A time in the morning and an unknown zone.
  assert.equal(exhaustedUntilOf({ error: { code: "quota_exhausted", message: "usage limit reached, resets 12:05am (UTC)" } }, Date.parse("2026-09-20T20:00:00Z")), "2026-09-21T00:05:00.000Z");
  assert.equal(exhaustedUntilOf({ error: { code: "quota_exhausted", message: "usage limit reached, resets 6:40pm (Mars/Olympus_Mons)" } }, Date.parse("2026-09-20T20:00:00Z")), null, "an unknown zone names no instant, and the failover edge is taken instead");
});

// Measured 2026-09-25 on the 3a gate plan: claude-fable-5-1 answered "You've
// hit your monthly spend limit", the stream settled as provider_error, and the
// planner's reviewer list never moved to its next entry.
test("the account's monthly spend limit is exhaustion with no reset, like an insufficient balance", () => {
  const text = "You've hit your monthly spend limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  const stream = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } });
  const envelope = normalizeProviderResult("claude", stream, 1, null);
  assert.equal(envelope.status, "exhausted");
  const availability = normalizeProviderAvailability("claude", envelope);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, "insufficient_balance");
  assert.equal(availability.exhaustedUntil, null);
});
