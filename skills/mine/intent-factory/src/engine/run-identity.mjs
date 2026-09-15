/**
 * Proving a resumed run is the same run.
 *
 * A run is pinned to a git head, a dirty-tree fingerprint, a hash per task
 * packet, the agent-guidance files in force and the harness versions observed.
 * `assertSourceUnchanged` is where a resume against a moved head, an edited
 * packet or a different harness build is refused: continuing there would mean
 * finishing work nobody approved, on evidence that no longer holds.
 *
 * `probeRuntimeVersionStable` retries because a cold CLI sometimes reports no
 * version on its first call, and a missing version is indistinguishable from a
 * changed one.
 */
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, probeRuntime } from "../harnesses/index.mjs";
import { appendJsonl, writeJsonAtomic } from "../run/store.mjs";
import { blockingChecks, environmentPreflight, reachableRuntimes } from "../host/preflight.mjs";
import { captureSourceIdentity } from "../repo/source-identity.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { stableJson } from "../util.mjs";
import { validateRunMetadata } from "../contract/snapshot.mjs";
import { contractDigest } from "../contract/index.mjs";

/** @typedef {import("../harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("../cli.mjs").LockHandle} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */

/**
 * @param {LockHandle} lock
 * @param {SourceIdentity} sourceIdentity
 * @param {{identityWarnings?: string[], relaunchCount?: number, lastRelaunchProgressAt?: string|null, attention?: {code: string, message: string, at: string}|null}} [resume]
 * @param {string} [integrationRef]
 * @returns {RunMetadata}
 */
export function createRunMetadata(lock, sourceIdentity, resume = {}, integrationRef = undefined) {
  const current = lock.current;
  // Both frozen records are carried forward from the run that already exists.
  // `driveRun` rewrites run.json on every controller start, so recomputing
  // them from the current tree would let a resume or a heartbeat relaunch
  // reinterpret history against a tree that has since drifted.
  const stored = readStoredRunRecords(sourceIdentity);
  const digest = stored.contractDigest ?? readContractDigest(sourceIdentity);
  const scopeDecision = stored.scopeDecision ?? {
    at: current.startedAt,
    base: sourceIdentity.gitHead ?? null,
    dirtyTreeFingerprint: sourceIdentity.dirtyTreeFingerprint ?? null,
  };
  const metadata = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: current.pid,
    processStartToken: current.processStartToken,
    startedAt: current.startedAt,
    sourceIdentity,
    ...(integrationRef ? { integrationRef } : {}),
    ...(resume.identityWarnings?.length ? { identityWarnings: resume.identityWarnings } : {}),
    // The supervisor's relaunch guard and its durable attention record are
    // carried through a controller restart by the controller itself; a field
    // not named here is dropped by the fixed field list above.
    ...(resume.relaunchCount !== undefined ? { relaunchCount: resume.relaunchCount } : {}),
    ...(resume.lastRelaunchProgressAt !== undefined ? { lastRelaunchProgressAt: resume.lastRelaunchProgressAt } : {}),
    ...(resume.attention !== undefined ? { attention: resume.attention } : {}),
    ...(digest !== null ? { contractDigest: digest } : {}),
    // The one-shot auto-retry ledger is durable across a controller restart
    // for the same reason: an in-memory flag would grant a fresh retry.
    ...(stored.autoRetries !== undefined ? { autoRetries: stored.autoRetries } : {}),
    scopeDecision,
  };
  return validateRunMetadata(metadata);
}

/**
 * The run directory the source identity names: the run lives at
 * `<cwd>/.runs/<contractId>`, which is derivable from the identity alone.
 *
 * @param {SourceIdentity} sourceIdentity
 * @returns {string|null}
 */
function runDirFor(sourceIdentity) {
  if (!sourceIdentity.cwd || !sourceIdentity.contractId) return null;
  return join(sourceIdentity.cwd, ".runs", sourceIdentity.contractId);
}

/**
 * The records a prior run.json already froze, when one exists. On creation
 * this is empty; on every later metadata rewrite it is the source of truth.
 *
 * @param {SourceIdentity} sourceIdentity
 * @returns {{contractDigest?: string, scopeDecision?: import("../contract/index.mjs").ScopeDecision, autoRetries?: Record<string, {code: string, at: string}>}}
 */
function readStoredRunRecords(sourceIdentity) {
  const runDir = runDirFor(sourceIdentity);
  if (!runDir) return {};
  /** @type {Record<string, unknown>} */
  let record;
  try {
    record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  } catch {
    return {};
  }
  return {
    ...(record.contractDigest !== undefined ? { contractDigest: /** @type {string} */ (record.contractDigest) } : {}),
    ...(record.scopeDecision !== undefined ? { scopeDecision: /** @type {import("../contract/index.mjs").ScopeDecision} */ (record.scopeDecision) } : {}),
    ...(record.autoRetries !== undefined ? { autoRetries: /** @type {Record<string, {code: string, at: string}>} */ (record.autoRetries) } : {}),
  };
}

/**
 * The digest of the stored contract.json, computed at creation and only then:
 * the contract bytes are frozen at launch, and a persisted load compares
 * against this record rather than against the mutated tree.
 *
 * @param {SourceIdentity} sourceIdentity
 * @returns {string|null}
 */
function readContractDigest(sourceIdentity) {
  const runDir = runDirFor(sourceIdentity);
  if (!runDir) return null;
  const raw = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  return contractDigest(raw);
}
const HARNESS_PROBE_RETRIES = 2;
const HARNESS_PROBE_RETRY_BACKOFF_MS = 250;
/**
 * Probe a runtime version, retrying transient unavailability so a loaded host
 * is never misread as a changed harness. Only a concrete version or final
 * unavailability leaves this function.
 *
 * @param {import("../harnesses/index.mjs").HarnessRuntime & {capabilities?: unknown}} runtime
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function probeRuntimeVersionStable(runtime, cwd) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await probeRuntime(runtime, { cwd, timeoutSec: 5 });
    if (result.version !== null || attempt >= HARNESS_PROBE_RETRIES) return result.version ?? null;
    await new Promise((resolveRetry) => setTimeout(resolveRetry, HARNESS_PROBE_RETRY_BACKOFF_MS * 2 ** attempt));
  }
}
/**
 * Capture the run's source identity, including one version-only probe per
 * distinct routed runtime (a local binary call, no model tokens) so a later
 * resume can refuse a harness that was upgraded or broke mid-campaign.
 *
 * @param {ValidatedContract} contract
 * @param {Map<string, import("../repo/workspace.mjs").WorkspaceScopeBoundary>} scopeBoundaries
 * @returns {Promise<SourceIdentity>}
 */
export async function captureRunIdentity(contract, scopeBoundaries) {
  const runtimes = reachableRuntimes(contract);
  const versionsPromise = Promise.all([...runtimes.entries()].map(async ([id, { runtime }]) => {
    return [id, await probeRuntimeVersionStable(runtime, contract.cwd)];
  }));
  const ignorePaths = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.files))];
  const ignoreRoots = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.roots))];
  const identity = captureSourceIdentity(contract, {}, { ignorePaths, ignoreRoots });
  const versions = await versionsPromise;
  return { ...identity, harnessVersions: Object.fromEntries(versions) };
}
/**
 * Compare the recorded source identity with the current one. A HEAD that
 * descends from the recorded one is accepted and recorded — workers and the
 * orchestrator commit between attempts, so a retry in place expects the branch
 * to have moved on — while a non-descendant HEAD is still drift. A dirty-tree
 * fingerprint mismatch is only a warning: the fingerprint covers the whole
 * tree, so any committed work between attempts changes it.
 *
 * @param {SourceIdentity|undefined} expected
 * @param {SourceIdentity|undefined} actual
 * @returns {{warnings: string[]}} warnings to surface in status
 */
export function assertSourceUnchanged(expected, actual) {
  const fields = ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "harnessVersions"];
  /** @type {string[]} */
  const warnings = [];
  for (const field of fields) {
    const expectedRecord = /** @type {Record<string, unknown>|undefined} */ (expected);
    const actualRecord = /** @type {Record<string, unknown>|undefined} */ (actual);
    if (expectedRecord?.[field] === undefined) throw new Error(`source identity is incomplete; resume refused`);
    if (field === "harnessVersions") {
      const expectedVersions = /** @type {Record<string, string|null>} */ (expectedRecord?.[field] ?? {});
      const actualVersions = /** @type {Record<string, string|null>} */ (actualRecord?.[field] ?? {});
      const ids = new Set([...Object.keys(expectedVersions), ...Object.keys(actualVersions)]);
      for (const id of ids) {
        const expectedVersion = expectedVersions[id] ?? null;
        const actualVersion = actualVersions[id] ?? null;
        if (expectedVersion === actualVersion) continue;
        if (expectedVersion === null || actualVersion === null) {
          throw new Error(`harness probe unavailable for ${id}; resume refused`);
        }
        throw new Error("source drift detected in harnessVersions; resume refused");
      }
      continue;
    }
    if (field === "gitHead" && stableJson(expectedRecord?.gitHead ?? null) !== stableJson(actualRecord?.gitHead ?? null)) {
      const expectedHead = typeof expectedRecord?.gitHead === "string" ? expectedRecord.gitHead : null;
      const actualHead = typeof actualRecord?.gitHead === "string" ? actualRecord.gitHead : null;
      if (expectedHead && actualHead && isDescendantHead(expected?.cwd, expectedHead, actualHead)) continue;
      throw new Error(`source drift detected in gitHead; resume refused`);
    }
    if (field === "dirtyTreeFingerprint" && stableJson(expectedRecord?.[field] ?? null) !== stableJson(actualRecord?.[field] ?? null)) {
      warnings.push("source tree fingerprint changed since the run started; work committed between attempts is expected and the run continues on the current tree");
      continue;
    }
    if (stableJson(expectedRecord?.[field] ?? null) !== stableJson(actualRecord?.[field] ?? null)) {
      throw new Error(`source drift detected in ${field}; resume refused`);
    }
  }
  return { warnings };
}
/**
 * Whether `head` is a descendant of `recorded` (or the same commit).
 *
 * @param {string|undefined} cwd
 * @param {string} recorded
 * @param {string} head
 * @returns {boolean}
 */
export function isDescendantHead(cwd, recorded, head) {
  if (!cwd) return false;
  const result = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", recorded, head], { encoding: "utf8" });
  return result.status === 0;
}
/**
 * @param {Map<string, NodeSnapshot>} states
 * @returns {string}
 */
export function statesFingerprint(states) {
  return [...states.values()].map((state) => `${state.id}:${state.status}:${state.phase}:${state.attempt ?? 0}:${state.revisions ?? 0}`).join("|");
}
/**
 * @param {ValidatedContract} contract
 * @returns {ValidatedContract}
 */
export function serializableContract(contract) {
  const { warnings, ...rest } = contract;
  return {
    ...rest,
    warnings,
    nodes: contract.nodes.map((node) => {
      const copy = /** @type {Record<string, unknown>} */ ({ ...node });
      delete copy.prompt;
      delete copy.promptFile;
      delete copy.taskPacketFile;
      return /** @type {ValidatedNode} */ (copy);
    }),
  };
}
/**
 * The dispatch gate: no node starts until the host can carry the run. The
 * report is written as run evidence either way, and a blocking failure leaves
 * the materialized run untouched — the operator fixes the host and resumes,
 * so a run is never silently restarted and already-paid nodes are not redone.
 *
 * @param {ValidatedContract} contract
 * @param {string} runDir
 * @param {SourceIdentity|undefined} sourceIdentity
 */
export function assertEnvironmentReady(contract, runDir, sourceIdentity) {
  const report = environmentPreflight({
    cwd: contract.cwd,
    runtimes: reachableRuntimes(contract),
    harnessVersions: sourceIdentity?.harnessVersions ?? {},
  });
  const evidence = {
    schemaVersion: report.schemaVersion,
    contractVersion: INTENT_FACTORY_VERSION,
    at: new Date().toISOString(),
    contractId: contract.id,
    ok: report.ok,
    checks: report.checks,
  };
  writeJsonAtomic(join(runDir, "env-preflight.json"), evidence);
  if (report.ok) return;
  appendJsonl(join(runDir, "events.jsonl"), { type: "run.env-preflight-failed", ...evidence });
  const blocking = blockingChecks(report).map((check) => `${check.name}: ${check.detail}`).join(" · ");
  throw Object.assign(new Error(`env_preflight_failed: ${blocking} · the run stays resumable: fix the environment and resume ${runDir}`), { code: "env_preflight_failed" });
}
