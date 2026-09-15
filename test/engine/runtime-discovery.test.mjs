import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAssignments, nextSameTierRuntime, normalizeProviderAvailability } from "../../src/engine/runtime-discovery.mjs";
import { normalizeProviderResult, probeRuntime } from "../../src/harnesses/index.mjs";

const ready = { available: true, exhaustedUntil: null, reason: "ready" };

test("normalizes Z.ai code 1310 with its reset timestamp", () => {
  // Z.ai's weekly-limit refusal reaches the ZCode harness before any result
  // object, so the vendor's code and the reset instant arrive on stderr alone.
  const envelope = normalizeProviderResult("zcode", "", 1, null, {
    stderr: "Error: [1310] Weekly limit exhausted. Your limit will reset at 2026-09-04 21:44:15\n",
  });
  const availability = normalizeProviderAvailability("zcode", envelope);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, "quota_exhausted");
  assert.equal(availability.exhaustedUntil, "2026-09-04T21:44:15.000Z");
});

test("normalizes Codex and Claude authentication failures", () => {
  for (const harness of ["codex", "claude"]) {
    const availability = normalizeProviderAvailability(harness, {
      status: "failed",
      error: { code: "authentication_failed", message: "invalid API key" },
    });
    assert.deepEqual(availability, { available: false, exhaustedUntil: null, reason: "authentication_failed" });
  }
});

test("normalizes Codex and Claude quota failures separately from auth", () => {
  for (const harness of ["codex", "claude"]) {
    const availability = normalizeProviderAvailability(harness, {
      status: "failed",
      error: { code: "quota_exhausted", message: "usage limit reached", resetAt: "2099-01-01T00:00:00Z" },
    });
    assert.deepEqual(availability, { available: false, exhaustedUntil: "2099-01-01T00:00:00.000Z", reason: "quota_exhausted" });
  }
});

test("an absent CLI is unavailable with a named not_found reason", async () => {
  const result = await probeRuntime({ harness: "codex", model: "m", executable: join(mkdtempSync(join(tmpdir(), "runtime-discovery-")), "missing") });
  assert.equal(result.ok, false);
  assert.equal(result.availability?.reason, "not_found");
});

test("composes the cheapest worker and strongest cross-vendor judge only for omitted roles", () => {
  const contract = {
    runtimes: {
      cheap: { vendor: "vendor-a", tier: 1, costRank: 1 },
      cheapJudge: { vendor: "vendor-b", tier: 1, costRank: 2 },
      strong: { vendor: "vendor-c", tier: 2, costRank: 3 },
    },
    runtimeDefaults: {},
    nodes: [
      { id: "composed", runtime: undefined, gate: { enabled: true, runtime: undefined } },
      { id: "explicit", runtime: "strong", gate: { enabled: true, runtime: "cheapJudge" } },
    ],
  };
  const assignments = composeAssignments(contract, { cheap: ready, cheapJudge: ready, strong: ready });
  assert.deepEqual(assignments.composed, { worker: "cheap", judge: "strong" });
  assert.deepEqual(assignments.explicit, { worker: "strong", judge: "cheapJudge" });
});

test("fails composition by name when no cross-vendor judge is available", () => {
  assert.throws(() => composeAssignments({
    runtimes: { worker: { vendor: "same", tier: 1, costRank: 1 } },
    runtimeDefaults: {},
    nodes: [{ id: "gated", gate: { enabled: true } }],
  }, { worker: ready }), /runtime_assignment_judge_unavailable/u);
});

test("same-tier re-tiering excludes exhausted and same-vendor judges", () => {
  const contract = {
    runtimes: {
      worker: { vendor: "worker-vendor", tier: 1, costRank: 1 },
      sibling: { vendor: "sibling-vendor", tier: 1, costRank: 2 },
      otherTier: { vendor: "other-vendor", tier: 2, costRank: 3 },
      sameVendor: { vendor: "worker-vendor", tier: 1, costRank: 0 },
    },
  };
  const routing = {
    assignments: { worker: "worker", judge: "otherTier", composedWorker: true, composedJudge: true },
    availability: {
      worker: { available: false, exhaustedUntil: "2099-01-01T00:00:00.000Z", reason: "quota" },
      sibling: ready,
      otherTier: ready,
      sameVendor: ready,
    },
  };
  assert.equal(nextSameTierRuntime(contract, routing, "worker", "worker", new Set(["worker"])), "sameVendor");
  assert.equal(nextSameTierRuntime(contract, routing, "judge", "otherTier", new Set(["otherTier"])), null);
});

/** @param {string[]} harnesses @param {string} [worker] @param {string} [judge] @returns {import("../../src/host/config.mjs").UserConfig} */
function userConfig(harnesses, worker, judge) {
  return {
    schemaVersion: 1,
    harnesses,
    ...(worker ? { worker } : {}),
    ...(judge ? { judge } : {}),
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

const CONFIG_CONTRACT = {
  runtimes: {
    dshA: { harness: "dsh", vendor: "vendor-a", tier: 1, costRank: 1 },
    zcodeA: { harness: "zcode", vendor: "vendor-b", tier: 1, costRank: 2 },
    zcodeB: { harness: "zcode", vendor: "vendor-b", tier: 1, costRank: 3 },
    claudeA: { harness: "claude", vendor: "vendor-c", tier: 2, costRank: 4 },
  },
  runtimeDefaults: {},
  nodes: [{ id: "composed", gate: { enabled: true } }],
};
const CONFIG_AVAILABLE = { dshA: ready, zcodeA: ready, zcodeB: ready, claudeA: ready };

test("a config harness list restricts composition to those harnesses", () => {
  // The preferred worker and judge both name zcode runtimes the enabled
  // harnesses exclude, so they are ignored and the cheapest/strongest rule
  // picks only from dsh and claude.
  const assignments = composeAssignments(CONFIG_CONTRACT, CONFIG_AVAILABLE, {
    config: userConfig(["dsh", "claude"], "zcodeA", "zcodeB"),
  });
  assert.deepEqual(assignments.composed, { worker: "dshA", judge: "claudeA" });
});

test("a config prefers its worker and cross-vendor judge when they are candidates", () => {
  const assignments = composeAssignments(CONFIG_CONTRACT, CONFIG_AVAILABLE, {
    config: userConfig(["dsh", "zcode", "claude"], "zcodeA", "claudeA"),
  });
  assert.deepEqual(assignments.composed, { worker: "zcodeA", judge: "claudeA" });
});

test("a config judge of the worker's vendor is ignored for the strongest other vendor", () => {
  const assignments = composeAssignments(CONFIG_CONTRACT, CONFIG_AVAILABLE, {
    config: userConfig(["dsh", "zcode", "claude"], "zcodeA", "zcodeB"),
  });
  assert.deepEqual(assignments.composed, { worker: "zcodeA", judge: "claudeA" });
});

test("an empty restriction falls back to the unrestricted candidates and warns", () => {
  /** @type {string[]} */
  const warnings = [];
  const assignments = composeAssignments(CONFIG_CONTRACT, CONFIG_AVAILABLE, {
    config: userConfig(["exec-jsonl"]),
    onWarning: (message) => warnings.push(message),
  });
  assert.deepEqual(assignments.composed, { worker: "dshA", judge: "claudeA" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /using all available runtimes/u);
});

test("an explicit runtime default is never overridden by the config", () => {
  const contract = {
    ...CONFIG_CONTRACT,
    runtimeDefaults: { worker: "dshA", judge: "claudeA" },
  };
  const assignments = composeAssignments(contract, CONFIG_AVAILABLE, {
    config: userConfig(["dsh", "zcode", "claude"], "zcodeA", "zcodeB"),
  });
  assert.deepEqual(assignments.composed, { worker: "dshA", judge: "claudeA" });
});
