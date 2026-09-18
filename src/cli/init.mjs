/**
 * `faberun init [--cwd <dir>] [--yes] [--no-skill] [--agentkit]
 * [--greenfield|--stable] [--json]`: prepare a target repository for campaigns.
 *
 * Three facts are established in order: the target is a git work tree, `.runs/`
 * is ignored, and the `faberun` skill is installed under `.claude/skills/`. The
 * agent kit is optional, and its compatibility rule is always asked or given by
 * flag -- never defaulted silently. The shipped shell script does the writing;
 * this module owns only the questions and the check lines.
 *
 * Questions, streams and process facts are injected so tests never touch a
 * terminal, the same split `cli/setup.mjs` uses.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { colorLevel, statusToken } from "./brand.mjs";
import { installSkills } from "./skills.mjs";
import { boundedGitSync } from "../repo/worktree.mjs";
import { RUNS_DIR_NAME } from "../run/paths.mjs";

/** @typedef {(text: string) => void} Writer */
/** @typedef {(question: string) => Promise<string>} Asker */
/** @typedef {{ask: Asker, close: () => void}} AskerHandle */
/** @typedef {"greenfield"|"stable"} Variant */
/** @typedef {{cwd: string, runsIgnored: boolean, skillInstalled: boolean, agentkit: boolean}} InitReport */
/**
 * @typedef {object} InitOptions
 * @property {string} [cwd]
 * @property {boolean} [yes]
 * @property {boolean} [skill] whether to install the faberun skill (default true)
 * @property {boolean} [agentkit] install the agent kit without asking
 * @property {Variant} [variant] the already-chosen compatibility rule
 * @property {boolean} [json]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {Asker} [ask]
 * @property {Writer} [stdout]
 * @property {Writer} [stderr]
 * @property {boolean} [isTTY]
 */

/** The shipped installer that lays the agent kit down, resolved from this module rather than the caller's cwd. */
const AGENTKIT_INSTALLER = fileURLToPath(new URL("../../skills/init-agentkit/scripts/install-agentkit.sh", import.meta.url));

/**
 * Prepare `cwd` for campaigns and return the process exit code.
 *
 * @param {InitOptions} [options]
 * @returns {Promise<number>}
 */
export async function initCommand(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const json = options.json === true;
  const cwd = resolve(options.cwd ?? ".");
  const level = colorLevel(env, isTTY);
  // `--yes` and `--json` are the two non-interactive paths; both take the
  // flags as given and never wait on a terminal.
  const interactive = isTTY && options.yes !== true && !json;
  const report = /** @type {InitReport} */ ({ cwd, runsIgnored: false, skillInstalled: false, agentkit: false });

  // The readline interface is created only if a question is actually asked, so
  // a flag-driven or `--json` invocation never opens stdin. The holder object
  // keeps the assignment inside the closure visible to the `finally` close.
  const state = { asker: /** @type {AskerHandle|null} */ (null) };
  /** @param {string} question @returns {Promise<string>} */
  const askQuestion = async (question) => {
    if (state.asker === null) {
      if (options.ask) {
        state.asker = { ask: options.ask, close: () => {} };
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        state.asker = { ask: (text) => rl.question(text), close: () => rl.close() };
      }
    }
    return (await state.asker.ask(question)).trim();
  };

  try {
    if (!isGitWorkTree(cwd)) {
      if (json) stdout(`${JSON.stringify(report, null, 2)}\n`);
      else stdout(`${statusToken("fail", level)} git · ${cwd} is not a git work tree\n`);
      return 1;
    }

    const gitignore = ensureRunsIgnored(cwd);
    report.runsIgnored = true;
    if (!json) stdout(`${statusToken("ok", level)} .runs ignored · ${gitignore}\n`);

    let skill = options.skill !== false;
    if (skill && interactive) {
      skill = !(await askQuestion("Install the faberun skill into .claude/skills? [Y/n] ")).toLowerCase().startsWith("n");
    }
    if (skill) {
      // `--json` still installs; the skill's own report lines are human output
      // and would otherwise corrupt the one machine-readable object.
      const skills = installSkills({
        names: ["faberun"],
        skillsDir: join(cwd, ".claude", "skills"),
        force: false,
        stdout: json ? { write: () => {} } : { write: stdout },
      });
      report.skillInstalled = skills.installed + skills.skipped > 0;
    }

    let agentkit = options.agentkit === true;
    if (!agentkit && interactive) {
      agentkit = (await askQuestion("Install the agent kit (AGENTS.md, docs/, ADRs, Sentrux gate)? [y/N] ")).toLowerCase().startsWith("y");
    }
    if (agentkit) {
      let variant = /** @type {Variant} */ (options.variant === "stable" ? "stable" : "greenfield");
      if (interactive && options.variant === undefined) {
        const answer = (await askQuestion("Compatibility rule: greenfield (break freely) or stable (preserve published contracts)? [greenfield] ")).toLowerCase();
        variant = answer.startsWith("s") ? "stable" : "greenfield";
      }
      const result = spawnSync("bash", [AGENTKIT_INSTALLER, cwd, `--${variant}`], { stdio: "inherit" });
      if (result.error) {
        stderr(`${result.error.message}\n`);
        return 1;
      }
      if (result.status !== 0) return result.status ?? 1;
      report.agentkit = true;
    }

    if (json) stdout(`${JSON.stringify(report, null, 2)}\n`);
    else stdout(`next · faberun doctor --cwd ${cwd} · faberun campaign init <id> --cwd ${cwd} --goal "..."\n`);
    return 0;
  } finally {
    state.asker?.close();
  }
}

/**
 * Whether `git -C cwd rev-parse --is-inside-work-tree` answers `true`.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isGitWorkTree(cwd) {
  const result = boundedGitSync(["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return !result.error && result.status === 0 && String(result.stdout).trim() === "true";
}

/**
 * Add a `.runs/` line to `cwd/.gitignore` unless an equivalent line already
 * exists, creating the file when missing. A file that does not end in a newline
 * gets one before the appended line, so the result is always a whole line.
 *
 * @param {string} cwd
 * @returns {string} the `.gitignore` path written or confirmed
 */
function ensureRunsIgnored(cwd) {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const ignored = existing.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed === `${RUNS_DIR_NAME}/` || trimmed === RUNS_DIR_NAME;
  });
  if (!ignored) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(path, `${existing}${separator}${RUNS_DIR_NAME}/\n`);
  }
  return path;
}
