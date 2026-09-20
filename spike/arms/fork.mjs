/**
 * The checkout an arm works in and the two measurements taken on what it
 * leaves behind. Every run of every arm starts from the same commit: the
 * fork the corpus was written against, plus one commit that adds the
 * acceptance proofs, so a session and a faberun worker see the same tree and
 * the same tests. Afterwards the proofs are restored from the corpus (a run
 * that edited a proof is measured against the real one, and the edit is
 * recorded) and run by this driver, never by the arm.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, WORKTREES } from "./lib.mjs";

/** The commit the corpus was written against; the proofs fail there. */
export const FORK = "a1117f7";
const PROOFS = resolve(ROOT, "spike/corpus/provas");
const GIT_IDENTITY = ["-c", "user.name=orchestration-arms", "-c", "user.email=arms@faberun.invalid"];

/** @param {string[]} args @param {string} [cwd] @returns {string} */
export function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** @returns {string} the fork's full sha, refused if the abbreviation resolves elsewhere */
export function forkSha() {
  const sha = git(["rev-parse", `${FORK}^{commit}`]);
  if (!sha.startsWith(FORK)) throw new Error(`fork ${FORK} resolved to ${sha}`);
  return sha;
}

/** @param {string} dir */
export function restoreProofs(dir) {
  mkdirSync(join(dir, "spike/corpus/provas"), { recursive: true });
  cpSync(PROOFS, join(dir, "spike/corpus/provas"), { recursive: true });
}

/**
 * A fresh worktree named `name` at `sha` (the fork by default). With
 * `withProofs`, the corpus proofs are committed on top, which is the base
 * every arm starts from; a checkout of an arm's *result* already carries
 * them and skips the commit.
 *
 * @param {string} name
 * @param {{sha?: string, withProofs?: boolean}} [options]
 * @returns {{dir: string, baseSha: string}}
 */
export function prepareCheckout(name, options = {}) {
  const dir = join(WORKTREES, name);
  removeCheckout(dir);
  mkdirSync(WORKTREES, { recursive: true });
  git(["worktree", "add", "--detach", dir, options.sha ?? forkSha()]);
  if (options.withProofs !== false) {
    restoreProofs(dir);
    git(["add", "spike/corpus/provas"], dir);
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
 * Keep an arm's final tree reachable after its worktree is gone: one commit
 * of everything the arm left (staged or not), under a ref of the experiment's
 * own, so the judge and any later audit can check it out again.
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
 * Commit everything in the checkout (staged or not) when there is anything
 * to commit, and return HEAD either way.
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
 * What the arm changed against its base, and whether any of it lies outside
 * the union of the corpus write scopes or inside the proofs. The audit is
 * taken before the proofs are restored, so a tampered proof is visible.
 *
 * @param {{dir: string, baseSha: string, requirements: import("./corpus.mjs").Requirement[]}} input
 * @returns {{changed: string[], outOfScope: string[], proofsEdited: string[]}}
 */
export function auditScope({ dir, baseSha, requirements }) {
  git(["add", "-A"], dir);
  const changed = git(["diff", "--cached", "--name-only", baseSha], dir).split("\n").filter(Boolean);
  const scope = new Set(requirements.flatMap((requirement) => requirement.escopoEscrita ?? []));
  const proofsEdited = changed.filter((path) => path.startsWith("spike/corpus/provas/"));
  // AGENTS.md carries the managed signal block faberun itself rewrites on
  // every campaign event; it is the product's bookkeeping, not an arm's edit.
  const outOfScope = changed.filter((path) => !scope.has(path) && !path.startsWith("spike/corpus/provas/") && path !== "AGENTS.md");
  return { changed, outOfScope, proofsEdited };
}

/**
 * Every requirement's proof, run by the driver against the tree with the
 * real proofs restored. `--test-reporter tap` so a pass/fail line is the
 * evidence, not an exit code alone.
 *
 * @param {{dir: string, requirements: import("./corpus.mjs").Requirement[]}} input
 * @returns {{id: string, passed: boolean, ms: number, tail: string}[]}
 */
export function runProofs({ dir, requirements }) {
  restoreProofs(dir);
  return requirements.map((requirement) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, ["--test", "--test-reporter", "tap", requirement.prova], {
      cwd: dir,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { id: requirement.id, passed: result.status === 0 && /^# fail 0$/mu.test(output), ms: Date.now() - started, tail: output.slice(-1500) };
  });
}
