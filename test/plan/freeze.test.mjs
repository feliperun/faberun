import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../helpers.mjs";
import { freezePlan, verifyFrozenPlan } from "../../src/plan/freeze.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** @returns {string} */
function outDir() {
  return mkdtempSync(join(tmpdir(), "plan-freeze-"));
}

/** @returns {import("../../src/plan/freeze.mjs").PlanProvenanceInput} */
function provenance() {
  return {
    targetGitHead: "0123456789abcdef0123456789abcdef01234567",
    planner: { runtimeId: "luna", model: "gpt-5.6-luna" },
    reviewer: { runtimeId: "sol", model: "gpt-5.6-sol" },
    sizing: [{ type: "split", from: "build", into: ["build-a", "build-b"] }],
    findings: [{ id: "F1", severity: "minor", nodeId: "build", text: "keep an eye on this" }],
  };
}

test("freezePlan writes a validated contract.json and a plan.json with digest and full provenance", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture", campaignId: "plan-fixture-campaign" });
  const expectedProvenance = provenance();

  const frozen = freezePlan(plan, { outDir: dir, provenance: expectedProvenance });

  assert.equal(frozen.formatVersion, 1);
  assert.equal(typeof frozen.contractDigest, "string");
  assert.ok(frozen.contractDigest.length > 0);
  assert.deepEqual(frozen.provenance, {
    packageVersion: PACKAGE_VERSION,
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    ...expectedProvenance,
  });

  const onDisk = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(onDisk, frozen);

  assert.equal(verifyFrozenPlan(dir).ok, true);
});

test("the emitted contract.json validates", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-2", campaignId: "plan-fixture-campaign-2" });
  freezePlan(plan, { outDir: dir, provenance: provenance() });

  const contractPath = join(dir, "contract.json");
  const raw = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.doesNotThrow(() => validateContract(raw, contractPath));
});

test("flipping one byte of contract.json makes verifyFrozenPlan report a mismatch", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-3", campaignId: "plan-fixture-campaign-3" });
  freezePlan(plan, { outDir: dir, provenance: provenance() });
  assert.equal(verifyFrozenPlan(dir).ok, true, "unmodified pair agrees");

  const contractPath = join(dir, "contract.json");
  const text = readFileSync(contractPath, "utf8");
  const needle = "Prove the runner works";
  const index = text.indexOf(needle);
  assert.ok(index >= 0, "fixture goal text is present to flip a byte inside");
  const flipped = `${text.slice(0, index)}Xrove the runner works${text.slice(index + needle.length)}`;
  writeFileSync(contractPath, flipped);

  const verdict = verifyFrozenPlan(dir);
  assert.equal(verdict.ok, false);
  assert.notEqual(verdict.digest, verdict.expectedDigest);
});

test("a plan that fails validateContract writes nothing", () => {
  const dir = outDir();
  const invalidPlan = fixture({ id: "plan-fixture-invalid", campaignId: "plan-fixture-campaign-invalid", goal: undefined });

  assert.throws(() => freezePlan(invalidPlan, { outDir: dir, provenance: provenance() }));
  assert.equal(existsSync(join(dir, "contract.json")), false);
  assert.equal(existsSync(join(dir, "plan.json")), false);
});

test("freezing and verifying a plan invokes no model: no FABERUN_*_BIN is required", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-no-model", campaignId: "plan-fixture-campaign-no-model" });
  /** @type {Record<string, string|undefined>} */
  const saved = {};
  for (const name of ["FABERUN_CLAUDE_BIN", "FABERUN_CODEX_BIN", "FABERUN_AGY_BIN", "FABERUN_DSH_BIN", "FABERUN_ZCODE_BIN"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const frozen = freezePlan(plan, { outDir: dir, provenance: provenance() });
    assert.equal(frozen.formatVersion, 1);
    assert.equal(verifyFrozenPlan(dir).ok, true);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
