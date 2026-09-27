import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderAvailability, normalizeProviderResult } from "../../src/harnesses/index.mjs";
import { classifyTransition, quotaResetSchedule } from "../../src/engine/backoff.mjs";

// R33: a Claude session limit names its reset time and the zone it is in, not
// a structured instant. The envelope must carry that instant so the node's wait
// decision holds on the runtime instead of burning a failover hop inside the
// window. Measured 2026-09-25: three nodes exhausted on "You've hit your
// session limit · resets 2:40pm (America/Sao_Paulo)".

test("a session limit that names its reset time waits for it", () => {
  const text = "You've hit your session limit · resets 6:40pm (America/Sao_Paulo)";
  const stream = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: text,
    session_id: "session-limit",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const envelope = normalizeProviderResult("claude", stream, 1, null);
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.error?.code, "quota_exhausted");

  const resetAt = /** @type {{resetAt?: string}} */ (envelope).resetAt;
  assert.equal(typeof resetAt, "string", "the adapter puts the named reset on the envelope");
  const at = new Date(String(resetAt));
  // 6:40pm in America/Sao_Paulo (UTC-3) is 21:40 UTC. The sentence names no
  // date, so the next occurrence of that wall clock is the reset.
  assert.equal(at.getUTCHours(), 21);
  assert.equal(at.getUTCMinutes(), 40);

  // Before the reset the node waits on the runtime it already warmed, spending
  // no failover hop; the message alone is enough to derive the wait.
  const before = Date.parse(String(resetAt)) - 60_000;
  assert.deepEqual(quotaResetSchedule(envelope, null, before), { kind: "reset", at: resetAt });
  const transition = classifyTransition(envelope, { now: before, deadline: null });
  assert.equal(transition.kind, "reset");
  assert.equal(transition.reason, "quota_reset");

  // Once the named instant passes, the reset buys no wait and the edge is taken.
  assert.deepEqual(quotaResetSchedule(envelope, null, Date.parse(String(resetAt)) + 1), { kind: "failover" });

  // The availability classification reads the same instant from the envelope.
  assert.equal(normalizeProviderAvailability("claude", envelope).exhaustedUntil, resetAt);
});
