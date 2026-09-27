/**
 * The executable half of `npm run docs:check`: it runs the getting-started
 * walkthrough on a throwaway repository, under an isolated `FABERUN_HOME`,
 * with the `replay` harness standing in for every provider, and compares the
 * CLI's output against the blocks the guide marks as checked.
 *
 * The manual generator next door keeps `docs/COMMANDS.md` from drifting from
 * the option tables; this module does the same for the one document a
 * newcomer follows literally. Machine-varying fragments — the install home,
 * the project's directory under it, and the run directory — are normalized to
 * the fixed markers `<home>`, `<project>` and `<run>` before the comparison,
 * so the same guide is checkable on any host. A checked output that diverges
 * fails with both the expected excerpt and the one the CLI actually printed.
 *
 * The guide marks its blocks with three invisible HTML comments:
 *
 *   `<!-- walkthrough:contract -->` before the fenced contract JSON, which is
 *   written to `contract.json` with the replay runtimes composed in;
 *   `<!-- walkthrough:run -->` before a fenced command block the check runs; and
 *   `<!-- walkthrough:check -->` before a fenced output block that must match
 *   the preceding command's output.
 *
 * The markers are HTML comments so the rendered guide is unchanged.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedGitSync } from "../repo/worktree.mjs";

/** The guide this check reads. */
export const GUIDE_PATH = fileURLToPath(new URL("../../docs/GETTING-STARTED.md", import.meta.url));

/** The CLI every `faberun …` line in the guide is run as. */
const CLI_ENTRY = fileURLToPath(new URL("../cli.mjs", import.meta.url));

const CONTRACT_MARKER = "<!-- walkthrough:contract -->";
const RUN_MARKER = "<!-- walkthrough:run -->";
const CHECK_MARKER = "<!-- walkthrough:check -->";

/** The placeholders the guide and its checked outputs may carry. */
const PROJECT_LITERAL = "/path/to/target-repository";

/** @typedef {{home: string, project: string, projectId: string|null, runId: string, runDir: string|null}} WalkthroughContext */
/** @typedef {{type: "contract", text: string, line: number}|{type: "command", command: string, output: string|null, line: number}} WalkthroughStep */

/**
 * The fence whose opening line follows `from`, skipping blank lines. Returns
 * the language token, the body and the line index of the opening and closing
 * fences; `null` when the next non-blank line is not a fence.
 *
 * @param {string[]} lines
 * @param {number} from
 * @returns {{language: string, text: string, start: number, end: number}|null}
 */
function readFence(lines, from) {
  let index = from;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  const opening = /^(`{3,})(\S*)/u.exec(lines[index] ?? "");
  if (!opening) return null;
  const fence = opening[1];
  const language = opening[2];
  let end = index + 1;
  while (end < lines.length && lines[end].trim() !== fence) end += 1;
  return { language, text: lines.slice(index + 1, end).join("\n"), start: index, end };
}

/**
 * The marked blocks of the guide, in document order.
 *
 * @param {string} markdown
 * @returns {WalkthroughStep[]}
 */
export function parseWalkthrough(markdown) {
  const lines = markdown.split("\n");
  /** @type {WalkthroughStep[]} */
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].trim();
    if (marker !== CONTRACT_MARKER && marker !== RUN_MARKER && marker !== CHECK_MARKER) continue;
    const block = readFence(lines, index + 1);
    if (!block) throw new Error(`GETTING-STARTED.md line ${index + 1}: ${marker} is not followed by a fenced block`);
    if (marker === CONTRACT_MARKER) {
      steps.push({ type: "contract", text: block.text, line: index + 1 });
    } else if (marker === RUN_MARKER) {
      steps.push({ type: "command", command: block.text, output: null, line: index + 1 });
    } else {
      const command = [...steps].reverse().find((step) => step.type === "command");
      if (!command || command.type !== "command") {
        throw new Error(`GETTING-STARTED.md line ${index + 1}: ${CHECK_MARKER} has no preceding command`);
      }
      command.output = block.text;
    }
    index = block.end;
  }
  return steps;
}

/**
 * Every spelling of a path that may appear in CLI output: the literal one the
 * check passed in and its canonical form. On macOS `/tmp` and `/private/tmp`
 * are the same directory with two names, and `init` prints the canonical one.
 *
 * @param {string|null} path
 * @returns {string[]}
 */
function pathVariants(path) {
  if (!path) return [];
  const variants = [path];
  try {
    const canonical = realpathSync(path);
    if (canonical !== path) variants.push(canonical);
  } catch {
    // A path that does not exist yet — the run directory before the run — has
    // only its literal spelling.
  }
  return variants;
}

/**
 * Replace every machine-varying fragment with its fixed marker. The run
 * directory is replaced first because it contains all three, then the project
 * directory under the home, then the home, then the project id and the project
 * path on their own.
 *
 * @param {string} text
 * @param {WalkthroughContext} context
 * @returns {string}
 */
export function normalizeWalkthroughOutput(text, context) {
  /** @type {[string, string][]} */
  const replacements = [];
  const runDir = context.runDir;
  if (runDir) {
    for (const variant of pathVariants(runDir)) replacements.push([variant, "<home>/projects/<project>/runs/<run>"]);
  }
  if (context.projectId) {
    for (const variant of pathVariants(join(context.home, "projects", context.projectId))) {
      replacements.push([variant, "<home>/projects/<project>"]);
    }
  }
  for (const variant of pathVariants(context.home)) replacements.push([variant, "<home>"]);
  if (context.projectId) replacements.push([context.projectId, "<project>"]);
  for (const variant of pathVariants(context.project)) replacements.push([variant, "<project>"]);
  // Longest needle first: a literal path is a suffix of its canonical
  // `/private`-prefixed twin, so replacing the short one first would leave the
  // canonical spelling mangled (`/private<project>`).
  replacements.sort((left, right) => right[0].length - left[0].length);
  let output = text;
  for (const [needle, replacement] of replacements) {
    if (needle) output = output.split(needle).join(replacement);
  }
  return output;
}

/**
 * Whether `expected` appears in `actual` as a consecutive block of whole
 * lines. Whole lines, not a substring: a guide that promises `valid` must not
 * pass against `valid (2 warnings)`.
 *
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function containsExpectedBlock(actual, expected) {
  const actualLines = actual.split("\n").map((line) => line.trimEnd());
  const expectedLines = expected.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  if (expectedLines.length === 0) return true;
  for (let start = 0; start + expectedLines.length <= actualLines.length; start += 1) {
    if (expectedLines.every((line, index) => actualLines[start + index] === line)) return true;
  }
  return false;
}

/**
 * Substitute the guide's placeholders in one command line.
 *
 * @param {string} command
 * @param {WalkthroughContext} context
 * @returns {string}
 */
function substitutePlaceholders(command, context) {
  return command
    .split(PROJECT_LITERAL).join(context.project)
    .split("<home>").join(context.home)
    .split("<project>").join(context.projectId ?? context.project)
    .split("<run>").join(context.runId)
    .split("<session-id>").join("walkthrough");
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  if (process.platform === "win32") return `"${value}"`;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Run one marked command block. A leading `cd <dir>` line moves the working
 * directory for the rest of the block; every `faberun …` line is run as the
 * checkout's CLI; everything else goes to the shell (the guide's `git add &&
 * git commit` is one such line).
 *
 * @param {string} block
 * @param {WalkthroughContext} context
 * @returns {{stdout: string, stderr: string, status: number, command: string}}
 */
function runCommandBlock(block, context) {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  let cwd = context.project;
  let stdout = "";
  let stderr = "";
  let status = 0;
  let command = "";
  for (const raw of lines) {
    const line = substitutePlaceholders(raw, context);
    if (line.startsWith("cd ")) {
      cwd = resolve(cwd, line.slice(3).trim());
      continue;
    }
    command = line.replace(/^faberun(?=\s)/u, `${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRY)}`);
    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, FABERUN_HOME: context.home },
      input: "",
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout += result.stdout ?? "";
    stderr += result.stderr ?? "";
    status = result.status ?? (result.error ? 1 : 0);
    if (status !== 0) break;
  }
  return { stdout, stderr, status, command };
}

/**
 * @param {string} directory
 * @returns {void}
 */
function initializeRepository(directory) {
  /** @param {string[]} args */
  const run = (args) => {
    const result = boundedGitSync(args, { stdio: "ignore" });
    if (result.error || result.status !== 0) {
      throw new Error(`walkthrough git ${args.join(" ")} failed: ${result.error?.message ?? `exit ${result.status}`}`);
    }
  };
  run(["init", "-q", directory]);
  run(["-C", directory, "config", "user.email", "walkthrough@example.test"]);
  run(["-C", directory, "config", "user.name", "walkthrough"]);
  run(["-C", directory, "config", "commit.gpgSign", "false"]);
  writeFileSync(join(directory, "README.md"), "# Getting started walkthrough\n");
  run(["-C", directory, "add", "-A"]);
  run(["-C", directory, "commit", "-qm", "walkthrough baseline"]);
}

/**
 * The two envelopes a one-node walkthrough needs: a worker that writes
 * `hello.txt`, and a cross-vendor judge that accepts it. They are written
 * beside the throwaway repository, never into it, so the replay cursor
 * sidecars cannot dirty the tree the run cuts from.
 *
 * @param {string} directory
 * @returns {{worker: string, judge: string}}
 */
function writeRecordings(directory) {
  mkdirSync(directory, { recursive: true });
  const worker = join(directory, "worker.jsonl");
  writeFileSync(worker, `${JSON.stringify({
    envelope: {
      status: "done",
      result: JSON.stringify({ status: "done", summary: "wrote hello.txt", verification: [], artifacts: [], missingContext: [] }),
      continuationId: null,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 },
      costUsd: null,
      error: null,
    },
    files: [{ path: "hello.txt", content: "hello\n" }],
  })}\n`);
  const judge = join(directory, "judge.jsonl");
  writeFileSync(judge, `${JSON.stringify({
    envelope: {
      status: "done",
      result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] }),
      continuationId: null,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 },
      costUsd: null,
      error: null,
    },
  })}\n`);
  return { worker, judge };
}

/**
 * @param {string} id
 * @param {string} recording
 * @returns {Record<string, unknown>}
 */
function replayRuntime(id, recording) {
  return {
    harness: "replay",
    model: `${id}-model`,
    vendor: `${id}-vendor`,
    config: { "replay.recording": recording },
  };
}

/**
 * The project id the throwaway repository registered under the home, or null
 * before any command has resolved a runs root.
 *
 * @param {string} home
 * @returns {string|null}
 */
function findProjectId(home) {
  try {
    const entry = readdirSync(join(home, "projects"), { withFileTypes: true })
      .find((candidate) => candidate.isDirectory());
    return entry?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} output
 * @returns {string}
 */
function indent(output) {
  return output.split("\n").map((line) => `    ${line}`).join("\n");
}

/**
 * Run the guide and return every divergence. The returned `mismatches` is
 * empty exactly when the guide matches the CLI.
 *
 * @param {{guidePath?: string}} [options]
 * @returns {{ok: boolean, mismatches: {message: string, command?: string, expected?: string|null, actual?: string}[], error?: string}}
 */
export function checkGettingStarted(options = {}) {
  const guidePath = options.guidePath ?? GUIDE_PATH;
  /** @type {{message: string, command?: string, expected?: string|null, actual?: string}[]} */
  const mismatches = [];
  let steps;
  try {
    steps = parseWalkthrough(readFileSync(guidePath, "utf8"));
  } catch (error) {
    return { ok: false, mismatches, error: error instanceof Error ? error.message : String(error) };
  }
  if (!steps.some((step) => step.type === "command")) {
    return { ok: false, mismatches, error: "GETTING-STARTED.md marks no walkthrough command to run" };
  }
  if (!steps.some((step) => step.type === "command" && step.output !== null)) {
    return { ok: false, mismatches, error: "GETTING-STARTED.md marks no walkthrough output to check" };
  }
  const workRoot = mkdtempSync(join(tmpdir(), "faberun-walkthrough-"));
  const home = join(workRoot, "home");
  const project = join(workRoot, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const recordings = writeRecordings(join(workRoot, "recordings"));
  initializeRepository(project);
  let projectId = findProjectId(home);
  let contractId = "hello";
  try {
    for (const step of steps) {
      if (step.type === "contract") {
        const contract = /** @type {Record<string, unknown>} */ (JSON.parse(step.text));
        if (typeof contract.id === "string" && contract.id) contractId = contract.id;
        // The guide deliberately omits runtimes so the controller composes
        // them from discovery. The check cannot discover a recording, so it
        // pins the replay pair the way the guide says an operator may.
        contract.runtimeDefaults = { worker: "walkthrough-worker", judge: "walkthrough-judge" };
        contract.runtimes = {
          "walkthrough-worker": replayRuntime("walkthrough-worker", recordings.worker),
          "walkthrough-judge": replayRuntime("walkthrough-judge", recordings.judge),
        };
        writeFileSync(join(project, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
        continue;
      }
      let context = /** @type {WalkthroughContext} */ ({
        home,
        project,
        projectId,
        runId: contractId,
        runDir: projectId ? join(home, "projects", projectId, "runs", contractId) : null,
      });
      const result = runCommandBlock(step.command, context);
      projectId = projectId ?? findProjectId(home);
      context = {
        home,
        project,
        projectId,
        runId: contractId,
        runDir: projectId ? join(home, "projects", projectId, "runs", contractId) : null,
      };
      if (result.status !== 0) {
        mismatches.push({
          message: `walkthrough command exited ${result.status}`,
          command: result.command,
          expected: step.output,
          actual: `${result.stdout}${result.stderr}`.trim(),
        });
        break;
      }
      if (step.output !== null) {
        const normalized = normalizeWalkthroughOutput(result.stdout, context);
        if (!containsExpectedBlock(normalized, step.output)) {
          mismatches.push({
            message: "walkthrough output diverged",
            command: result.command,
            expected: step.output.trim(),
            actual: normalized.trim(),
          });
        }
      }
    }
  } catch (error) {
    return { ok: false, mismatches, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * A human-readable report of a failed check, for `manual.mjs --check`'s
 * stderr. Bounded: at most the first few divergences.
 *
 * @param {{mismatches: {message: string, command?: string, expected?: string|null, actual?: string}[], error?: string}} result
 * @returns {string}
 */
export function renderWalkthroughFailure(result) {
  if (result.error) return `docs/GETTING-STARTED.md walkthrough could not run: ${result.error}\n`;
  const lines = ["docs/GETTING-STARTED.md walkthrough is out of date; fix the guide or the CLI it describes."];
  for (const mismatch of result.mismatches.slice(0, 5)) {
    lines.push(`- ${mismatch.message}${mismatch.command ? ` · \`${mismatch.command}\`` : ""}`);
    if (mismatch.expected !== undefined && mismatch.expected !== null) lines.push(`  expected:\n${indent(mismatch.expected)}`);
    if (mismatch.actual !== undefined) lines.push(`  obtained:\n${indent(mismatch.actual)}`);
  }
  return `${lines.join("\n")}\n`;
}
