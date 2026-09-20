/**
 * The checkout an arm works in and the two measurements taken on what it
 * leaves behind. Every run of every arm starts from the same commit: the
 * corpus's fork, plus (for a corpus whose proofs are visible) one commit that
 * adds them, plus `npm ci` when the corpus needs the dev toolchain. Afterwards
 * the acceptance files are restored from the corpus -- from disk or from the
 * commit the real phase landed -- and the acceptance commands run by this
 * driver, never by the arm.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, WORKTREES } from "./lib.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

const GIT_IDENTITY = ["-c", "user.name=orchestration-arms", "-c", "user.email=arms@faberun.invalid"];

/** @param {string[]} args @param {string} [cwd] @returns {string} */
export function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** @param {string} fork @returns {string} the fork's full sha, refused if the abbreviation resolves elsewhere */
export function forkSha(fork) {
  const sha = git(["rev-parse", `${fork}^{commit}`]);
  if (!sha.startsWith(fork)) throw new Error(`fork ${fork} resolved to ${sha}`);
  return sha;
}

/**
 * Write the corpus's acceptance files into a checkout: from disk for a corpus
 * that ships them, from the landing commit for one taken from history.
 *
 * @param {string} dir
 * @param {CorpusSet} corpus
 */
export function restoreFiles(dir, corpus) {
  for (const item of corpus.restore) {
    const content = item.file ? readFileSync(item.file, "utf8") : `${git(["show", `${item.sha}:${item.path}`])}\n`;
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
  const dir = join(WORKTREES, name);
  removeCheckout(dir);
  mkdirSync(WORKTREES, { recursive: true });
  git(["worktree", "add", "--detach", dir, options.sha ?? forkSha(corpus.fork)]);
  if (corpus.npmCi) {
    const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
    if (install.status !== 0) throw new Error(`npm ci failed in ${dir}: ${install.stderr}`);
  }
  if (corpus.visibleProofs) {
    restoreFiles(dir, corpus);
    git(["add", "-A", "--", ...corpus.restore.map((item) => item.path)], dir);
    git([...GIT_IDENTITY, "commit", "-q", "-m", "test(corpus): acceptance proofs for the corpus requirements"], dir);
  }
  return { dir, baseSha: git(["rev-parse", "HEAD"], dir) };
}

/** @param {string} dir */
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
 * Commit everything in the checkout (staged or not) when there is anything
 * to commit, and return HEAD either way. node_modules is ignored by the
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
  if (dirty) git([...GIT_IDENTITY, "commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

/**
 * Keep an arm's final tree reachable after its worktree is gone: one commit
 * of everything the arm left, under a ref of the experiment's own.
 *
 * @param {string} dir
 * @param {string} refName e.g. `refs/arms/pilot/B-r1`
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
 * The corpus's acceptance, run by the driver against the tree with the
 * acceptance files restored. Pass is the exit code: `node --test` and `tsc`
 * both exit non-zero on any failure.
 *
 * @param {{dir: string, corpus: CorpusSet}} input
 * @returns {{id: string, passed: boolean, ms: number, tail: string}[]}
 */
export function runAcceptance({ dir, corpus }) {
  restoreFiles(dir, corpus);
  return corpus.acceptance.map((check) => {
    const started = Date.now();
    const result = spawnSync(check.argv[0], check.argv.slice(1), {
      cwd: dir,
      encoding: "utf8",
      timeout: check.timeoutSec * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { id: check.id, passed: result.status === 0, ms: Date.now() - started, tail: output.slice(-1500) };
  });
}
