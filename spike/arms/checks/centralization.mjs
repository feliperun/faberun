#!/usr/bin/env node
/**
 * The complex corpus's centralization acceptance: in src/, the runs directory
 * name is spelled only by its resolver. This is the property the phase's
 * fourth node turned into a repository ratchet; checked here directly, over
 * the arm's tree, so an arm is judged on the property and not on whether its
 * own ratchet test matches the landed one line for line. "Spelled" is the
 * landed ratchet's own measurement: the exact double-quoted token, which is
 * what the migration nodes rewrote; a mention in a comment, a pathspec or a
 * longer string is not (the landed tree keeps four of those).
 *
 *   node spike/arms/checks/centralization.mjs <checkout>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED = new Set(["src/run/paths.mjs"]);
const LITERAL = /"\.runs"/u;

/**
 * @param {string} root a checkout
 * @returns {string[]} src/ files spelling the literal that are not the resolver
 */
export function offendersIn(root) {
  /** @type {string[]} */
  const offenders = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".mjs") && LITERAL.test(readFileSync(path, "utf8"))) {
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
