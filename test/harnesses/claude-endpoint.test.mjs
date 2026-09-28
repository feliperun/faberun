import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderResult, providerCommand } from "../../src/harnesses/index.mjs";

// A claude runtime pointed at an Anthropic-compatible endpoint other than
// Anthropic's own (GLM on the Z.ai Coding Plan): split out of harnesses.test.mjs,
// which had reached the 800-line ceiling.

test("a claude runtime with a declared endpoint carries its own endpoint and token", () => {
  const previous = process.env.FABERUN_TEST_ZAI_TOKEN;
  process.env.FABERUN_TEST_ZAI_TOKEN = "zai-token";
  try {
    const glm = {
      harness: "claude",
      model: "glm-5.3",
      config: { base_url: "https://api.z.ai/api/anthropic", "auth_token.env_key": "FABERUN_TEST_ZAI_TOKEN" },
    };
    const before = { ...process.env };
    // The runtime's own `*.env_key` name travels too: the worker allowlist
    // (safe-to-hand-to-a-friend R1) passes every name the runtime declares.
    assert.deepEqual(providerCommand(glm, "review").env, {
      FABERUN_TEST_ZAI_TOKEN: "zai-token",
      ANTHROPIC_AUTH_TOKEN: "zai-token",
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    // A runtime without the config, beside it in the same controller, is untouched.
    const plain = providerCommand({ harness: "claude", model: "claude-sonnet-5" }, "review").env ?? {};
    assert.equal(plain.ANTHROPIC_BASE_URL, undefined, "no endpoint reaches a runtime that declared none");
    assert.equal(plain.ANTHROPIC_AUTH_TOKEN, undefined, "no endpoint token reaches a runtime that declared none");
    assert.deepEqual({ ...process.env }, before, "the controller's own environment is not written");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_TEST_ZAI_TOKEN;
    else process.env.FABERUN_TEST_ZAI_TOKEN = previous;
  }
});

test("a claude runtime refuses a declared endpoint it has no token for", () => {
  delete process.env.FABERUN_TEST_UNSET_TOKEN;
  const endpoint = { base_url: "https://api.z.ai/api/anthropic" };
  assert.throws(
    () => providerCommand({ harness: "claude", model: "glm-5.3", config: endpoint }, "review"),
    (error) => /** @type {{code?: string}} */ (error).code === "auth_token_unresolved",
  );
  assert.throws(
    () => providerCommand({ harness: "claude", model: "glm-5.3", config: { ...endpoint, "auth_token.env_key": "FABERUN_TEST_UNSET_TOKEN" } }, "review"),
    /FABERUN_TEST_UNSET_TOKEN, which is unset/u,
  );
});

test("claude's self-reported cost is dropped for a runtime on another endpoint", () => {
  const stdout = JSON.stringify({ type: "result", result: "ok", session_id: "s", total_cost_usd: 0.13, usage: { input_tokens: 2, output_tokens: 1 } });
  assert.equal(normalizeProviderResult({ harness: "claude", model: "claude-sonnet-5" }, stdout, 0, null).costUsd, 0.13);
  const glm = { harness: "claude", model: "glm-5.3", config: { base_url: "https://api.z.ai/api/anthropic" } };
  assert.equal(normalizeProviderResult(glm, stdout, 0, null).costUsd, null);
});
