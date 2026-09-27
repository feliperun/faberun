import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { setFreshPreflight } from "../../src/engine/run-identity.mjs";
import { availabilityKey, readAvailability, recordAvailability } from "../../src/run/availability.mjs";
import { availabilityPath, runDirectory } from "../../src/run/paths.mjs";
import { fakeCodex, fixture, packet, writeContract } from "../helpers.mjs";

// The verdict store: a live-preflight answer outlives the launch that bought
// it, keyed on the provider -- harness, model, resolved executable -- and
// reused only inside the hello window's own clock. The clock is injected
// everywhere a store call accepts `now`; no test sleeps and no test reaches a
// real provider.

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

/** @param {string} runDir @returns {any} the persisted gate evidence */
function envEvidence(runDir) {
  return JSON.parse(readFileSync(join(runDir, "env-preflight.json"), "utf8"));
}

/** @param {string} runDir @returns {any} the persisted state of the fixture's one node */
function nodeState(runDir) {
  return JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
}

/** @returns {string[]} the store's verdict keys currently on disk */
function storedKeys() {
  return Object.keys(JSON.parse(readFileSync(availabilityPath(), "utf8")).verdicts ?? {});
}

/** @param {string} observedAt @returns {string} what a reused probe's detail names */
function reuseDetail(observedAt) {
  return `live verdict reused · observed ${observedAt}`;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} runtimes
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>} a one-runtime, one-node contract
 */
function singleRuntimeFixture(id, runtimes, overrides = {}) {
  const runtimeId = Object.keys(runtimes)[0];
  return {
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: runtimeId, judge: runtimeId },
    runtimes,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    ...overrides,
  };
}

/**
 * @template T
 * @param {string} seconds
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function withPreflightBudget(seconds, body) {
  const key = "FABERUN_PREFLIGHT_TIMEOUT_SEC";
  const previous = process.env[key];
  process.env[key] = seconds;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/**
 * Answers the gate's liveness hello and then refuses the work with a quota
 * exhaustion: the shape of a real account that can still speak but cannot
 * spend. Its verdict is an answer, so the store records it.
 *
 * @returns {string}
 */
function quotaAfterHelloProvider() {
  const path = join(mkdtempSync(join(tmpdir(), "runner-cache-quota-")), "quota-after-hello.mjs");
  writeFileSync(path, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("quota-after-hello 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (input.includes("FABERUN_PREFLIGHT_OK")) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "preflight-hello" }));
      const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: hello } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Please try again at 12:58 PM" } }));
    process.exitCode = 1;
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Reports a version, so the static checks pass, and then answers nothing at
 * all -- the gate's only honest verdict about it is silence, and silence is
 * no verdict to record.
 *
 * @returns {string}
 */
function deadProvider() {
  const path = join(mkdtempSync(join(tmpdir(), "runner-cache-dead-")), "dead.mjs");
  writeFileSync(path, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("dead 1.0.0");
} else {
  setInterval(() => {}, 60_000);
}
`);
  chmodSync(path, 0o755);
  return path;
}

/** @param {{harness: string, model: string, executable: string}} provider @returns {string} */
function keyOf(provider) {
  return availabilityKey(provider);
}

test("a recorded verdict is reused inside its window and never past it", () => {
  const key = keyOf({ harness: "codex", model: "window", executable: "/executables/window" });
  recordAvailability([key], NOW);
  const fresh = readAvailability(key, NOW);
  assert.equal(fresh?.available, true);
  // The window is the hello's own clock: the record names it, never one of
  // the provider quota windows it must not be derived from.
  assert.equal(fresh?.window, "preflight");
  assert.equal(fresh?.observedAt, new Date(NOW).toISOString());
  // The window is declared in runtime-discovery.mjs as fifteen minutes; the
  // last millisecond inside it still reuses, the first one past it asks.
  assert.ok(readAvailability(key, NOW + 15 * 60 * 1000), "the final millisecond inside the window still reuses");
  assert.equal(readAvailability(key, NOW + 15 * 60 * 1000 + 1), null, "one millisecond past the window, the launch asks again");
  // A later recording merges into the store; it never drops the providers
  // already held.
  const other = keyOf({ harness: "codex", model: "window", executable: "/executables/other" });
  recordAvailability([other], NOW + 1);
  assert.ok(readAvailability(key, NOW + 1));
  assert.ok(readAvailability(other, NOW + 1));
});

test("the key is the provider, never a contract's local name for it", () => {
  const executable = "/executables/provider";
  const codex = keyOf({ harness: "codex", model: "one-model", executable });
  assert.notEqual(codex, keyOf({ harness: "codex", model: "other-model", executable }), "a different model is a different question");
  assert.notEqual(codex, keyOf({ harness: "claude", model: "one-model", executable }), "a different harness is a different question");
  assert.notEqual(codex, keyOf({ harness: "codex", model: "one-model", executable: "/executables/elsewhere" }), "a different executable is a different question");
  recordAvailability([codex], NOW);
  assert.ok(readAvailability(codex, NOW));
  assert.equal(readAvailability(keyOf({ harness: "codex", model: "other-model", executable }), NOW), null, "no answer bleeds across providers");
});

test("a stored record that fails its own validator reads as no verdict", () => {
  const good = keyOf({ harness: "codex", model: "validator", executable: "/executables/good" });
  recordAvailability([good], NOW);
  const corrupt = keyOf({ harness: "codex", model: "validator", executable: "/executables/corrupt" });
  const path = availabilityPath();
  const store = JSON.parse(readFileSync(path, "utf8"));
  store.verdicts[corrupt] = { available: "yes", exhaustedUntil: null, reason: "ready", observedAt: new Date(NOW).toISOString(), window: "preflight" };
  writeFileSync(path, JSON.stringify(store));
  assert.ok(readAvailability(good, NOW), "one corrupt entry never touches its neighbours");
  assert.equal(readAvailability(corrupt, NOW), null, "an untypable record is dropped, and the caller asks again");
});

test("a launch reuses stored verdicts instead of asking, whatever each contract names the provider", async () => {
  const executable = fakeCodex(mkdtempSync(join(tmpdir(), "runner-cache-pass-")), "pass");
  const provider = { harness: "codex", model: "cache-model", executable };
  const firstDirectory = mkdtempSync(join(tmpdir(), "runner-cache-first-"));
  const firstPath = writeContract(firstDirectory, fixture(singleRuntimeFixture("cache-run-first", {
    only: { harness: provider.harness, model: provider.model, executable },
  })));
  const firstRun = runDirectory(firstDirectory, "cache-run-first");
  await runContract(firstPath);
  assert.equal(nodeState(firstRun).status, "done");
  assert.equal(envEvidence(firstRun).runtimes?.[0]?.liveStatus, "done", "the first launch asked");
  const observedAt = JSON.parse(readFileSync(availabilityPath(), "utf8")).verdicts[keyOf(provider)]?.observedAt;
  assert.ok(observedAt, "the first launch recorded the verdict under the provider's identity");

  // A different project, a different contract, a different local runtime id:
  // the same provider is one record.
  const secondDirectory = mkdtempSync(join(tmpdir(), "runner-cache-second-"));
  const secondPath = writeContract(secondDirectory, fixture(singleRuntimeFixture("cache-run-second", {
    differentlyNamed: { harness: provider.harness, model: provider.model, executable },
  })));
  const secondRun = runDirectory(secondDirectory, "cache-run-second");
  await runContract(secondPath);
  assert.equal(nodeState(secondRun).status, "done");
  const evidence = envEvidence(secondRun);
  assert.equal(evidence.runtimes?.[0]?.liveStatus, "reused", "the second launch read the verdict back instead of asking");
  assert.equal(evidence.runtimes?.[0]?.detail, reuseDetail(observedAt), "the reuse names the instant the verdict was observed");
});

// Measured 2026-09-24: a refusal was stored as an answer, the next launches
// reused it without asking, and six processes spent into two exhausted accounts.
test("a refusal the work met is recorded, and the next launch is refused on it without asking", async () => {
  const executable = quotaAfterHelloProvider();
  const provider = { harness: "codex", model: "refusal-model", executable };
  const firstDirectory = mkdtempSync(join(tmpdir(), "runner-cache-refusal-1-"));
  await runContract(writeContract(firstDirectory, fixture(singleRuntimeFixture("cache-refusal-first", {
    only: { harness: provider.harness, model: provider.model, executable },
  }, { timeoutSec: 5 }))));
  assert.equal(nodeState(runDirectory(firstDirectory, "cache-refusal-first")).status, "exhausted");
  const stored = JSON.parse(readFileSync(availabilityPath(), "utf8")).verdicts[keyOf(provider)];
  assert.equal(stored?.available, false, "the refusal the work met is stored as a refusal, not as an answer");
  assert.equal(stored?.reason, "quota_exhausted");

  const secondDirectory = mkdtempSync(join(tmpdir(), "runner-cache-refusal-2-"));
  const secondPath = writeContract(secondDirectory, fixture(singleRuntimeFixture("cache-refusal-second", {
    only: { harness: provider.harness, model: provider.model, executable },
  }, { timeoutSec: 5 })));
  await runContract(secondPath).catch(() => null);
  const secondRun = runDirectory(secondDirectory, "cache-refusal-second");
  const probe = envEvidence(secondRun).runtimes?.[0];
  assert.equal(probe?.liveStatus, "exhausted", "the launch is refused on the recorded refusal");
  assert.match(String(probe?.detail), /refusal recorded on this machine/u, "and it says the refusal was recorded, not asked");
  assert.notEqual(nodeState(secondRun).status, "done", "no work was dispatched into the exhausted account");
});

test("--fresh-preflight asks again even when a fresh verdict is stored", async () => {
  const executable = fakeCodex(mkdtempSync(join(tmpdir(), "runner-cache-fresh-")), "pass");
  const provider = { harness: "codex", model: "fresh-model", executable };
  /** @param {string} id @returns {{directory: string, path: string}} */
  const launch = (id) => {
    const directory = mkdtempSync(join(tmpdir(), `runner-cache-fresh-${id}-`));
    return { directory, path: writeContract(directory, fixture(singleRuntimeFixture(id, {
      only: { harness: provider.harness, model: provider.model, executable },
    }))) };
  };
  await runContract(launch("cache-fresh-first").path);
  const observedAfterFirst = JSON.parse(readFileSync(availabilityPath(), "utf8")).verdicts[keyOf(provider)]?.observedAt;
  assert.ok(observedAfterFirst);

  const second = launch("cache-fresh-second");
  await runContract(second.path);
  assert.equal(envEvidence(runDirectory(second.directory, "cache-fresh-second")).runtimes?.[0]?.liveStatus, "reused");

  setFreshPreflight(true);
  try {
    const forced = launch("cache-fresh-forced");
    await runContract(forced.path);
    const evidence = envEvidence(runDirectory(forced.directory, "cache-fresh-forced"));
    assert.equal(evidence.runtimes?.[0]?.liveStatus, "done", "the flag asked, and the ask happened");
    assert.equal(nodeState(runDirectory(forced.directory, "cache-fresh-forced")).status, "done");
  } finally {
    setFreshPreflight(false);
  }
  const observedAfterForce = JSON.parse(readFileSync(availabilityPath(), "utf8")).verdicts[keyOf(provider)]?.observedAt;
  assert.ok(observedAfterForce && observedAfterForce >= /** @type {string} */ (observedAfterFirst), "the fresh ask re-recorded the verdict at a later instant");
});

test("silence is never recorded, so the launch after a fix asks again", async () => {
  const executable = deadProvider();
  const directory = mkdtempSync(join(tmpdir(), "runner-cache-silent-"));
  const path = writeContract(directory, fixture(singleRuntimeFixture("cache-silent-run", {
    only: { harness: "codex", model: "silent-model", executable },
  })));
  await withPreflightBudget("2", async () => {
    await assert.rejects(runContract(path), (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "env_preflight_failed");
      return true;
    });
  });
  assert.equal(storedKeys().filter((key) => key.includes(executable)).length, 0, "a silent provider left no verdict to reuse");
});
