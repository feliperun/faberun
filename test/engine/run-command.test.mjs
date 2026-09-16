/**
 * A signal death — an attempt killed by a signal the controller itself did not
 * send — is retried once rather than treated as a verdict, because a `kill`
 * from outside the process group is evidence about the sandbox, not about the
 * command under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../../src/engine/run-command.mjs";

test("a signal death is retried once and passes when the retry passes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-signal-death-"));
  const marker = join(cwd, "marker");
  const script = join(cwd, "once-killed.mjs");
  writeFileSync(
    script,
    `import { existsSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(marker)})) process.exit(0);
writeFileSync(${JSON.stringify(marker)}, "1");
process.kill(process.pid, "SIGKILL");
`,
  );
  const result = await runVerification([{ argv: [process.execPath, script] }], cwd);
  assert.equal(result.passed, true);
  const attempts = result.commands[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].signalDeath, true);
  assert.equal(attempts[0].signal, "SIGKILL");
  assert.equal(attempts[1].passed, true);
  assert.ok(existsSync(marker));
});

test("a second signal death fails the command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-signal-death-twice-"));
  const script = join(cwd, "always-killed.mjs");
  writeFileSync(script, `process.kill(process.pid, "SIGKILL");\n`);
  const result = await runVerification([{ argv: [process.execPath, script] }], cwd);
  assert.equal(result.passed, false);
  const attempts = result.commands[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].signalDeath, true);
  assert.equal(attempts[1].signal, "SIGKILL");
  assert.equal(attempts[1].passed, false);
  assert.equal(attempts[1].signalDeath, undefined);
});
