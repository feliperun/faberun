/**
 * Freezing a plan: the boundary between a session's draft and a contract the
 * engine can execute. `freezePlan` writes the plan's nodes as a validated
 * contract.json, plus a plan.json carrying that contract's digest, the plan's
 * per-phase requirement declarations (which requirement ids each phase
 * satisfies and its one-sentence deliverable), and the full provenance of how
 * it was produced — the two files travel together so a later launch and this
 * record agree on exactly what was reviewed.
 * `verifyFrozenPlan` is the one check that the pair still agree.
 *
 * Nothing here invokes a model or the engine; it only writes and hashes
 * bytes, so freezing a plan can never be mistaken for starting a run.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, contractDigest, validateContract } from "../contract/index.mjs";
import { writeJsonAtomic } from "../run/store.mjs";
import { validatePlanPhases } from "./template.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */

/** @typedef {{runtimeId: string, model: string}} PlanParticipant */
/** @typedef {{id: string, severity: "minor"|"major"|"critical", nodeId?: string, text: string}} PlanFinding */
/** @typedef {{targetGitHead: string|null, planner: PlanParticipant, reviewer: PlanParticipant, sizing: unknown, findings: PlanFinding[]}} PlanProvenanceInput */
/** @typedef {PlanProvenanceInput & {packageVersion: string, schemaVersion: number, contractVersion: string}} PlanProvenance */
/** @typedef {{id: string, requirementIds: string[], deliverable: string}} PlanPhase */
/** @typedef {{formatVersion: number, contractDigest: string, phases?: PlanPhase[], provenance: PlanProvenance}} FrozenPlan */
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
 * `options.phases` carries the plan's per-phase requirement declarations —
 * each phase's requirementIds|deliverable pair — validated by the same check
 * validatePlanOutput applies, and recorded on plan.json verbatim.
 *
 * @param {JsonObject} plan
 * @param {{outDir: string, provenance: PlanProvenanceInput, phases?: import("./template.mjs").PlanPhase[]}} options
 * @returns {FrozenPlan}
 */
export function freezePlan(plan, { outDir, provenance, phases }) {
  // Shape-checked before anything is written, so a malformed declaration
  // leaves the outDir exactly as it was — the same failure discipline as the
  // validateContract rollback below. A phase that declares no requirementIds
  // passes here: the gap is validatePlanOutput's finding to report, not a
  // reason to refuse the freeze.
  const phaseDeclarations = validatePlanPhases(phases);
  mkdirSync(outDir, { recursive: true });
  const contractPath = join(outDir, "contract.json");
  const raw = /** @type {JsonObject} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    ...plan,
  });
  writeJsonAtomic(contractPath, raw);
  try {
    validateContract(raw, contractPath);
  } catch (error) {
    rmSync(contractPath, { force: true });
    throw error;
  }
  const frozen = /** @type {FrozenPlan} */ ({
    formatVersion: PLAN_FORMAT_VERSION,
    contractDigest: contractDigest(raw),
    // The declarations ride on the record rather than the contract (the
    // contract schema takes no extra field), so the traceability a reviewer
    // saw is readable straight off plan.json.
    ...(phaseDeclarations === undefined ? {} : { phases: phaseDeclarations }),
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
  // Atomic: the pipeline rewrites this file with its status straight after, and a
  // reader polling for the frozen plan must never see a torn or half-written one
  // (measured 2026-09-17: eval case D25 read a statusless plan.json on a slow runner).
  writeJsonAtomic(join(outDir, "plan.json"), frozen);
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
