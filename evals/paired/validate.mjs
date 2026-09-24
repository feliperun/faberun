/**
 * `--validate-corpus`: without a model, restore each corpus's base tree from
 * `evals/golden/fixtures.bundle` and prove the corpus is discriminating — every
 * `proof` fails at the base and every `guard` passes there. Why separate: the
 * check is the corpus's own contract with the fixtures bundle, not part of
 * running the arms, and `evals/paired.mjs` is the class entry, so the restore
 * and the pass/fail reading live together here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVALS_ROOT } from "../paths.mjs";
import { loadCorpusSet } from "./corpus.mjs";
import { runAcceptance } from "./fork.mjs";
import { PAIRED_CORPUS_ROOT, PAIRED_REPO_ROOT } from "./lib.mjs";

/** The one shared bundle every corpus's base and restore commits must resolve in. */
const BUNDLE_PATH = join(EVALS_ROOT, "golden", "fixtures.bundle");
/** The dev toolchain a corpus with `npmCi` needs at the base, linked rather than installed for a validation. */
const NODE_MODULES = join(PAIRED_REPO_ROOT, "node_modules");

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** @param {string} corpusRoot @returns {string[]} corpus ids with a corpus.json, sorted */
export function discoverCorpusIds(corpusRoot = PAIRED_CORPUS_ROOT) {
  if (!existsSync(corpusRoot)) return [];
  return readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(corpusRoot, entry.name, "corpus.json")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {{corpus: CorpusSet, repoDir: string, temp: string, resolved: Map<string, boolean>, nodeModules: string}} input
 * @returns {{id: string, ok: boolean, proofsFailed: boolean, guardsPassed: boolean, checks: {id: string, kind: string, passed: boolean}[], failures: string[]}}
 */
function validateOne({ corpus, repoDir, temp, resolved, nodeModules }) {
  const fork = corpus.fork;
  if (typeof fork !== "string" || !fork || !resolved.get(fork)) {
    const reason = typeof fork !== "string" || !fork
      ? `corpus ${corpus.id}: declares no base sha`
      : `corpus ${corpus.id}: base sha ${fork} does not resolve in the fixtures bundle`;
    return { id: corpus.id, ok: false, proofsFailed: false, guardsPassed: false, checks: [], failures: [reason] };
  }
  /** @type {string[]} */
  const failures = [];
  for (const item of corpus.restore) {
    if (typeof item.sha === "string" && !resolved.get(item.sha)) {
      failures.push(`corpus ${corpus.id}: restore sha ${item.sha} for ${item.path} does not resolve in the fixtures bundle`);
    }
  }
  // R4 wants the historical reading carried with the corpus, so an entry with
  // no recorded cost/time reference is not a measured round.
  const arms = corpus.history && typeof corpus.history === "object" ? corpus.history.arms : null;
  if (!arms || Object.keys(arms).length === 0) failures.push(`corpus ${corpus.id}: carries no historical cost/time reference`);
  const source = corpus.history && typeof corpus.history === "object" ? corpus.history.source : null;
  if (typeof source !== "string" || !existsSync(join(PAIRED_REPO_ROOT, source))) failures.push(`corpus ${corpus.id}: historical reference source ${String(source)} is not a path under the repository`);
  if (failures.length > 0) return { id: corpus.id, ok: false, proofsFailed: false, guardsPassed: false, checks: [], failures };

  const dir = join(temp, `checkout-${corpus.id}`);
  let added = false;
  try {
    git(["-C", repoDir, "worktree", "add", "--detach", dir, fork]);
    added = true;
    // A real run installs the toolchain; a validation links the one this
    // checkout of the repository already has, so the guard pays no npm ci.
    if (corpus.npmCi && existsSync(nodeModules) && !existsSync(join(dir, "node_modules"))) symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
    const outcomes = runAcceptance({ dir, corpus });
    const proofs = outcomes.filter((outcome) => outcome.kind === "proof");
    const guards = outcomes.filter((outcome) => outcome.kind === "guard");
    const failingProofs = proofs.filter((outcome) => outcome.passed);
    const failingGuards = guards.filter((outcome) => !outcome.passed);
    if (proofs.length === 0) failures.push(`corpus ${corpus.id}: declares no proof`);
    if (failingProofs.length > 0) failures.push(`corpus ${corpus.id}: proof(s) pass at the base: ${failingProofs.map((outcome) => outcome.id).join(", ")}`);
    if (failingGuards.length > 0) failures.push(`corpus ${corpus.id}: guard(s) fail at the base: ${failingGuards.map((outcome) => outcome.id).join(", ")}`);
    return {
      id: corpus.id,
      ok: failures.length === 0,
      proofsFailed: proofs.length > 0 && failingProofs.length === 0,
      guardsPassed: failingGuards.length === 0,
      checks: outcomes.map((outcome) => ({ id: outcome.id, kind: outcome.kind, passed: outcome.passed })),
      failures,
    };
  } catch (error) {
    failures.push(`corpus ${corpus.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return { id: corpus.id, ok: false, proofsFailed: false, guardsPassed: false, checks: [], failures };
  } finally {
    if (added) {
      try {
        git(["-C", repoDir, "worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

/**
 * Restore every corpus's base from the one bundle and check its acceptance: the
 * proofs must fail there and the guards must pass. No provider is reached and
 * nothing under the repository is written; the checkouts live under a temp root.
 *
 * @param {{corpusRoot?: string, bundlePath?: string, nodeModules?: string}} [options]
 * @returns {{ok: boolean, corpora: ReturnType<typeof validateOne>[], failures: string[]}}
 */
export function validateCorpora(options = {}) {
  const corpusRoot = options.corpusRoot ?? PAIRED_CORPUS_ROOT;
  const bundlePath = options.bundlePath ?? BUNDLE_PATH;
  const nodeModules = options.nodeModules ?? NODE_MODULES;
  if (!existsSync(bundlePath)) {
    return { ok: false, corpora: [], failures: [`fixtures bundle not found: ${bundlePath}`] };
  }
  const ids = discoverCorpusIds(corpusRoot);
  if (ids.length === 0) return { ok: false, corpora: [], failures: [`no corpus directory under ${corpusRoot}`] };

  const temp = mkdtempSync(join(tmpdir(), "paired-validate-"));
  const repoDir = join(temp, "bundle");
  try {
    git(["init", "-q", "--bare", repoDir]);
    /** @type {Map<string, boolean>} */
    const resolved = new Map();
    /** @type {ReturnType<typeof validateOne>[]} */
    const corpora = [];
    for (const id of ids) {
      const corpus = loadCorpusSet(corpusRoot, id);
      const shas = [corpus.fork, ...corpus.restore.map((item) => item.sha)].filter((sha) => typeof sha === "string");
      for (const sha of shas) {
        if (resolved.has(sha)) continue;
        try {
          git(["-C", repoDir, "fetch", "-q", bundlePath, sha]);
          resolved.set(sha, true);
        } catch {
          // recorded as unresolved below, with the corpus and path that named it
          resolved.set(sha, false);
        }
      }
      corpora.push(validateOne({ corpus, repoDir, temp, resolved, nodeModules }));
    }
    return { ok: corpora.every((entry) => entry.ok), corpora, failures: corpora.flatMap((entry) => entry.failures) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
