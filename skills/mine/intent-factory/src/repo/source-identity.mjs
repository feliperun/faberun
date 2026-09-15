/**
 * The identity a run is pinned to: the git head it started from, a fingerprint
 * of the dirty tree, the hash of every task packet, the agent-guidance files in
 * force, and the harness versions observed.
 *
 * This is what makes a resume honest. A run that resumes against a different
 * head, a changed packet or an edited `AGENTS.md` is not the run that was
 * approved, and `validateCompleteSourceIdentity` is where that is refused.
 */
import { Buffer } from "node:buffer";
import { assertObject, rejectUnknown, requireId, requirePacketHash, requireString } from "../contract/assert.mjs";
import { createHash } from "node:crypto";
import { errorCode } from "../util.mjs";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeManagedSignalBlock } from "./signal-block.mjs";

/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {JsonObject|null} expected
 */
export function validateSourceIdentity(value, label, expected = null) {
  assertObject(value, label);
  const allowed = new Set([
    "kind", "id", "campaignId", "contractId", "nodeId", "cwd", "gitHead",
    "dirtyTreeFingerprint", "packetHashes", "harnessVersions",
  ]);
  rejectUnknown(value, allowed, label);
  requireString(value.kind, `${label}.kind`);
  for (const key of ["id", "campaignId", "contractId", "nodeId"]) {
    if (value[key] !== undefined) requireId(value[key], `${label}.${key}`);
  }
  if (value.cwd !== undefined) requireString(value.cwd, `${label}.cwd`);
  for (const key of ["gitHead", "dirtyTreeFingerprint"]) {
    if (value[key] !== undefined && value[key] !== null) requireString(value[key], `${label}.${key}`);
  }
  if (value.packetHashes !== undefined) validateHashMap(value.packetHashes, `${label}.packetHashes`);
  if (value.harnessVersions !== undefined) {
    assertObject(value.harnessVersions, `${label}.harnessVersions`);
    for (const [key, version] of Object.entries(value.harnessVersions)) {
      requireId(key, `${label}.harnessVersions key`);
      if (version !== null) requireString(version, `${label}.harnessVersions.${key}`);
    }
  }
  if (expected) {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) throw new TypeError(`${label}.${key} does not match its source`);
    }
  }
  return /** @type {SourceIdentity} */ ({ ...value });
}
/**
 * @param {{id: string, campaignId: string, cwd: string, nodes: {id: string, packetHash: string}[]}} contract
 * @param {Record<string, string|null>} harnessVersions
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 */
export function captureSourceIdentity(contract, harnessVersions = {}, options = {}) {
  const git = gitIdentity(contract.cwd, options);
  return validateSourceIdentity({
    kind: "run",
    contractId: contract.id,
    campaignId: contract.campaignId,
    cwd: contract.cwd,
    gitHead: git.gitHead,
    dirtyTreeFingerprint: git.dirtyTreeFingerprint,
    packetHashes: Object.fromEntries(contract.nodes.map((node) => [node.id, node.packetHash])),
    harnessVersions,
  }, "run source identity", { kind: "run", contractId: contract.id, campaignId: contract.campaignId });
}
/**
 * @param {JsonObject} value
 */
export function validateCompleteSourceIdentity(value) {
  for (const key of ["cwd", "gitHead", "dirtyTreeFingerprint", "packetHashes", "harnessVersions"]) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`run metadata.sourceIdentity.${key} is required for resume`);
  }
}
/**
 * @param {unknown} value
 * @param {string} label
 */
function validateHashMap(value, label) {
  assertObject(value, label);
  for (const [key, hash] of Object.entries(value)) {
    requireId(key, `${label} key`);
    requirePacketHash(hash, `${label}.${key}`);
  }
}
/**
 * The pathspec that scopes a source-identity read: everything, minus the
 * factory's own run tree, minus the machine-managed AGENTS.md signal, minus
 * whatever the caller declared out of scope.
 *
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 * @returns {string[]}
 */
function sourcePathspec(options = {}) {
  return [
    ".",
    ":(exclude).runs",
    ":(exclude)AGENTS.md",
    ...(options.ignorePaths ?? []).map((path) => `:(exclude)${path}`),
    ...(options.ignoreRoots ?? []).map((path) => `:(exclude)${path}`),
  ];
}

/**
 * The commit a source identity is pinned to. Without `baseRef` this is the
 * checkout's own HEAD, with the unborn-HEAD probe that makes a fresh
 * repository report `null` rather than fail. With `baseRef` it is that ref's
 * sha, so a run can be cut from a landing branch while the operator's tree
 * stays on whatever they were doing.
 *
 * @param {string} cwd
 * @param {string|undefined} baseRef
 * @returns {string|null}
 */
function resolveGitHead(cwd, baseRef) {
  if (baseRef) {
    try {
      return execFileSync("git", ["-C", cwd, "rev-parse", baseRef], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      // An unknown ref resolves to null; the caller decides whether that is fatal.
      return null;
    }
  }
  const headPath = resolve(cwd, ".git", "HEAD");
  let headText = null;
  try { headText = readFileSync(headPath, "utf8").trim(); } catch {
    // A missing or unreadable .git/HEAD leaves headText null; rev-parse below still decides gitHead.
  }
  if (headText?.startsWith("ref: ") === true) {
    try { lstatSync(resolve(cwd, ".git", headText.slice(5))); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; return null; }
  }
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    // Any rev-parse failure (no repo, unborn HEAD, git absent) leaves gitHead null.
    return null;
  }
}

/**
 * The paths the working tree has modified, added or left untracked, ignoring
 * the factory's own `.runs` tree and the machine-managed AGENTS.md signal. A
 * clean tree is `[]`; an unreadable tree is treated as clean because the
 * caller has no dirt to name.
 *
 * @param {string} cwd
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} [options]
 * @returns {string[]}
 */
export function dirtyTreePaths(cwd, options = {}) {
  try {
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...sourcePathspec(options)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status.split("\0").filter(Boolean);
  } catch {
    // Not a repository, or git absent: there is no dirt the launch can name.
    return [];
  }
}

/**
 * Refuse a launch whose base is the checked-out HEAD and whose tree is dirty.
 * The base is what every worktree is cut from, so a dirty tree only matters
 * when it *is* the base: then the validator sees files the worker will never
 * have. A base ref that resolves elsewhere leaves the operator's checkout
 * alone and is always clean enough to launch from.
 *
 * @param {string} cwd
 * @param {string|undefined} baseRef
 * @returns {void}
 */
export function assertLaunchBaseClean(cwd, baseRef) {
  const headSha = resolveGitHead(cwd, undefined);
  const baseSha = baseRef ? resolveGitHead(cwd, baseRef) : headSha;
  if (baseRef && !baseSha) {
    throw Object.assign(new Error(`base ref does not resolve: ${baseRef}`), { code: "base_ref_unresolved" });
  }
  if (!baseSha || !headSha || baseSha !== headSha) return;
  const dirty = dirtyTreePaths(cwd);
  if (dirty.length) {
    const label = baseRef ?? "HEAD";
    throw Object.assign(
      new Error(`refusing to launch against ${label}: the working tree has ${dirty.length} uncommitted path${dirty.length === 1 ? "" : "s"}; commit or stash before running when the cwd HEAD is the base, or pass --base-ref for a different base`),
      { code: "dirty_work_tree" },
    );
  }
}

/**
 * @param {string} cwd
 * @param {{ignorePaths?: string[], ignoreRoots?: string[], baseRef?: string}} options
 * @returns {{gitHead: string|null, dirtyTreeFingerprint: string|null}}
 */
export function gitIdentity(cwd, options = {}) {
  try {
    const pathspec = sourcePathspec(options);
    const gitHead = resolveGitHead(cwd, options.baseRef);
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...pathspec], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const statusText = status.toString("utf8");
    const diff = !gitHead || status.length === 0
      ? Buffer.alloc(0)
      : execFileSync("git", ["-C", cwd, "diff", "--binary", "HEAD", "--", ...pathspec], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const untrackedFiles = statusText.split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3));
    const contents = createHash("sha256");
    for (const relativePath of untrackedFiles) {
      const absolutePath = resolve(cwd, relativePath);
      const metadata = lstatSync(absolutePath);
      contents.update(`${relativePath}\0${metadata.mode}\0`);
      if (metadata.isSymbolicLink()) contents.update(readlinkSync(absolutePath));
      else if (metadata.isFile()) contents.update(readFileSync(absolutePath));
      contents.update("\0");
    }
    return {
      gitHead,
      dirtyTreeFingerprint: createHash("sha256")
        .update(status)
        .update(diff)
        .update(contents.digest())
        .update(agentGuidanceIdentity(cwd))
        .digest("hex"),
    };
  } catch {
    return { gitHead: null, dirtyTreeFingerprint: null };
  }
}
/**
 * Hash AGENTS.md separately so its machine-managed signal may change without
 * hiding edits to human-authored repository guidance.
 *
 * @param {string} cwd
 * @returns {Buffer}
 */
function agentGuidanceIdentity(cwd) {
  const path = resolve(cwd, "AGENTS.md");
  const identity = createHash("sha256").update("AGENTS.md\0");
  try {
    const metadata = lstatSync(path);
    identity.update(`${metadata.mode}\0`);
    if (metadata.isSymbolicLink()) identity.update(`symlink\0${readlinkSync(path)}`);
    else if (metadata.isFile()) identity.update(`file\0${normalizeManagedSignalBlock(readFileSync(path, "utf8"))}`);
    else identity.update("unsupported");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    identity.update("missing");
  }
  return identity.digest();
}
