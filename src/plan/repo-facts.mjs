/**
 * Repo facts: a deterministic, bounded inventory of the target repository —
 * tracked paths, declared scripts, verification candidates across the Node,
 * Python, Go, Rust, Zig and Makefile ecosystems, and which test file covers
 * which source module — collected without invoking a model. Every candidate
 * records the manifest it was read from; only the Node candidates are timed,
 * and no candidate for another ecosystem is ever executed to be found.
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timeVerificationCommands } from "../host/preflight.mjs";
import { boundedGitSync, gitHead } from "../repo/worktree.mjs";
import { runShellCapture } from "./proof-run.mjs";

/** @typedef {import("./spec.mjs").SpecRequirement} SpecRequirement */
/** @typedef {import("./proof-run.mjs").MeasureProbes} MeasureProbes */
/** @typedef {{requirementId: string|null, command: string, output: string, exitCode: number|null, truncated: boolean}} RequirementMeasurement */
/**
 * A verification command repo facts detected, the manifest file it was read
 * from, and its eligibility. The Node candidates are timed, so they carry a
 * numeric `measuredMs`; every other ecosystem's candidate was found by reading
 * its manifest, never by running the command, so its `measuredMs` is null —
 * the same "no measurement" sentinel `freeze.mjs` reads — and its `eligible`
 * is true because the manifest's own presence is the evidence.
 *
 * @typedef {{argv: string[], manifest: string, measuredMs: number|null, eligible: boolean}} VerificationCandidate
 */
/** @typedef {{path: string, covers: string|null}} TestFileEntry */
/** @typedef {{formatVersion: number, gitHead: string|null, paths: string[], truncated: boolean, scripts: Record<string, string>, verificationCandidates: VerificationCandidate[], testFiles: TestFileEntry[], requirementMeasurements: RequirementMeasurement[]}} RepoFacts */

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

/** The manifest the Node candidates — the test directories and the scripts — are read from. */
const PACKAGE_MANIFEST = "package.json";

/**
 * The Node candidates: one per first-level test directory, plus the `check`
 * and `typecheck` scripts `package.json` declares. Every one is measured, so
 * each is handed to the timed probe below; each names package.json as the
 * manifest it came from.
 *
 * @param {Record<string, string>} scripts
 * @param {string[]} paths
 * @returns {{argv: string[], manifest: string}[]}
 */
function nodeCandidateCommands(scripts, paths) {
  const commands = testDirectories(paths).map((directory) => ({ argv: ["node", "--test", directory], manifest: PACKAGE_MANIFEST }));
  for (const name of ["check", "typecheck"]) {
    if (typeof scripts[name] === "string") commands.push({ argv: ["npm", "run", name], manifest: PACKAGE_MANIFEST });
  }
  return commands;
}

/**
 * The makefile that declares a `test` target, or null when none does. A rule
 * line starts at column zero with the target name `test` followed by a colon;
 * `test:=` is a variable assignment, `.PHONY: test` declares no rule, an
 * indented recipe line never matches, and `test-all:` names another target.
 * Pure text inspection of the first conventional makefile present, so a
 * command is never run to discover the target.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function makefileWithTestTarget(cwd) {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    if (/^test[ \t]*:(?!=)/mu.test(readFileSync(path, "utf8"))) return name;
  }
  return null;
}

/**
 * The verification commands the non-Node ecosystems declare, in a fixed order,
 * each naming the manifest file it was read from. Detection is file inspection
 * alone — existence for the manifest files, one read for a Makefile target —
 * so no discovered command is executed, the order never depends on a directory
 * listing, and two calls at the same HEAD return identical candidates.
 * `pyproject.toml` wins over `pytest.ini` when both exist because it is the
 * file pytest itself reads first.
 *
 * @param {string} cwd
 * @returns {{argv: string[], manifest: string}[]}
 */
function manifestCandidateCommands(cwd) {
  /** @type {{argv: string[], manifest: string}[]} */
  const commands = [];
  const present = (name) => existsSync(join(cwd, name));
  if (present("pyproject.toml")) commands.push({ argv: ["pytest"], manifest: "pyproject.toml" });
  else if (present("pytest.ini")) commands.push({ argv: ["pytest"], manifest: "pytest.ini" });
  if (present("go.mod")) commands.push({ argv: ["go", "test", "./..."], manifest: "go.mod" });
  if (present("Cargo.toml")) commands.push({ argv: ["cargo", "test"], manifest: "Cargo.toml" });
  if (present("build.zig")) commands.push({ argv: ["zig", "build", "test"], manifest: "build.zig" });
  const makefile = makefileWithTestTarget(cwd);
  if (makefile !== null) commands.push({ argv: ["make", "test"], manifest: makefile });
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
  /** @type {RequirementMeasurement[]} */
  const measurements = [];
  for (const requirement of requirements) {
    // Only the `command` kind is wired: a `path` or `judgment` measure parses
    // (parseProof already accepts both) but nothing runs it — left unmeasured
    // rather than guessed at.
    if (requirement.measure?.kind !== "command" || !requirement.measure.ref) continue;
    const command = requirement.measure.ref;
    const { output, exitCode, truncated } = runShellCapture(cwd, command, probes);
    measurements.push({ requirementId: requirement.id, command, output, exitCode, truncated });
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
  const measured = measureCandidates(cwd, nodeCandidateCommands(scripts, allPaths), options.measure ?? {});
  const detected = manifestCandidateCommands(cwd);
  const truncated = allPaths.length > maxPaths;
  return {
    formatVersion: FORMAT_VERSION,
    gitHead: gitHead(cwd),
    paths: truncated ? allPaths.slice(0, maxPaths) : allPaths,
    truncated,
    scripts,
    // The Node candidates first, in their measured order, then the
    // manifest-only candidates in a fixed ecosystem order. Only the Node ones
    // carry a numeric `measuredMs`: a detected command is never run, so its
    // manifest's presence is the whole eligibility evidence and its
    // measurement is the null sentinel freeze.mjs already reads.
    verificationCandidates: [
      ...measured.map((candidate) => ({ ...candidate, manifest: PACKAGE_MANIFEST })),
      ...detected.map((candidate) => ({ ...candidate, measuredMs: null, eligible: true })),
    ],
    testFiles: testFileEntries(allPaths, pathSet),
    requirementMeasurements: measureRequirements(cwd, options.requirements ?? [], options.measure ?? {}),
  };
}
