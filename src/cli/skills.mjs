/**
 * `skills` argv: list, install, register.
 *
 * Per-operation options only, so `--force` is rejected by `list`. The
 * behavior lives in `installSkills` and `registerSkills`, exported because
 * `faberun init` installs the same catalogue into a target repository and
 * `faberun setup` registers the skill into every installed harness; this file
 * owns the wire, the same split `seat.mjs` uses.
 *
 * `install` copies the catalogue into a caller-chosen `.claude/skills`.
 * `register` discovers each installed harness's own skills directory and links
 * (or, with `--copy`, copies) the `faberun` skill into it. Discovery is a
 * measured table below, not a probe of live harness state.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseFlags } from "node:util";

import { faberunHome, installedVersionDir } from "../host/home.mjs";
import { findExecutable } from "../host/preflight.mjs";
import { colorLevel, statusToken } from "./brand.mjs";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
const CHECKOUT_SKILL = join(SKILLS_DIR, "faberun");

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  list: {},
  install: {
    target: { type: "string" },
    global: { type: "boolean" },
    force: { type: "boolean" },
  },
  register: {
    harness: { type: "string" },
    copy: { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  },
};

/**
 * Where each operator harness keeps the skills a user can add, measured
 * 2026-09-16 on the machine this node ran on.
 *
 * - `claude` -> `~/.claude/skills` and `codex` -> `~/.codex/skills` are the
 *   documented conventions; on this machine both directories hold symlinks into
 *   `~/.agents/skills`.
 * - `agents` -> `~/.agents/skills` is the shared convention. It is registered
 *   on its own too, because a harness directory is often a symlink to it, and
 *   it is optional so a machine without it stays quiet.
 * - `zcode` 0.16.5: `zcode skills list` labels every local, non-plugin entry
 *   `(user/agents)` and resolves it under `~/.agents/skills`; `~/.zcode` holds
 *   only plugin and CLI state, so its user skill convention is the shared one.
 * - `agy` (Antigravity CLI): the installed binary's embedded guide names
 *   `~/.gemini/config/` as the global customization root and
 *   `~/.gemini/config/skills/<name>/` as a global skill; the
 *   `~/.gemini/antigravity-cli/builtin/skills` tree is shipped, read-only.
 * - `dsh`: `dsh --help` lists no skills command and no skills directory exists,
 *   so it has no registration target. It is kept in the table to record the
 *   measurement, and reported as `no skill support`.
 *
 * @type {Record<string, {binary: string|null, optional: boolean, dir: ((home: string) => string)|null}>}
 */
const HARNESS_SKILL_DIRS = {
  claude: { binary: "claude", optional: false, dir: (home) => join(home, ".claude", "skills") },
  codex: { binary: "codex", optional: false, dir: (home) => join(home, ".codex", "skills") },
  zcode: { binary: "zcode", optional: false, dir: (home) => join(home, ".agents", "skills") },
  agy: { binary: "agy", optional: false, dir: (home) => join(home, ".gemini", "config", "skills") },
  dsh: { binary: "dsh", optional: false, dir: null },
  agents: { binary: null, optional: true, dir: (home) => join(home, ".agents", "skills") },
};

/** @typedef {(text: string) => void} Writer */
/**
 * @typedef {object} SkillTarget
 * @property {string} harness
 * @property {string|null} dir
 * @property {string|null} binary
 * @property {boolean} installed
 * @property {boolean} dirExists
 * @property {boolean} unsupported
 * @property {boolean} optional
 */
/**
 * @typedef {object} SkillRegistration
 * @property {string} harness
 * @property {string|null} dir
 * @property {"linked"|"copied"|"unchanged"|"skipped"|"no_dir"|"not_installed"|"unsupported"} action
 */

/**
 * @param {string[]} args
 * @returns {void}
 */
export function skillsCli(args) {
  const operation = args[0];
  if (!operation || !Object.hasOwn(OPERATION_OPTIONS, operation)) return usage();
  let parsed;
  try {
    parsed = parseFlags({ args: args.slice(1), options: OPERATION_OPTIONS[operation], allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return usage();
  }
  const values = /** @type {{target?: string, global?: boolean, force?: boolean, copy?: boolean, json?: boolean, harness?: string}} */ (parsed.values);
  if (operation === "list") {
    if (parsed.positionals.length) return usage();
    for (const name of catalog()) process.stdout.write(`${name}\n`);
    return;
  }
  if (operation === "register") {
    if (parsed.positionals.length) return usage();
    try {
      const results = registerSkills({
        harnesses: splitHarnesses(values.harness),
        copy: values.copy === true,
        force: values.force === true,
        env: process.env,
        level: values.json === true ? 0 : colorLevel(process.env, process.stdout.isTTY),
        stdout: values.json === true ? () => {} : (text) => process.stdout.write(text),
      });
      if (values.json === true) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return usage();
    }
    return;
  }
  const skillsDir = values.global
    ? join(homedir(), ".claude", "skills")
    : join(values.target ? resolve(values.target) : process.cwd(), ".claude", "skills");
  try {
    installSkills({ names: parsed.positionals, skillsDir, force: values.force === true, stdout: process.stdout });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return usage();
  }
}

/**
 * Copy catalogue skills into `skillsDir`. A skill that is already installed is
 * kept unless `force`; the caller owns the wire and the target directory.
 *
 * @param {{names: string[], skillsDir: string, force: boolean, stdout: {write(text: string): unknown}}} options
 * @returns {{installed: number, skipped: number}}
 */
export function installSkills({ names, skillsDir, force, stdout }) {
  const available = catalog();
  const selected = names.length ? names : available;
  for (const name of selected) {
    if (!available.includes(name)) throw new Error(`no skill named "${name}" (run \`faberun skills list\`)`);
  }
  mkdirSync(skillsDir, { recursive: true });
  let installed = 0;
  let skipped = 0;
  for (const name of selected) {
    const destination = join(skillsDir, name);
    if (existsSync(destination) && !force) {
      stdout.write(`skipped ${name} · exists, use --force\n`);
      skipped++;
      continue;
    }
    rmSync(destination, { recursive: true, force: true });
    cpSync(join(SKILLS_DIR, name), destination, { recursive: true });
    stdout.write(`installed ${name} · ${skillsDir}\n`);
    installed++;
  }
  stdout.write(`${installed} installed · ${skipped} skipped\n`);
  return { installed, skipped };
}

/**
 * The harness skills directories that exist on this machine, in table order,
 * deduplicated by directory. `zcode` and the shared `agents` entry name the
 * same `~/.agents/skills`; whichever is installed first claims it. A filter of
 * harness names limits the result and rejects a name that is not in the table.
 *
 * @param {{env?: NodeJS.ProcessEnv, harnesses?: string[], isInstalled?: (name: string) => boolean}} [options]
 * @returns {SkillTarget[]}
 */
export function discoverSkillTargets(options = {}) {
  const env = options.env ?? process.env;
  const home = skillHome(env);
  const requested = options.harnesses && options.harnesses.length ? options.harnesses : null;
  if (requested) {
    for (const name of requested) {
      if (!Object.hasOwn(HARNESS_SKILL_DIRS, name)) {
        throw new Error(`no harness named "${name}" (choose from ${Object.keys(HARNESS_SKILL_DIRS).join(", ")})`);
      }
    }
  }
  const filter = requested ? new Set(requested) : null;
  const isInstalled = options.isInstalled ?? ((name) => findExecutable(name) !== null);
  /** @type {SkillTarget[]} */
  const targets = [];
  const claimed = new Set();
  for (const [harness, entry] of Object.entries(HARNESS_SKILL_DIRS)) {
    if (filter && !filter.has(harness)) continue;
    const dir = entry.dir ? entry.dir(home) : null;
    const installed = entry.binary ? isInstalled(entry.binary) : true;
    if (dir && claimed.has(dir)) continue;
    if (installed && dir && !entry.optional) claimed.add(dir);
    targets.push({
      harness,
      dir,
      binary: entry.binary,
      installed,
      dirExists: dir !== null && existsSync(dir),
      unsupported: dir === null,
      optional: entry.optional,
    });
  }
  return targets;
}

/**
 * Link or copy the `faberun` skill into every installed harness's skills
 * directory. A harness whose binary is absent is reported and skipped; one
 * whose directory is missing is a `[warn]` unless `force` creates it. A real
 * directory already at the destination is left alone unless `force`. The
 * caller owns the wire and the streams; `--json` passes a no-op writer.
 *
 * @param {{harnesses?: string[], copy?: boolean, force?: boolean, env?: NodeJS.ProcessEnv, level?: number, stdout?: Writer, isInstalled?: (name: string) => boolean}} [options]
 * @returns {SkillRegistration[]}
 */
export function registerSkills(options = {}) {
  const env = options.env ?? process.env;
  const home = skillHome(env);
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const level = options.level ?? 0;
  const force = options.force === true;
  const source = skillSource(env);
  const targets = discoverSkillTargets({ env, harnesses: options.harnesses, isInstalled: options.isInstalled });
  /** @type {SkillRegistration[]} */
  const results = [];
  for (const target of targets) {
    if (target.unsupported || target.dir === null) {
      results.push({ harness: target.harness, dir: null, action: "unsupported" });
      stdout(`${statusToken("ok", level)} ${target.harness} · no skill support\n`);
      continue;
    }
    const dir = target.dir;
    const destination = join(dir, "faberun");
    if (!target.installed) {
      results.push({ harness: target.harness, dir: destination, action: "not_installed" });
      stdout(`${statusToken("ok", level)} ${target.harness} · not installed\n`);
      continue;
    }
    if (!target.dirExists && !force) {
      if (target.optional) continue;
      results.push({ harness: target.harness, dir: destination, action: "no_dir" });
      stdout(`${statusToken("warn", level)} ${target.harness} · no skills directory (${displayPath(dir, home)})\n`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const action = options.copy === true ? copySkill(source, destination, force) : linkSkill(source, destination, force);
    results.push({ harness: target.harness, dir: destination, action });
    const path = displayPath(destination, home);
    if (action === "skipped") {
      stdout(`${statusToken("warn", level)} ${target.harness} · ${path} · exists, use --force\n`);
    } else {
      stdout(`${statusToken("ok", level)} ${target.harness} · ${path} · ${action}\n`);
    }
  }
  return results;
}

/**
 * The skill tree a registration points at: `$FABERUN_HOME/current/skills/faberun`
 * when this CLI runs from the installed home layout, so the link follows every
 * update, and this checkout's `skills/faberun` otherwise.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function skillSource(env) {
  const home = faberunHome(env);
  return installedVersionDir(process.argv[1], home) ? join(home, "current", "skills", "faberun") : CHECKOUT_SKILL;
}

/**
 * @param {string} source
 * @param {string} destination
 * @param {boolean} force
 * @returns {"linked"|"unchanged"|"skipped"}
 */
function linkSkill(source, destination, force) {
  const existing = lstatOrNull(destination);
  if (existing) {
    if (existing.isSymbolicLink() && !force && resolvesTo(destination, source)) return "unchanged";
    if (!existing.isSymbolicLink() && !force) return "skipped";
    rmSync(destination, { recursive: true, force: true });
  }
  symlinkSync(source, destination);
  return "linked";
}

/**
 * @param {string} source
 * @param {string} destination
 * @param {boolean} force
 * @returns {"copied"|"unchanged"|"skipped"}
 */
function copySkill(source, destination, force) {
  const existing = lstatOrNull(destination);
  if (existing) {
    if (existing.isDirectory() && !force) return "unchanged";
    if (!force && !existing.isSymbolicLink()) return "skipped";
    rmSync(destination, { recursive: true, force: true });
  }
  cpSync(source, destination, { recursive: true });
  return "copied";
}

/**
 * @param {string} path
 * @returns {import("node:fs").Stats|null}
 */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    // A path that does not exist has no stats; the caller treats that as "free".
    return null;
  }
}

/**
 * @param {string} destination
 * @param {string} source
 * @returns {boolean}
 */
function resolvesTo(destination, source) {
  try {
    return realpathSync(destination) === realpathSync(source);
  } catch {
    // Either path may be a dangling symlink; it cannot already point at source.
    return false;
  }
}

/**
 * The home directory the skill directories hang off. `HOME` is honoured so a
 * test or an install can point the whole discovery at a temporary tree.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function skillHome(env) {
  const configured = env.HOME;
  if (typeof configured === "string" && configured) return configured;
  return homedir();
}

/**
 * Render a path under the home directory as `~/…` for the human lines; the
 * machine-readable `dir` stays absolute.
 *
 * @param {string} path
 * @param {string} home
 * @returns {string}
 */
function displayPath(path, home) {
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  if (path === home) return "~";
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/**
 * @param {string|undefined} text
 * @returns {string[]}
 */
function splitHarnesses(text) {
  if (typeof text !== "string" || !text) return [];
  return [...new Set(text.split(",").map((name) => name.trim()).filter(Boolean))];
}

/**
 * @returns {string[]} catalogue entries that carry a SKILL.md
 */
function catalog() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** @returns {void} */
function usage() {
  process.stderr.write("usage: faberun skills <list|install|register> [<name>...] [--target <dir>] [--global] [--force] [--copy] [--harness <a,b>] [--json]\n");
  process.exitCode = 2;
}
