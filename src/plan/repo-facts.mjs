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
 *
 * The `paths` array is a byte-limited cut, never the tree. A path a
 * requirement's proof or measure names, a test file, and a module the tree
 * references are always kept; the ceiling bounds only what nothing asks for.
 * What the cut discarded is reported per source kind in `pathOmission`, so a
 * reader can tell a dropped manifest from a dropped historical log instead of
 * reading one `truncated` flag, and the complete index every path was listed
 * from is written beside the artefact (`writePathIndex`) for a discovery node
 * explicitly authorised to enumerate the tree.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
/**
 * The source kind a discarded path is reported under. `other` is reserved for
 * a path this module cannot name — no manifest basename, no document, log or
 * source suffix — so a known category is never pooled into it.
 *
 * @typedef {"document"|"archived-log"|"manifest"|"code"|"other"} PathKind
 */
/** @typedef {{paths: number, bytes: number}} PathKindOmission */
/** @typedef {{paths: number, bytes: number, byKind: Record<PathKind, PathKindOmission>}} PathOmission */
/** @typedef {{formatVersion: number, gitHead: string|null, paths: string[], pathOmission: PathOmission, scripts: Record<string, string>, verificationCandidates: VerificationCandidate[], detectedVerificationCandidates?: DetectedVerificationCandidate[], testFiles: TestFileEntry[], requirementMeasurements: RequirementMeasurement[]}} RepoFacts */

const FORMAT_VERSION = 1;
/**
 * The byte ceiling on the artefact's `paths` array. Measured 2026-09-21
 * (AGENTS.md, Faberun protocol): a node whose serialized packet passed 64 KiB
 * was killed by the guard that serializes it, and this inventory rides in that
 * same packet — so the cut is held under 48 KiB and the rest of the artefact
 * has the remainder. A count cap (the 2000 paths this replaces) says nothing
 * about size: the same count is a different artefact in every repository.
 */
export const DEFAULT_MAX_PATH_BYTES = 48 * 1024;
const ELIGIBLE_MS_CEILING = 600_000;
const CANDIDATE_TIMEOUT_SEC = ELIGIBLE_MS_CEILING / 1_000;

/** Every kind a discarded path can be reported under, so the omission report
 * carries a full row per kind even when it discarded nothing there. */
export const PATH_KINDS = Object.freeze(/** @type {PathKind[]} */ (["document", "archived-log", "manifest", "code", "other"]));

/** The files commands are declared in: this module reads its own candidates
 * out of the first two, and the rest are the other ecosystems' manifests. */
export const MANIFEST_BASENAMES = Object.freeze([
  "package.json", "package-lock.json", "tsconfig.json",
  "pyproject.toml", "pytest.ini", "go.mod", "go.sum",
  "Cargo.toml", "Cargo.lock", "build.zig", "build.zig.zon",
  "Makefile", "makefile", "GNUmakefile",
]);

/** Every TOML file is a manifest, declared name or not (`netlify.toml`). */
export const MANIFEST_SUFFIX = ".toml";

/** Prose a human wrote for a human: a document is never a build input. */
export const DOCUMENT_SUFFIX = ".md";

/** Directories holding historical record: ledgers and superseded runs. */
export const ARCHIVED_LOG_PREFIXES = Object.freeze([".runs/", "docs/history/"]);

/** A machine-written ledger, wherever it lives. */
export const ARCHIVED_LOG_SUFFIX = ".jsonl";

/**
 * The extensions of the ecosystems this module already reasons about (Node,
 * Python, Go, Rust, Zig, shell). A path whose extension is not here is not
 * promoted to `code`: calling a PNG source would be the same lie in the other
 * direction as calling it `other`.
 */
const CODE_SUFFIXES = Object.freeze([".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".zig", ".sh", ".mk", ".c", ".h"]);

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

/**
 * The bytes one path costs the artefact: its own UTF-8 length. That is what
 * the ceiling counts and what the omission report sums, so the number a reader
 * sees for a discarded kind is the number that kind was worth to the budget.
 *
 * @param {string} path
 * @returns {number}
 */
export function pathBytes(path) {
  return Buffer.byteLength(path, "utf8");
}

/**
 * Which source kind one path belongs to. Total by construction — every path
 * lands in exactly one of `PATH_KINDS` — which is what lets the per-kind
 * counts of a cut sum to the discarded total with no path uncounted.
 *
 * Order matters: a `docs/history/*.md` is record, not live prose, and a
 * `package.json` is a manifest, not a document that happens to be JSON.
 *
 * @param {string} path
 * @returns {PathKind}
 */
export function pathKindOf(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (MANIFEST_BASENAMES.includes(basename) || basename.endsWith(MANIFEST_SUFFIX)) return "manifest";
  if (ARCHIVED_LOG_PREFIXES.some((prefix) => path.startsWith(prefix)) || basename.endsWith(ARCHIVED_LOG_SUFFIX)) return "archived-log";
  if (basename.endsWith(DOCUMENT_SUFFIX)) return "document";
  if (CODE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return "code";
  return "other";
}

/**
 * The tracked paths the cut may not discard, whatever the byte ceiling: every
 * path a requirement's own proof or measure names, every test file, and every
 * module the tree references. A path a requirement names is the one piece of
 * the tree the plan is already contracted to reason about; dropping it to save
 * bytes would make the artefact cheap and the plan blind. References matter
 * for the same reason: a module nothing names is a leaf, a module something
 * reads is where a change lands.
 *
 * @param {string[]} allPaths every tracked path
 * @param {SpecRequirement[]} requirements
 * @param {Map<string, string[]>} references repo-relative references per file
 * @returns {Set<string>}
 */
export function requiredPaths(allPaths, requirements, references) {
  const tracked = new Set(allPaths);
  /** @type {Set<string>} */
  const required = new Set();
  for (const requirement of requirements) {
    for (const proof of [requirement.proof, requirement.measure]) {
      if (proof?.kind !== "path" || typeof proof.ref !== "string") continue;
      if (tracked.has(proof.ref)) required.add(proof.ref);
    }
  }
  for (const path of allPaths) {
    if (path.startsWith("test/") && path.endsWith(".test.mjs")) required.add(path);
  }
  for (const referenced of references.values()) {
    for (const path of referenced) if (tracked.has(path)) required.add(path);
  }
  return required;
}

/**
 * The byte-limited cut over the tracked paths. Every required path is kept
 * whatever the ceiling; the rest are kept in sorted order while the path bytes
 * fit. Each discarded path is counted once under the one kind `pathKindOf`
 * gives it, so the per-kind counts and bytes sum to the omitted total by
 * construction — no path counted twice, none uncounted, and a known category
 * never reported as a generic `other`.
 *
 * The ceiling bounds only what nothing requires, so the kept list can exceed
 * `maxPathBytes` on a repository whose requirements name more than the budget
 * holds. That is the intended direction: an artefact cheap and blind is the
 * outcome this rule exists to prevent, and `omitted` says by how much the rest
 * lost.
 *
 * @param {string[]} allPaths every tracked path, sorted
 * @param {Set<string>} required the paths `requiredPaths` selected
 * @param {number} maxPathBytes
 * @returns {{paths: string[], omitted: PathOmission}}
 */
export function cutPaths(allPaths, required, maxPathBytes) {
  const byKind = /** @type {Record<PathKind, PathKindOmission>} */ (Object.fromEntries(PATH_KINDS.map((kind) => [kind, { paths: 0, bytes: 0 }])));
  /** @type {string[]} */
  const kept = [];
  let optionalBytes = 0;
  for (const path of allPaths) {
    if (required.has(path)) {
      kept.push(path);
      continue;
    }
    const bytes = pathBytes(path);
    if (optionalBytes + bytes > maxPathBytes) {
      const kind = pathKindOf(path);
      byKind[kind].paths += 1;
      byKind[kind].bytes += bytes;
      continue;
    }
    optionalBytes += bytes;
    kept.push(path);
  }
  const kinds = PATH_KINDS.map((kind) => byKind[kind]);
  return {
    paths: [...kept].sort(),
    omitted: {
      paths: kinds.reduce((sum, entry) => sum + entry.paths, 0),
      bytes: kinds.reduce((sum, entry) => sum + entry.bytes, 0),
      byKind,
    },
  };
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
 * @param {{measure?: MeasureProbes, maxPathBytes?: number, requirements?: SpecRequirement[], onProgress?: RepoFactsProgress}} [options]
 * @returns {RepoFacts}
 */
export function collectRepoFacts(cwd, options = {}) {
  const maxPathBytes = options.maxPathBytes ?? DEFAULT_MAX_PATH_BYTES;
  const allPaths = listTrackedPaths(cwd);
  const pathSet = new Set(allPaths);
  // One graph for both readers: the cut needs it to know what the tree
  // references, `testFileEntries` to know what each test file covers.
  const references = directReferenceGraph(cwd);
  const scripts = readScripts(cwd);
  const candidates = nodeCandidateCommands(scripts, allPaths);
  options.onProgress?.({ kind: "commands", commands: candidates.map((command) => command.argv) });
  const measured = measureCandidates(cwd, candidates, options.measure ?? {}, options.onProgress);
  const detected = manifestCandidateCommands(cwd);
  const requirements = options.requirements ?? [];
  const cut = cutPaths(allPaths, requiredPaths(allPaths, requirements, references), maxPathBytes);
  return {
    formatVersion: FORMAT_VERSION,
    gitHead: gitHead(cwd),
    paths: cut.paths,
    pathOmission: cut.omitted,
    scripts,
    // The measured Node candidates first, in their timed order, each naming
    // package.json as the manifest it came from; then the manifest-only
    // candidates in a fixed ecosystem order, each naming the manifest it was
    // read from. Only the measured candidates carry a numeric `measuredMs`:
    // a detected command is never run, so it lands in its own array with the
    // null "no measurement" sentinel freeze.mjs reads and eligibility true.
    verificationCandidates: measured.map((candidate) => ({ ...candidate, manifest: PACKAGE_MANIFEST })),
    detectedVerificationCandidates: detected.map((candidate) => ({ ...candidate, measuredMs: null, eligible: true })),
    testFiles: testFileEntries(allPaths, pathSet, references),
    requirementMeasurements: measureRequirements(cwd, requirements, options.measure ?? {}),
  };
}

/** The file name the cut artefact is persisted under, both beside the staged
 * planning inputs and durably beside a frozen plan. */
export const REPO_FACTS_FILE = "repo-facts.json";
/** The file name the complete path index is staged under, beside that artefact. */
export const PATH_INDEX_FILE = "repo-paths.txt";

/**
 * Write the complete tracked-path index — every path `git ls-files` reports,
 * one per line — beside the cut artefact. The cut is what a planning stage
 * reads; this file is what an authorised discovery packet reads when it must
 * reach a path the cut discarded, which is why it is a separate file and never
 * a field of the artefact itself: the artefact stays byte-bounded, and the
 * whole tree stays reachable.
 *
 * @param {string} cwd
 * @param {string} indexPath
 * @returns {string[]} the indexed paths, in the order written
 */
export function writePathIndex(cwd, indexPath) {
  const paths = listTrackedPaths(cwd);
  writeFileSync(indexPath, paths.map((path) => `${path}\n`).join(""));
  return paths;
}

/**
 * Persist the two files a later reader needs: the changed artefact — repo
 * facts carrying the byte cut and its per-kind omission report — and the
 * complete path index beside it. `pipeline.mjs` calls this into the scratch
 * relay the draft and review stages read; `resolve.mjs` calls it into the
 * plans directory, so a contested plan resumed without redrafting still leaves
 * the facts it froze with on disk.
 *
 * @param {string} outDir
 * @param {RepoFacts} facts
 * @param {string} cwd the checkout the index is listed from
 * @returns {string} the artefact path
 */
export function persistRepoFacts(outDir, facts, cwd) {
  const factsPath = join(outDir, REPO_FACTS_FILE);
  writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`);
  writePathIndex(cwd, join(outDir, PATH_INDEX_FILE));
  return factsPath;
}
