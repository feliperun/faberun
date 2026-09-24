#!/usr/bin/env node
/**
 * The complex corpus's centralization acceptance: in `src/`, the runs
 * directory name is spelled only by its resolver. This is the property the
 * phase's fourth node turned into a repository ratchet; checked here directly,
 * over the arm's tree, so an arm is judged on the property and not on whether
 * its own ratchet test matches the landed one line for line. Ported verbatim
 * from `spike/arms/checks/centralization.mjs`; it stays a standalone program
 * because the acceptance invokes it as one.
 *
 *   node evals/paired/checks/centralization.mjs <checkout>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const ALLOWED = new Set(["src/run/paths.mjs"]);

/** @param {string} root @returns {string} */
function runsDirNameFromTree(root) {
  const source = readFileSync(join(root, "src/run/paths.mjs"), "utf8");
  const match = source.match(/RUNS_DIR_NAME\s*=\s*(["'`])([^"'`]+)\1/u);
  if (!match) throw new Error("the arm tree does not declare a literal RUNS_DIR_NAME");
  return match[2];
}

/**
 * @param {string} root a checkout
 * @returns {string[]} src/ files spelling the literal that are not the resolver
 */
export function offendersIn(root) {
  const runsDirName = runsDirNameFromTree(root);
  const escaped = runsDirName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const literal = new RegExp(`["'\`]${escaped}["'\`]`, "u");
  /** @type {string[]} */
  const offenders = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".mjs") && literal.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, ""))) {
        const rel = relative(root, path).split("\\").join("/");
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }
  };
  walk(join(root, "src"));
  return offenders.sort();
}

if (process.argv[1]?.endsWith("centralization.mjs")) {
  const root = process.argv[2] ?? process.cwd();
  const offenders = offendersIn(root);
  if (offenders.length) {
    process.stdout.write(`${offenders.length} src/ file(s) still spell the runs directory literal:\n${offenders.map((path) => `  ${path}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("only src/run/paths.mjs spells the runs directory literal\n");
}
