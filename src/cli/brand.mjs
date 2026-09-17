/**
 * The command line's visual identity: color capability, the semantic role
 * palette, glyphs, check tokens, the hornero-nest banner and the usage text.
 *
 * It is separate from `cli.mjs` because `DESIGN.md` is the specification and a
 * renderer that disagrees with it is a defect. Dispatch decides what to print;
 * this module is the one place a palette value, a glyph or a banner line lives.
 * `--json` and other machine output call with `level` 0 and receive the text
 * untouched.
 */

import { compareVersions, faberunHome, readUpdateCheck } from "../host/home.mjs";

/** @typedef {"brand"|"ok"|"progress"|"warn"|"fail"|"muted"|"text"} Role */
/** @typedef {"terra"|"argila"|"folha"} ColorName */
/** @typedef {{color?: ColorName, bold?: boolean, dim?: boolean}} RoleSpec */
/** @typedef {{version: string, nodeVersion: string, harnessCount: number, level: number, env?: NodeJS.ProcessEnv}} BannerOptions */

/** The palette's terminal encodings, exactly as DESIGN.md's table gives them. */
/** @type {Record<ColorName, {rgb: string, index: number, ansi16: number}>} */
const COLORS = {
  terra: { rgb: "38;2;181;82;42", index: 166, ansi16: 31 },
  argila: { rgb: "38;2;217;123;79", index: 173, ansi16: 33 },
  folha: { rgb: "38;2;85;107;63", index: 65, ansi16: 32 },
};

/** One role per rendered state; a new state picks a row, never a color. */
/** @type {Record<Role, RoleSpec>} */
const ROLE_SPECS = {
  brand: { color: "terra", bold: true },
  ok: { color: "folha" },
  progress: { color: "argila" },
  warn: { color: "argila", bold: true },
  fail: { color: "terra", bold: true },
  muted: { dim: true },
  text: {},
};

/** The Unicode glyph and ASCII fallback of each glyph-bearing role. */
/** @type {Record<string, {unicode: string, ascii: string}>} */
const GLYPHS = {
  ok: { unicode: "✓", ascii: "+" },
  progress: { unicode: "·", ascii: "." },
  warn: { unicode: "!", ascii: "!" },
  fail: { unicode: "✗", ascii: "x" },
};

/**
 * Resolve how much color this process may emit, once, in DESIGN.md's order:
 * `NO_COLOR` wins, an explicit `FORCE_COLOR` overrides the terminal, and a
 * non-TTY or `TERM=dumb` stays monochrome.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} isTTY
 * @returns {0|1|2|3}
 */
export function colorLevel(env, isTTY) {
  if (env.NO_COLOR !== undefined) return 0;
  if (env.FORCE_COLOR !== undefined) {
    if (env.FORCE_COLOR === "") return 3;
    if (env.FORCE_COLOR === "0") return 0;
    if (env.FORCE_COLOR === "1") return 1;
    if (env.FORCE_COLOR === "2") return 2;
    return 3;
  }
  if (!isTTY || env.TERM === "dumb") return 0;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;
  return 2;
}

/**
 * @param {ColorName} name
 * @param {number} level
 * @returns {string}
 */
function colorCode(name, level) {
  const color = COLORS[name];
  if (level === 1) return `\u001b[${color.ansi16}m`;
  if (level === 2) return `\u001b[38;5;${color.index}m`;
  return `\u001b[${color.rgb}m`;
}

/**
 * @param {string} text
 * @param {RoleSpec} spec
 * @param {number} level
 * @returns {string}
 */
function colorize(text, spec, level) {
  if (level === 0) return text;
  let open = "";
  if (spec.bold) open += "\u001b[1m";
  if (spec.dim) open += "\u001b[2m";
  if (spec.color) open += colorCode(spec.color, level);
  return open ? `${open}${text}\u001b[0m` : text;
}

/**
 * Paint one short token in its semantic role. At level 0 the text is returned
 * untouched, which is what every non-TTY test and all `--json` output see.
 *
 * @param {string} text
 * @param {Role} role
 * @param {number} level
 * @returns {string}
 */
export function paint(text, role, level) {
  return colorize(text, ROLE_SPECS[role], level);
}

/**
 * Whether the locale advertises UTF-8 and the terminal is not dumb.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function useUnicodeGlyphs(env) {
  if (env.TERM === "dumb") return false;
  return [env.LANG, env.LC_ALL, env.LC_CTYPE].some((value) => typeof value === "string" && /utf-?8/iu.test(value));
}

/**
 * The role's glyph, in Unicode or its ASCII fallback. Roles without a glyph
 * (brand, muted, text) have none.
 *
 * @param {Role} role
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function glyph(role, env) {
  const entry = GLYPHS[role];
  if (!entry) return "";
  return useUnicodeGlyphs(env) ? entry.unicode : entry.ascii;
}

/**
 * The bracketed check token in its role color. The bracketed text is the
 * contract with scripts and tests and never changes; only color is added.
 *
 * @param {"ok"|"warn"|"fail"} kind
 * @param {number} level
 * @returns {string}
 */
export function statusToken(kind, level) {
  return paint(`[${kind}]`, kind, level);
}

/**
 * The five-line hornero-nest banner. The dome is Terra without bold, the inner
 * opening is muted, the wordmark is the brand role, the tagline is plain text
 * and the last line is muted and filled from the running process. The last line
 * gains ` · update available: <latest>` when the cached check names a newer
 * release; the banner reads only the cache (`update-check.json`) and never
 * fetches. ASCII apart from the middle-dot separator, so it survives every
 * monospace font.
 *
 * @param {BannerOptions} options
 * @returns {string}
 */
export function renderBanner({ version, nodeVersion, harnessCount, level, env = process.env }) {
  const cached = readUpdateCheck(faberunHome(env));
  const latest = cached && compareVersions(cached.latest, version) > 0 ? cached.latest : null;
  const terra = /** @param {string} text @returns {string} */ (text) => colorize(text, { color: "terra" }, level);
  const lines = [
    terra("       .-~~~-."),
    `${terra("    .-'  ")}${paint(".-.", "muted", level)}${terra("  '-.")}       ${paint("faberun", "brand", level)}`,
    `${terra("   /    ")}${paint("(   )", "muted", level)}${terra("    \\")}      from intent to running software`,
    `${terra("   \\     ")}${paint("'-'", "muted", level)}${terra("     /")}`,
    `${terra("    '-.._____..-'")}       ${paint(`v${version} · node ${nodeVersion} · ${harnessCount} harnesses detected${latest ? ` · update available: ${latest}` : ""}`, "muted", level)}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * One `usage: faberun <verb> ...` line per verb group, keeping the verbs and
 * flags the CLI dispatches. The same text serves the help path (stdout) and
 * the usage error (stderr).
 *
 * @returns {string}
 */
export function renderUsage() {
  const groups = [
    "<run|validate> <contract.json> [--base-ref <ref>] [--detach]",
    "preflight <contract.json> [--static] [--time-verification] [--json]",
    "<resume|cancel> <run-dir> [--detach]",
    "supervise <run-dir> [--detach] [--interval <sec>]",
    "supervise campaign <campaign-id> [--cwd <dir>] [--allow-main]",
    "<status|report> <run-dir> [--json]",
    "findings <run-dir>",
    "doctor [<contract.json>] [--cwd <dir>] [--discover] [--json]",
    "setup [--yes] [--no-skill] [--harnesses <a,b>] [--worker <id>] [--judge <id>] [--json]",
    "init [--cwd <dir>] [--yes] [--no-skill] [--agentkit] [--greenfield|--stable] [--json]",
    "update [--check] [--json]",
    "models [--probe] [--json]",
    "next [--cwd <dir>] [--json]",
    "bulk-read --question <text> --paths <a,b,c> [--json]",
    "contract validate <contract.json>",
    "spec validate <file> [--strict-traceability] [--json]",
    "spec scaffold <path> [--id <id>]",
    "metrics <campaign-id> [--cwd <dir>] [--json]",
    "campaign <init|watch|attach|note|resolve|close|supervise|show|list|sync|ack> ...",
    "seat <start|attach|status|stop> [<campaign-id>] [--cwd <dir>] ...",
    "skills list",
    "skills install [<name>...] [--target <dir>] [--global] [--force]",
    "skills register [--harness <a,b>] [--copy] [--force] [--json]",
  ];
  return `${groups.map((group) => `usage: faberun ${group}`).join("\n")}\n`;
}
