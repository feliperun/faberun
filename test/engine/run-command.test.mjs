/**
 * A signal death — an attempt killed by a signal the controller itself did not
 * send — is retried once rather than treated as a verdict, because a `kill`
 * from outside the process group is evidence about the sandbox, not about the
 * command under test.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../../src/engine/run-command.mjs";
import { gitArguments } from "../../src/host/platform.mjs";

/**
 * A signal death is a POSIX outcome. Windows reports a process it terminated
 * as an ordinary non-zero exit with no signal attached -- indistinguishable
 * from a command that simply failed -- so there is nothing for the retry to
 * recognize, and a retry that fired on the exit code alone would re-run
 * genuinely failing verifications.
 */
const SIGNAL_DEATH_IS_POSIX = "a terminated process is an ordinary non-zero exit on Windows, with no signal to recognize";

test("a signal death is retried once and passes when the retry passes", { skip: process.platform === "win32" ? SIGNAL_DEATH_IS_POSIX : false }, async () => {
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

test("a second signal death fails the command", { skip: process.platform === "win32" ? SIGNAL_DEATH_IS_POSIX : false }, async () => {
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

test("a read-only refusal outside the worktree is classified as a sandbox-blocked write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-sandbox-blocked-"));
  const denied = join(tmpdir(), "runner-sandbox-cache", "o", "abc");
  const script = join(cwd, "blocked.mjs");
  writeFileSync(
    script,
    `import { writeSync } from "node:fs";\nwriteSync(2, ${JSON.stringify(`error: unable to create '${denied}': ReadOnlyFileSystem\n`)});\nprocess.exit(1);\n`,
  );
  const result = await runVerification([{ argv: [process.execPath, script] }], cwd, { sandboxMode: "workspace-write" });
  assert.equal(result.passed, false);
  assert.deepEqual(
    /** @type {{sandboxBlockedWrite?: unknown}} */ (result.commands[0].attempts[0]).sandboxBlockedWrite,
    {
      classification: "sandbox_blocked_write",
      mode: "workspace-write",
      path: denied,
    },
  );
});

/**
 * Through the product's own argument list, exactly as
 * test/contract/verification.test.mjs initializes its git fixtures.
 * @param {string} directory
 */
function initializeGit(directory) {
  execFileSync("git", gitArguments(["init", "-q", directory]));
  execFileSync("git", gitArguments(["-C", directory, "add", "."]));
  execFileSync("git", gitArguments(["-C", directory, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"]));
}

/**
 * A counted command in a committed fixture: `runs.log` grows once per real
 * execution and is gitignored, so it is invisible to the tree fingerprint and
 * its length is a direct count of how many times the command actually ran.
 * The checkpoint `logs/` directory is gitignored for the same reason.
 *
 * @param {string} label
 * @param {Record<string, string>} [files] extra committed files
 * @param {string} [ignore] the fixture's .gitignore content
 */
function countedFixture(label, files = {}, ignore = "runs.log\nlogs/\n") {
  const cwd = mkdtempSync(join(tmpdir(), label));
  writeFileSync(join(cwd, ".gitignore"), ignore);
  writeFileSync(join(cwd, "counter.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('runs.log', '1');\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  initializeGit(cwd);
  return cwd;
}

/** @param {string} cwd */
function executionCount(cwd) {
  try {
    return readFileSync(join(cwd, "runs.log"), "utf8").length;
  } catch {
    return 0;
  }
}

const COUNTER_ENTRY = { argv: [process.execPath, "counter.mjs"] };

test("a resumed pass serves an unchanged command from its checkpoint instead of re-running it", async () => {
  const cwd = countedFixture("runner-checkpoint-reuse-");
  const logDir = join(cwd, "logs");
  const first = await runVerification([COUNTER_ENTRY], cwd, { logDir });
  assert.equal(first.passed, true);
  assert.equal(executionCount(cwd), 1);
  const second = await runVerification([COUNTER_ENTRY], cwd, { logDir });
  assert.equal(second.passed, true);
  assert.equal(executionCount(cwd), 1, "the checkpoint was served; the command did not run again");
  assert.deepEqual(second.commands[0], first.commands[0], "the served record is the recorded one");
});

test("any difference in tree, command, environment or dependency inputs forces re-execution", async () => {
  // Tree: an edit the fingerprint can see.
  const tree = countedFixture("runner-checkpoint-tree-", { "src.txt": "before" });
  const treeLog = join(tree, "logs");
  await runVerification([COUNTER_ENTRY], tree, { logDir: treeLog });
  writeFileSync(join(tree, "src.txt"), "after");
  await runVerification([COUNTER_ENTRY], tree, { logDir: treeLog });
  assert.equal(executionCount(tree), 2, "a tree difference forces re-execution");

  // Command: same argv, changed declaration.
  const command = countedFixture("runner-checkpoint-command-");
  const commandLog = join(command, "logs");
  await runVerification([COUNTER_ENTRY], command, { logDir: commandLog });
  await runVerification([{ ...COUNTER_ENTRY, timeoutSec: 60 }], command, { logDir: commandLog });
  assert.equal(executionCount(command), 2, "a command difference forces re-execution");

  // Environment: the declared name's value differs between the passes.
  const environment = countedFixture("runner-checkpoint-env-");
  const environmentLog = join(environment, "logs");
  const probe = { ...COUNTER_ENTRY, env: ["FABERUN_CHECKPOINT_PROBE"] };
  process.env.FABERUN_CHECKPOINT_PROBE = "1";
  try {
    await runVerification([probe], environment, { logDir: environmentLog });
    process.env.FABERUN_CHECKPOINT_PROBE = "2";
    await runVerification([probe], environment, { logDir: environmentLog });
  } finally {
    delete process.env.FABERUN_CHECKPOINT_PROBE;
  }
  assert.equal(executionCount(environment), 2, "an environment difference forces re-execution");

  // Dependency inputs: gitignored, so only the dependency hash can see it.
  const dependencies = countedFixture("runner-checkpoint-deps-", { "dep.txt": "one" }, "runs.log\ndep.txt\nlogs/\n");
  const dependenciesLog = join(dependencies, "logs");
  await runVerification([COUNTER_ENTRY], dependencies, { logDir: dependenciesLog, writeFiles: ["dep.txt"] });
  writeFileSync(join(dependencies, "dep.txt"), "two");
  await runVerification([COUNTER_ENTRY], dependencies, { logDir: dependenciesLog, writeFiles: ["dep.txt"] });
  assert.equal(executionCount(dependencies), 2, "a dependency-input difference forces re-execution");
});

test("a committed tree change forces re-execution even when both trees are clean", async () => {
  // d5.1: the dirty fingerprint hashes the difference from HEAD, so two clean
  // trees at different commits shared one identity and the second pass was
  // served the first pass's passing record without running.
  const cwd = mkdtempSync(join(tmpdir(), "runner-checkpoint-committed-"));
  writeFileSync(join(cwd, ".gitignore"), "runs.log\nlogs/\n");
  writeFileSync(join(cwd, "value.txt"), "good");
  writeFileSync(join(cwd, "check.mjs"), "import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync('runs.log', '1');\nprocess.exit(readFileSync('value.txt', 'utf8') === 'good' ? 0 : 1);\n");
  initializeGit(cwd);
  const logDir = join(cwd, "logs");
  const first = await runVerification([{ argv: [process.execPath, "check.mjs"] }], cwd, { logDir });
  assert.equal(first.passed, true);
  assert.equal(executionCount(cwd), 1);
  writeFileSync(join(cwd, "value.txt"), "BROKEN");
  execFileSync("git", gitArguments(["-C", cwd, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qam", "b"]));
  const second = await runVerification([{ argv: [process.execPath, "check.mjs"] }], cwd, { logDir });
  assert.equal(second.passed, false, "the stale pass is not served for the committed tree that breaks it");
  assert.equal(executionCount(cwd), 2, "the committed change forced a real re-run");
});

test("a mutant proof never serves its checkpoint and a corrupted one fails closed", async () => {
  // A planted checkpoint that would otherwise match changes nothing: the
  // mutation entry runs baseline-plus-mutant, and the planted file is left
  // untouched — never served, never refreshed.
  const cwd = countedFixture("runner-checkpoint-mutant-");
  writeFileSync(join(cwd, "module.mjs"), "export const value = 1 === 1;\n");
  writeFileSync(join(cwd, "check.mjs"), "import assert from 'node:assert/strict';\nimport { appendFileSync } from 'node:fs';\nimport { value } from './module.mjs';\nappendFileSync('runs.log', '1');\nassert.equal(value, true);\n");
  initializeGit(cwd);
  const logDir = join(cwd, "logs");
  mkdirSync(logDir, { recursive: true });
  const planted = { identity: "c".repeat(64), result: { passed: true, commands: [{ argv: [process.execPath, "check.mjs"], cwd: ".", timeoutSec: 120, repeat: 1, env: [], passed: true, attempts: [] }] } };
  writeFileSync(join(logDir, "checkpoint-1.json"), JSON.stringify(planted));
  const result = await runVerification([{ argv: [process.execPath, "check.mjs"], mutation: { tier: "high" } }], cwd, { logDir, writeFiles: ["module.mjs"] });
  assert.equal(result.passed, true, "the asserting suite kills the mutant and passes");
  assert.equal(executionCount(cwd), 2, "baseline plus mutant ran; nothing was served from the checkpoint");
  assert.deepEqual(JSON.parse(readFileSync(join(logDir, "checkpoint-1.json"), "utf8")), planted, "no checkpoint is recorded for a mutation entry");

  // Corrupted: the record cannot be parsed, so the command re-runs.
  const corrupt = countedFixture("runner-checkpoint-corrupt-");
  const corruptLog = join(corrupt, "logs");
  mkdirSync(corruptLog, { recursive: true });
  writeFileSync(join(corruptLog, "checkpoint-1.json"), '{"identity":');
  const corruptRun = await runVerification([COUNTER_ENTRY], corrupt, { logDir: corruptLog });
  assert.equal(corruptRun.passed, true);
  assert.equal(executionCount(corrupt), 1, "a corrupted checkpoint fails closed to a real run");
});

test("a checkpoint never serves without a tree fingerprint", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-checkpoint-nogit-"));
  writeFileSync(join(cwd, "counter.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync('runs.log', '1');\n");
  const logDir = join(cwd, "logs");
  await runVerification([COUNTER_ENTRY], cwd, { logDir });
  await runVerification([COUNTER_ENTRY], cwd, { logDir });
  assert.equal(executionCount(cwd), 2, "no git identity, no reuse");
});
