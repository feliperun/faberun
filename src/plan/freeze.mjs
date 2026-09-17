/**
 * Freezing a plan: the boundary between a session's draft and a contract the
 * engine can execute. `freezePlan` writes the plan's nodes as a validated
 * contract.json, plus a plan.json carrying that contract's digest and the
 * full provenance of how it was produced — the two files travel together so
 * a later launch and this record agree on exactly what was reviewed.
 * `verifyFrozenPlan` is the one check that the pair still agree.
 *
 * Nothing here invokes a model or the engine; it only writes and hashes
 * bytes, so freezing a plan can never be mistaken for starting a run.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, contractDigest, validateContract } from "../contract/index.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */

/** @typedef {{runtimeId: string, model: string}} PlanParticipant */
/** @typedef {{id: string, severity: "minor"|"major"|"critical", nodeId?: string, text: string}} PlanFinding */
/** @typedef {{targetGitHead: string|null, planner: PlanParticipant, reviewer: PlanParticipant, sizing: unknown, findings: PlanFinding[]}} PlanProvenanceInput */
/** @typedef {PlanProvenanceInput & {packageVersion: string, schemaVersion: number, contractVersion: string}} PlanProvenance */
/** @typedef {{formatVersion: number, contractDigest: string, provenance: PlanProvenance}} FrozenPlan */
/** @typedef {{ok: boolean, digest: string, expectedDigest: string}} FrozenPlanVerdict */

const PLAN_FORMAT_VERSION = 1;

/** @returns {string} the installed package's own version, read once per call so a freeze always names the toolchain that produced it */
function packageVersion() {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

/**
 * Validate `plan` as a contract and, only once it is valid, write it and a
 * sibling plan.json naming its digest and provenance. `plan` supplies
 * `schemaVersion`/`contractVersion` itself; when it does not, this fills in
 * the runner's own current values.
 *
 * contract.json is written before validation runs, because a packet may
 * declare `readFiles: ["contract.json"]` — an execution packet's own file,
 * self-referenced the same way every fixture in this codebase already does.
 * A validation failure removes that file again, so a caller never observes a
 * contract.json that failed its own check.
 *
 * @param {JsonObject} plan
 * @param {{outDir: string, provenance: PlanProvenanceInput}} options
 * @returns {FrozenPlan}
 */
export function freezePlan(plan, { outDir, provenance }) {
  mkdirSync(outDir, { recursive: true });
  const contractPath = join(outDir, "contract.json");
  const raw = /** @type {JsonObject} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    ...plan,
  });
  writeFileSync(contractPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    validateContract(raw, contractPath);
  } catch (error) {
    rmSync(contractPath, { force: true });
    throw error;
  }
  const frozen = /** @type {FrozenPlan} */ ({
    formatVersion: PLAN_FORMAT_VERSION,
    contractDigest: contractDigest(raw),
    provenance: {
      packageVersion: packageVersion(),
      schemaVersion: /** @type {number} */ (raw.schemaVersion),
      contractVersion: /** @type {string} */ (raw.contractVersion),
      targetGitHead: provenance.targetGitHead,
      planner: provenance.planner,
      reviewer: provenance.reviewer,
      sizing: provenance.sizing,
      findings: provenance.findings,
    },
  });
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(frozen, null, 2)}\n`);
  return frozen;
}

/**
 * Recompute contract.json's digest from the bytes on disk and compare it
 * with the digest plan.json recorded at freeze time. A single byte changed
 * in either file — the contract re-authored after review, or the plan
 * record itself tampered with — is a mismatch.
 *
 * @param {string} outDir
 * @returns {FrozenPlanVerdict}
 */
export function verifyFrozenPlan(outDir) {
  const raw = JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8"));
  const plan = JSON.parse(readFileSync(join(outDir, "plan.json"), "utf8"));
  const digest = contractDigest(raw);
  return { ok: digest === plan.contractDigest, digest, expectedDigest: plan.contractDigest };
}
