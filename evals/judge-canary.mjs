/**
 * Builds and checks the judge canary corpus. This module owns the sealed-case
 * format (a golden task's parent sha plus one sealed diff) so the builder, the
 * corpus verifier, the proof tests and the class all read one definition.
 *
 * The cases come from `judge-canary/corpus.json`: one packet per golden task,
 * stated the way a real contract states it, and one in-file edit set per
 * defect. A clean control is the task's golden diff; a defect is the same diff
 * with its edits applied to files the task already changes. The sources are
 * JSON because they quote this repository's 2026-09 code byte for byte, and
 * its `.mjs` ratchets hold today's conventions, not that code's.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EVALS_ROOT } from "./paths.mjs";

const REPO_ROOT = resolve(EVALS_ROOT, "..");
const CANARY_ROOT = join(EVALS_ROOT, "judge-canary");
const CORPUS_SPEC = join(CANARY_ROOT, "corpus.json");
const BUILDER_VERSION = 3;
/** R5 and review finding 5: the corpus floor, each count over distinct golden tasks. */
const MIN_TASKS = 8;
const MIN_CLEAN = 10;
const MIN_PER_KIND = 5;
/** A synchronous git or tar spawn that blocks forever would hang every case that materializes a tree. */
const EXTRACT_TIMEOUT_MS = 30_000;
/** The product's own command-proof ceiling; measured 2026-09-23 the slowest corpus command takes 9 s. */
const VERIFY_TIMEOUT_MS = 120_000;
/** Neutral identity for the throwaway repositories the builder and the judge workspace commit in. */
const GIT_IDENTITY = ["-c", "user.email=evals@example.test", "-c", "user.name=faberun-evals", "-c", "commit.gpgSign=false"];
export const CANARY_KINDS = [
  "nongoal-violated",
  "requirement-half-done",
  "scope-drift-inside-writefiles",
  "doc-contradicts-code",
  "test-weakened",
];
/** The vendor families a corpus entry may name; the vocabulary of runtimes.json's `vendor` field. */
export const AUTHOR_FAMILIES = ["anthropic", "openai", "deepseek", "zhipu", "google"];

/** @typedef {{runtime: string, family: string}} CanaryAuthoredBy */
/** @typedef {{argv: string[]}} Verification */
/** @typedef {{commitSha: string, parentSha: string, parentTreeSha?: string}} GoldenMeta */
/** @typedef {{id: string, statement: string, meta: GoldenMeta, verify: {source?: string, commands: Verification[]}}} GoldenTask */
/** @typedef {{path: string, find: string[], replace: string[]}} CanaryEdit */
/** @typedef {{task: string, kind: string, description: string, edits: CanaryEdit[], authoredBy: CanaryAuthoredBy}} CanaryDefect */
/** @typedef {{task: string, node: string, objective: string, instructions: string[], nonGoals: string[], behaviours: {id: string, text: string}[], summary: string, authoredBy: CanaryAuthoredBy}} CanaryTaskSpec */
/** @typedef {{schemaVersion: number, tasks: CanaryTaskSpec[], defects: CanaryDefect[]}} CanaryCorpusSpec */
/** @typedef {{schemaVersion?: number, id: string, label: string, sourceTask: string, source: GoldenMeta, nodeId: string, diff: string, diffPaths: string[], verification: Verification[], taskPacket: Record<string, unknown>, definitionOfDone: Record<string, unknown>[], workerResult: Record<string, unknown>, authoredBy: CanaryAuthoredBy, mutation?: {kind: string, description: string, edits: CanaryEdit[]}}} CanaryArtifact */
/** @typedef {{id: string, label: string, sourceTask: string, ok: boolean, failures: string[]}} CanaryVerification */

/**
 * The judgment items every case carries besides its task's own behaviours.
 * They are the same for a clean control and for each defect, so they tell the
 * judge what a careful review checks, never which case it is looking at.
 */
const COMMON_JUDGMENT_ITEMS = [
  {
    id: "in-scope",
    text: "Every change in the diff serves the objective, and none does what a non-goal excludes.",
    judgment: true,
    reason: "The write boundary admits any edit inside the declared files; no command tells a requested edit from an unrequested one.",
  },
  {
    id: "docs-match-code",
    text: "Every comment and document the diff adds or edits describes what the code does.",
    judgment: true,
    reason: "No command compares prose with behaviour.",
  },
  {
    id: "tests-assert-behaviour",
    text: "Every test the diff adds or edits asserts the behaviour its name and the instructions claim, and no assertion is removed or loosened.",
    judgment: true,
    reason: "A loosened assertion still passes; only reading the test shows what it no longer checks.",
  },
];
const BEHAVIOUR_REASON = "The verification exercises part of this behaviour at most; reading the change is what shows all of it is there.";

/** The archive's name inside the tree it is extracted into, removed once the tree is out. */
const ARCHIVE_FILE = ".faberun-canary-tree.tar";

/**
 * Extract a commit's tree (or some of its paths) into `dir` through a file, not
 * a pipe, and with a relative name. Measured 2026-09-24 on CI: macOS's bsdtar
 * stops reading at the end-of-archive marker, so the padding `git archive`
 * writes after it hit EPIPE on a piped extraction; and GNU tar on Windows reads
 * `C:\...` in `-C` or `-f` as a remote host, so no absolute path reaches it.
 *
 * @param {string} sha
 * @param {string[]} paths every path when empty
 * @param {string} dir
 * @returns {void}
 */
function extractArchive(sha, paths, dir) {
  const file = join(dir, ARCHIVE_FILE);
  try {
    execFileSync("git", ["-C", REPO_ROOT, "archive", "--output", file, sha, ...(paths.length ? ["--", ...paths] : [])], { stdio: ["ignore", "ignore", "pipe"], timeout: EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL" });
    execFileSync("tar", ["-xf", ARCHIVE_FILE], { cwd: dir, stdio: ["ignore", "ignore", "pipe"], timeout: EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL" });
  } finally {
    rmSync(file, { force: true });
  }
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function runGit(args, cwd = REPO_ROOT) {
  return runGitPreservingOutput(args, cwd).trim();
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function runGitPreservingOutput(args, cwd = REPO_ROOT) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL" });
}

/** @param {string} path @returns {Record<string, unknown>} */
function readJson(path) {
  return /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, "utf8")));
}

/** @param {string} id @returns {GoldenTask} */
function goldenTask(id) {
  const dir = join(EVALS_ROOT, "golden", id);
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`judge canary names golden task ${id}, which evals/golden/ does not hold`);
  const meta = /** @type {GoldenMeta} */ (readJson(join(dir, "meta.json")));
  const verify = /** @type {{source?: string, commands: Verification[]}} */ (readJson(join(dir, "verify.json")));
  return { id, statement: readFileSync(join(dir, "statement.md"), "utf8"), meta, verify };
}

/**
 * The hand-authored corpus sources.
 *
 * @param {string} [file]
 * @returns {CanaryCorpusSpec}
 */
export function loadCorpusSpec(file = CORPUS_SPEC) {
  return /** @type {CanaryCorpusSpec} */ (/** @type {unknown} */ (readJson(file)));
}

/**
 * The author of one corpus entry, refused unless it names a runtime and a known
 * vendor family. Why the builder refuses: the report separates recall by author
 * family, so a case with no author would mislabel the measurement it feeds.
 *
 * @param {unknown} value
 * @param {string} context
 * @returns {CanaryAuthoredBy}
 */
function authoredByOf(value, context) {
  const entry = /** @type {{runtime?: unknown, family?: unknown}|null|undefined} */ (value);
  if (entry === null || typeof entry !== "object") throw new Error(`${context} has no authoredBy`);
  if (typeof entry.runtime !== "string" || entry.runtime.length === 0) throw new Error(`${context} declares no author runtime`);
  if (typeof entry.family !== "string" || !AUTHOR_FAMILIES.includes(entry.family)) {
    throw new Error(`${context} names author family ${JSON.stringify(entry.family)}, not one of ${AUTHOR_FAMILIES.join(", ")}`);
  }
  return { runtime: entry.runtime, family: entry.family };
}

/**
 * The paths one sealed diff changes, read from its `diff --git` headers the
 * way the product reads a sealed attempt's changed paths. The builder writes
 * every diff with `--no-renames`, so each header names one path twice; any
 * other header is refused rather than guessed at.
 *
 * @param {string} diff
 * @returns {string[]}
 */
export function sealedDiffPaths(diff) {
  /** @type {string[]} */
  const paths = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const rest = line.startsWith("diff --git a/") ? line.slice("diff --git a/".length) : "";
    const path = rest.slice(0, (rest.length - " b/".length) / 2);
    if (!path || rest !== `${path} b/${path}`) throw new Error(`sealed diff header is not a same-path change: ${line}`);
    paths.push(path);
  }
  return paths;
}

/** @param {GoldenTask} task @returns {string[]} */
function goldenChangedPaths(task) {
  return runGit(["diff", "--name-only", "--no-renames", task.meta.parentSha, task.meta.commitSha]).split("\n").filter(Boolean);
}

/** @param {CanaryTaskSpec} spec @param {GoldenTask} task @param {string[]} writeFiles @returns {Record<string, unknown>} */
function taskPacket(spec, task, writeFiles) {
  return {
    mode: "execution",
    objective: spec.objective,
    instructions: spec.instructions,
    readFiles: writeFiles,
    writeFiles,
    writeRoots: [],
    symbols: [],
    decisions: [],
    nonGoals: spec.nonGoals,
    verification: task.verify.commands,
  };
}

/** @param {CanaryTaskSpec} spec @param {GoldenTask} task @returns {Record<string, unknown>[]} */
function definitionOfDone(spec, task) {
  return [
    {
      id: "verification",
      text: "The declared verification commands pass on the sealed tree.",
      proof: { kind: "command", ref: task.verify.commands.map((entry) => entry.argv.join(" ")).join(" && ") },
    },
    ...spec.behaviours.map((behaviour) => ({ id: behaviour.id, text: behaviour.text, judgment: true, reason: BEHAVIOUR_REASON })),
    ...COMMON_JUDGMENT_ITEMS,
  ];
}

/**
 * Apply one defect's edits to a tree holding the golden output. Each anchor
 * must occur exactly once in a file the task already changes, so a defect can
 * only ever be a change to the task's real files inside its writeFiles.
 *
 * @param {string} dir @param {CanaryEdit[]} edits @param {string[]} writeFiles @param {string} caseId
 * @returns {void}
 */
function applyEdits(dir, edits, writeFiles, caseId) {
  for (const edit of edits) {
    if (!writeFiles.includes(edit.path)) throw new Error(`canary case ${caseId}: ${edit.path} is outside the task's writeFiles`);
    const file = join(dir, edit.path);
    const text = readFileSync(file, "utf8");
    const find = edit.find.join("\n");
    const count = text.split(find).length - 1;
    if (count !== 1) throw new Error(`canary case ${caseId}: the edit anchor in ${edit.path} matches ${count} times, not once`);
    writeFileSync(file, text.replace(find, () => edit.replace.join("\n")));
  }
}

/**
 * The sealed diff of one case: the golden diff, or the golden diff with the
 * defect's edits applied, rebuilt in a throwaway repository that holds only
 * the task's changed files.
 *
 * @param {GoldenTask} task @param {string[]} writeFiles @param {CanaryEdit[]|null} edits @param {string} caseId
 * @returns {string}
 */
function sealedDiff(task, writeFiles, edits, caseId) {
  const golden = runGitPreservingOutput(["diff", "--binary", "--no-renames", task.meta.parentSha, task.meta.commitSha]);
  if (!edits) return golden;
  const temp = mkdtempSync(join(tmpdir(), "faberun-canary-build-"));
  try {
    const present = runGit(["ls-tree", "-r", "--name-only", task.meta.parentSha, "--", ...writeFiles]).split("\n").filter(Boolean);
    if (present.length > 0) {
      extractArchive(task.meta.parentSha, present, temp);
    }
    runGit(["init", "-q"], temp);
    runGit(["add", "-A"], temp);
    runGit([...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "base"], temp);
    applySealedDiff(temp, golden);
    applyEdits(temp, edits, writeFiles, caseId);
    runGit(["add", "-A"], temp);
    const diff = runGitPreservingOutput(["diff", "--cached", "--binary", "--no-renames"], temp);
    if (diff === golden) throw new Error(`canary case ${caseId}: its edits leave the golden diff unchanged`);
    return diff;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** @param {CanaryTaskSpec} spec @param {CanaryDefect|null} defect @returns {CanaryArtifact} */
function makeArtifact(spec, defect) {
  const task = goldenTask(spec.task);
  const label = defect ? `defect:${defect.kind}` : "clean";
  const id = `${defect ? `defect-${defect.kind}` : "clean"}-${task.id}`;
  const authoredBy = authoredByOf(defect ? defect.authoredBy : spec.authoredBy, defect
    ? `judge canary defect ${defect.kind} on ${spec.task}`
    : `judge canary task ${spec.task}`);
  const writeFiles = goldenChangedPaths(task);
  const diff = sealedDiff(task, writeFiles, defect ? defect.edits : null, id);
  const diffPaths = sealedDiffPaths(diff);
  return {
    id,
    label,
    sourceTask: task.id,
    source: task.meta,
    nodeId: spec.node,
    diff,
    diffPaths,
    verification: task.verify.commands,
    taskPacket: taskPacket(spec, task, writeFiles),
    definitionOfDone: definitionOfDone(spec, task),
    workerResult: {
      status: "done",
      summary: spec.summary,
      verification: task.verify.commands.map((entry) => entry.argv.join(" ")),
      artifacts: diffPaths,
      missingContext: [],
    },
    authoredBy,
    ...(defect ? { mutation: { kind: defect.kind, description: defect.description, edits: defect.edits } } : {}),
  };
}

/**
 * Build every case the corpus sources declare: one clean control per task
 * and one case per defect. A test passes its own sources to build a case the
 * shipped corpus does not hold.
 *
 * @param {CanaryCorpusSpec} [spec]
 * @returns {CanaryArtifact[]}
 */
export function buildCanaryArtifacts(spec = loadCorpusSpec()) {
  const tasks = new Map(spec.tasks.map((task) => [task.task, task]));
  /** @type {CanaryArtifact[]} */
  const artifacts = spec.tasks.map((task) => makeArtifact(task, null));
  for (const defect of spec.defects) {
    if (!CANARY_KINDS.includes(defect.kind)) throw new Error(`judge canary defect on ${defect.task} has unknown kind ${defect.kind}`);
    const task = tasks.get(defect.task);
    if (!task) throw new Error(`judge canary defect ${defect.kind} names ${defect.task}, which declares no packet`);
    artifacts.push(makeArtifact(task, defect));
  }
  return artifacts;
}

/**
 * The corpus floor of R5 and review finding 5, each count over distinct
 * golden tasks, so a repeated diff never inflates an n.
 *
 * @param {{label: string, sourceTask: string}[]} cases
 * @returns {string[]} what falls short, empty when the corpus meets the floor
 */
export function corpusShortfalls(cases) {
  /** @param {string} label @returns {number} */
  const distinct = (label) => new Set(cases.filter((entry) => entry.label === label).map((entry) => entry.sourceTask)).size;
  const shortfalls = [];
  const tasks = new Set(cases.map((entry) => entry.sourceTask)).size;
  if (tasks < MIN_TASKS) shortfalls.push(`${tasks} distinct golden tasks, fewer than ${MIN_TASKS}`);
  if (distinct("clean") < MIN_CLEAN) shortfalls.push(`clean controls cover ${distinct("clean")} distinct tasks, fewer than ${MIN_CLEAN}`);
  for (const kind of CANARY_KINDS) {
    if (distinct(`defect:${kind}`) < MIN_PER_KIND) shortfalls.push(`${kind} covers ${distinct(`defect:${kind}`)} distinct tasks, fewer than ${MIN_PER_KIND}`);
  }
  return shortfalls;
}

/**
 * The builder's gate: every clean control passes its task's verification, and
 * no defect is caught by it. A caught case is rejected by name, because a
 * defect a command already catches does not measure the judge.
 *
 * @param {CanaryArtifact[]} artifacts
 * @returns {Promise<void>}
 */
export async function assertDiscriminatingArtifacts(artifacts) {
  const results = await verifyArtifacts(artifacts);
  const broken = results.filter((result) => !result.ok);
  if (broken.length === 0) return;
  throw new Error(broken.map((result) => result.label === "clean"
    ? `canary case ${result.id} is a clean control that fails its own verification: ${result.failures.join("; ")}`
    : `canary case ${result.id} was caught by its verification: ${result.failures.join("; ")}`).join("\n"));
}

/**
 * Extract a golden task's parent tree from this repository into a fresh
 * directory. The caller owns the returned directory.
 *
 * @param {string} parentSha
 * @param {string} [root]
 * @param {string} [prefix]
 * @returns {string}
 */
function extractParentTree(parentSha, root = tmpdir(), prefix = "faberun-canary-base-") {
  const dir = mkdtempSync(join(root, prefix));
  try {
    extractArchive(parentSha, [], dir);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Apply one sealed diff to an already-extracted tree in place. Bounded so a git
 * blocked on a repository lock fails the case it is verifying instead of
 * parking the whole suite.
 *
 * @param {string} dir
 * @param {string} diff
 * @returns {void}
 */
function applySealedDiff(dir, diff) {
  execFileSync("git", ["apply", "--binary"], { cwd: dir, input: diff, stdio: ["pipe", "pipe", "pipe"], timeout: EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL" });
}

/**
 * The tree a harness judge reviews: the parent tree committed as `base`, with
 * the sealed diff applied and left uncommitted, so `git diff` and `git status`
 * show the judge exactly the change under review and nothing names the case.
 * The caller owns the returned directory.
 *
 * @param {CanaryArtifact} artifact
 * @param {string} [root]
 * @returns {string}
 */
export function materializeJudgeWorkspace(artifact, root = tmpdir()) {
  const dir = extractParentTree(artifact.source.parentSha, root, "faberun-review-");
  try {
    runGit(["init", "-q"], dir);
    runGit(["add", "-A"], dir);
    runGit([...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "base"], dir);
    applySealedDiff(dir, artifact.diff);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Materialize one case from an already-extracted parent tree by copying it and
 * applying the case's diff. Why: a corpus verification runs up to four cases
 * per source task, and git archive plus tar once per task is cheaper.
 *
 * @param {CanaryArtifact} artifact
 * @param {string} baseDir
 * @returns {string}
 */
function materializeFromBase(artifact, baseDir) {
  const dir = mkdtempSync(join(tmpdir(), "faberun-canary-"));
  try {
    for (const entry of readdirSync(baseDir)) cpSync(join(baseDir, entry), join(dir, entry), { recursive: true });
    applySealedDiff(dir, artifact.diff);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The environment a historical verification runs under: this process's, with
 * the test runner's context and every provider, notification and controller
 * override removed, so a 2026-09 test neither nests inside this runner nor
 * reaches a real provider or a real notification transport.
 *
 * @returns {Record<string, string>}
 */
function verificationEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "NODE_TEST_CONTEXT" || key === "NODE_OPTIONS") continue;
    if (/^(?:FABERUN|PLAN_RUNNER)_/u.test(key) || /NOTIFY/u.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** @param {unknown} error @returns {string|undefined} */
function errorCode(error) {
  return /** @type {{code?: string}} */ (error)?.code;
}

/**
 * Kill a verification's whole process group. Measured 2026-09-23: a golden
 * test killed on its own left the git children it had spawned running under
 * pid 1, so the group goes, not the pid.
 *
 * @param {number|undefined} pid
 * @returns {void}
 */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/**
 * Run one verification command in its own process group and settle with the
 * failure it reports, or null when it exits 0.
 *
 * @param {Verification} verification
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
function runVerification(verification, cwd) {
  const [executable, ...args] = verification.argv;
  return new Promise((settle) => {
    const child = spawn(executable ?? "", args, { cwd, env: verificationEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    /** @param {Buffer} chunk */
    const keep = (chunk) => { tail = `${tail}${chunk}`.slice(-2048); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => killGroup(child.pid), VERIFY_TIMEOUT_MS);
    let settled = false;
    /** @param {string|null} failure */
    const done = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      settle(failure);
    };
    child.on("error", (error) => done(`${verification.argv.join(" ")} (${error.message})`));
    child.on("close", (code, signal) => done(code === 0
      ? null
      : `${verification.argv.join(" ")} (${signal ? `signal ${signal}` : `exit ${code}`}): ${tail.trim().split("\n").slice(-3).join(" | ")}`));
  });
}

/**
 * Run each case's verification over its own tree, one case at a time, every
 * parent tree extracted once. A clean control is ok when its verification
 * passes; a defect is ok when its verification passes too, which is what makes
 * it a defect only a judge can find.
 *
 * @param {CanaryArtifact[]} artifacts
 * @returns {Promise<CanaryVerification[]>}
 */
async function verifyArtifacts(artifacts) {
  /** @type {Map<string, string>} */
  const bases = new Map();
  /** @type {CanaryVerification[]} */
  const results = [];
  try {
    for (const artifact of artifacts) {
      /** @type {string[]} */
      const failures = [];
      /** @type {string|null} */
      let tree = null;
      try {
        const parentSha = artifact.source.parentSha;
        let baseDir = bases.get(parentSha);
        if (baseDir === undefined) {
          baseDir = extractParentTree(parentSha);
          bases.set(parentSha, baseDir);
        }
        tree = materializeFromBase(artifact, baseDir);
        for (const verification of artifact.verification) {
          // A failure is asked once more before it counts: the golden tasks'
          // 2026-09 suites are load-sensitive. Measured 2026-09-24: under a
          // loaded full suite the supervisor test failed a canary case once in
          // three runs and passed it four times in four alone. A defect a
          // verification really catches fails both times and is still refused.
          const failure = await runVerification(verification, tree) && await runVerification(verification, tree);
          if (failure) failures.push(failure);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      } finally {
        if (tree) rmSync(tree, { recursive: true, force: true });
      }
      results.push({ id: artifact.id, label: artifact.label, sourceTask: artifact.sourceTask, ok: failures.length === 0, failures });
    }
  } finally {
    for (const baseDir of bases.values()) rmSync(baseDir, { recursive: true, force: true });
  }
  return results;
}

/** @param {CanaryArtifact[]} artifacts @returns {void} */
function writeArtifacts(artifacts) {
  mkdirSync(CANARY_ROOT, { recursive: true });
  const ids = artifacts.map((artifact) => artifact.id);
  const expected = new Set(ids);
  for (const entry of readdirSync(CANARY_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && !expected.has(entry.name)) rmSync(join(CANARY_ROOT, entry.name), { recursive: true, force: true });
  }
  for (const artifact of artifacts) {
    const dir = join(CANARY_ROOT, artifact.id);
    mkdirSync(dir, { recursive: true });
    const { diff, ...rest } = artifact;
    const spec = { schemaVersion: BUILDER_VERSION, ...rest, diff: "diff.patch", diffSha256: createHash("sha256").update(diff).digest("hex") };
    writeFileSync(join(dir, "case.json"), `${JSON.stringify(spec, null, 2)}\n`);
    writeFileSync(join(dir, "diff.patch"), diff);
  }
  const counts = Object.fromEntries(["clean", ...CANARY_KINDS.map((kind) => `defect:${kind}`)].map((label) => [label, artifacts.filter((artifact) => artifact.label === label).length]));
  const manifest = {
    schemaVersion: BUILDER_VERSION,
    builderVersion: BUILDER_VERSION,
    source: "evals/judge-canary/corpus.json over evals/golden",
    tasks: [...new Set(artifacts.map((artifact) => artifact.sourceTask))].sort(),
    cases: ids,
    counts,
  };
  writeFileSync(join(CANARY_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** @returns {string[]} */
export function discoverCanaryCaseIds() {
  if (!existsSync(CANARY_ROOT)) return [];
  return readdirSync(CANARY_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(CANARY_ROOT, entry.name, "case.json"))).map((entry) => entry.name).sort();
}

/** @param {string} caseId @returns {CanaryArtifact} */
export function loadCanaryCase(caseId) {
  const dir = join(CANARY_ROOT, caseId);
  const spec = readJson(join(dir, "case.json"));
  const diff = readFileSync(join(dir, /** @type {string} */ (spec.diff)), "utf8");
  const actualHash = createHash("sha256").update(diff).digest("hex");
  if (actualHash !== spec.diffSha256) throw new Error(`canary case ${caseId} has a sealed diff hash mismatch`);
  return { .../** @type {CanaryArtifact} */ (/** @type {unknown} */ (spec)), diff };
}

/** @returns {Promise<CanaryVerification[]>} */
export function verifyCanaryCorpus() {
  return verifyArtifacts(discoverCanaryCaseIds().map(loadCanaryCase));
}

/** @returns {Promise<void>} */
async function build() {
  const artifacts = buildCanaryArtifacts();
  const shortfalls = corpusShortfalls(artifacts);
  if (shortfalls.length > 0) throw new Error(`judge canary corpus falls short: ${shortfalls.join("; ")}`);
  await assertDiscriminatingArtifacts(artifacts);
  writeArtifacts(artifacts);
  process.stdout.write(`built ${artifacts.length} judge canary cases over ${new Set(artifacts.map((artifact) => artifact.sourceTask)).size} golden tasks\n`);
}

/** @param {string[]} argv @returns {Promise<void>} */
async function main(argv) {
  if (argv.includes("--verify-discriminating")) {
    const results = await verifyCanaryCorpus();
    const failures = results.filter((result) => !result.ok);
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ schemaVersion: BUILDER_VERSION, ok: failures.length === 0, cases: results }, null, 2)}\n`);
    else for (const result of results) process.stdout.write(`[${result.ok ? "ok" : "fail"}] ${result.id}\n`);
    if (failures.length > 0) {
      for (const result of failures) for (const failure of result.failures) process.stderr.write(`canary case ${result.id}: ${failure}\n`);
      process.exitCode = 1;
    }
    return;
  }
  await build();
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) await main(process.argv.slice(2));
