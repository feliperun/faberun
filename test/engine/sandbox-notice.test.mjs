import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSandboxNotice } from "../../src/engine/prompts.mjs";
import { classifySandboxBlockedWrite } from "../../src/engine/run-command.mjs";

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

// The executor side of the same boundary: a toolchain cache outside the
// worktree under `workspace-write` is refused there, and the controller names
// that refusal instead of leaving the operator with a bare filesystem error.
const WORKSPACE = join(tmpdir(), "sandbox-notice-workspace");
const DENIED = join(tmpdir(), "sandbox-notice-cache", "o", "abc");

test("a write blocked by the sandbox names the mode and the path", () => {
  const classification = classifySandboxBlockedWrite({
    text: `error: unable to write '${DENIED}': ReadOnlyFileSystem`,
    workspace: WORKSPACE,
    mode: "workspace-write",
  });
  assert.ok(classification, "a read-only refusal outside the worktree is classified");
  assert.equal(classification.classification, "sandbox_blocked_write");
  assert.equal(classification.mode, "workspace-write");
  assert.equal(classification.path, DENIED);
});

test("a refusal inside the worktree, or under another mode, is not a sandbox block", () => {
  const inside = join(WORKSPACE, "node_modules", ".cache", "x");
  assert.equal(
    classifySandboxBlockedWrite({ text: `'${inside}': ReadOnlyFileSystem`, workspace: WORKSPACE, mode: "workspace-write" }),
    null,
  );
  assert.equal(
    classifySandboxBlockedWrite({ text: `'${DENIED}': ReadOnlyFileSystem`, workspace: WORKSPACE, mode: "danger-full-access" }),
    null,
  );
  assert.equal(
    classifySandboxBlockedWrite({ text: "error: something else failed", workspace: WORKSPACE, mode: "workspace-write" }),
    null,
  );
});
