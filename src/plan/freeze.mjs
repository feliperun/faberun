/**
 * Freezing a plan: the boundary between a session's draft and a contract the
 * engine can execute. `freezePlan` writes the plan's nodes as a validated
 * contract.json, plus a plan.json carrying that contract's digest, the
 * structured spec's path and content digest, the plan's per-phase requirement
 * declarations (which requirement ids each phase satisfies, which planned
 * nodes it assigns, and its one-sentence deliverable), and the full provenance
 * of how it was produced — the two files travel together so a later launch and
 * this record agree on exactly what was reviewed.
 * `verifyFrozenPlan` is the one check that the pair still agree.
 *
 * Nothing here invokes a model or the engine; it only writes and hashes
 * bytes, so freezing a plan can never be mistaken for starting a run.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, contractDigest, validateContract } from "../contract/index.mjs";
import { assertObject, rejectUnknown, requirePacketHash, requireString } from "../contract/assert.mjs";
import { writeJsonAtomic, writeTextAtomic } from "../run/store.mjs";
import { VERIFICATION_LIMITS } from "../contract/verification.mjs";
import { validatePlanPhases } from "./template.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */

/** @typedef {{runtimeId: string, model: string}} PlanParticipant */
/** @typedef {{id: string, severity: "minor"|"major"|"critical", nodeId?: string, text: string}} PlanFinding */
/** @typedef {{targetGitHead: string|null, planner: PlanParticipant, reviewer: PlanParticipant, sizing: unknown, findings: PlanFinding[]}} PlanProvenanceInput */
/** @typedef {PlanProvenanceInput & {packageVersion: string, schemaVersion: number, contractVersion: string}} PlanProvenance */
/** @typedef {{id: string, requirementIds: string[], nodeIds?: string[], deliverable: string}} PlanPhase */
/** @typedef {{path: string, digest: string}} PlanSpecIdentity */
/** @typedef {{formatVersion: number, contractDigest: string, spec?: PlanSpecIdentity, phases?: PlanPhase[], provenance: PlanProvenance}} FrozenPlan */
/** @typedef {{ok: boolean, digest: string, expectedDigest: string}} FrozenPlanVerdict */
/** @typedef {{scripts?: Record<string, string>, verificationCandidates: {argv: string[], measuredMs: number}[]}} MeasuredFacts */

const PLAN_FORMAT_VERSION = 1;

/**
 * The margin a frozen verification timeout keeps over its measured duration.
 * No measurement behind the number itself: it is the spec's (RM-057), and a
 * timeout only bounds a failure, so a passing command never waits for it.
 */
const MEASURED_TIMEOUT_MARGIN = 1.5;

/** `node --test` options that run a subset of the files they name. */
const FILTER_OPTIONS = ["--test-name-pattern", "--test-skip-pattern", "--test-only", "--test-shard"];

/** `node` options whose value is the next argument, so it is not a path. */
const NODE_VALUE_OPTIONS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout"]);

/**
 * The `node --test <dir>` candidates one path argument includes: a directory
 * includes itself and everything below it, and a glob includes the
 * directories below its literal prefix only when it descends (`test/*` +
 * `/…`); `test/*.test.mjs` names top-level files no candidate measured.
 *
 * @param {string} arg
 * @param {string[]} directories
 * @returns {string[]}
 */
function includedDirectories(arg, directories) {
  const path = arg.replace(/^\.\//u, "").replace(/\/+$/u, "");
  const wildcard = path.search(/[*?[]/u);
  if (wildcard < 0) return directories.filter((directory) => directory === path || directory.startsWith(`${path}/`));
  const base = path.slice(0, path.lastIndexOf("/", wildcard));
  if (!path.slice(wildcard).includes("/")) return [];
  return directories.filter((directory) => base === "" || directory.startsWith(`${base}/`));
}

/**
 * What repo facts measured for a verification command: its own candidate, or
 * the sum of the `node --test <dir>` candidates it includes, `npm test`
 * resolved through the `test` script. A lower bound when the command also
 * runs files no candidate measured; null when it includes nothing measured.
 *
 * @param {string[]} argv
 * @param {MeasuredFacts} facts
 * @returns {number|null}
 */
function measuredMsFor(argv, facts) {
  const candidates = facts.verificationCandidates;
  const exact = candidates.find((candidate) => candidate.argv.join(" ") === argv.join(" "));
  if (exact) return exact.measuredMs;
  const npmTest = argv[0] === "npm" && ["test", "run test"].includes(argv.slice(1).join(" "));
  if (npmTest && typeof facts.scripts?.test === "string") return measuredMsFor(facts.scripts.test.trim().split(/\s+/u), facts);
  if (argv[0] !== "node" || argv[1] !== "--test") return null;
  // A filtered run measures nothing a directory candidate measured.
  if (argv.some((arg) => FILTER_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)))) return null;
  const measured = new Map(candidates
    .filter((candidate) => candidate.argv.length === 3 && candidate.argv[0] === "node" && candidate.argv[1] === "--test")
    .map((candidate) => [candidate.argv[2].replace(/\/+$/u, ""), candidate.measuredMs]));
  /** @type {string[]} */
  const paths = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (NODE_VALUE_OPTIONS.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("-")) paths.push(argv[index]);
  }
  const included = new Set((paths.length ? paths : ["test"]).flatMap((path) => includedDirectories(path, [...measured.keys()])));
  if (!included.size) return null;
  return [...included].reduce((sum, directory) => sum + /** @type {number} */ (measured.get(directory)), 0);
}

/**
 * Refuse a contract whose verification timeout sits under
 * `MEASURED_TIMEOUT_MARGIN` times what repo facts measured for the command,
 * and name a command no legal timeout can cover, so the plan is contested
 * with the advice to split it. RM-057, measured on the Campaign Brief run:
 * a gate frozen at 120s against parts measured at 178,904 ms and 246,955 ms.
 *
 * @param {import("../contract/index.mjs").ValidatedContract} contract
 * @param {MeasuredFacts} facts
 * @returns {void}
 */
export function assertTimeoutsCoverMeasured(contract, facts) {
  const commands = [
    ...contract.nodes.flatMap((node) => node.taskPacket.verification ?? []),
    ...contract.sharedVerification ?? [],
    ...contract.finalVerification ?? [],
  ];
  const problems = new Set();
  for (const command of commands) {
    const measuredMs = measuredMsFor(command.argv, facts);
    if (measuredMs === null) continue;
    const timeoutSec = command.timeoutSec ?? 120;
    const requiredSec = Math.ceil((measuredMs * MEASURED_TIMEOUT_MARGIN) / 1_000);
    const shown = `${command.argv.join(" ")} measured ${(measuredMs / 1_000).toFixed(1)}s`;
    if (requiredSec > VERIFICATION_LIMITS.maxTimeoutSec) {
      problems.add(`${shown}, and ${MEASURED_TIMEOUT_MARGIN} times that passes the ${VERIFICATION_LIMITS.maxTimeoutSec}s maxTimeoutSec: split it into commands that each fit`);
    } else if (timeoutSec < requiredSec) {
      problems.add(`verification ${command.argv.join(" ")} has timeoutSec ${timeoutSec}s, under ${MEASURED_TIMEOUT_MARGIN} times its measured ${(measuredMs / 1_000).toFixed(1)}s: raise it to at least ${requiredSec}s`);
    }
  }
  if (problems.size) throw new TypeError(`verification timeouts do not cover their measured durations: ${[...problems].join("; ")}`);
}

/** @returns {string} the installed package's own version, read once per call so a freeze always names the toolchain that produced it */
function packageVersion() {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

/**
 * Nodes inherit the requirement ids of the phase declaration that names them.
 * The frozen contract preserves them per node, so the engine can stamp them
 * onto the node's accepted result without the worker packet or the worker ever
 * declaring one. The current `{id, requirementIds, nodeIds, deliverable}`
 * declaration names its nodes outright; the legacy
 * `{id, requirementIds, deliverable}` shape still resolves by the node's
 * execution `phase`, so a record frozen before node assignment existed keeps
 * reading. A node no declaration names, or a declaration that declares no ids,
 * leaves it unstamped. Nodes are re-listed rather than mutated in place, so
 * the caller's plan keeps the shape it was reviewed with.
 *
 * @param {unknown} nodes
 * @param {PlanPhase[]} phases
 * @returns {unknown} the node list with the inherited ids stamped on
 */
function stampPhaseRequirementIds(nodes, phases) {
  if (!Array.isArray(nodes)) return nodes;
  /** @type {Map<string, string[]>} */
  const byNodeId = new Map();
  /** @type {Map<string, string[]>} */
  const byExecutionPhase = new Map();
  for (const phase of phases) {
    if (phase.requirementIds.length === 0) continue;
    if (phase.nodeIds === undefined) {
      byExecutionPhase.set(phase.id, phase.requirementIds);
      continue;
    }
    for (const nodeId of phase.nodeIds) byNodeId.set(nodeId, phase.requirementIds);
  }
  return nodes.map((node) => {
    const record = /** @type {Record<string, unknown>} */ (node && typeof node === "object" ? node : {});
    const byId = typeof record.id === "string" ? byNodeId.get(record.id) : undefined;
    const inherited = byId ?? (typeof record.phase === "string" ? byExecutionPhase.get(record.phase) : undefined);
    return inherited ? { ...record, requirementIds: [...inherited] } : node;
  });
}

/**
 * The planned node ids a declaration set is checked against, when `plan.nodes`
 * is a usable list. A non-array nodes field yields undefined, which leaves the
 * assignment checks to `validateContract`'s own refusal.
 *
 * @param {unknown} nodes
 * @returns {string[]|undefined}
 */
function plannedNodeIdsOf(nodes) {
  if (!Array.isArray(nodes)) return undefined;
  /** @type {string[]} */
  const ids = [];
  for (const node of nodes) {
    const id = /** @type {Record<string, unknown>|undefined} */ (node && typeof node === "object" ? node : undefined)?.id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * The spec identity a frozen plan records, shape-checked before anything is
 * written. Absent is legal so a caller that predates spec identity keeps
 * freezing; a plan without it is refused by the Campaign Brief instead.
 *
 * @param {unknown} spec
 * @returns {PlanSpecIdentity|undefined}
 */
function specIdentityOf(spec) {
  if (spec === undefined) return undefined;
  assertObject(spec, "spec");
  const record = /** @type {Record<string, unknown>} */ (spec);
  rejectUnknown(record, new Set(["path", "digest"]), "spec");
  requireString(record.path, "spec.path");
  requirePacketHash(record.digest, "spec.digest");
  return { path: /** @type {string} */ (record.path), digest: /** @type {string} */ (record.digest) };
}

/**
 * The SHA-256 of a file's exact bytes: the independent digest a frozen plan's
 * `plan.json.sha256` sidecar carries, recomputable by a reader without parsing
 * the JSON.
 *
 * @param {string} path
 * @returns {string}
 */
export function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The SHA-256 of a UTF-8 string, the same digest `fileDigest` computes for the
 * exact bytes a reader sees. Used for the structured spec's content digest.
 *
 * @param {string} text
 * @returns {string}
 */
export function contentDigest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Write the final frozen plan record and the `plan.json.sha256` sidecar over
 * those exact bytes. The digest is taken from the file after it is written, so
 * it always covers what a reader will read; the caller must not rewrite
 * plan.json once this returns.
 *
 * @param {string} outDir
 * @param {FrozenPlan} record the final record, status and approval included
 * @returns {FrozenPlan}
 */
export function writeFrozenPlanRecord(outDir, record) {
  const planPath = join(outDir, "plan.json");
  writeJsonAtomic(planPath, record);
  writeTextAtomic(join(outDir, "plan.json.sha256"), `${fileDigest(planPath)}\n`);
  return record;
}

/**
 * Validate `plan` as a contract and, only once it is valid, write it and a
 * sibling plan.json naming its digest, its spec identity and its provenance.
 * `plan` supplies `schemaVersion`/`contractVersion` itself; when it does not,
 * this fills in the runner's own current values.
 *
 * contract.json is written before validation runs, because a packet may
 * declare `readFiles: ["contract.json"]` — an execution packet's own file,
 * self-referenced the same way every fixture in this codebase already does.
 * A validation failure removes that file again, so a caller never observes a
 * contract.json that failed its own check.
 *
 * `options.phases` carries the plan's per-phase declarations — each phase's
 * requirementIds, nodeIds and deliverable — validated by the same check
 * validatePlanOutput applies, and recorded on plan.json verbatim.
 * `options.spec` carries the structured spec's path and content digest; when
 * given, both are recorded so a reader can pin the plan to the exact spec it
 * was planned from.
 *
 * @param {JsonObject} plan
 * `options.facts` carries repo facts' measured durations; given, a
 * verification timeout that does not cover one is refused.
 *
 * @param {{outDir: string, provenance: PlanProvenanceInput, phases?: import("./template.mjs").PlanPhase[], spec?: PlanSpecIdentity, facts?: MeasuredFacts}} options
 * @returns {FrozenPlan}
 */
export function freezePlan(plan, { outDir, provenance, phases, spec, facts }) {
  // Shape-checked before anything is written, so a malformed declaration
  // leaves the outDir exactly as it was — the same failure discipline as the
  // validateContract rollback below. A declaration in the nodeIds shape must
  // cover every planned node exactly once; a legacy declaration that names no
  // requirements passes here, its gap being validatePlanOutput's finding to
  // report rather than a reason to refuse the freeze.
  const phaseDeclarations = validatePlanPhases(phases, plannedNodeIdsOf(plan.nodes));
  const specIdentity = specIdentityOf(spec);
  mkdirSync(outDir, { recursive: true });
  const contractPath = join(outDir, "contract.json");
  const raw = /** @type {JsonObject} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    ...plan,
    // Listed again, not mutated in place, so the caller's plan object keeps
    // the shape it was reviewed with.
    ...(phaseDeclarations ? { nodes: stampPhaseRequirementIds(plan.nodes, phaseDeclarations) } : {}),
  });
  writeJsonAtomic(contractPath, raw);
  try {
    const validated = validateContract(raw, contractPath);
    if (facts) assertTimeoutsCoverMeasured(validated, facts);
  } catch (error) {
    rmSync(contractPath, { force: true });
    throw error;
  }
  const frozen = /** @type {FrozenPlan} */ ({
    formatVersion: PLAN_FORMAT_VERSION,
    contractDigest: contractDigest(raw),
    // The spec's path and digest pin the plan to the exact structured spec it
    // was drafted from, so the brief can verify the pair before reading facts.
    ...(specIdentity === undefined ? {} : { spec: specIdentity }),
    // The declarations ride on the record rather than the contract (the
    // contract schema takes no extra field), so the traceability a reviewer
    // saw is readable straight off plan.json, nodeIds included.
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
