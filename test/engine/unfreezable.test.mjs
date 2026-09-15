/**
 * Phase 5a — a loop that cannot freeze.
 *
 * Seven done-when cases over the three ways the controller could park forever:
 * a verification command whose grandchild escapes the group and holds the pipe,
 * a synchronous git call blocked on a held index lock, and a node that claims
 * it is running while the controller has no job for it. The static gate for
 * unbounded git lives in `test/repo/source-shape.test.mjs`; case 5 here checks
 * the call sites this packet owns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { runVerification } from "../../src/engine/run-command.mjs";
import { enforceRunningInvariant } from "../../src/engine/scheduler.mjs";
import { boundedGitSync, git } from "../../src/repo/worktree.mjs";
import { initializeGit, waitForValue } from "../helpers.mjs";

const SKILL_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** @param {string} directory @param {string} name @param {string} body @returns {string} */
function writeScript(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, body);
  return path;
}

/** @param {string} directory @returns {string} */
function tempDir(directory) {
  return mkdtempSync(join(tmpdir(), `unfreezable-${directory}-`));
}

/**
 * A child that spawns a detached grandchild inheriting the pipe, records the
 * grandchild's pid, and exits. The direct child closes; the grandchild keeps
 * the stdout pipe open, so `close` never fires.
 */
const ESCAPE_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
writeFileSync("escape.pid", String(child.pid));
child.unref();
`;

/**
 * A child that spawns a grandchild in its own process group and then stays
 * alive itself, so the group contains a member besides the leader.
 */
const GROUP_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync("group.pid", String(child.pid));
setInterval(() => {}, 1000);
`;

/** @param {number} pid @returns {void} */
function killQuietly(pid) {
  try { process.kill(pid, "SIGKILL"); } catch {
    // The process already exited; there is nothing left to clean up.
  }
}

/** A fully valid node snapshot, so `transition` can persist it. @param {string} id @param {Record<string, unknown>} [overrides] @returns {import("../../src/contract/index.mjs").NodeSnapshot} */
function validState(id, overrides = {}) {
  return /** @type {import("../../src/contract/index.mjs").NodeSnapshot} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "unfreezable", nodeId: id },
    packetHash: "a".repeat(64),
    status: "failed",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    result: null,
    gate: null,
    error: { code: "provider_error", message: "boom" },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// done-when 1: settle from the timer when a grandchild holds the pipe.
// ---------------------------------------------------------------------------

test("done-when 1: a child that escapes the group and holds the pipe settles from the timer with timedOut", { timeout: 15_000 }, async () => {
  const directory = tempDir("escape");
  writeScript(directory, "escape.mjs", ESCAPE_SCRIPT);
  let escapedPid = null;
  try {
    const result = await runVerification([
      { argv: [process.execPath, "escape.mjs"], timeoutSec: 0.4 },
      { argv: [process.execPath, "-e", "process.exit(0)"], timeoutSec: 5 },
    ], directory, {});
    const attempt = result.commands[0].attempts[0];
    assert.equal(attempt.timedOut, true, "the timer settles the attempt even though close never fires");
    assert.equal(attempt.passed, false);
    assert.equal(result.commands[1].passed, true, "the loop continues to the next command");
    escapedPid = Number(readFileSync(join(directory, "escape.pid"), "utf8"));
    assert.ok(Number.isInteger(escapedPid) && escapedPid > 0, "the escaped grandchild recorded its pid");
  } finally {
    if (escapedPid !== null) killQuietly(escapedPid);
  }
});

// ---------------------------------------------------------------------------
// done-when 2: cancellation settles immediately, even when close will not.
// ---------------------------------------------------------------------------

test("done-when 2: an aborted command settles immediately instead of waiting for close", { timeout: 15_000 }, async () => {
  const directory = tempDir("abort");
  writeScript(directory, "escape.mjs", ESCAPE_SCRIPT);
  const controller = new AbortController();
  let escapedPid = null;
  try {
    const pending = runVerification([{ argv: [process.execPath, "escape.mjs"], timeoutSec: 60 }], directory, { signal: controller.signal });
    await waitForValue(() => (existsSync(join(directory, "escape.pid")) ? true : null), 5_000, 10);
    controller.abort();
    const result = await pending;
    const attempt = result.commands[0].attempts[0];
    assert.equal(attempt.timedOut, false, "an abort is not a timeout");
    assert.match(attempt.error ?? "", /aborted/u);
    escapedPid = Number(readFileSync(join(directory, "escape.pid"), "utf8"));
  } finally {
    if (escapedPid !== null) killQuietly(escapedPid);
  }
});

// ---------------------------------------------------------------------------
// done-when 3: the killed group leaves no surviving grandchild.
// ---------------------------------------------------------------------------

test("done-when 3: a timed-out command leaves no surviving member of its process group", { timeout: 15_000 }, async () => {
  const directory = tempDir("group");
  writeScript(directory, "group.mjs", GROUP_SCRIPT);
  /** @type {number|null} */
  let processGroupId = null;
  /** @type {number|null} */
  let leaderPid = null;
  try {
    const result = await runVerification([{ argv: [process.execPath, "group.mjs"], timeoutSec: 0.4 }], directory, {
      onAttemptSpawn: (attempt) => {
        processGroupId = attempt.processGroupId;
        leaderPid = attempt.pid;
      },
    });
    assert.equal(result.commands[0].attempts[0].timedOut, true);
    if (process.platform === "win32" || processGroupId === null) {
      const dead = await waitForValue(() => {
        try { process.kill(/** @type {number} */ (leaderPid), 0); return null; } catch { return true; }
      }, 3_000, 25);
      assert.equal(dead, true, "the leader is gone");
      return;
    }
    const gone = await waitForValue(() => {
      try { process.kill(-/** @type {number} */ (processGroupId), 0); return null; } catch { return true; }
    }, 3_000, 25);
    assert.equal(gone, true, "no process in the killed group survives");
  } finally {
    // Nothing should be left, but be explicit if a platform kill proved partial.
    if (leaderPid !== null) killQuietly(leaderPid);
  }
});

// ---------------------------------------------------------------------------
// done-when 4: bounded synchronous git returns by its timeout, both paths.
// ---------------------------------------------------------------------------

test("done-when 4: a synchronous git blocked on a held index lock returns by its timeout with a named error", { timeout: 15_000 }, () => {
  const directory = tempDir("git");
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  const fakeBin = tempDir("fake-git");
  const fakeGit = join(fakeBin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nsleep 60\n");
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.FABERUN_GIT_TIMEOUT_MS;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  process.env.FABERUN_GIT_TIMEOUT_MS = "200";
  try {
    // The spawnSync-shaped caller reads the result object.
    const spawned = boundedGitSync(["-C", directory, "add", "-A"]);
    assert.equal(spawned.timedOut, true);
    assert.equal(spawned.error?.code, "git_timeout");
    assert.match(String(spawned.error?.message), /timed out after 200ms/u);
    // The execFileSync-shaped caller (`runGit`) throws the same named error.
    assert.throws(() => git(directory, ["add", "-A"]), (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "git_timeout");
      assert.match(error.message, /timed out after 200ms/u);
      return true;
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.FABERUN_GIT_TIMEOUT_MS;
    else process.env.FABERUN_GIT_TIMEOUT_MS = previousTimeout;
  }
});

// ---------------------------------------------------------------------------
// done-when 5: the call sites this packet owns all route through the wrapper.
// ---------------------------------------------------------------------------

test("done-when 5: the git call sites this packet owns route through boundedGitSync", () => {
  /** @param {string} text @returns {string[]} */
  const rawGitLines = (text) => text.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && /(?:execFileSync|spawnSync)\s*\(\s*["'`]git/u.test(trimmed);
  });
  const owned = [
    "src/engine/run-identity.mjs",
    "src/engine/live-preflight.mjs",
    "src/host/preflight.mjs",
    "src/repo/source-identity.mjs",
    "src/repo/integrate.mjs",
  ];
  for (const file of owned) {
    const text = readFileSync(join(SKILL_DIR, file), "utf8");
    assert.deepEqual(rawGitLines(text), [], `${file} must route git through boundedGitSync`);
    assert.match(text, /boundedGitSync/u, `${file} must import boundedGitSync`);
  }
  const worktreeText = readFileSync(join(SKILL_DIR, "src/repo/worktree.mjs"), "utf8");
  assert.equal(rawGitLines(worktreeText).length, 1, "the wrapper owns the only raw synchronous git spawn");
});

// ---------------------------------------------------------------------------
// done-when 5b: the hook seam is in process.test.mjs under test/run/.
// ---------------------------------------------------------------------------
// Asserted there because it needs a real provider process to observe the kill.

// ---------------------------------------------------------------------------
// done-when 6: running with no job transitions to blocked in one tick.
// ---------------------------------------------------------------------------

test("done-when 6: a running node absent from the running map becomes blocked with integration_unresolved", () => {
  const runDir = tempDir("invariant");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const state = validState("build", { status: "running", phase: "worker", error: null });
  const states = new Map([["build", state]]);
  const parked = enforceRunningInvariant(runDir, states, new Map(), null);
  assert.deepEqual(parked, ["build"]);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "integration_unresolved");
  const persisted = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(persisted.status, "blocked");
  assert.equal(persisted.error?.code, "integration_unresolved");
});

// ---------------------------------------------------------------------------
// done-when 7: parked and runtime_tier_exhausted waiting nodes are untouched.
// ---------------------------------------------------------------------------

test("done-when 7: the invariant leaves parked and runtime_tier_exhausted waiting nodes untouched, tick after tick", () => {
  const runDir = tempDir("invariant-negative");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const parked = validState("parked", {
    status: "blocked",
    phase: "complete",
    error: { code: "integration_conflict", message: "conflict in: a.txt" },
  });
  const waiting = validState("waiting", {
    status: "blocked",
    phase: "worker",
    error: { code: "runtime_tier_exhausted", message: "no available runtime remains in tier 1" },
    routing: {
      history: [],
      currentOverride: null,
      tierExhaustion: { role: "worker", candidates: [{ runtimeId: "luna", exhaustedUntil: null }] },
    },
  });
  const states = new Map([["parked", parked], ["waiting", waiting]]);
  for (let tick = 0; tick < 3; tick += 1) {
    const result = enforceRunningInvariant(runDir, states, new Map(), null);
    assert.deepEqual(result, [], `tick ${tick} parks nothing`);
    assert.equal(parked.status, "blocked");
    assert.equal(parked.error?.code, "integration_conflict");
    assert.equal(waiting.status, "blocked");
    assert.equal(waiting.error?.code, "runtime_tier_exhausted");
    assert.equal(waiting.routing?.tierExhaustion?.role, "worker");
  }
});
