import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { JUDGE_SCHEMA, parseJudge, retryPrompt } from "../../src/engine/prompts.mjs";
import { JUDGE_ENVELOPE_REASON, JUDGE_FINDING_ENVELOPE_REASON, JUDGE_LIMITS } from "../../src/contract/judge-envelope.mjs";
import { judgeReaskInstruction } from "../../src/contract/review-modes.mjs";
import { mechanicalVerdict } from "../../src/engine/judge-gate.mjs";
import { validateVerificationCommands } from "../../src/contract/verification.mjs";
import { parseDiscoveryResult, parseWorkerResult } from "../../src/contract/worker-result.mjs";
import { runVerification } from "../../src/engine/run-command.mjs";
import { captureWorkspaceScope, captureWorkspaceSnapshot, compareWorkspaceSnapshot, validateWorkspaceScopeBoundary } from "../../src/repo/workspace.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { gitArguments } from "../../src/host/platform.mjs";

/** @param {string} directory */
function initializeGit(directory) {
  // Through the product's own argument list: one fixture here is deliberately
  // deeper than 260 characters, and git refuses to open such a directory
  // unless `core.longpaths` is on -- which is what gitArguments turns on for
  // Windows, alongside the fsmonitor daemon it keeps off everywhere.
  execFileSync("git", gitArguments(["init", "-q", directory]));
  execFileSync("git", gitArguments(["-C", directory, "add", "."]));
  execFileSync("git", gitArguments(["-C", directory, "-c", "commit.gpgSign=false", "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-qm", "fixture"]));
}

test("worker result accepts done and blocked_context without prose", () => {
  assert.equal(parseWorkerResult(JSON.stringify({
    status: "done", summary: "complete", verification: [], artifacts: [], missingContext: [],
  })).status, "done");
  assert.equal(parseWorkerResult(JSON.stringify({
    status: "blocked_context", summary: "missing input", verification: [], artifacts: [], missingContext: ["missing.txt"],
  })).status, "blocked_context");
  // Unknown provider-added fields are dropped; the normalized pick keeps only
  // the canonical protocol fields.
  assert.deepEqual(parseWorkerResult(JSON.stringify({
    status: "done", summary: "complete", verification: [], artifacts: [], missingContext: [], confidence: 0.9,
  })), {
    status: "done", summary: "complete", verification: [], artifacts: [], missingContext: [],
  });
  assert.throws(() => parseWorkerResult("worker complete"), /invalid JSON/u);
});

test("verification repeats commands and captures bounded evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-repeat-"));
  const logDir = join(cwd, "logs");
  const result = await runVerification([{ argv: [process.execPath, "-e", "console.log('ok')"], repeat: 2 }], cwd, { logDir });
  assert.equal(result.passed, true);
  assert.equal(result.commands[0].attempts.length, 2);
  assert.equal(result.commands[0].attempts[0].exitCode, 0);
  const logged = JSON.parse(readFileSync(join(logDir, "verification-1.json"), "utf8"));
  assert.equal(logged.passed, true);
  assert.equal(logged.commands.length, 1);
  assert.equal(logged.commands[0].attempts.length, 2);
  assert.equal(logged.commands[0].attempts[0].exitCode, 0);
});

test("verification reports timeout and nonzero exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-timeout-"));
  const result = await runVerification([
    { argv: [process.execPath, "-e", "process.exit(3)"], repeat: 2 },
    { argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], timeoutSec: 0.05 },
  ], cwd);
  assert.equal(result.passed, false);
  assert.equal(result.commands[0].attempts.length, 2);
  assert.equal(result.commands[0].attempts[0].exitCode, 3);
  assert.equal(result.commands[1].attempts[0].timedOut, true);
});

test("verification rejects legacy shell strings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-contract-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const contract = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, id: "strict-verification", campaignId: "strict",
    goal: "verify", cwd: ".", runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { harness: "codex", model: "test", executable: "/nonexistent/codex" } },
    nodes: [{ id: "build", type: "backend", phase: "verification", taskPacket: {
      mode: "execution", objective: "verify", instructions: ["verify"], readFiles: ["README.md"], writeFiles: ["README.md"],
      symbols: [], decisions: [], nonGoals: [], verification: ["node --check README.md"],
    }, gate: false }],
  };
  const path = join(cwd, "contract.json");
  writeFileSync(path, JSON.stringify(contract));
  assert.throws(() => validateContract(contract, path), /argv command object/u);
});

test("a mutation entry declares a risk tier and nothing else", () => {
  // The kill fraction is `MUTATION_TIERS`' property, not the entry author's
  // number: a hand-picked `threshold` is exactly the field the tier replaced.
  const [entry] = validateVerificationCommands([{ argv: [process.execPath], mutation: { tier: "high" } }]);
  assert.equal(entry.mutation?.tier, "high");
  for (const bad of [{}, { tier: "extreme" }, { tier: 1 }, { threshold: 0.5 }, { tier: "high", threshold: 0.5 }]) {
    assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: bad }]), /verification\[0\]\.mutation/u);
  }
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], mutation: true }]), /verification\[0\]\.mutation must be an object/u);
});

test("writeFiles close to the line ceiling warns, one with room does not, and both still validate", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-line-budget-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  // 751 lines (750 newline-terminated) leaves 49 lines of margin, inside the
  // warning band; 501 lines leaves 299, well outside it.
  writeFileSync(join(cwd, "tight.mjs"), "// line\n".repeat(750));
  writeFileSync(join(cwd, "roomy.mjs"), "// line\n".repeat(500));
  const base = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, id: "line-budget", campaignId: "line-budget-campaign",
    goal: "verify", cwd: ".", runtimeDefaults: { worker: "worker", judge: "worker" },
    runtimes: { worker: { harness: "codex", model: "test", executable: "/nonexistent/codex" } },
  };
  const path = join(cwd, "contract.json");
  /** @param {string} file */
  const nodeWriting = (file) => ([{ id: "build", type: "backend", phase: "verification", taskPacket: {
    mode: "execution", objective: "verify", instructions: ["verify"], readFiles: ["README.md"], writeFiles: [file],
    symbols: [], decisions: [], nonGoals: [], verification: [],
  }, gate: false }]);

  const tight = validateContract({ ...base, nodes: nodeWriting("tight.mjs") }, path);
  assert.equal(tight.id, "line-budget", "the contract still validates");
  assert.ok(
    tight.warnings.some((warning) => warning.includes("tight.mjs") && warning.includes("800-line ceiling")),
    `expected a line-budget warning, got: ${JSON.stringify(tight.warnings)}`,
  );

  const roomy = validateContract({ ...base, nodes: nodeWriting("roomy.mjs") }, path);
  assert.equal(roomy.id, "line-budget", "the contract still validates");
  assert.ok(
    !roomy.warnings.some((warning) => warning.includes("800-line ceiling")),
    `expected no line-budget warning, got: ${JSON.stringify(roomy.warnings)}`,
  );
});

test("discovery and verification aggregate prompt limits fail before spawn", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-oversized-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const base = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, id: "oversized", campaignId: "oversized-campaign", goal: "test", cwd: ".",
    runtimeDefaults: { worker: "worker", judge: "worker" }, runtimes: { worker: { harness: "codex", model: "test", executable: "/nonexistent/codex" } },
  };
  assert.throws(() => validateContract({
    ...base,
    nodes: [{ id: "discover", type: "backend", phase: "discovery", taskPacket: {
      mode: "discovery", objective: "x".repeat(70 * 1024), instructions: ["inspect"], readFiles: [], writeFiles: [], symbols: [], decisions: [], nonGoals: [], verification: [],
    } }],
  }, join(cwd, "contract.json")), /prompt exceeds 65536 bytes/u);
  assert.throws(() => validateVerificationCommands([{ argv: Array.from({ length: 32 }, () => "x".repeat(1100)) }]), /aggregate byte limit/u);
  assert.throws(() => validateVerificationCommands([{ argv: [process.execPath], env: Array.from({ length: 2000 }, (_, index) => `ENV_${index}`) }]), /aggregate byte limit/u);
  const retry = retryPrompt({ prompt: "# closed\n" }, {
    summary: "s".repeat(4096),
    findings: [{ severity: "critical", description: "d".repeat(4096), evidence: "e".repeat(512 * 1024) }],
  });
  assert.ok(Buffer.byteLength(retry, "utf8") <= 64 * 1024);
  assert.ok(!retry.includes("e".repeat(10000)));
});

test("worker result and verification output stay within hard caps", async () => {
  const oversized = JSON.stringify({
    status: "done", summary: "x".repeat(4097), verification: [], artifacts: [], missingContext: [],
  });
  assert.throws(() => parseWorkerResult(oversized), /summary exceeds/u);
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-cap-"));
  const result = await runVerification([{ argv: [process.execPath, "-e", "console.log('x'.repeat(100000))"] }], cwd);
  assert.equal(result.passed, true);
  assert.ok(Buffer.byteLength(result.commands[0].attempts[0].stdout, "utf8") <= 16 * 1024);
});

test("a verdict rejected by its envelope is re-asked with the size rule", () => {
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "s".repeat(JUDGE_LIMITS.summaryBytes + 1), findings: [],
  })), new RegExp(JUDGE_ENVELOPE_REASON, "u"));
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e".repeat(JUDGE_LIMITS.evidenceBytes + 1) }],
  })), new RegExp(JUDGE_FINDING_ENVELOPE_REASON, "u"));
  // The defect is size, not shape: a judge told it "did not carry exactly one
  // usable verdict" rewrites the whole arbitration and overshoots again.
  for (const reason of [JUDGE_ENVELOPE_REASON, JUDGE_FINDING_ENVELOPE_REASON]) {
    const instruction = judgeReaskInstruction(reason);
    assert.match(instruction, /envelope/u);
    assert.match(instruction, /re-issue the same verdict/u);
    assert.doesNotMatch(instruction, /did not carry exactly one usable verdict/u);
  }
});

test("the judge schema asks for every field and the parser forgives a missing findings", () => {
  // Two providers with opposite demands, learned one campaign apart.
  // OpenAI rejects the schema itself (400 invalid_json_schema) unless
  // `required` lists every key in `properties`, so dropping `findings` from
  // `required` took every codex judge down. Claude occasionally omits the
  // empty array and its CLI then refuses a verdict that had already been
  // reached. So: the schema stays strict for the provider that checks it,
  // and the parser stays lenient for the model that forgets.
  assert.deepEqual(
    JUDGE_SCHEMA.required.slice().sort(),
    Object.keys(JUDGE_SCHEMA.properties).sort(),
    "OpenAI structured output rejects a schema whose required omits any property",
  );
  const clean = parseJudge(JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "all items hold" }));
  assert.equal(clean.verdict, "pass");
  assert.deepEqual(clean.findings, []);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "s", findings: "none",
  })), /judge findings must be an array/u);
});

test("judge results are bounded, consistent, and require concrete evidence", () => {
  assert.equal(parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "ok", findings: [],
  })).verdict, "pass");
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s".repeat(4097), findings: [],
  })), /judge result exceeds limits/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e".repeat(4097) }],
  })), /judge finding exceeds limits/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "minor", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e" }],
  })), /maxSeverity does not match/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "none", summary: "s", findings: [],
  })), /verdict and maxSeverity are inconsistent/u);
  assert.throws(() => parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: Array.from({ length: 33 }, () => ({ severity: "minor", description: "d", evidence: "e" })),
  })), /judge result exceeds limits/u);
  // Unknown provider-added fields (toolAction, confidence, …) are dropped at
  // the LLM boundary instead of failing the node; the verdict stays canonical.
  assert.deepEqual(parseJudge(JSON.stringify({
    verdict: "pass", maxSeverity: "none", summary: "ok", findings: [], toolAction: { type: "none" },
  })), { verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] });
  assert.deepEqual(parseJudge(JSON.stringify({
    verdict: "fail", maxSeverity: "critical", summary: "s",
    findings: [{ severity: "critical", description: "d", evidence: "e", confidence: 0.9 }],
  })).findings, [{ severity: "critical", description: "d", evidence: "e" }]);
  assert.throws(() => parseJudge(JSON.stringify(["pass", "none", "ok", []])), /judge result must be an object/u);
});

test("verification passes only the declared controller environment names", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-env-"));
  const previous = process.env.FABERUN_TEST_ALLOWED;
  const secret = process.env.FABERUN_TEST_FORBIDDEN;
  process.env.FABERUN_TEST_ALLOWED = "controller-value";
  process.env.FABERUN_TEST_FORBIDDEN = "must-not-leak";
  try {
    const result = await runVerification([{
      argv: [process.execPath, "-e", "process.exit(process.env.FABERUN_TEST_ALLOWED === 'controller-value' && !process.env.FABERUN_TEST_FORBIDDEN ? 0 : 1)"],
      env: ["FABERUN_TEST_ALLOWED"],
    }], cwd);
    assert.equal(result.passed, true);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_TEST_ALLOWED;
    else process.env.FABERUN_TEST_ALLOWED = previous;
    if (secret === undefined) delete process.env.FABERUN_TEST_FORBIDDEN;
    else process.env.FABERUN_TEST_FORBIDDEN = secret;
  }
});

test("verification attempt identity is published before release and completes exactly once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-identity-"));
  /** @type {Array<{phase: string} & Record<string, unknown>>} */
  const events = [];
  const result = await runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], repeat: 1 }], cwd, {
    onAttemptStart: (attempt) => events.push({ phase: "start", ...attempt }),
    onAttemptSpawn: (attempt) => events.push({ phase: "spawn", ...attempt }),
    onAttemptComplete: (attempt) => events.push({ phase: "complete", ...attempt }),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(events.map((event) => event.phase), ["start", "spawn", "complete"]);
  assert.equal(events[0].invocationId, events[1].invocationId);
  assert.equal(events[1].invocationId, events[2].invocationId);
  assert.ok(Number.isInteger(events[1].pid));
  // A process group is a POSIX fact. On Windows the attempt carries none and
  // the kill path reaches the tree through the pid instead, so assert the
  // identity this host actually publishes rather than a stand-in for it.
  // guard-exempt: host-layout which identity is published is the fact under test
  assert.equal(events[1].processGroupId, process.platform === "win32" ? null : events[1].pid);
  assert.equal(typeof events[1].deadlineAt, "string");
  assert.equal(events[2].status, "closed");
});

test("verification rejects parent traversal and runtime cwd symlink escape", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-cwd-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-verification-outside-"));
  symlinkSync(outside, join(cwd, "escape"));
  await assert.rejects(() => runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: "../" }], cwd), /relative path without \.\./u);
  await assert.rejects(() => runVerification([{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: "escape" }], cwd), /escapes workspace/u);
});

test("workspace snapshots fail closed and hash the complete file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-snapshot-"));
  const large = join(cwd, "large.bin");
  writeFileSync(large, Buffer.alloc(192 * 1024, "a"));
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  const changed = Buffer.alloc(1, "b");
  writeFileSync(large, Buffer.concat([Buffer.alloc(96 * 1024, "a"), changed, Buffer.alloc(96 * 1024 - 1, "a")]));
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: ["large.bin"], roots: [] });
  assert.deepEqual(comparison.unexpectedPaths, []);
  assert.deepEqual(comparison.changedPaths, ["large.bin"]);

  const escape = mkdtempSync(join(tmpdir(), "runner-verification-symlink-"));
  symlinkSync(outsidePath(), join(escape, "outward"));
  initializeGit(escape);
  assert.throws(() => captureWorkspaceSnapshot(escape), /symlink escapes workspace/u);

  const many = mkdtempSync(join(tmpdir(), "runner-verification-many-"));
  for (let index = 0; index < 4097; index += 1) writeFileSync(join(many, `f-${index}`), "x");
  initializeGit(many);
  assert.throws(() => captureWorkspaceSnapshot(many), /exceeds 4096 entries/u);
});

test("workspace snapshots follow Git visibility and retain tracked runtime files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-runtime-scratch-"));
  writeFileSync(join(cwd, ".gitignore"), ".claude/\n.codex/\nnode_modules/\n.runs/\n");
  writeFileSync(join(cwd, "src.txt"), "before");
  initializeGit(cwd);
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "scratch.lock"), "runtime debris");
  writeFileSync(join(cwd, ".claude", "tracked.txt"), "tracked before");
  execFileSync("git", ["-C", cwd, "add", "-f", ".claude/tracked.txt"]);
  const before = captureWorkspaceSnapshot(cwd);
  // Runtime-debris directory names to fabricate, not a path composition -- not
  // a resolver call site.
  for (const directory of [".codex", ".runs", "node_modules"]) {
    mkdirSync(join(cwd, directory));
    writeFileSync(join(cwd, directory, "scratch.lock"), "runtime debris");
  }
  writeFileSync(join(cwd, ".claude", "tracked.txt"), "tracked after");
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [".claude/tracked.txt"], roots: [] });
  assert.deepEqual(comparison.changedPaths, [".claude/tracked.txt"]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("workspace snapshots use nested ignore rules, negation, and tracked ignored files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-gitignore-"));
  writeFileSync(join(cwd, ".gitignore"), "ignored/*\n!ignored/keep.txt\ntracked.log\n");
  mkdirSync(join(cwd, "ignored"));
  writeFileSync(join(cwd, "ignored", "drop.txt"), "ignored");
  writeFileSync(join(cwd, "ignored", "keep.txt"), "kept");
  mkdirSync(join(cwd, "nested"));
  writeFileSync(join(cwd, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
  writeFileSync(join(cwd, "nested", "drop.tmp"), "ignored");
  writeFileSync(join(cwd, "nested", "keep.tmp"), "kept");
  writeFileSync(join(cwd, "tracked.log"), "tracked despite ignore");
  initializeGit(cwd);
  execFileSync("git", ["-C", cwd, "add", "-f", "tracked.log"]);

  const paths = captureWorkspaceSnapshot(cwd).entries.map((entry) => entry.path);
  assert.ok(paths.includes("ignored/keep.txt"));
  assert.ok(paths.includes("nested/keep.tmp"));
  assert.ok(paths.includes("tracked.log"));
  assert.ok(!paths.includes("ignored/drop.txt"));
  assert.ok(!paths.includes("nested/drop.tmp"));
});

test("workspace snapshots apply optional .faberunignore rules", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-faberunignore-"));
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  writeFileSync(join(cwd, ".faberunignore"), "generated/*\n!generated/keep.txt\n");
  mkdirSync(join(cwd, "generated"));
  writeFileSync(join(cwd, "generated", "drop.txt"), "ignored");
  writeFileSync(join(cwd, "generated", "keep.txt"), "kept");

  const paths = captureWorkspaceSnapshot(cwd).entries.map((entry) => entry.path);
  assert.ok(paths.includes(".faberunignore"));
  assert.ok(paths.includes("generated/keep.txt"));
  assert.ok(!paths.includes("generated/drop.txt"));
});

test("scope roots resolve contained symlink aliases to Git paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-symlink-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "file.txt"), "before");
  symlinkSync("src", join(cwd, "alias"));
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, "src", "file.txt"), "after");

  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [], roots: ["alias"] });
  assert.deepEqual(comparison.changedPaths, ["src/file.txt"]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("ignore-source changes fail closed before mutable rules can hide files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-ignore-source-change-"));
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, ".faberunignore"), "*\n");
  writeFileSync(join(cwd, "undeclared.txt"), "hidden");

  assert.throws(
    () => compareWorkspaceSnapshot(before, cwd, { files: [".faberunignore"], roots: [] }),
    /ignore sources changed/u,
  );
});

test("linked-worktree Git identity changes fail closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "runner-verification-linked-worktree-"));
  const repository = join(parent, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "read");
  initializeGit(repository);
  const first = join(parent, "first");
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "--detach", first]);

  const before = captureWorkspaceSnapshot(first);
  assert.ok(before.ignoreSources.some((entry) => entry.path === ".git"));
  assert.ok(before.ignoreSources.some((entry) => entry.path === ".git/config"));
  assert.ok(before.ignoreSources.some((entry) => entry.path === ".git/info/exclude"));
  const configPath = execFileSync("git", ["-C", first, "rev-parse", "--git-path", "config"], { encoding: "utf8" }).trim();
  writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[core]\nexcludesFile = linked-worktree-exclude\n`);

  assert.throws(
    () => compareWorkspaceSnapshot(before, first, { files: [".git"], roots: [] }),
    /ignore sources changed/u,
  );

  const beforeExclude = captureWorkspaceSnapshot(first);
  const excludePath = execFileSync("git", ["-C", first, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
  writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}\nlinked-hidden.txt\n`);
  assert.throws(
    () => compareWorkspaceSnapshot(beforeExclude, first, { files: [".git"], roots: [] }),
    /ignore sources changed/u,
  );
});

test("POSIX Git paths retain legal backslashes", (t) => {
  if (process.platform === "win32") {
    t.skip("backslash is a path separator on Windows");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-backslash-path-"));
  const path = "literal\\name.txt";
  writeFileSync(join(cwd, path), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, path), "after");

  const comparison = compareWorkspaceSnapshot(before, cwd, { files: [path], roots: [] });
  assert.deepEqual(comparison.changedPaths, [path]);
  assert.deepEqual(comparison.unexpectedPaths, []);
});

test("ignored directories do not consume the relevant snapshot entry cap", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-ignored-many-"));
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
  writeFileSync(join(cwd, "README.md"), "read");
  initializeGit(cwd);
  mkdirSync(join(cwd, "ignored"));
  for (let index = 0; index < 5000; index += 1) writeFileSync(join(cwd, "ignored", `f-${index}`), "ignored");
  const snapshot = captureWorkspaceSnapshot(cwd);
  assert.ok(snapshot.entries.every((entry) => !entry.path.startsWith("ignored/")));
});

test("scope exact files and roots respect prefix boundaries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-boundary-"));
  mkdirSync(join(cwd, "src", "foo"), { recursive: true });
  mkdirSync(join(cwd, "src", "foobar"), { recursive: true });
  writeFileSync(join(cwd, "src", "foo", "file.txt"), "before");
  writeFileSync(join(cwd, "src", "foobar", "file.txt"), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, "src", "foo", "file.txt"), "after");
  writeFileSync(join(cwd, "src", "foobar", "file.txt"), "after");

  const exact = compareWorkspaceSnapshot(before, cwd, { files: ["src/foo/file.txt"], roots: [] });
  assert.deepEqual(exact.unexpectedPaths, ["src/foobar/file.txt"]);
  const root = compareWorkspaceSnapshot(before, cwd, { files: [], roots: ["src/foo"] });
  assert.deepEqual(root.unexpectedPaths, ["src/foobar/file.txt"]);
});

/** A boundary is always re-validated against the scope that declared it.
 * @param {import("../../src/repo/workspace.mjs").WorkspaceScopeBoundary} boundary
 * @returns {import("../../src/repo/workspace.mjs").WorkspaceScope} */
function declared(boundary) {
  return { files: [], roots: ["docs/NOTES.md"], boundary };
}

test("a scope root that names a regular file authorizes exactly that path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-file-root-"));
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "docs", "NOTES.md"), "before");
  writeFileSync(join(cwd, "sibling.md"), "before");
  initializeGit(cwd);
  const boundary = captureWorkspaceScope(cwd, { files: [], roots: ["docs/NOTES.md"] });
  assert.deepEqual(boundary.fileRoots, ["docs/NOTES.md"]);
  assert.throws(
    () => validateWorkspaceScopeBoundary(cwd, { ...boundary, fileRoots: ["docs/OTHER.md"] }),
    /file roots must be declared roots/u,
  );

  const before = captureWorkspaceSnapshot(cwd);
  writeFileSync(join(cwd, "docs", "NOTES.md"), "after");
  assert.deepEqual(compareWorkspaceSnapshot(before, cwd, declared(boundary)).unexpectedPaths, []);

  // Replacing the declared file with a same-named directory authorizes only
  // that path: what is beneath it stays unexpected, unlike a directory root.
  rmSync(join(cwd, "docs", "NOTES.md"));
  mkdirSync(join(cwd, "docs", "NOTES.md"));
  writeFileSync(join(cwd, "docs", "NOTES.md", "nested.txt"), "inside");
  writeFileSync(join(cwd, "sibling.md"), "after");
  assert.deepEqual(
    compareWorkspaceSnapshot(before, cwd, declared(boundary)).unexpectedPaths,
    ["docs/NOTES.md/nested.txt", "sibling.md"],
  );
});

test("workspace snapshots reject paths over the hard byte limit", (t) => {
  if (process.platform === "darwin") {
    t.skip("macOS PATH_MAX prevents constructing a >1024-byte relative path");
    return;
  }
  const long = mkdtempSync(join(tmpdir(), "runner-verification-long-"));
  let current = long;
  for (let index = 0; index < 5; index += 1) {
    current = join(current, `segment-${index}-${"x".repeat(230)}`);
    mkdirSync(current);
  }
  writeFileSync(join(current, "file"), "x");
  initializeGit(long);
  assert.throws(() => captureWorkspaceSnapshot(long), /exceeds 1024 bytes/u);
});

test("scope comparison computes forbidden paths beyond the evidence window", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-scope-cap-"));
  const allowed = [];
  for (let index = 0; index < 70; index += 1) {
    const path = `allowed-${index}.txt`;
    allowed.push(path);
    writeFileSync(join(cwd, path), "before");
  }
  writeFileSync(join(cwd, "forbidden.txt"), "before");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);
  for (const path of [...allowed, "forbidden.txt"]) writeFileSync(join(cwd, path), "after");
  const comparison = compareWorkspaceSnapshot(before, cwd, { files: allowed, roots: [] });
  assert.equal(comparison.unexpectedPaths.length, 1);
  assert.deepEqual(comparison.unexpectedPaths, ["forbidden.txt"]);
});

test("only the complete runner-managed AGENTS.md signal block is scope-neutral", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-agent-signal-"));
  const agents = join(cwd, "AGENTS.md");
  const managedStart = "<!-- faberun-active:start (managed by faberun — read, never edit) -->";
  const managedEnd = "<!-- faberun-active:end -->";
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- faberun run \`old-run\`: active\n${managedEnd}\n`);
  writeFileSync(join(cwd, "README.md"), "read\n");
  initializeGit(cwd);
  const before = captureWorkspaceSnapshot(cwd);

  // The runner rewriting only the managed block (new active run lines) is not
  // worker scope drift and must not trip unexpected-write protection.
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- faberun run \`new-run\`: active\n- faberun campaign \`other-campaign\`: active\n${managedEnd}\n`);
  const managedOnly = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(managedOnly.changedPaths, []);
  assert.deepEqual(managedOnly.unexpectedPaths, []);

  // Human-authored guidance outside the block still changes the identity and
  // is protected as an unexpected write.
  writeFileSync(agents, `# Guidance\nHuman edit outside the managed block.\n\n${managedStart}\n- faberun run \`new-run\`: active\n${managedEnd}\n`);
  const humanEdit = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(humanEdit.changedPaths, ["AGENTS.md"]);
  assert.deepEqual(humanEdit.unexpectedPaths, ["AGENTS.md"]);

  // A partial or malformed block is not runner-owned: it stays part of source
  // identity and must still trigger protection.
  writeFileSync(agents, `# Guidance\nHuman guidance stays protected.\n\n${managedStart}\n- faberun run \`partial\`: active\n`);
  const partialBlock = compareWorkspaceSnapshot(before, cwd, { files: [], roots: [] });
  assert.deepEqual(partialBlock.changedPaths, ["AGENTS.md"]);
  assert.deepEqual(partialBlock.unexpectedPaths, ["AGENTS.md"]);
});

test("verification timeout and cancellation terminate process groups", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-verification-descendants-"));
  const pidPath = join(cwd, "child.pid");
  const script = "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); fs.writeFileSync(process.argv[1],String(c.pid)); setInterval(()=>{},1000);";
  // 2s leaves the child time to boot and write child.pid before the timeout
  // kills it, even under full-suite load; the assertion only needs a timeout.
  const timed = await runVerification([{ argv: [process.execPath, "-e", script, pidPath], timeoutSec: 2 }], cwd);
  assert.equal(timed.passed, false);
  assert.equal(timed.commands[0].attempts[0].timedOut, true);
  const childPid = Number(readFileSync(pidPath, "utf8"));
  await waitForDeath(childPid);
  const controller = new AbortController();
  const pending = runVerification([{ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutSec: 5 }], cwd, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const canceled = await pending;
  assert.equal(canceled.passed, false);
});

test("discovery result parses exactly one strict execution task packet artifact", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-discovery-result-"));
  writeFileSync(join(cwd, "README.md"), "read\n");
  const packet = {
    mode: "execution", objective: "build", instructions: ["build"], readFiles: ["README.md"], writeFiles: ["out.txt"],
    symbols: [], decisions: [], nonGoals: [], verification: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
  };
  const result = parseDiscoveryResult({
    status: "done", summary: "discovered", verification: [], artifacts: [JSON.stringify(packet)], missingContext: [],
  }, cwd);
  assert.equal(result.discoveryPacket.mode, "execution");
  assert.throws(() => parseDiscoveryResult({ ...result, artifacts: [] }, cwd), /exactly one task packet/u);
});

function outsidePath() {
  return mkdtempSync(join(tmpdir(), "runner-verification-outward-target-"));
}

/**
 * @param {number} pid
 * @returns {Promise<void>}
 */
async function waitForDeath(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      const cause = /** @type {{code?: string}} */ (error);
      if (cause.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  assert.fail(`process ${pid} survived process-group termination`);
}

test("a failing command proof with oversized output stays inside the evidence ceiling", () => {
  // Field report, campaign beliva-pades-phase6 run r2: a failing command proof
  // whose output exceeded 4 KiB produced a finding the contract validator
  // rejects, and that rejection killed the controller mid-gate. The trigger
  // needs both halves — the proof must FAIL, because mechanicalVerdict builds
  // findings only from failed results, and its output must exceed the ceiling.
  const verdict = mechanicalVerdict([
    { id: "build", kind: "command", ref: "cargo build --workspace", pass: false, detail: "x".repeat(9000) },
    { id: "test", kind: "command", ref: "cargo test", pass: false, detail: "é".repeat(5000) },
    { id: "clean", kind: "command", ref: "git status", pass: true, detail: "y".repeat(9000) },
  ]);
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.findings.length, 2, "only failed proofs become findings");
  for (const finding of verdict.findings) {
    assert.ok(
      Buffer.byteLength(finding.evidence, "utf8") <= 4 * 1024,
      `evidence is ${Buffer.byteLength(finding.evidence, "utf8")} bytes`,
    );
    assert.ok(Buffer.byteLength(finding.description, "utf8") <= 2 * 1024);
  }
  // validateNodeSnapshot is the thing that used to throw and take the
  // controller with it: prove it accepts a snapshot carrying this verdict.
  assert.doesNotThrow(() => validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "build",
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "contract-test", nodeId: "build" },
    packetHash: "a".repeat(64),
    status: "exhausted",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: null,
    updatedAt: "2026-09-05T00:00:00.000Z",
    result: null,
    gate: verdict,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  }));
});

test("a virtual environment never changes the ignore-source fingerprint", () => {
  // Same class as node_modules: `uv venv` writes a .gitignore inside the
  // environment and installed packages carry their own, so the sources change
  // mid-node and kill a worker that did nothing wrong.
  const directory = mkdtempSync(join(tmpdir(), "verification-venv-"));
  writeFileSync(join(directory, ".gitignore"), ".venv/\n");
  initializeGit(directory);
  const before = captureWorkspaceSnapshot(directory);
  for (const name of [".venv", "env"]) {
    const root = join(directory, name);
    mkdirSync(join(root, "lib", "site-packages", "tests"), { recursive: true });
    writeFileSync(join(root, "pyvenv.cfg"), "home = /usr/bin\n");
    writeFileSync(join(root, ".gitignore"), "*\n");
    writeFileSync(join(root, "lib", "site-packages", "tests", ".gitignore"), "outputs/\n");
  }
  const after = captureWorkspaceSnapshot(directory);
  assert.deepEqual(after.ignoreSources, before.ignoreSources, "a venv adds no ignore source");
});

test("a nested node_modules stays out of the snapshot, not only a root one", () => {
  // A monorepo that anchors the pattern to the root leaves every package's own
  // `node_modules` visible to git, so a per-package install mid-node walked
  // thousands of dependency files into the snapshot — reported as unexpected
  // writes, and past 20k entries a `snapshot_too_large` failure for a worker
  // that touched nothing of the sort. The ignore-source walk already excluded
  // the directory at any depth; the entry walk only did so at the root.
  const directory = mkdtempSync(join(tmpdir(), "verification-nested-modules-"));
  writeFileSync(join(directory, ".gitignore"), "/node_modules/\n");
  mkdirSync(join(directory, "packages", "a", "src"), { recursive: true });
  writeFileSync(join(directory, "packages", "a", "src", "index.mjs"), "export const a = 1;\n");
  initializeGit(directory);

  const before = captureWorkspaceSnapshot(directory);
  assert.ok(before.entries.some((entry) => entry.path === "packages/a/src/index.mjs"), "real source is snapshotted");

  mkdirSync(join(directory, "node_modules", "root-dep"), { recursive: true });
  writeFileSync(join(directory, "node_modules", "root-dep", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(directory, "packages", "a", "node_modules", "leaf-dep"), { recursive: true });
  writeFileSync(join(directory, "packages", "a", "node_modules", "leaf-dep", "index.js"), "module.exports = 2;\n");

  const after = captureWorkspaceSnapshot(directory);
  const dependencyEntries = after.entries.filter((entry) => entry.path.includes("node_modules"));
  assert.deepEqual(dependencyEntries, [], "no dependency file enters the snapshot at any depth");
  assert.deepEqual(
    compareWorkspaceSnapshot(before, directory, { files: ["packages/a/src/index.mjs"], roots: [] }).unexpectedPaths,
    [],
    "installing dependencies is not an unexpected write",
  );
});
