/**
 * Repo facts: a deterministic, bounded inventory of the target repository —
 * tracked paths, declared scripts, timed verification candidates, and which
 * test file covers which source module — collected without invoking a model.
 * A planning stage's draft is authored against exactly this JSON instead of
 * the session reading the repository by hand.
 *
 * When the caller passes the spec's parsed requirements, every `measure`
 * command a requirement declares also runs here — read-only, before any node
 * exists — and its output rides along as `requirementMeasurements`: the draft
 * reasons from a fact the planner measured, not one it inferred from prose.
 *
 * Sorting and the absence of any clock in the output itself (only inside an
 * injected measurer's own numbers) is what makes two calls at the same HEAD
 * byte-identical.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timeVerificationCommands } from "../host/preflight.mjs";
import { NOTIFY_BIN_ENV } from "../notify/index.mjs";
import { NOTIFY_SESSION_ENV } from "../notify/session.mjs";
import { boundedGitSync, gitHead } from "../repo/worktree.mjs";

/** @typedef {import("./spec.mjs").SpecRequirement} SpecRequirement */
/** @typedef {{requirementId: string|null, command: string, output: string, exitCode: number|null, truncated: boolean}} RequirementMeasurement */
/** @typedef {{argv: string[], measuredMs: number, eligible: boolean}} VerificationCandidate */
/** @typedef {{path: string, covers: string|null}} TestFileEntry */
/** @typedef {{formatVersion: number, gitHead: string|null, paths: string[], truncated: boolean, scripts: Record<string, string>, verificationCandidates: VerificationCandidate[], testFiles: TestFileEntry[], requirementMeasurements: RequirementMeasurement[]}} RepoFacts */
/** @typedef {{now?: () => number, run?: typeof import("node:child_process").spawnSync}} MeasureProbes */

const FORMAT_VERSION = 1;
const DEFAULT_MAX_PATHS = 2000;
const ELIGIBLE_MS_CEILING = 600_000;
const CANDIDATE_TIMEOUT_SEC = ELIGIBLE_MS_CEILING / 1_000;
const MEASURE_TIMEOUT_MS = 30_000;
const MEASURE_OUTPUT_CAP_BYTES = 4096;

/**
 * The same named few `timeVerificationCommands` subtracts before spawning a
 * measurement (SIDE_EFFECT_ENV_KEYS in src/host/preflight.mjs, which is
 * module-private and could not be edited by the node that added this): a
 * measure must not notify a human and must not be redirectable at a live,
 * paid harness binary. A subtraction of a named few, not an allowlist — PATH,
 * HOME and every ordinary variable still pass through unchanged.
 */
const MEASURE_SIDE_EFFECT_ENV_KEYS = [
  NOTIFY_BIN_ENV,
  NOTIFY_SESSION_ENV,
  "FABERUN_CODEX_BIN",
  "FABERUN_CLAUDE_BIN",
  "FABERUN_AGY_BIN",
  "FABERUN_DSH_BIN",
  "FABERUN_ZCODE_BIN",
  "FABERUN_EXEC_JSONL_BIN",
];

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
 * Run every requirement's declared `measure` command against the repository
 * as it stands right now and record what it reports. This is the planner's
 * fact, not the node's proof: it has to be evaluable before any node exists,
 * which is why it reuses the same SpecProof shape `proof` parses into.
 *
 * The command goes through the shell (`spawnSync` with `shell: true`), so a
 * requirement's own pipe — `| wc -l`, `| grep -v …` — works exactly as a spec
 * author would type it at a terminal. The bounding shape matches
 * `timeVerificationCommands` (stripped env, injectable probes, a hard
 * ceiling) but that function discards stdout by design, so it cannot be
 * reused where the output is the point. A non-zero exit is recorded, never
 * thrown: finding the pattern still present is exactly the fact a draft
 * needs.
 *
 * @param {string} cwd
 * @param {SpecRequirement[]} requirements
 * @param {MeasureProbes} [probes]
 * @returns {RequirementMeasurement[]}
 */
export function measureRequirements(cwd, requirements, probes = {}) {
  if (requirements.length === 0) return [];
  const run = probes.run ?? spawnSync;
  const env = { ...process.env };
  for (const key of MEASURE_SIDE_EFFECT_ENV_KEYS) delete env[key];
  /** @type {RequirementMeasurement[]} */
  const measurements = [];
  for (const requirement of requirements) {
    // Only the `command` kind is wired: a `path` or `judgment` measure parses
    // (parseProof already accepts both) but nothing runs it — left unmeasured
    // rather than guessed at.
    if (requirement.measure?.kind !== "command" || !requirement.measure.ref) continue;
    const command = requirement.measure.ref;
    const result = run(command, { shell: true, cwd, timeout: MEASURE_TIMEOUT_MS, encoding: "utf8", env });
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const bytes = Buffer.from(combined, "utf8");
    const truncated = bytes.length > MEASURE_OUTPUT_CAP_BYTES;
    measurements.push({
      requirementId: requirement.id,
      command,
      output: truncated ? bytes.subarray(0, MEASURE_OUTPUT_CAP_BYTES).toString("utf8") : combined,
      exitCode: result.status,
      truncated,
    });
  }
  return measurements;
}

/**
 * @param {string} cwd
 * @param {{measure?: MeasureProbes, maxPaths?: number, requirements?: SpecRequirement[]}} [options]
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
    requirementMeasurements: measureRequirements(cwd, options.requirements ?? [], options.measure ?? {}),
  };
}
