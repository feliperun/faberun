import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexUsageWindows } from "../../src/harnesses/codex/usage-window.mjs";
import { readUsageWindows, recordInvocationWindows, usageAccountOf } from "../../src/run/usage-windows.mjs";
import { checkUsageWindows } from "../../src/host/preflight.mjs";

const NOW = Date.parse("2026-09-24T19:00:00.000Z");

/** @param {number} weekly @returns {Record<string, string>} a Codex home holding one thread's session file */
function codexHomeWith(weekly) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const date = new Date(NOW);
  const dir = join(home, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const limits = { limit_id: "codex", primary: { used_percent: 47, window_minutes: 300, resets_at: NOW / 1000 + 3600 }, secondary: { used_percent: weekly, window_minutes: 10080, resets_at: NOW / 1000 + 86400 } };
  writeFileSync(join(dir, "rollout-2026-09-24T16-22-41-thread-1.jsonl"), [
    JSON.stringify({ type: "session_meta" }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: limits } }),
  ].join("\n") + "\n");
  return { CODEX_HOME: home };
}

// Measured 2026-09-24: `codex exec --json` streams no limits, while the
// thread's session file carries them on every turn; the week went from 86% to
// 94% in one afternoon and nothing read it.
test("the Codex account's usage windows are read after an invocation and warned about before the next launch", () => {
  const env = codexHomeWith(94);
  assert.deepEqual(codexUsageWindows("thread-1", { env, now: NOW }).map((window) => [window.window, window.usedPercent]), [["five_hour", 47], ["seven_day", 94]]);
  recordInvocationWindows({ harness: "codex" }, "thread-1", { env, now: NOW });
  const account = /** @type {string} */ (usageAccountOf({ harness: "codex" }, env));
  assert.equal(readUsageWindows(account, NOW).length, 2);
  const runtimes = new Map([["codex-sol", { runtime: /** @type {any} */ ({ harness: "codex", model: "gpt-6-sol" }), requiredCapabilitySets: [], routed: true }]]);
  const [warning] = checkUsageWindows(runtimes, env, NOW);
  assert.equal(warning.ok, false);
  assert.equal(warning.advisory, true, "at 90% or more the launch is warned, not blocked");
  assert.match(warning.detail, /seven_day 94% used/u);

  const full = codexHomeWith(100);
  recordInvocationWindows({ harness: "codex" }, "thread-1", { env: full, now: NOW });
  const [block] = checkUsageWindows(runtimes, full, NOW);
  assert.equal(block.advisory, false, "a spent window blocks the dispatch");
  assert.match(block.detail, /every call would be refused/u);
  assert.deepEqual(checkUsageWindows(runtimes, full, NOW + 2 * 86400 * 1000), [], "after the reset nothing is known, so nothing is said");
  assert.equal(usageAccountOf({ harness: "zcode" }, env), null, "a harness that reports no windows adds no check");
});
