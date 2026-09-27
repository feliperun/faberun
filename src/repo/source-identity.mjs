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
import { boundedGitSync } from "./worktree.mjs";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeManagedSignalBlock } from "./signal-block.mjs";

/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {{encoding?: "utf8"|"buffer", stdio?: import("node:child_process").StdioOptions}} GitReadOptions */

/**
 * Run one bounded synchronous git read and surface a failure as a throw, so
 * the callers below keep their `try/catch` shape. Every `execFileSync("git")`
 * here went through this helper so a held index lock cannot hang the controller.
 *
 * @param {string[]} args
 * @param {GitReadOptions} [options]
 * @returns {string|Buffer}
 */
function gitSyncOrThrow(args, options = {}) {
  const result = boundedGitSync(args, options);
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`git ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {JsonObject|null} expected
 */
export function validateSourceIdentity(value, label, expected = null) {
  assertObject(value, label);
  const allowed = new Set([
    "kind", "id", "campaignId", "contractId", "nodeId", "cwd", "gitHead",
    "dirtyTreeFingerprint", "packetHashes", "harnessVersions", "baseRef",
  ]);
  rejectUnknown(value, allowed, label);
  requireString(value.kind, `${label}.kind`);
  for (const key of ["id", "campaignId", "contractId", "nodeId"]) {
    if (value[key] !== undefined) requireId(value[key], `${label}.${key}`);
  }
  if (value.cwd !== undefined) requireString(value.cwd, `${label}.cwd`);
  for (const key of ["gitHead", "dirtyTreeFingerprint", "baseRef"]) {
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
 * @param {{ignorePaths?: string[], ignoreRoots?: string[], baseRef?: string}} options
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
    baseRef: options.baseRef ?? null,
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
 * factory's own run tree, minus `AGENTS.md` (whose managed signal block git
 * cannot tell apart from a human edit; `agentGuidanceDirty` and
 * `agentGuidanceIdentity` check its content directly instead), minus
 * whatever the caller declared out of scope.
 *
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} options
 * @returns {string[]}
 */
function sourcePathspec(options = {}) {
  return [
    ".",
    ":(exclude).runs",
    // The planning pipeline's own scratch relay (src/plan/pipeline.mjs's
    // PLAN_SCRATCH_DIR_NAME) lands inside the target repo the same way
    // .runs used to: untracked, and not every target repository's own
    // .gitignore names it. Excluded here for the same reason .runs is —
    // a dirty-tree refusal must not fire on state the pipeline itself
    // wrote, only on an operator's own uncommitted work.
    ":(exclude).faberun-plan",
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
      return String(gitSyncOrThrow(["-C", cwd, "rev-parse", baseRef], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })).trim() || null;
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
    return String(gitSyncOrThrow(["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim() || null;
  } catch {
    // Any rev-parse failure (no repo, unborn HEAD, git absent) leaves gitHead null.
    return null;
  }
}

/**
 * The paths the working tree has modified, added or left untracked, ignoring
 * the factory's own `.runs` tree. `AGENTS.md` is git-excluded from that scan
 * (its managed block would otherwise flag every launch) and checked on its
 * own instead: it counts as dirty exactly when its content differs from
 * `gitHead`'s once both are normalized with `normalizeManagedSignalBlock`, so
 * a human edit outside the block is refused — including one that sits
 * alongside a block change in the same file (R17) — while a block-only
 * change is not. A clean tree is `[]`; an unreadable tree is treated as clean
 * because the caller has no dirt to name.
 *
 * @param {string} cwd
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} [options]
 * @returns {string[]}
 */
export function dirtyTreePaths(cwd, options = {}) {
  try {
    const status = String(gitSyncOrThrow(["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...sourcePathspec(options)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const paths = status.split("\0").filter(Boolean);
    if (agentGuidanceDirty(cwd, resolveGitHead(cwd, undefined))) paths.push("AGENTS.md");
    return paths;
  } catch {
    // Not a repository, or git absent: there is no dirt the launch can name.
    return [];
  }
}

/**
 * Whether `AGENTS.md` itself counts as a dirty path: its working-tree content
 * differs from `gitHead`'s once both are normalized with
 * `normalizeManagedSignalBlock`. A change confined to the managed block does
 * not count, so the block the runner itself rewrites never blocks a launch;
 * any other edit does. `gitHead` null (no commit to compare against) is never
 * dirty.
 *
 * @param {string} cwd
 * @param {string|null} gitHead
 * @returns {boolean}
 */
function agentGuidanceDirty(cwd, gitHead) {
  if (!gitHead) return false;
  let working = null;
  try { working = readFileSync(resolve(cwd, "AGENTS.md"), "utf8"); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  let committed = null;
  try {
    committed = String(gitSyncOrThrow(["-C", cwd, "show", `${gitHead}:AGENTS.md`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    // AGENTS.md does not exist at gitHead: committed stays null.
  }
  if (working === null && committed === null) return false;
  const normalize = (/** @type {string|null} */ text) => (text === null ? null : normalizeManagedSignalBlock(text));
  return normalize(working) !== normalize(committed);
}

/**
 * Refuse a launch whose base is the checked-out HEAD and whose tree is dirty.
 * The base is what every worktree is cut from, so a dirty tree only matters
 * when it *is* the base: then the validator sees files the worker will never
 * have. A base ref that resolves elsewhere leaves the operator's checkout
 * alone and is always clean enough to launch from.
 *
 * The launch's own contract file is passed in `ignorePaths`: it is the input
 * being launched, written or re-authored immediately before the command, and
 * is not source the worktrees are cut from.
 *
 * @param {string} cwd
 * @param {string|undefined} baseRef
 * @param {{ignorePaths?: string[], ignoreRoots?: string[]}} [options]
 * @returns {void}
 */
export function assertLaunchBaseClean(cwd, baseRef, options = {}) {
  const headSha = resolveGitHead(cwd, undefined);
  const baseSha = baseRef ? resolveGitHead(cwd, baseRef) : headSha;
  if (baseRef && !baseSha) {
    throw Object.assign(new Error(`base ref does not resolve: ${baseRef}`), { code: "base_ref_unresolved" });
  }
  if (!baseSha || !headSha || baseSha !== headSha) return;
  const dirty = dirtyTreePaths(cwd, options);
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
    const status = /** @type {Buffer} */ (gitSyncOrThrow(["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...pathspec], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const statusText = status.toString("utf8");
    const diff = !gitHead || status.length === 0
      ? Buffer.alloc(0)
      : /** @type {Buffer} */ (gitSyncOrThrow(["-C", cwd, "diff", "--binary", "HEAD", "--", ...pathspec], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      }));
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
