import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, packet } from "../helpers.mjs";
import { contentDigest, fileDigest, freezePlan, verifyFrozenPlan, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
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

test("a frozen contract carries operator-supplied shared and final verification, digest included", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-ratchets", campaignId: "plan-fixture-campaign-ratchets" });
  plan.sharedVerification = [{ argv: ["npm", "test"] }];
  plan.finalVerification = [{ argv: ["git", "diff", "--quiet"] }];

  freezePlan(plan, { outDir: dir, provenance: provenance() });

  assert.equal(verifyFrozenPlan(dir).ok, true);
  const contractPath = join(dir, "contract.json");
  const raw = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.deepEqual(raw.sharedVerification, plan.sharedVerification);
  assert.deepEqual(raw.finalVerification, plan.finalVerification);
  assert.doesNotThrow(() => validateContract(raw, contractPath));

  // The suites are contract content, not authoring-attention text: a suite
  // edited after the freeze is a digest mismatch, like any other byte.
  const tampered = JSON.parse(readFileSync(contractPath, "utf8"));
  tampered.sharedVerification[0].argv = ["npm", "run", "test"];
  writeFileSync(contractPath, JSON.stringify(tampered, null, 2));
  assert.equal(verifyFrozenPlan(dir).ok, false);
});

test("a frozen plan phase declares requirements it satisfies and its one-sentence deliverable", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-phases", campaignId: "plan-fixture-campaign-phases" });
  const phases = [
    { id: "protocol", requirementIds: ["R1", "R2"], deliverable: "The packet schema closes over every file the change forces to change." },
    { id: "reporting", requirementIds: [], deliverable: "The run page shows node verdicts." },
  ];

  const frozen = freezePlan(plan, { outDir: dir, provenance: provenance(), phases });

  assert.deepEqual(frozen.phases, phases);
  const onDisk = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(onDisk, frozen);
  assert.equal(verifyFrozenPlan(dir).ok, true);

  // The requirement gap is not a refusal here either: a phase that names no
  // requirement still freezes, and validatePlanOutput is the check that
  // reports the gap as a finding.
  const sparseDir = outDir();
  assert.doesNotThrow(() =>
    freezePlan(fixture({ id: "plan-fixture-sparse-phase", campaignId: "plan-fixture-campaign-sparse-phase" }), {
      outDir: sparseDir,
      provenance: provenance(),
      phases: [{ id: "reporting", requirementIds: [], deliverable: "The run page shows node verdicts." }],
    }),
  );
  assert.equal(verifyFrozenPlan(sparseDir).ok, true);
});

test("malformed phase declarations write nothing, like any other freeze failure", () => {
  const dir = outDir();
  const plan = fixture({ id: "plan-fixture-bad-phases", campaignId: "plan-fixture-campaign-bad-phases" });

  assert.throws(() => freezePlan(plan, { outDir: dir, provenance: provenance(), phases: /** @type {any} */ ("protocol") }), /plan\.phases/);
  assert.equal(existsSync(join(dir, "contract.json")), false);
  assert.equal(existsSync(join(dir, "plan.json")), false);
});

/**
 * Two nodes sharing one execution phase: the shape the legacy phase-id match
 * could not express, which nodeIds exist to disambiguate.
 *
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
function sharedPhasePlan(id) {
  return fixture({
    id,
    campaignId: `${id}-campaign`,
    nodes: [
      { id: "build", type: "backend", phase: "shared-phase", taskPacket: packet(), gate: false },
      { id: "docs", type: "docs", phase: "shared-phase", taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Survey the docs" }), gate: false },
    ],
  });
}

test("freeze records the structured spec's path and content digest in plan.json", () => {
  const dir = outDir();
  const spec = { path: "docs/campaigns/campaign-brief/spec/SPEC.md", digest: contentDigest("# Campaign brief\n") };
  const frozen = freezePlan(fixture({ id: "plan-fixture-spec", campaignId: "plan-fixture-campaign-spec" }), {
    outDir: dir,
    provenance: provenance(),
    spec,
  });

  assert.deepEqual(frozen.spec, spec);
  const onDisk = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(onDisk.spec, spec);
  assert.equal(verifyFrozenPlan(dir).ok, true);

  // A digest that is not a SHA-256 refuses before either file is written.
  const badDir = outDir();
  assert.throws(
    () => freezePlan(fixture({ id: "plan-fixture-bad-spec", campaignId: "plan-fixture-campaign-bad-spec" }), {
      outDir: badDir,
      provenance: provenance(),
      spec: { path: "docs/SPEC.md", digest: "not-a-sha256" },
    }),
    /spec\.digest/,
  );
  assert.equal(existsSync(join(badDir, "contract.json")), false);
  assert.equal(existsSync(join(badDir, "plan.json")), false);
});

test("freeze stamps a nodeIds declaration's requirement ids on the named nodes and preserves the nodeIds", () => {
  const dir = outDir();
  const phases = [
    { id: "build-phase", requirementIds: ["R1", "R2"], nodeIds: ["build"], deliverable: "Build it." },
    { id: "docs-phase", requirementIds: ["R3"], nodeIds: ["docs"], deliverable: "Document it." },
  ];
  const frozen = freezePlan(sharedPhasePlan("plan-fixture-nodeids"), { outDir: dir, provenance: provenance(), phases });

  assert.deepEqual(frozen.phases, phases);
  const onDisk = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(onDisk.phases, phases);
  const contract = JSON.parse(readFileSync(join(dir, "contract.json"), "utf8"));
  assert.deepEqual(contract.nodes.find((/** @type {any} */ node) => node.id === "build").requirementIds, ["R1", "R2"]);
  assert.deepEqual(contract.nodes.find((/** @type {any} */ node) => node.id === "docs").requirementIds, ["R3"]);
  assert.equal(verifyFrozenPlan(dir).ok, true);
});

test("freeze refuses a missing, duplicate or unknown node assignment and writes nothing", () => {
  const cases = [
    {
      label: "missing",
      phases: [{ id: "build-phase", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build it." }],
      message: /leaves planned node\(s\) assigned to no phase: docs/,
    },
    {
      label: "duplicate",
      phases: [
        { id: "p1", requirementIds: ["R1"], nodeIds: ["build", "docs"], deliverable: "Both." },
        { id: "p2", requirementIds: ["R2"], nodeIds: ["build"], deliverable: "Again." },
      ],
      message: /assigns node build to both p1 and p2/,
    },
    {
      label: "unknown",
      phases: [
        { id: "p1", requirementIds: ["R1"], nodeIds: ["build"], deliverable: "Build." },
        { id: "p2", requirementIds: ["R2"], nodeIds: ["docs", "ghost"], deliverable: "Ghost." },
      ],
      message: /assigns unknown node ghost/,
    },
  ];
  for (const testCase of cases) {
    const dir = outDir();
    assert.throws(
      () => freezePlan(sharedPhasePlan(`plan-fixture-assignment-${testCase.label}`), { outDir: dir, provenance: provenance(), phases: testCase.phases }),
      testCase.message,
      testCase.label,
    );
    assert.equal(existsSync(join(dir, "contract.json")), false, `${testCase.label}: no contract`);
    assert.equal(existsSync(join(dir, "plan.json")), false, `${testCase.label}: no plan`);
  }
});

test("writeFrozenPlanRecord seals the final plan bytes with an independent sha256 sidecar", () => {
  const dir = outDir();
  const frozen = freezePlan(fixture({ id: "plan-fixture-seal", campaignId: "plan-fixture-seal-campaign" }), { outDir: dir, provenance: provenance() });
  const outcome = { status: "frozen", approved: true };
  writeFrozenPlanRecord(dir, { ...frozen, ...outcome });

  const planPath = join(dir, "plan.json");
  const planBytes = readFileSync(planPath);
  const sidecar = readFileSync(join(dir, "plan.json.sha256"), "utf8").trim();
  assert.equal(sidecar, createHash("sha256").update(planBytes).digest("hex"));
  assert.equal(sidecar, fileDigest(planPath), "the exported file digest hashes the same exact bytes");
  const onDisk = JSON.parse(planBytes.toString("utf8"));
  assert.equal(onDisk.status, "frozen");
  assert.equal(onDisk.approved, true);
});

test("the frozen contract keeps the runtime the operator declared", () => {
  // R15: an operator-declared runtime persists through the freeze verbatim --
  // routing strategies are plan-time economics and never rewrite a
  // declaration; the frozen artifact must read as the operator wrote it.
  const dir = outDir();
  const plan = fixture({
    id: "plan-fixture-operator-runtime",
    campaignId: "plan-fixture-operator-runtime-campaign",
    runtimeDefaults: { worker: "luna", judge: "sol" },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), runtime: "luna", gate: false }],
  });

  freezePlan(plan, { outDir: dir, provenance: provenance() });

  assert.equal(verifyFrozenPlan(dir).ok, true);
  const contractPath = join(dir, "contract.json");
  const raw = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.equal(raw.nodes[0].runtime, "luna");
  assert.deepEqual(raw.runtimeDefaults, { worker: "luna", judge: "sol" });
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
