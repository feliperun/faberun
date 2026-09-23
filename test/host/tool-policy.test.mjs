import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookSettings } from "../../src/host/tool-policy-hook.mjs";
import { READ_ONLY_TOOLS, WRITE_SCOPE_FIELDS, bashReadDecision, readThresholdDecision, writeScopeDecision } from "../../src/host/tool-policy-decisions.mjs";
import { DEFAULT_CLAUDE_TOOLS } from "../../src/harnesses/claude/index.mjs";
import { harnessCapabilities, providerCommand } from "../../src/harnesses/index.mjs";

/** @param {number} lines @returns {string} */
const fileWithLines = (lines) => `${Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n")}\n`;

test("tool policy is pure", () => {
  const policy = {
    foregroundOnly: true,
    maxToolOutputBytes: 8192,
    workspace: "/tmp/attempt-workspace",
    writeFiles: ["src/a.mjs", "src/b.mjs"],
    writeRoots: ["src/pkg"],
    maxReadLines: 1500,
  };
  const command1 = hookCommand(policy);
  const command2 = hookCommand(policy);
  assert.equal(command1, command2, "same policy in, same command string out");
  const settings1 = hookSettings(policy);
  const settings2 = hookSettings(policy);
  assert.deepEqual(settings1, settings2, "same policy in, same settings out");
  assert.equal(hookCommand.toString().includes("process.env"), false, "hookCommand never reads process.env");
  assert.equal(hookSettings.toString().includes("process.env"), false, "hookSettings never reads process.env");
  assert.equal(hookCommand.toString().includes("writeFileSync") || hookCommand.toString().includes("Sync("), false, "hookCommand performs no disk writes");
  assert.equal(hookSettings.toString().includes("writeFileSync") || hookSettings.toString().includes("Sync("), false, "hookSettings performs no disk writes");
});

test("tool policy optional capability", () => {
  const runtime = { harness: "exec-jsonl", model: "pi", executable: "pi-wrapper" };
  assert.equal(harnessCapabilities(runtime).toolPolicy, false, "this runtime's surface cannot prove enforcement");
  const policy = {
    foregroundOnly: true,
    maxToolOutputBytes: 8192,
    workspace: "/tmp/attempt-workspace",
    writeFiles: [],
    writeRoots: [],
    maxReadLines: 1500,
  };
  assert.doesNotThrow(() => {
    const command = providerCommand(runtime, "work", { toolPolicy: policy });
    assert.equal(command.args.includes("--settings"), false, "no --settings flag is emitted for an unsupported runtime");
  });
});

test("tool policy write scope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-write-"));
  mkdirSync(join(workspace, "src", "pkg"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), "// a\n");
  writeFileSync(join(workspace, "src", "b.mjs"), "// b\n");
  writeFileSync(join(workspace, "src", "b.ipynb"), "{}");
  writeFileSync(join(workspace, "src", "pkg", "nested.mjs"), "// nested\n");
  writeFileSync(join(workspace, "anywhere.mjs"), "// anywhere\n");
  const policy = { workspace, writeFiles: ["src/a.mjs"], writeRoots: ["src/pkg"] };
  assert.equal(writeScopeDecision(policy, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/a.mjs") } }), null, "a declared write file passes");
  assert.equal(writeScopeDecision(policy, { tool_name: "Edit", tool_input: { file_path: join(workspace, "src/pkg/nested.mjs") } }), null, "a path under a declared write root passes");
  const denial = writeScopeDecision(policy, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/b.mjs") } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /outside the declared write scope/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /src\/a\.mjs/u, "the reason cites the declared paths");
  assert.equal(writeScopeDecision(policy, { tool_name: "NotebookEdit", tool_input: { notebook_path: join(workspace, "src/b.ipynb") } })?.hookSpecificOutput.permissionDecision, "deny", "NotebookEdit reads notebook_path");
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: [], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: join(workspace, "anywhere.mjs") } }),
    null,
    "an empty declared scope is the absence of a scope, not a closed one",
  );
});

test("a declared write root that is a symlink cannot reach outside the workspace", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tool-policy-symlink-"));
  const workspace = join(directory, "workspace");
  const outside = join(directory, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "src", "real-pkg"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  // `src/pkg` is declared as a write root and is a symlink out of the tree.
  // Lexically every path under it looks in scope; on disk every one of them
  // lands in `outside`. Reproduced against the real provider on 2026-09-13:
  // the write succeeded and left no trace inside the workspace at all.
  symlinkSync(outside, join(workspace, "src", "pkg"));
  symlinkSync(join(workspace, "src", "real-pkg"), join(workspace, "src", "linked-pkg"));

  const escaping = { workspace, writeFiles: [], writeRoots: ["src/pkg"] };
  const denial = writeScopeDecision(escaping, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/pkg/new.txt") } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny", "a write through a symlinked root leaves the workspace");

  // A symlink that stays inside the workspace is an ordinary scope: git
  // reports the target's spelling, so both spellings have to pass.
  const internal = { workspace, writeFiles: [], writeRoots: ["src/linked-pkg"] };
  assert.equal(
    writeScopeDecision(internal, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/linked-pkg/new.mjs") } }),
    null,
    "a symlinked root inside the workspace still passes under its declared spelling",
  );
  const byTarget = { workspace, writeFiles: [], writeRoots: ["src/real-pkg"] };
  assert.equal(
    writeScopeDecision(byTarget, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/linked-pkg/new.mjs") } }),
    null,
    "and under the spelling the filesystem actually reaches",
  );

  // A trailing slash is an easy thing to type into a contract and used to
  // deny every write under that root.
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: [], writeRoots: ["src/real-pkg/"] }, { tool_name: "Write", tool_input: { file_path: join(workspace, "src/real-pkg/new.mjs") } }),
    null,
    "a declared root keeps matching with a trailing slash",
  );
});

test("every write-capable tool the adapter offers is judged by the write scope", () => {
  // The hook decides nothing for a tool it does not know, and Claude Code
  // reads silence as an allow. So the offered tool list and the judged tool
  // list have to move together: adding a write-capable tool to the adapter
  // without teaching the hook its path field would open the scope silently.
  for (const tool of DEFAULT_CLAUDE_TOOLS) {
    const judged = Object.hasOwn(WRITE_SCOPE_FIELDS, tool);
    assert.ok(
      judged || READ_ONLY_TOOLS.has(tool),
      `${tool} is offered to workers but is neither judged by WRITE_SCOPE_FIELDS nor declared read-only`,
    );
  }
});

test("tool policy read threshold", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-read-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  const denial = readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /2000 lines/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /1500-line/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /offset and limit/u);
});

test("tool policy targeted read", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-targeted-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large, offset: 1 } }), null, "an explicit offset passes without measuring");
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: large, limit: 200 } }), null, "an explicit limit passes without measuring");
});

test("tool policy small file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-small-"));
  const small = join(workspace, "small.txt");
  writeFileSync(small, fileWithLines(10));
  const policy = { maxReadLines: 1500 };
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: small } }), null, "a file below the threshold passes");
  assert.equal(bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${small}` } }), null, "a small file read through bash passes");
});

test("tool policy bash passthrough", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-bash-"));
  const large = join(workspace, "large.txt");
  writeFileSync(large, fileWithLines(2000));
  const policy = { maxReadLines: 1500 };
  const denial = bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large}` } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny", "a single cat over a large file is denied");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /2000 lines/u);
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `head -n 50 ${large}` } }),
    null,
    "head with an explicit -n limit passes",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `tail -50 ${large}` } }),
    null,
    "tail with a bare numeric limit passes",
  );
  assert.notEqual(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `head ${large}` } }),
    null,
    "head with no limit at all is denied like cat",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} | grep line` } }),
    null,
    "a pipeline passes without analysis",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} > /tmp/copy.txt` } }),
    null,
    "a redirection passes without analysis",
  );
  assert.equal(
    bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${large} && echo done` } }),
    null,
    "a chain passes without analysis",
  );
});

test("tool policy missing path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-missing-"));
  const newFile = join(workspace, "ghost.mjs");
  const outOfScope = join(workspace, "other.mjs");
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: ["ghost.mjs"], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: newFile } }),
    null,
    "a write to a declared but not-yet-created file passes: write scope is judged on the path alone, not on existence",
  );
  assert.equal(
    writeScopeDecision({ workspace, writeFiles: ["ghost.mjs"], writeRoots: [] }, { tool_name: "Write", tool_input: { file_path: outOfScope } })
      ?.hookSpecificOutput.permissionDecision,
    "deny",
    "creating a new file outside the scope is denied: scope membership is a fact about the path, and this is the ordinary violation",
  );
  assert.equal(readThresholdDecision({ maxReadLines: 1500 }, { tool_name: "Read", tool_input: { file_path: newFile } }), null, "a nonexistent read target is never denied: it cannot be measured");
  assert.equal(bashReadDecision({ maxReadLines: 1500 }, { tool_name: "Bash", tool_input: { command: `cat ${newFile}` } }), null, "a nonexistent bash read target is never denied: it cannot be measured");
});

test("tool policy read byte threshold: a file of few long lines is denied by size, with the same retry hint", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-tool-policy-bytes-"));
  const wide = join(workspace, "wide.json");
  writeFileSync(wide, `${"x".repeat(40 * 1024)}\n`);
  const policy = { maxReadLines: 1500, maxReadBytes: 32 * 1024 };
  const denial = readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: wide } });
  assert.equal(denial?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /40961 bytes/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /32768-byte/u);
  assert.match(String(denial?.hookSpecificOutput.permissionDecisionReason), /offset and limit/u);
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: wide, limit: 1 } }), null, "a targeted read passes without measuring");
  const bash = bashReadDecision(policy, { tool_name: "Bash", tool_input: { command: `cat ${wide}` } });
  assert.match(String(bash?.hookSpecificOutput.permissionDecisionReason), /40961 bytes/u, "the same whole-file read through bash is denied by size too");
  const small = join(workspace, "small.json");
  writeFileSync(small, `${"y".repeat(1024)}\n`);
  assert.equal(readThresholdDecision(policy, { tool_name: "Read", tool_input: { file_path: small } }), null, "a small file passes");
  assert.equal(
    readThresholdDecision({ maxReadLines: null, maxReadBytes: 32 * 1024 }, { tool_name: "Read", tool_input: { file_path: wide } })?.hookSpecificOutput.permissionDecision,
    "deny",
    "the byte threshold stands on its own",
  );
  const command = hookCommand({ ...policy, foregroundOnly: false, maxToolOutputBytes: null, workspace, writeFiles: [], writeRoots: [] });
  assert.ok(command.includes("'--max-read-bytes' '32768'"), `the hook command carries the byte threshold: ${command}`);
});
