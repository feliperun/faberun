import { spawnSync } from "node:child_process";
import { gitArguments } from "../host/platform.mjs";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RUNS_DIR_NAME, attemptWorktreePath, candidateWorktreePath } from "../run/paths.mjs";

/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */

/** @typedef {{status: "ready", path: string, branch: string, commit: string|null, baseSha: string}} AttemptWorktree */
/** @typedef {{sha: string, empty: boolean}} SealedAttempt */
/** @typedef {{encoding?: "utf8"|"buffer", stdio?: import("node:child_process").StdioOptions, timeoutMs?: number, maxBuffer?: number, cwd?: string, env?: NodeJS.ProcessEnv}} BoundedGitOptions */
/** @typedef {{status: number|null, signal: NodeJS.Signals|null, stdout: string|Buffer, stderr: string|Buffer, error?: Error & {code?: string}, timedOut: boolean}} BoundedGitResult */

/**
 * The wall-clock bound on every synchronous git subprocess. A controller that
 * blocks forever on `git` while another process holds `.git/index.lock` is a
 * frozen loop; git has no timeout of its own, so the wrapper supplies one.
 * 30s is far longer than any one of these calls takes at the sizes this runner
 * uses, and far shorter than an operator waiting on a silent run.
 */
export const GIT_SYNC_TIMEOUT_MS = 30_000;

/**
 * The timeout a call uses: the explicit option, else the operator override
 * (`FABERUN_GIT_TIMEOUT_MS`, for a slow disk or a test), else the
 * default. Read at call time so the env is honoured without a restart.
 *
 * @param {number|undefined} optionMs
 * @returns {number}
 */
function gitSyncTimeoutMs(optionMs) {
  if (optionMs !== undefined) return optionMs;
  const raw = process.env.FABERUN_GIT_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GIT_SYNC_TIMEOUT_MS;
}

/**
 * The one place a synchronous `git` process is spawned. `execFileSync`-style
 * callers (`runGit`) read `stdout`, `spawnSync`-style callers read the result
 * object, and both are held to the same timeout. A spawn that hits the timeout
 * carries a named `git_timeout` error instead of hanging.
 *
 * @param {string[]} args
 * @param {BoundedGitOptions} [options]
 * @returns {BoundedGitResult}
 */
export function boundedGitSync(args, options = {}) {
  const timeoutMs = gitSyncTimeoutMs(options.timeoutMs);
  const result = spawnSync("git", gitArguments(args), {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const timedOut = result.error !== undefined && /** @type {{code?: string}} */ (result.error).code === "ETIMEDOUT";
  if (timedOut) {
    /** @type {Error & {code?: string}} */
    const error = new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`);
    error.code = "git_timeout";
    error.cause = result.error;
    return { ...result, error, timedOut: true };
  }
  return { ...result, timedOut: false };
}

/**
 * Run git and, when it fails, carry git's own stderr into the error.
 *
 * Node's `execFileSync` error says only `Command failed: git -C … commit -qm
 * …` and drops the reason. That is how an empty-change-set commit exiting 1
 * was misdiagnosed twice across two campaigns: the surfaced error named the
 * command, never git's "nothing to commit". Every git call here goes through
 * this helper so a failure always says why.
 *
 * @param {string[]} args @returns {string}
 */
function runGit(args) {
  const result = boundedGitSync(args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const error = /** @type {Error & {stderr?: unknown, stdout?: unknown, status?: number|null, signal?: string|null}} */ (result.error ?? new Error(`Command failed: git ${args.join(" ")}`));
    if (result.error === undefined) {
      error.stderr = result.stderr;
      error.stdout = result.stdout;
      error.status = result.status;
      error.signal = result.signal;
    }
    const reason = gitFailureReason(error);
    if (reason && !String(error.message).includes(reason)) error.message = `${String(error.message).split("\n")[0]}: ${reason}`;
    throw error;
  }
  return String(result.stdout ?? "").trim();
}

/** @param {string} runId @returns {string} */
export function runRefName(runId) {
  return `refs/faberun/${runId}/run`;
}

/** @param {string} runId @returns {string} */
export function candidateRefName(runId) {
  return `refs/faberun/${runId}/candidate`;
}

/** @param {string} runId @param {string} nodeId @returns {string} */
export function preservedRefName(runId, nodeId) {
  return `refs/faberun/${runId}/preserved/${nodeId}`;
}

/** @param {string} runId @param {string} nodeId @param {number} attempt @returns {string} */
function attemptBranchName(runId, nodeId, attempt) {
  return `faberun/${runId}/${nodeId}/${attempt}`;
}

/** @param {unknown} error @returns {string} */
function gitFailureReason(error) {
  const streams = /** @type {{stderr?: unknown, stdout?: unknown}} */ (error ?? {});
  return [streams.stderr, streams.stdout]
    .map((stream) => (typeof stream === "string" ? stream : stream ? String(stream) : ""))
    .map((text) => text.trim())
    .find(Boolean) ?? "";
}

/** @param {string} repo @param {string[]} args @returns {string} */
export function git(repo, args) {
  return runGit(["-C", repo, ...args]);
}

/** @param {string} repo @param {string} [ref] @returns {string|null} */
export function gitHead(repo, ref = "HEAD") {
  try {
    return git(repo, ["rev-parse", ref]);
  } catch {
    return null;
  }
}

/**
 * The path of the worktree that has `branch` checked out right now, or null.
 * The operator's own checkout is included: `git worktree list` reports it, so
 * moving that branch under a live checkout is exactly what this guards.
 *
 * @param {string} repo
 * @param {string} branch
 * @returns {string|null}
 */
export function worktreeCheckedOutAt(repo, branch) {
  const ref = `refs/heads/${branch}`;
  let output;
  try {
    output = git(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    // A repository that cannot list its worktrees cannot prove the branch is
    // safe to move; the caller treats null as "not checked out".
    return null;
  }
  let path = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && line.slice("branch ".length) === ref) return path;
  }
  return null;
}

/** @param {string} repo @param {string} runId @param {string|null|undefined} head @returns {string} */
export function createRunRef(repo, runId, head) {
  if (!head) throw Object.assign(new Error("an execution repository must have at least one commit"), { code: "git_head_required" });
  const ref = runRefName(runId);
  if (gitHead(repo, ref)) throw new Error(`run ref already exists: ${ref}`);
  runGit(["-C", repo, "update-ref", ref, head]);
  return ref;
}

/**
 * Keep one node's integrated commit reachable after cancel releases the run
 * ref and the attempt branches: without a ref of its own the commit is
 * garbage the next `git gc` collects, and the persisted snapshot alone cannot
 * bring a pruned object back.
 *
 * Idempotent by the same contract `deleteRef` and `removeWorktree` honour:
 * cancel can legitimately run twice (a retry after a partial first pass, or
 * the operator repeating it), so a preserved ref that already names this
 * exact commit is done, not a conflict — the second creation neither fails
 * nor moves the target. A ref left at a different sha moves to the commit
 * handed in now.
 *
 * @param {string} repo @param {string} runId @param {string} nodeId @param {string|null|undefined} sha @returns {string}
 */
export function createPreservedRef(repo, runId, nodeId, sha) {
  if (!sha) throw Object.assign(new Error("a preserved ref needs an integrated commit"), { code: "git_head_required" });
  const ref = preservedRefName(runId, nodeId);
  if (gitHead(repo, ref) === sha) return ref;
  runGit(["-C", repo, "update-ref", ref, sha]);
  return ref;
}

/**
 * @param {{repo: string, runDir: string, runId: string, nodeId: string, attempt: number, base?: string, declaredReads?: string[]}} args
 *   `base` cuts the new branch from a sealed sha instead of the run ref tip —
 *   the previous attempt's sealed work, when it left one (TECH-SPEC lean
 *   v0.3 section 3 rule 4). Omitted, it falls back to the run ref tip as
 *   before. `declaredReads` names the packet's readFiles: entries git does
 *   not track are carried into the fresh worktree, since a checkout carries
 *   only tracked content and the worker reads the packet's reads from here.
 * @returns {AttemptWorktree}
 */
export function createAttemptWorktree({ repo, runDir, runId, nodeId, attempt, base, declaredReads }) {
  const runRefSha = gitHead(repo, runRefName(runId));
  if (!runRefSha) throw Object.assign(new Error(`integration ref is unavailable for ${runId}`), { code: "run_ref_missing" });
  const path = attemptWorktreePath(runDir, runId, nodeId, attempt);
  const branch = attemptBranchName(runId, nodeId, attempt);
  mkdirSync(dirname(path), { recursive: true });
  const existingCommit = gitHead(path);
  const existingBranch = gitHead(repo, branch);
  if (existingCommit) {
    if (existingBranch !== existingCommit) throw new Error(`attempt worktree identity does not match ${branch}: ${path}`);
  } else if (existingBranch) {
    runGit(["-C", repo, "worktree", "add", path, branch]);
  } else {
    runGit(["-C", repo, "worktree", "add", path, "-b", branch, base ?? runRefName(runId)]);
  }
  prepareWorktreeEnvironment(repo, path);
  carryDeclaredReads(repo, path, declaredReads ?? []);
  return { status: "ready", path, branch, commit: gitHead(path), baseSha: base ?? runRefSha };
}

/**
 * Give a fresh worktree the environment repository tooling needs: the
 * installed `node_modules`, linked as a symlink and never copied, so
 * commitlint through the commit-msg hook and `npm run typecheck` work without
 * an install. A no-op when the repository has nothing installed, or the
 * worktree already has an entry at that path.
 *
 * Every worktree a run creates goes through here — attempts and the
 * integration candidate alike. That is the point of the single function: the
 * candidate re-runs the verification the attempt just passed, so any
 * environment the attempt had and the candidate lacked turns a correct node
 * into a failed one, and the failure names the node rather than the missing
 * install.
 *
 * @param {string} repo @param {string} path @returns {void}
 */
function prepareWorktreeEnvironment(repo, path) {
  const source = join(repo, "node_modules");
  if (!existsSync(source)) return;
  const target = join(path, "node_modules");
  if (existsSync(target) || isSymlink(target)) return;
  symlinkSync(source, target);
}

/** @param {string} path @returns {boolean} */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Carry a packet's declared reads that git does not track from the repository
 * checkout into a freshly created attempt worktree. Validation checks
 * readFiles against the repository, but the worker reads them from the
 * worktree, and a worktree carries only tracked content: an ignored or
 * untracked declared read — the plan pipeline's gitignored repo-facts relay is
 * the live case — would be absent from the very packet that names it.
 *
 * A tracked file is never copied, so a dirty working copy cannot leak into a
 * clean attempt: the worktree's own checkout is the only source for those. A
 * path already present in the worktree is left alone, so recreating one never
 * clobbers what an attempt left there.
 *
 * @param {string} repo @param {string} worktree @param {string[]} readFiles @returns {void}
 */
function carryDeclaredReads(repo, worktree, readFiles) {
  const repoRoot = resolve(repo);
  const realRepoRoot = realpathSync(repoRoot);
  for (const read of readFiles) {
    if (typeof read !== "string" || !read || isAbsolute(read)) continue;
    const source = resolve(repoRoot, read);
    let real;
    try {
      if (!statSync(source).isFile()) continue;
      real = realpathSync(source);
    } catch {
      // Absent or unreadable — including a broken symlink inside the path:
      // nothing exists to carry, and a declared read may legitimately be
      // produced later or removed since authoring.
      continue;
    }
    // Containment inline: task-packet.mjs owns pathInside privately, and a
    // second top-level body would fail the duplicate-body gate.
    const rel = relative(realRepoRoot, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (gitTracks(repo, read)) continue;
    const target = join(worktree, read);
    if (existsSync(target) || isSymlink(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    // A copy, never a symlink back at the checkout: the attempt's grounding
    // input is frozen at creation, exactly like the tracked content around it.
    writeFileSync(target, readFileSync(source));
  }
}

/**
 * Whether git lists the path in the index, i.e. a fresh worktree's checkout
 * already brings it on its own.
 *
 * @param {string} repo @param {string} read @returns {boolean}
 */
function gitTracks(repo, read) {
  try {
    return git(repo, ["ls-files", "--", read]).length > 0;
  } catch {
    // git could not answer (locked index, unusable repository): fail toward
    // "tracked", because never copying a tracked file outranks carrying one.
    return true;
  }
}

/**
 * Every untracked, unignored path in a worktree, outside the runner's own
 * `.runs` tree and the linked `node_modules`: the same exclusions the seal
 * applies, so the two agree on what "left in the worktree" means.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function untrackedPaths(path) {
  const listed = git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", `:(exclude)${RUNS_DIR_NAME}`, ":(exclude)node_modules"]);
  return listed.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)).sort();
}

/**
 * `exclude` names paths the attempt holds but must not seal: what the
 * controller's own verification left behind (`verificationArtifacts`). They
 * stay on disk and out of the commit.
 *
 * @param {{repo: string, path: string, baseSha: string|null, runId: string, nodeId: string, attempt: number, exclude?: string[]}} args
 * @returns {SealedAttempt}
 */
export function sealAttempt({ repo, path, baseSha, runId, nodeId, attempt, exclude = [] }) {
  // The attempt-local `.runs` result sidecar must never enter the attempt
  // commit. Naming it through an exclude pathspec makes `git add` exit 1 with
  // advice.addIgnoredFile as soon as the sidecar exists in a repository that
  // ignores `.runs/` (every real worker writes it), so stage everything and
  // unstage the sidecar afterwards; that also covers a repository that does
  // not ignore it.
  //
  // The probe below must therefore exclude exactly what the staging step
  // unstages, `node_modules` included: `node_modules/` in .gitignore does not
  // match the symlink of the same name, so a re-sealed attempt whose only
  // entry is that link would look dirty, stage it, unstage it, and commit an
  // empty change set — which exits 1 and turns every retry of an
  // already-sealed attempt into a hard failure.
  const dirty = git(path, ["status", "--porcelain=v1", "--", ".", `:(exclude)${RUNS_DIR_NAME}`, ":(exclude)node_modules"]);
  if (dirty) {
    runGit(["-C", path, "add", "-A", "--", "."]);
    // node_modules is linked into the worktree as a symlink, which `node_modules/`
    // in .gitignore does not match; never let the link into the attempt commit.
    runGit(["-C", path, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", RUNS_DIR_NAME, "node_modules"]);
    if (exclude.length) runGit(["-C", path, "rm", "-q", "--cached", "--ignore-unmatch", "--", ...exclude.map((item) => `:(literal)${item}`)]);
  }
  // A worktree whose only change was an excluded artifact stages nothing, and
  // an empty commit exits 1; the attempt's head is then its seal.
  if (dirty && !stagedNothing(path)) {
    runGit([
      "-C", path,
      "-c", "user.email=runner@example.test",
      "-c", "user.name=faberun",
      "-c", "commit.gpgSign=false",
      // The seal is bookkeeping, not a contribution: it checkpoints one
      // attempt's worktree onto a throwaway `faberun/<run>/<node>/<attempt>` branch
      // so the next attempt can build on it, and nothing here is ever pushed.
      // Running the target repository's hooks on it is wrong twice over.
      // Measured 2026-09-13 against a repository with a plain failing
      // `.git/hooks/pre-commit`: every seal failed, and because the commit
      // message never varies between attempts, every node of every run failed
      // the same way with no way out. A lint or test hook is also work the
      // controller already does deliberately through `verification`, on a
      // schedule it chose. The identity and signing overrides above are the
      // same argument: this commit answers to the factory, not to the repo's
      // conventions for human commits.
      "commit", "--no-verify", "-qm", `faberun ${runId} ${nodeId} attempt ${attempt}`,
    ]);
  }
  const sha = gitHead(path);
  if (!sha) throw new Error(`attempt worktree has no commit: ${path}`);
  const empty = Boolean(baseSha && gitDiffEmpty(path, baseSha, sha));
  return { sha, empty };
}

/** @param {string} path @returns {boolean} */
function stagedNothing(path) {
  try {
    runGit(["-C", path, "diff", "--cached", "--quiet"]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repo @param {string} base @param {string} head @returns {boolean} */
export function gitDiffEmpty(repo, base, head) {
  try {
    runGit(["-C", repo, "diff", "--quiet", base, head]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repo @param {string} ref @param {string} next @param {string} previous @returns {void} */
export function updateRefConditional(repo, ref, next, previous) {
  runGit(["-C", repo, "update-ref", ref, next, previous]);
}

/** @param {string} repo @param {string} ref @returns {void} */
export function deleteRef(repo, ref) {
  try {
    runGit(["-C", repo, "update-ref", "-d", ref]);
  } catch {
    // Deleting an already absent cleanup ref is idempotent.
  }
}

/**
 * @param {{repo: string, runDir: string, runId: string, ref?: string}} args
 * @returns {string}
 */
export function createCandidateWorktree({ repo, runDir, runId, ref = candidateRefName(runId) }) {
  const path = candidateWorktreePath(runDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  runGit(["-C", repo, "worktree", "add", "--detach", path, ref]);
  prepareWorktreeEnvironment(repo, path);
  return path;
}

/** @param {string} repo @param {string|null|undefined} path @returns {void} */
export function removeWorktree(repo, path) {
  if (!path) return;
  try {
    runGit(["-C", repo, "worktree", "remove", "--force", path]);
  } catch (error) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    else if (/** @type {{status?: number}} */ (error)?.status !== 128) throw error;
  }
}

/**
 * Release one node's attempt worktree and the branch name it was checked out
 * on. Git refuses to delete a branch that is still checked out anywhere, so
 * the worktree goes first; both halves already tolerate an artefact that is
 * already gone, which is what makes calling this on an accepted (worktree
 * already `removed`) or an already-released attempt harmless.
 *
 * @param {string} repo
 * @param {string|null|undefined} path
 * @param {string} branch
 * @returns {void}
 */
export function releaseAttemptWorktree(repo, path, branch) {
  removeWorktree(repo, path);
  deleteRef(repo, `refs/heads/${branch}`);
}

/** @param {string} repo @param {string} runDir @param {string} runId @returns {void} */
export function cleanupCandidate(repo, runDir, runId) {
  removeWorktree(repo, candidateWorktreePath(runDir, runId));
  deleteRef(repo, candidateRefName(runId));
}

/** @param {NodeSnapshot|undefined} state @returns {string|null} */
export function attemptWorkspace(state) {
  const path = state?.worktree?.path;
  return path && state?.worktree?.status !== "removed" && existsSync(path) ? path : null;
}
