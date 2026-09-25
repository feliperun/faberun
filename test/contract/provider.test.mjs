import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateContract } from "../../src/contract/index.mjs";
import { canonicalProvider } from "../../src/contract/provider.mjs";
import { validateRuntime } from "../../src/contract/runtime.mjs";
import { packet, writeFixture } from "./helpers.mjs";
import { readFileSync } from "node:fs";

// R18's first half: the vendor rule compares the canonical provider derived
// from a runtime's harness, model and route, never the free-text `vendor`
// label a contract happens to declare.

test("the vendor rule compares the provider derived from harness and model", () => {
  // (1) The derivation table: a route wins over the model's family, which
  // wins over the harness default; replay and exec-jsonl derive none, so the
  // declared vendor stands for them exactly as it did before this rule.
  assert.equal(
    canonicalProvider({ harness: "codex", model: "deepseek-v4-flash", config: { model_provider: "deepseek" } }),
    "deepseek",
    "a codex route to deepseek outranks the gpt-* family the model id would otherwise suggest",
  );
  assert.equal(
    canonicalProvider({ harness: "dsh", model: "deepseek-flash", config: { provider: "deepseek-official" } }),
    "deepseek",
    "dsh's own route key names the provider through a '-official' suffix",
  );
  assert.equal(
    canonicalProvider({ harness: "agy", model: "claude-sonnet-4-6" }),
    "anthropic",
    "the model's family outranks agy's own harness default of google",
  );
  assert.equal(canonicalProvider({ harness: "claude", model: "opus" }), "anthropic", "a bare family word, not just a claude- prefix, is recognized");
  assert.equal(canonicalProvider({ harness: "codex", model: "unrecognized-model-id" }), "openai", "codex's harness default applies when the model names no family");
  assert.equal(canonicalProvider({ harness: "zcode", model: "glm-5.3-flash" }), "zhipu");
  assert.equal(canonicalProvider({ harness: "replay", model: "anything" }), null, "replay stands in for whatever the recording is: it derives no provider");
  assert.equal(canonicalProvider({ harness: "exec-jsonl", model: "anything" }), null, "exec-jsonl stands in for whatever the exec'd binary is: it derives no provider");

  // A replay or exec-jsonl runtime's declared vendor stands exactly as before:
  // validateRuntime accepts it outright since there is no derived provider to
  // contradict.
  assert.equal(validateRuntime("replay-worker", { harness: "replay", model: "anything", vendor: "recorded-vendor" }).vendor, "recorded-vendor");

  // (2) A declared vendor equal to the derived provider is accepted, and the
  // validated runtime's vendor becomes the derived provider.
  assert.equal(validateRuntime("sol", { harness: "codex", model: "gpt-5.6-sol", vendor: "openai" }).vendor, "openai");
  assert.equal(validateRuntime("solo-deepseek", { harness: "codex", model: "gpt-5.6-sol", config: { model_provider: "deepseek" }, vendor: "deepseek" }).vendor, "deepseek");

  // A declared vendor that contradicts the derived provider is refused,
  // naming both.
  assert.throws(
    () => validateRuntime("sol", { harness: "codex", model: "gpt-5.6-sol", vendor: "openai-sol" }),
    /runtime sol declares vendor openai-sol but codex gpt-5\.6-sol is provider openai/u,
  );

  // (3) validateContract refuses a codex gpt worker judged by a codex gpt
  // runtime labelled differently: the old free-text rule would have accepted
  // this pair as cross-vendor, and the fix must not.
  const { path } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "gpt-5.6", executable: "/nonexistent/codex" },
      judge: { harness: "codex", model: "gpt-5.6-sol", vendor: "openai-judge", executable: "/nonexistent/codex" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /runtime judge declares vendor openai-judge but codex gpt-5\.6-sol is provider openai/u,
  );
});
