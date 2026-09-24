/**
 * The checkout an arm works in and the two measurements taken on what it
 * leaves behind. Ported from `spike/arms/fork.mjs`: every run starts from the
 * corpus's fork, the acceptance files are restored from the corpus, and the
 * acceptance commands are run by this driver, never by the arm. Why separate:
 * the acceptance ordering is the measurement defect R3 fixes, so the one
 * function that restores before running the restore checks has a single home.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PAIRED_REPO_ROOT, PAIRED_WORKTREES } from "./lib.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

const GIT_IDENTITY = ["-c", "user.name=orchestration-arms", "-c", "user.email=arms@faberun.invalid"];
/**
 * The driver's bookkeeping commits run with no hooks: a checkout with
 * node_modules carries husky's commitlint, and measured 2026-09-20 the
 * complex round's four snapshot commits were all refused for their message
 * type. An empty hooks directory of the experiment's own is how git is told
 * there are none.
 */
const NO_HOOKS = join(PAIRED_WORKTREES, ".no-hooks");
const COMMIT = [...GIT_IDENTITY, "-c", `core.hooksPath=${NO_HOOKS}`, "commit", "-q", "-m"];

/** @param {string[]} args @param {string} [cwd] @returns {string} */
export function git(args, cwd = PAIRED_REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** @param {string} fork @returns {string} the fork's full sha, refused if the abbreviation resolves elsewhere */
export function forkSha(fork) {
  const sha = git(["rev-parse", `${fork}^{commit}`]);
  if (!sha.startsWith(fork)) throw new Error(`fork ${fork} resolved to ${sha}`);
  return sha;
}

/**
 * Write the corpus's accepted files into a checkout: from disk for a corpus
 * that ships them, from the landing commit for one taken from history, or
 * from the corpus JSON's own text for a replay fixture.
 *
 * @param {string} dir
 * @param {CorpusSet} corpus
 * @returns {void}
 */
export function restoreFiles(dir, corpus) {
  for (const item of corpus.restore) {
    const content = item.content !== undefined
      ? item.content
      : item.file !== undefined
        ? readFileSync(isAbsolute(item.file) ? item.file : join(corpus.dir, item.file), "utf8")
        : `${git(["show", `${item.sha}:${item.path}`])}\n`;
    mkdirSync(dirname(join(dir, item.path)), { recursive: true });
    writeFileSync(join(dir, item.path), content);
  }
}

/**
 * A fresh worktree named `name` at `sha` (the corpus fork by default). The
 * visible proofs, when the corpus has them, are committed on top; a corpus
 * that needs the dev toolchain gets `npm ci` (attempt worktrees link the
 * checkout's node_modules). A checkout of an arm's *result* skips the proof
 * commit but still needs the toolchain for the acceptance.
 *
 * @param {string} name
 * @param {CorpusSet} corpus
 * @param {{sha?: string}} [options]
 * @returns {{dir: string, baseSha: string}}
 */
export function prepareCheckout(name, corpus, options = {}) {
  if (corpus.fork === null) throw new Error(`corpus ${corpus.id} has no fork to prepare a checkout from`);
  const dir = join(PAIRED_WORKTREES, name);
  removeCheckout(dir);
  mkdirSync(NO_HOOKS, { recursive: true });
  git(["worktree", "add", "--detach", dir, options.sha ?? forkSha(corpus.fork)]);
  if (corpus.npmCi) {
    const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
    if (install.status !== 0) throw new Error(`npm ci failed in ${dir}: ${install.stderr}`);
  }
  if (corpus.visibleProofs) {
    restoreFiles(dir, corpus);
    git(["add", "-A", "--", ...corpus.restore.map((item) => item.path)], dir);
    git([...COMMIT, "test(corpus): acceptance proofs for the corpus requirements"], dir);
  }
  return { dir, baseSha: git(["rev-parse", "HEAD"], dir) };
}

/** @param {string} dir @returns {void} */
export function removeCheckout(dir) {
  if (!existsSync(dir)) {
    try { git(["worktree", "prune"]); } catch { /* a repo with nothing to prune */ }
    return;
  }
  try {
    git(["worktree", "remove", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(["worktree", "prune"]);
  }
}

/**
 * Commit everything in the checkout (staged or not) when there is anything to
 * commit, and return HEAD either way. node_modules is ignored by the
 * repository, so an `npm ci` never lands in the commit.
 *
 * @param {string} dir
 * @param {string} message
 * @returns {string}
 */
export function commitAll(dir, message) {
  git(["add", "-A"], dir);
  // `diff --quiet` answers with its exit code, so it does not go through `git()`, which throws on non-zero.
  const dirty = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: dir }).status !== 0;
  if (dirty) git([...COMMIT, message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

/**
 * Keep an arm's final tree reachable after its worktree is gone: one commit
 * of everything the arm left, under a ref of the experiment's own.
 *
 * @param {string} dir
 * @param {string} refName e.g. `refs/arms/paired/A-r1`
 * @returns {string} the sha
 */
export function keepFinalTree(dir, refName) {
  const sha = commitAll(dir, "arms: final tree of one run");
  git(["update-ref", refName, sha], dir);
  return sha;
}

/**
 * What the arm changed against its base, and whether any of it lies outside
 * the union of the corpus write scopes or inside the acceptance files. Taken
 * before the acceptance files are restored, so a tampered proof is visible.
 * AGENTS.md is the product's own signal block and is never an arm's edit.
 *
 * @param {{dir: string, baseSha: string, corpus: CorpusSet}} input
 * @returns {{changed: string[], outOfScope: string[], proofsEdited: string[]}}
 */
export function auditScope({ dir, baseSha, corpus }) {
  git(["add", "-A"], dir);
  const changed = git(["diff", "--cached", "--name-only", baseSha], dir).split("\n").filter(Boolean);
  const scope = new Set(corpus.requirements.flatMap((requirement) => requirement.writeFiles));
  const restored = new Set(corpus.restore.map((item) => item.path));
  const proofsEdited = corpus.visibleProofs ? changed.filter((path) => restored.has(path)) : [];
  const outOfScope = changed.filter((path) => !scope.has(path) && !restored.has(path) && path !== "AGENTS.md");
  return { changed, outOfScope, proofsEdited };
}

/**
 * The corpus's acceptance, run by the driver. Checks without `restore` run on
 * the tree exactly as the arm left it, in corpus order; then the corpus's
 * accepted files are written over the arm's own and the `restore` checks run.
 * Pass is the exit code: `node --test` and `tsc` both exit non-zero on any
 * failure. `NODE_TEST_CONTEXT` is removed so a nested `node --test` emits TAP
 * instead of silently joining the outer runner (AGENTS.md, measured
 * 2026-09-21).
 *
 * @param {{dir: string, corpus: CorpusSet}} input
 * @returns {{id: string, kind: "proof"|"guard", passed: boolean, ms: number, tail: string}[]}
 */
export function runAcceptance({ dir, corpus }) {
  const ordered = [...corpus.acceptance.filter((check) => !check.restore), ...corpus.acceptance.filter((check) => check.restore)];
  let restored = false;
  return ordered.map((check) => {
    if (check.restore && !restored) {
      restoreFiles(dir, corpus);
      restored = true;
    }
    const started = Date.now();
    const env = /** @type {Record<string, string|undefined>} */ ({ ...process.env, NO_COLOR: "1" });
    delete env.NODE_TEST_CONTEXT;
    // A corpus that spells `node` runs the same interpreter as the driver, so
    // an acceptance check cannot silently pick a different one off PATH.
    const executable = check.argv[0] === "node" ? process.execPath : check.argv[0];
    const result = spawnSync(executable, check.argv.slice(1), {
      cwd: check.cwd ? resolve(dir, check.cwd) : dir,
      encoding: "utf8",
      timeout: check.timeoutSec * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { id: check.id, kind: check.kind, passed: result.status === 0, ms: Date.now() - started, tail: output.slice(-1500) };
  });
}
