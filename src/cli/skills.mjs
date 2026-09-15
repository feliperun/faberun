/**
 * `skills` argv: list, install.
 *
 * Per-operation options only, so `--force` is rejected by `list`. The
 * behavior lives in `installSkills`, exported because `faberun init` installs
 * the same catalogue into a target repository; this file owns the wire, the
 * same split `seat.mjs` uses.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseFlags } from "node:util";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  list: {},
  install: {
    target: { type: "string" },
    global: { type: "boolean" },
    force: { type: "boolean" },
  },
};

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
  const values = /** @type {{target?: string, global?: boolean, force?: boolean}} */ (parsed.values);
  if (operation === "list") {
    if (parsed.positionals.length) return usage();
    for (const name of catalog()) process.stdout.write(`${name}\n`);
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
  process.stderr.write("usage: faberun skills <list|install> [<name>...] [--target <dir>] [--global] [--force]\n");
  process.exitCode = 2;
}
