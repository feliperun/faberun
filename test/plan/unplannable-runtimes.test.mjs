import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { refuseUnplannableRuntimes } from "../../src/plan/preflight.mjs";

// Measured 2026-09-24, choose-the-judges R5: both choices surfaced only at
// freeze, after four review rounds.
test("a runtime choice no frozen contract could carry is refused before the draft", () => {
  const runtimes = {
    "codex-luna": { harness: "codex", model: "gpt-5.6-luna", vendor: "openai", sandbox: "danger-full-access", fallback: "dsh-deepseek" },
    "dsh-deepseek": { harness: "dsh", model: "deepseek-flash", vendor: "deepseek", sandbox: "danger-full-access" },
    "codex-astra": { harness: "codex", model: "gpt-6-astra", vendor: "openai", sandbox: "read-only" },
    "claude-opus": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    "claude-opus-worker": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic", permissionMode: "bypassPermissions" },
    "dsh-judge": { harness: "dsh", model: "deepseek-v4-pro", vendor: "deepseek", sandbox: "read-only" },
  };
  assert.doesNotThrow(() => refuseUnplannableRuntimes(runtimes, { worker: "codex-luna", judge: "claude-opus" }, "implementation"), "the campaign-one choice is plannable");
  assert.throws(() => refuseUnplannableRuntimes(runtimes, { worker: "codex-luna", judge: "codex-astra" }, "implementation"), /shares vendor openai/u, "a judge of the worker's vendor never routes");
  assert.throws(() => refuseUnplannableRuntimes(runtimes, { worker: "codex-luna", judge: "dsh-judge" }, "implementation"), /shares vendor deepseek/u, "nor one of its fallback's vendor");
  assert.throws(() => refuseUnplannableRuntimes(runtimes, { worker: "claude-opus", judge: "codex-astra" }, "implementation"), /cannot run the verification/u, "a worker that cannot run commands cannot carry an implementation node");
  assert.doesNotThrow(() => refuseUnplannableRuntimes(runtimes, { worker: "claude-opus", judge: "codex-astra" }, "exploratory"), "an exploratory package carries no verification of its own");
  assert.doesNotThrow(() => refuseUnplannableRuntimes(runtimes, { worker: "claude-opus-worker", judge: "codex-astra" }, "implementation"));
  assert.doesNotThrow(() => refuseUnplannableRuntimes(runtimes, {}, "implementation"), "discovery decides when the operator names nothing");
});
