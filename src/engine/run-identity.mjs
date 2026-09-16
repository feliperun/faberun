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
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, probeRuntime } from "../harnesses/index.mjs";
import { appendJsonl, writeJsonAtomic } from "../run/store.mjs";
import { blockingChecks, environmentPreflight, reachableRuntimes } from "../host/preflight.mjs";
import { captureSourceIdentity } from "../repo/source-identity.mjs";
import { boundedGitSync } from "../repo/worktree.mjs";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
 * @param {{identityWarnings?: string[], relaunchCount?: number, lastRelaunchProgressAt?: string|null, attention?: {code: string, message: string, at: string}|null, controllerIdentity?: import("../contract/index.mjs").ControllerIdentity}} [resume]
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
  const controllerIdentity = stored.controllerIdentity ?? resume.controllerIdentity ?? defaultControllerIdentity();
  const scopeDecision = stored.scopeDecision ?? {
    at: current.startedAt,
    base: sourceIdentity.gitHead ?? null,
    dirtyTreeFingerprint: sourceIdentity.dirtyTreeFingerprint ?? null,
  };
  const metadata = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: current.pid,
    processStartToken: current.processStartToken,
    startedAt: current.startedAt,
    sourceIdentity,
    controllerIdentity,
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
 * @returns {{contractDigest?: string, scopeDecision?: import("../contract/index.mjs").ScopeDecision, autoRetries?: Record<string, {code: string, at: string}>, controllerIdentity?: import("../contract/index.mjs").ControllerIdentity}}
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
    ...(record.controllerIdentity !== undefined ? { controllerIdentity: /** @type {import("../contract/index.mjs").ControllerIdentity} */ (record.controllerIdentity) } : {}),
  };
}

/**
 * The digest of the contract stored in a run directory, computed over the
 * stored bytes. The controller writes this file and records this digest at
 * creation; a later reader must read the same file for the same answer,
 * because the in-memory validated contract carries `undefined` fields the
 * stored JSON dropped, so hashing the two objects disagrees.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function storedContractDigest(runDir) {
  const raw = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  return contractDigest(raw);
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
  return storedContractDigest(runDir);
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
 * The base ref a *creation* was launched with, set by the CLI entry before it
 * calls `runContract`. It is a module rather than an option because
 * `runContract` reads the contract itself and threads no base ref; a resume
 * never sets it, so the identity a resume captures is the checkout's HEAD as
 * before.
 *
 * @type {string|null}
 */
let pendingLaunchBaseRef = null;

/**
 * @param {string|undefined|null} baseRef
 * @returns {void}
 */
export function setLaunchBaseRef(baseRef) {
  pendingLaunchBaseRef = baseRef ?? null;
}

/**
 * The base ref a run was launched against, when it was launched with
 * `--base-ref`. A run recorded before this field existed, or launched
 * without the flag, has none — a resume of that run keeps comparing against
 * the checkout's own HEAD.
 *
 * @param {RunMetadata|undefined} metadata
 * @returns {string|null}
 */
export function recordedBaseRef(metadata) {
  const baseRef = metadata?.sourceIdentity?.baseRef;
  return typeof baseRef === "string" && baseRef.length > 0 ? baseRef : null;
}

/**
 * Capture the run's source identity, including one version-only probe per
 * distinct routed runtime (a local binary call, no model tokens) so a later
 * resume can refuse a harness that was upgraded or broke mid-campaign.
 *
 * @param {ValidatedContract} contract
 * @param {Map<string, import("../repo/workspace.mjs").WorkspaceScopeBoundary>} scopeBoundaries
 * @param {string} [baseRef] the ref the run is cut from; defaults to the CLI's `--base-ref`
 * @returns {Promise<SourceIdentity>}
 */
export async function captureRunIdentity(contract, scopeBoundaries, baseRef = pendingLaunchBaseRef ?? undefined) {
  const runtimes = reachableRuntimes(contract);
  const versionsPromise = Promise.all([...runtimes.entries()].map(async ([id, { runtime }]) => {
    return [id, await probeRuntimeVersionStable(runtime, contract.cwd)];
  }));
  const ignorePaths = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.files))];
  const ignoreRoots = [...new Set([...scopeBoundaries.values()].flatMap((boundary) => boundary.roots))];
  const identity = captureSourceIdentity(contract, {}, { ignorePaths, ignoreRoots, ...(baseRef ? { baseRef } : {}) });
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
  const result = boundedGitSync(["-C", cwd, "merge-base", "--is-ancestor", recorded, head], { encoding: "utf8" });
  return result.status === 0;
}
/**
 * The controller snapshot a freshly created run is pinned to when the caller
 * names none: the source tree of the controller that is running now.
 *
 * @returns {string}
 */
export function controllerSnapshotPath() {
  return fileURLToPath(new URL("../", import.meta.url));
}
/**
 * Hash a controller executable snapshot: a single file, or every file below a
 * directory, in sorted relative-path order, so two reads of an unchanged
 * snapshot always agree and any edit changes the sha.
 *
 * @param {string} snapshotPath
 * @returns {string}
 */
function hashControllerSnapshot(snapshotPath) {
  const hash = createHash("sha256");
  if (lstatSync(snapshotPath).isDirectory()) {
    for (const file of walkControllerFiles(snapshotPath)) {
      hash.update(relative(snapshotPath, file).split(sep).join("/"));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  } else {
    hash.update(readFileSync(snapshotPath));
  }
  return hash.digest("hex");
}
/**
 * @param {string} root
 * @returns {string[]}
 */
function walkControllerFiles(root) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".runs") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...walkControllerFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
/**
 * The `{path, sha}` identity of a controller snapshot. `path` is the file or
 * directory a launch would execute from; `sha` is its content digest.
 *
 * @param {string} snapshotPath
 * @returns {import("../contract/index.mjs").ControllerIdentity}
 */
export function controllerSnapshotIdentity(snapshotPath) {
  return { path: snapshotPath, sha: hashControllerSnapshot(snapshotPath) };
}
/**
 * @returns {import("../contract/index.mjs").ControllerIdentity}
 */
export function defaultControllerIdentity() {
  return controllerSnapshotIdentity(controllerSnapshotPath());
}
/**
 * The check the next chain node runs before launching N+1: the executable
 * snapshot at the recorded path must still hash to the recorded sha. A path
 * plus sha is not enough on its own because the path can be rewritten under a
 * recorded sha.
 *
 * @param {import("../contract/index.mjs").ControllerIdentity} identity
 * @param {string} [snapshotPath]
 * @returns {import("../contract/index.mjs").ControllerIdentity}
 */
export function verifyControllerIdentity(identity, snapshotPath = identity.path) {
  let actual;
  try {
    actual = controllerSnapshotIdentity(snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`controller snapshot at ${identity.path} is unreadable: ${message}`), { code: "controller_snapshot_missing" });
  }
  if (actual.sha !== identity.sha) {
    throw Object.assign(
      new Error(`controller snapshot at ${identity.path} does not match its recorded sha ${identity.sha}; refresh the snapshot as a declared human boundary`),
      { code: "controller_snapshot_changed" },
    );
  }
  return actual;
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
    contractVersion: CONTRACT_VERSION,
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
