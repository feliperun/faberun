/**
 * Repo facts: a deterministic, bounded inventory of the target repository —
 * tracked paths, declared scripts, verification candidates across the Node,
 * Python, Go, Rust, Zig and Makefile ecosystems, and which source modules each
 * test file covers, by its name and by what it imports or runs — collected
 * without invoking a model. Every candidate
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
import { directReferenceGraph } from "../repo/scope-closure.mjs";
import { boundedGitSync, gitHead } from "../repo/worktree.mjs";
import { runShellCapture } from "./proof-run.mjs";

/** @typedef {import("./spec.mjs").SpecRequirement} SpecRequirement */
/** @typedef {import("./proof-run.mjs").MeasureProbes} MeasureProbes */
/** @typedef {{requirementId: string|null, command: string, output: string, exitCode: number|null, truncated: boolean}} RequirementMeasurement */
/**
 * A verification command repo facts measured: a timed Node candidate, the
 * manifest file it was read from, and its eligibility. It keeps the shape
 * `freeze.mjs`'s `MeasuredFacts` reads (`argv` plus a numeric `measuredMs`),
 * so a repository's facts stay assignable there while carrying the manifest
 * the planner needs.
 *
 * @typedef {{argv: string[], manifest: string, measuredMs: number, eligible: boolean}} VerificationCandidate
 */
/**
 * A verification command repo facts detected in a non-Node manifest it never
 * ran: `pyproject.toml`/`pytest.ini` (Python), `go.mod`, `Cargo.toml`,
 * `build.zig`, or a `Makefile` with a `test` target. Detection is file
 * inspection alone, so `measuredMs` is the null "no measurement" sentinel
 * `freeze.mjs` reads and `eligible` is true — the manifest's own presence is
 * the evidence. `manifest` names the file the command was read from.
 *
 * @typedef {{argv: string[], manifest: string, measuredMs: number|null, eligible: boolean}} DetectedVerificationCandidate
 */
/** @typedef {{path: string, covers: string[]}} TestFileEntry */
/** @typedef {{formatVersion: number, gitHead: string|null, paths: string[], truncated: boolean, scripts: Record<string, string>, verificationCandidates: VerificationCandidate[], detectedVerificationCandidates?: DetectedVerificationCandidate[], testFiles: TestFileEntry[], requirementMeasurements: RequirementMeasurement[]}} RepoFacts */

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
 * What each test file covers: the module it is named after, when that module
 * exists, plus every tracked module it imports or runs (RM-109). The naming
 * convention alone was the whole answer, so a test that exercises a module
 * without being named for it — a cross-module integration test, a test that
 * spawns the CLI by URL — was invisible to planning. Measured on
 * `safe-to-hand-to-a-friend`: four failures in 1763 reached the integration
 * branch while every node had passed its own suite.
 *
 * Only tracked paths count, so a stray file in the working tree cannot become
 * part of a plan's verification, and only `test/**\/*.test.mjs` files are
 * entries at all: a helper is covered by the tests that import it, never a
 * verifier itself.
 *
 * @param {string[]} paths
 * @param {Set<string>} pathSet
 * @param {Map<string, string[]>} references repo-relative references per file
 * @returns {TestFileEntry[]}
 */
function testFileEntries(paths, pathSet, references) {
  return paths
    .filter((path) => path.startsWith("test/") && path.endsWith(".test.mjs"))
    .map((path) => {
      /** @type {Set<string>} */
      const covers = new Set();
      const namedAfter = `src/${path.slice("test/".length, -".test.mjs".length)}.mjs`;
      if (pathSet.has(namedAfter)) covers.add(namedAfter);
      for (const referenced of references.get(path) ?? []) {
        if (pathSet.has(referenced)) covers.add(referenced);
      }
      return { path, covers: [...covers].sort() };
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
  /** @param {string} name @returns {boolean} */
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
 * How a caller watches this stage work. `commands` arrives once, naming every
 * command about to be timed; `measured` arrives once per command as it
 * finishes. Neither reaches the returned facts: two calls at the same HEAD
 * stay byte-identical because no event is written into them.
 *
 * Measured 2026-09-25/26 (AP3): this stage took five to eight minutes and said
 * nothing while it did, so `faberun plan` was indistinguishable from a hang
 * and the operator checked the process by hand on six relaunches.
 *
 * @typedef {(event: {kind: "commands", commands: string[][]} | {kind: "measured", argv: string[], measuredMs: number, index: number, total: number}) => void} RepoFactsProgress
 */

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
 * @param {RepoFactsProgress} [onProgress]
 * @returns {{argv: string[], measuredMs: number, eligible: boolean}[]}
 */
function measureCandidates(cwd, commands, probes, onProgress) {
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
  timeVerificationCommands(contract, {
    ...probes,
    now: () => {
      const mark = now();
      marks.push(mark);
      // Every command contributes exactly one start mark and one stop mark, in
      // order, so an even mark count means the command at half that count just
      // finished. That is the only progress signal this stage has while it
      // holds the terminal for minutes.
      const stopped = marks.length;
      if (stopped % 2 === 0 && onProgress) {
        onProgress({ kind: "measured", argv: commands[stopped / 2 - 1].argv, measuredMs: mark - marks[stopped - 2], index: stopped / 2, total: commands.length });
      }
      return mark;
    },
  });
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
 * @param {{measure?: MeasureProbes, maxPaths?: number, requirements?: SpecRequirement[], onProgress?: RepoFactsProgress}} [options]
 * @returns {RepoFacts}
 */
export function collectRepoFacts(cwd, options = {}) {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const allPaths = listTrackedPaths(cwd);
  const pathSet = new Set(allPaths);
  const scripts = readScripts(cwd);
  const candidates = nodeCandidateCommands(scripts, allPaths);
  options.onProgress?.({ kind: "commands", commands: candidates.map((command) => command.argv) });
  const measured = measureCandidates(cwd, candidates, options.measure ?? {}, options.onProgress);
  const detected = manifestCandidateCommands(cwd);
  const truncated = allPaths.length > maxPaths;
  return {
    formatVersion: FORMAT_VERSION,
    gitHead: gitHead(cwd),
    paths: truncated ? allPaths.slice(0, maxPaths) : allPaths,
    truncated,
    scripts,
    // The measured Node candidates first, in their timed order, each naming
    // package.json as the manifest it came from; then the manifest-only
    // candidates in a fixed ecosystem order, each naming the manifest it was
    // read from. Only the measured candidates carry a numeric `measuredMs`:
    // a detected command is never run, so it lands in its own array with the
    // null "no measurement" sentinel freeze.mjs reads and eligibility true.
    verificationCandidates: measured.map((candidate) => ({ ...candidate, manifest: PACKAGE_MANIFEST })),
    detectedVerificationCandidates: detected.map((candidate) => ({ ...candidate, measuredMs: null, eligible: true })),
    testFiles: testFileEntries(allPaths, pathSet, directReferenceGraph(cwd)),
    requirementMeasurements: measureRequirements(cwd, options.requirements ?? [], options.measure ?? {}),
  };
}
