/**
 * Repo facts: a deterministic, bounded inventory of the target repository —
 * tracked paths, declared scripts, timed verification candidates, and which
 * test file covers which source module — collected without invoking a model.
 * A planning stage's draft is authored against exactly this JSON instead of
 * the session reading the repository by hand.
 *
 * Sorting and the absence of any clock in the output itself (only inside an
 * injected measurer's own numbers) is what makes two calls at the same HEAD
 * byte-identical.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timeVerificationCommands } from "../host/preflight.mjs";
import { boundedGitSync, gitHead } from "../repo/worktree.mjs";

/** @typedef {{argv: string[], measuredMs: number, eligible: boolean}} VerificationCandidate */
/** @typedef {{path: string, covers: string|null}} TestFileEntry */
/** @typedef {{formatVersion: number, gitHead: string|null, paths: string[], truncated: boolean, scripts: Record<string, string>, verificationCandidates: VerificationCandidate[], testFiles: TestFileEntry[]}} RepoFacts */
/** @typedef {{now?: () => number, run?: typeof import("node:child_process").spawnSync}} MeasureProbes */

const FORMAT_VERSION = 1;
const DEFAULT_MAX_PATHS = 2000;
const ELIGIBLE_MS_CEILING = 600_000;
const CANDIDATE_TIMEOUT_SEC = ELIGIBLE_MS_CEILING / 1_000;

/**
 * Every path git tracks at HEAD, sorted. The bounded spawn is the same
 * pattern `src/repo/source-identity.mjs` uses for its own git reads: a
 * `boundedGitSync` call, thrown on a non-zero exit or a killed process,
 * never a raw `spawnSync`.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function listTrackedPaths(cwd) {
  const result = boundedGitSync(["-C", cwd, "ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`git ls-files exited ${result.status}`);
  return String(result.stdout).split("\n").filter(Boolean).sort();
}

/** @param {string} cwd @returns {Record<string, string>} */
function readScripts(cwd) {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return {};
  const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
}

/**
 * The first-level directories under test/ that any tracked path is nested
 * inside. `node --test <dir>` recurses through everything below it, so one
 * candidate per directory is the whole layout, not one per file.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
function testDirectories(paths) {
  /** @type {Set<string>} */
  const directories = new Set();
  for (const path of paths) {
    const match = /^test\/([^/]+)\//u.exec(path);
    if (match) directories.add(`test/${match[1]}`);
  }
  return [...directories].sort();
}

/**
 * @param {string[]} paths
 * @param {Set<string>} pathSet
 * @returns {TestFileEntry[]}
 */
function testFileEntries(paths, pathSet) {
  return paths
    .filter((path) => path.startsWith("test/") && path.endsWith(".test.mjs"))
    .map((path) => {
      const modulePath = `src/${path.slice("test/".length, -".test.mjs".length)}.mjs`;
      return { path, covers: pathSet.has(modulePath) ? modulePath : null };
    });
}

/**
 * @param {Record<string, string>} scripts
 * @param {string[]} paths
 * @returns {{argv: string[]}[]}
 */
function candidateCommands(scripts, paths) {
  const commands = testDirectories(paths).map((directory) => ({ argv: ["node", "--test", directory] }));
  for (const name of ["check", "typecheck"]) {
    if (typeof scripts[name] === "string") commands.push({ argv: ["npm", "run", name] });
  }
  return commands;
}

/**
 * Time every candidate through `timeVerificationCommands`'s own probe —
 * real `spawnSync` and `Date.now` by default, or the caller's fake — instead
 * of re-implementing the spawn, ceiling and ENOENT handling it already owns.
 * That function calls `now()` exactly twice per command, in order (start,
 * then stop); wrapping it to record every mark it produces is how the real
 * elapsed ms is recovered without parsing its human-readable report.
 *
 * @param {string} cwd
 * @param {{argv: string[]}[]} commands
 * @param {MeasureProbes} probes
 * @returns {VerificationCandidate[]}
 */
function measureCandidates(cwd, commands, probes) {
  if (commands.length === 0) return [];
  const now = probes.now ?? (() => Date.now());
  /** @type {number[]} */
  const marks = [];
  const contract = /** @type {import("../contract/index.mjs").ValidatedContract} */ (/** @type {any} */ ({
    cwd,
    nodes: commands.map((command, index) => ({
      id: `repo-facts-${index}`,
      taskPacket: { verification: [{ argv: command.argv, timeoutSec: CANDIDATE_TIMEOUT_SEC }] },
    })),
  }));
  timeVerificationCommands(contract, { ...probes, now: () => { const mark = now(); marks.push(mark); return mark; } });
  return commands.map((command, index) => {
    const measuredMs = marks[index * 2 + 1] - marks[index * 2];
    return { argv: command.argv, measuredMs, eligible: measuredMs <= ELIGIBLE_MS_CEILING };
  });
}

/**
 * @param {string} cwd
 * @param {{measure?: MeasureProbes, maxPaths?: number}} [options]
 * @returns {RepoFacts}
 */
export function collectRepoFacts(cwd, options = {}) {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const allPaths = listTrackedPaths(cwd);
  const pathSet = new Set(allPaths);
  const scripts = readScripts(cwd);
  const commands = candidateCommands(scripts, allPaths);
  const truncated = allPaths.length > maxPaths;
  return {
    formatVersion: FORMAT_VERSION,
    gitHead: gitHead(cwd),
    paths: truncated ? allPaths.slice(0, maxPaths) : allPaths,
    truncated,
    scripts,
    verificationCandidates: measureCandidates(cwd, commands, options.measure ?? {}),
    testFiles: testFileEntries(allPaths, pathSet),
  };
}
