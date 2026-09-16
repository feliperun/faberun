import test from "node:test";
import assert from "node:assert/strict";
import { appendSandboxNotice } from "../../src/engine/prompts.mjs";

// The dispatch-time sandbox warning: a worker harness whose adapter declares
// `signalsProcesses === false` cannot run a test that starts and terminates a
// child process, so its prompt names the limitation. Every other declaration
// (true, or the unmeasured null) leaves the prompt untouched.

const PROMPT = "# Node build\n\nDo the work.\n";

test("a dsh runtime gets the sandbox section", () => {
  const prompt = appendSandboxNotice(PROMPT, { harness: "dsh" });
  assert.ok(prompt.startsWith(PROMPT), "the section is appended to the prompt, never a replacement");
  assert.match(prompt, /\n## Sandbox\nYour harness runs you in a sandbox that cannot signal other processes or read the process table\./u);
  assert.match(prompt, /Do not run such tests; the controller runs them after you report\./u);
});

test("a claude runtime keeps its prompt unchanged", () => {
  assert.equal(appendSandboxNotice(PROMPT, { harness: "claude" }), PROMPT);
});

test("an unmeasured harness keeps its prompt unchanged", () => {
  for (const harness of ["codex", "agy", "zcode", "exec-jsonl"]) {
    assert.equal(appendSandboxNotice(PROMPT, { harness }), PROMPT, `${harness} is unmeasured`);
  }
});
