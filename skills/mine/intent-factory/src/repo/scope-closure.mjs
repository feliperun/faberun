/**
 * Whether the scope a packet declared actually closes: every repository file
 * that a declared write drags along must be declared or explicitly dismissed.
 *
 * A `writeFiles` list names the files a node may change, but changing a module
 * obliges its importers, changing a declared symbol obliges the files that
 * mention it, and adding a file to a directory obliges the tests that assert
 * what that directory contains. None of those obligations is visible in the
 * packet, and three incidents in two campaigns came from exactly that gap.
 * Three mechanical detectors point at the dragged-along files, and
 * `validateContract` refuses until each is in `readFiles`, `writeFiles`, or the
 * contract author's `scopeAcknowledged` list.
 *
 * It reads the target repository to validate a contract, which is why it sits
 * in `repo/` beside declared-paths.mjs. It also carries the runtime import edge
 * parser that used to live in `test/repo/source-shape.test.mjs`; the shape gate
 * refuses two copies of that body, so there is one home and both import it.
 *
 * Calibration, measured 2026-09-13 against the six recorded contracts under
 * `.runs/campaigns/<campaign>/control` (p1, p2, p3, sp1, sp2, sp2b; the running
 * sp25 contract is excluded), found 26 findings. The three incidents that cost
 * the hours are all in that set:
 *   p3 bulk-read        -> test/installer.test.mjs        (directory enumerator)
 *   sp1 lossy-notify    -> src/engine/scheduler.mjs       (reverse import)
 *   sp2 seat-switch     -> test/cli/cli.test.mjs          (reverse import of the
 *                                                        entry point the test runs)
 * The first pass was wider: a bare "every importer of a written module" rule
 * reported 23 files for p3 bulk-read alone, most of them importers of the broad
 * `cli.mjs` surface, and an ancestor-based directory rule then re-reported
 * `installer.test.mjs` for every deep write under `skills/mine`. The narrowing
 * kept all three: detector 1 only counts an importer that takes one of the
 * packet's declared `symbols` (a packet that declares no symbols declares no
 * surface, and the detector abstains), the one test it follows through an entry
 * point is the test named after that entry, and detector 3 only fires when the
 * written file names the direct child the enumerator reads.
 *
 * A fourth obligation only exists between nodes, so it is checked per contract
 * rather than per packet. Node A writes a test that points at a path node B
 * also writes; B's correct implementation changes that test, but B's packet
 * does not permit it. seat-switch is the recorded instance: seat-lifecycle
 * wrote `test/cli/cli.test.mjs` with an assertion that fixed the usage line,
 * and seat-switch had to change `src/cli.mjs` without holding the test. Each
 * packet read alone is fine; the pair is impossible. `crossNodeScopeFindings`
 * reads the pair together and refuses the contract.
 */
import { errorCode } from "../util.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** @typedef {import("../contract/index.mjs").TaskPacket} TaskPacket */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {{path: string, detector: "imports"|"symbols"|"directory", reason: string}} ScopeClosureFinding */
/** @typedef {{path: string, detector: "cross-node", reason: string, nodeIndex: number, nodeId: string}} CrossNodeScopeFinding */

/**
 * Directories that hold dependencies, run state, or historical worktree copies
 * rather than repository source. Walking them would report every vendored
 * importer and every `.runs/` worktree as a scope violation.
 */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".runs",
  "node_modules",
  ".claude",
  ".codex",
  ".venv",
  "venv",
  "dist",
  "coverage",
]);

const IMPORT_FROM = /\b(?:import|export)\s+([\s\S]*?)\s+from\s*"(\.[^"]+)"/gu;
const SIDE_EFFECT_IMPORT = /\bimport\s*"(\.[^"]+)"/gu;
const EXECUTED_URL = /new URL\(\s*"(\.[^"]+)"\s*,\s*import\.meta\.url\s*\)/gu;
const DIRECTORY_CALL = /\b(readdirSync|readdir|globSync|glob)\s*\(/gu;
const CONSTANT = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/gu;

/**
 * Runtime import edges only, keyed by `root`-relative module path. A JSDoc
 * `import("./x.mjs").Type` is erased before the module loads; counting those
 * reports cycles that do not exist, so only real `import`/`export ... from`
 * statements are edges.
 *
 * @param {string} root absolute directory to walk
 * @returns {Map<string, string[]>}
 */
export function runtimeImportGraph(root) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const [path, source] of repositorySources(root)) {
    /** @type {Set<string>} */
    const specifiers = new Set();
    for (const record of parseImportRecords(source.text)) specifiers.add(record.specifier);
    graph.set(
      path,
      [...specifiers].map((specifier) => resolveSpecifier(source.absolute, root, specifier)).sort(),
    );
  }
  return graph;
}

/**
 * Files a node's declared writes drag into the same change, minus those the
 * packet already declares or dismisses.
 *
 * @param {ValidatedNode} node
 * @param {number} index
 * @param {string} cwd
 * @returns {ScopeClosureFinding[]}
 */
export function scopeClosureFindings(node, index, cwd) {
  const packet = node.taskPacket;
  const writeFiles = [...(packet.writeFiles ?? [])];
  if (writeFiles.length === 0) return [];
  const declared = declaredPaths(packet);
  const sources = repositorySources(cwd);
  const findings = [
    ...reverseImportFindings(packet, declared, sources, cwd),
    ...symbolMentionFindings(packet, declared, sources),
    ...directoryEnumeratorFindings(writeFiles, declared, sources, cwd),
  ];
  /** @type {Map<string, ScopeClosureFinding>} */
  const byPath = new Map();
  for (const finding of findings) {
    if (declared.has(finding.path) || byPath.has(finding.path)) continue;
    byPath.set(finding.path, finding);
  }
  return [...byPath.values()];
}

/**
 * The paths a packet already covers: what it may read, what it may write, its
 * write roots, and what its author explicitly acknowledged. One home for the
 * set, so a detector cannot quietly disagree with another about what "declared"
 * means.
 *
 * @param {TaskPacket} packet
 * @returns {Set<string>}
 */
function declaredPaths(packet) {
  return new Set([
    ...(packet.readFiles ?? []),
    ...(packet.writeFiles ?? []),
    ...(packet.writeRoots ?? []),
    ...(packet.scopeAcknowledged ?? []),
  ]);
}

/**
 * DETECTOR 4, the obligation no single packet can show. Node A writes a test
 * whose content points at a path node B writes, so B's correct implementation
 * changes that test -- and if B's packet does not permit the test, B is
 * structurally stuck: the fix breaks a test B may not touch. `readFiles` does
 * not count, because reading the test cannot repair it; only `writeFiles`, a
 * covering `writeRoots`, or `scopeAcknowledged` does.
 *
 * The reference is read through the same parser the per-node detectors use --
 * runtime imports and executed `new URL`s -- not by pattern-matching the test's
 * prose, which is why a test that only asserts on a string surface abstains
 * here and node-local detector 2 covers the symbol-name case.
 *
 * @param {ValidatedNode[]} nodes all nodes of one contract
 * @param {string} cwd
 * @returns {CrossNodeScopeFinding[]} one finding per (node, test) pair, naming
 *   the node whose packet must change
 */
export function crossNodeScopeFindings(nodes, cwd) {
  const sources = repositorySources(cwd);
  /** @type {CrossNodeScopeFinding[]} */
  const findings = [];
  const seen = new Set();
  for (const [writerIndex, writer] of nodes.entries()) {
    for (const testPath of writer.taskPacket.writeFiles ?? []) {
      if (!isTestPath(testPath)) continue;
      const source = sources.get(testPath);
      if (!source) continue;
      const references = referencePaths(source, cwd);
      if (references.size === 0) continue;
      for (const [targetIndex, target] of nodes.entries()) {
        if (targetIndex === writerIndex) continue;
        const targetWrites = new Set(target.taskPacket.writeFiles ?? []);
        const rootCovers = (target.taskPacket.writeRoots ?? []).some(
          (root) => testPath === root || testPath.startsWith(`${root}/`),
        );
        const declared = new Set([...(target.taskPacket.scopeAcknowledged ?? []), ...targetWrites]);
        if (rootCovers || declared.has(testPath)) continue;
        const reference = [...references].find((path) => targetWrites.has(path));
        if (reference === undefined) continue;
        const key = `${targetIndex}:${testPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          path: testPath,
          detector: "cross-node",
          nodeIndex: targetIndex,
          nodeId: target.id,
          reason: `this node writes ${reference}, which ${writer.id} wrote a test against; declare ${testPath} in writeFiles or scopeAcknowledged so this node may change the test its work breaks`,
        });
      }
    }
  }
  return findings;
}

/**
 * DETECTOR 1. An importer of a written module must change with it, so it is in
 * scope unless declared. A packet that names `symbols` narrows the rule to
 * importers that take one of those symbols -- the surface the node announced it
 * changes -- because the broad entry modules (`cli.mjs`, `harnesses/index.mjs`)
 * are imported by half the tree for reasons nothing here touches. A test that
 * executes an entry point importing a written module is the same obligation one
 * hop out, and is the only reason a test with no direct import is in scope.
 *
 * @param {ValidatedNode["taskPacket"]} packet
 * @param {Set<string>} declared
 * @param {Map<string, {absolute: string, text: string}>} sources
 * @param {string} cwd
 * @returns {ScopeClosureFinding[]}
 */
function reverseImportFindings(packet, declared, sources, cwd) {
  const writeFiles = packet.writeFiles ?? [];
  const written = new Set(writeFiles);
  const symbols = new Set(packet.symbols ?? []);
  /** @type {Map<string, string[]>} */
  const importersOf = new Map();
  for (const [importer, source] of sources) {
    for (const record of parseImportRecords(source.text)) {
      const target = resolveSpecifier(source.absolute, cwd, record.specifier);
      importersOf.set(target, [...(importersOf.get(target) ?? []), importer]);
    }
  }

  /** @type {ScopeClosureFinding[]} */
  const findings = [];
  for (const target of writeFiles) {
    for (const importer of importersOf.get(target) ?? []) {
      if (declared.has(importer) || symbols.size === 0) continue;
      const source = sources.get(importer);
      if (!source) continue;
      const takesDeclared = parseImportRecords(source.text).some(
        (record) =>
          resolveSpecifier(source.absolute, cwd, record.specifier) === target &&
          [...record.names].some((name) => symbols.has(name)),
      );
      if (!takesDeclared) continue;
      findings.push({ path: importer, detector: "imports", reason: `imports ${target}, which this node writes` });
    }
  }

  for (const [path, source] of sources) {
    if (declared.has(path) || !isTestPath(path)) continue;
    const stem = basename(path).replace(/\.test\.mjs$/u, "");
    for (const executed of executedReferencePaths(source, cwd)) {
      if (declared.has(executed)) continue;
      if (basename(executed).replace(/\.mjs$/u, "") !== stem) continue;
      const entry = sources.get(executed);
      if (!entry) continue;
      for (const record of parseImportRecords(entry.text)) {
        const target = resolveSpecifier(entry.absolute, cwd, record.specifier);
        if (!written.has(target)) continue;
        findings.push({ path, detector: "imports", reason: `runs ${executed}, which imports ${target}` });
      }
    }
  }
  return findings;
}

/**
 * DETECTOR 2. `symbols` is the packet's own statement of the surface it will
 * touch, so any code that mentions one of those names is dragged along.
 * Mentions inside comments and strings are not references and are removed
 * first, exactly as the import parser removes them.
 *
 * @param {ValidatedNode["taskPacket"]} packet
 * @param {Set<string>} declared
 * @param {Map<string, {absolute: string, text: string}>} sources
 * @returns {ScopeClosureFinding[]}
 */
function symbolMentionFindings(packet, declared, sources) {
  const symbols = packet.symbols ?? [];
  if (symbols.length === 0) return [];
  /** @type {ScopeClosureFinding[]} */
  const findings = [];
  for (const [path, source] of sources) {
    if (declared.has(path)) continue;
    const code = maskCode(source.text);
    const symbol = symbols.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "u").test(code));
    if (symbol) findings.push({ path, detector: "symbols", reason: `mentions ${symbol}, which this node declares it will change` });
  }
  return findings;
}

/**
 * DETECTOR 3. A file written into a directory changes what that directory
 * contains, so any test that enumerates it -- directly, or by running a module
 * that does -- asserts a set that is about to change. `test/installer.test.mjs`
 * asserted "2 installed" and broke when a third skill directory appeared; it
 * never calls `readdirSync` itself, it runs `bin/skills.mjs`, which does. The
 * enumerating module is not the finding; the test that depends on it is.
 *
 * @param {string[]} writeFiles
 * @param {Set<string>} declared
 * @param {Map<string, {absolute: string, text: string}>} sources
 * @param {string} cwd
 * @returns {ScopeClosureFinding[]}
 */
function directoryEnumeratorFindings(writeFiles, declared, sources, cwd) {
  const affected = [...new Set(writeFiles.map((path) => dirname(path).split(sep).join("/")))];
  /** @type {Map<string, string[]>} */
  const referrersOf = new Map();
  for (const [path, source] of sources) {
    for (const reference of referencePaths(source, cwd)) {
      referrersOf.set(reference, [...(referrersOf.get(reference) ?? []), path]);
    }
  }

  /** @type {ScopeClosureFinding[]} */
  const findings = [];
  for (const [path, source] of sources) {
    for (const directory of directoryScans(source, cwd)) {
      // `readdir` sees direct children only: a write changes the set when the
      // scanned directory is the written file's own directory, or its parent
      // (the written file names the new entry). A write deep inside an existing
      // subtree leaves the listing unchanged.
      if (!affected.some((target) => directory === target || directory === dirname(target))) continue;
      if (!declared.has(path) && isTestPath(path)) {
        findings.push({ path, detector: "directory", reason: `enumerates ${directory || "."} while this node writes beneath it` });
      }
      for (const referrer of referrersOf.get(path) ?? []) {
        if (!declared.has(referrer) && isTestPath(referrer)) {
          findings.push({ path: referrer, detector: "directory", reason: `runs ${path}, which enumerates ${directory || "."}` });
        }
      }
    }
  }
  return findings;
}

/**
 * Every `.mjs` under `root` except dependency, run-state, and worktree
 * directories, keyed by `root`-relative path.
 *
 * @param {string} root
 * @returns {Map<string, {absolute: string, text: string}>}
 */
function repositorySources(root) {
  /** @type {Map<string, {absolute: string, text: string}>} */
  const sources = new Map();
  for (const absolute of walkMjs(root)) {
    sources.set(relativeKey(root, absolute), { absolute, text: readFileSync(absolute, "utf8") });
  }
  return sources;
}

/**
 * @param {string} directory
 * @returns {Generator<string>}
 */
function* walkMjs(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walkMjs(join(directory, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      yield join(directory, entry.name);
    }
  }
}

/**
 * Relative specifiers, their imported binding names, and side-effect imports.
 *
 * @param {string} text
 * @returns {{specifier: string, names: Set<string>}[]}
 */
function parseImportRecords(text) {
  const source = stripComments(text);
  /** @type {{specifier: string, names: Set<string>}[]} */
  const records = [];
  for (const match of source.matchAll(IMPORT_FROM)) {
    records.push({ specifier: match[2], names: bindingNames(match[1]) });
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    records.push({ specifier: match[1], names: new Set() });
  }
  return records;
}

/**
 * The names a clause imports, including re-exported source names. A renamed
 * `{ a as b }` contributes `a`, because that is the surface the written module
 * declares.
 *
 * @param {string} clause
 * @returns {Set<string>}
 */
function bindingNames(clause) {
  /** @type {Set<string>} */
  const names = new Set();
  const braces = clause.match(/\{([\s\S]*?)\}/u);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/u)[0].trim();
      if (name) names.add(name);
    }
  }
  const head = clause.replace(/\{[\s\S]*?\}/u, "").replace(/,/gu, " ").trim().split(/\s+/u)[0];
  if (head && head !== "*" && !head.startsWith("*")) names.add(head);
  return names;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text.replace(/\/\*(?:[^*]|\*(?!\/))*\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}

/**
 * Code with comments and string/template bodies blanked, so a name that only
 * appears in prose or a message is not a mention.
 *
 * @param {string} text
 * @returns {string}
 */
function maskCode(text) {
  let masked = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      masked += " ";
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number} index just past the closing quote
 */
function skipString(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/**
 * Modules a file points at, by import or by an executed `new URL`. Both are
 * edges for the directory detector; only the executed ones count as "runs".
 *
 * @param {{absolute: string, text: string}} source
 * @param {string} cwd
 * @returns {Set<string>}
 */
function referencePaths(source, cwd) {
  /** @type {Set<string>} */
  const paths = new Set();
  for (const record of parseImportRecords(source.text)) paths.add(resolveSpecifier(source.absolute, cwd, record.specifier));
  for (const path of executedReferencePaths(source, cwd)) paths.add(path);
  return paths;
}

/**
 * @param {{absolute: string, text: string}} source
 * @param {string} cwd
 * @returns {string[]}
 */
function executedReferencePaths(source, cwd) {
  /** @type {string[]} */
  const paths = [];
  for (const match of source.text.matchAll(EXECUTED_URL)) {
    paths.push(relativeKey(cwd, resolve(dirname(source.absolute), match[1])));
  }
  return paths;
}

/**
 * Directories a file enumerates through `readdirSync`/`readdir`/`glob`, resolved
 * from literals, `join(...)` chains, and the constants those chains are built
 * from. An argument that cannot be resolved statically is not guessed.
 *
 * @param {{absolute: string, text: string}} source
 * @param {string} cwd
 * @returns {string[]}
 */
function directoryScans(source, cwd) {
  /** @type {string[]} */
  const directories = [];
  for (const match of source.text.matchAll(DIRECTORY_CALL)) {
    const args = argumentText(source.text, match.index + match[0].length);
    for (const part of splitTopLevel(args)) {
      const directory = resolvePathExpression(part, source, cwd, new Set());
      if (directory !== null) directories.push(directory);
    }
  }
  return directories;
}

/**
 * The text between an opening parenthesis and its match.
 *
 * @param {string} text
 * @param {number} start index just past the opening parenthesis
 * @returns {string}
 */
function argumentText(text, start) {
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }
  return text.slice(start, index);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevel(text) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The text of a plain string literal, or null for anything else. Inside a
 * `join(...)` chain a literal is a path segment, not a path from the file.
 *
 * @param {string} expression
 * @returns {string|null}
 */
function literalValue(expression) {
  const expr = expression.trim();
  const single = /^"([^"]*)"$/u.exec(expr);
  if (single) return single[1];
  const template = /^`([^`$]*)`$/u.exec(expr);
  return template ? template[1] : null;
}

/**
 * @param {string} expression
 * @param {{absolute: string, text: string}} source
 * @param {string} cwd
 * @param {Set<string>} seen constants already expanded, to stop a cycle
 * @returns {string|null}
 */
function resolvePathExpression(expression, source, cwd, seen) {
  const expr = expression.trim();
  const literal = /^"([^"]*)"$/u.exec(expr);
  if (literal) return relativeKey(cwd, resolve(dirname(source.absolute), literal[1]));
  const template = /^`([^`$]*)`$/u.exec(expr);
  if (template) return relativeKey(cwd, resolve(dirname(source.absolute), template[1]));
  const url = /^fileURLToPath\(\s*new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)\s*\)$/u.exec(expr);
  if (url) return relativeKey(cwd, resolve(dirname(source.absolute), url[1]));
  if (expr === "process.cwd()") return ".";
  const call = /^(?:join|resolve)\(([\s\S]*)\)$/u.exec(expr);
  if (call) {
    let combined = null;
    for (const part of splitTopLevel(call[1])) {
      const segment = literalValue(part);
      if (combined !== null && segment !== null) {
        combined = relativeKey(cwd, resolve(cwd, combined, segment));
        continue;
      }
      const value = resolvePathExpression(part, source, cwd, seen);
      if (value === null) return null;
      combined = combined === null ? value : relativeKey(cwd, resolve(cwd, combined, value));
    }
    return combined;
  }
  if (/^[A-Za-z_$][\w$]*$/u.test(expr)) {
    if (seen.has(expr)) return null;
    const value = constantsIn(source.text).get(expr);
    if (value === undefined) return null;
    seen.add(expr);
    return resolvePathExpression(value, source, cwd, seen);
  }
  return null;
}

/**
 * @param {string} text
 * @returns {Map<string, string>}
 */
function constantsIn(text) {
  /** @type {Map<string, string>} */
  const constants = new Map();
  for (const match of text.matchAll(CONSTANT)) constants.set(match[1], match[2].trim());
  return constants;
}

/**
 * @param {string} importer absolute path of the importing file
 * @param {string} root
 * @param {string} specifier
 * @returns {string}
 */
function resolveSpecifier(importer, root, specifier) {
  return relativeKey(root, resolve(dirname(importer), specifier));
}

/**
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
function relativeKey(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isTestPath(path) {
  return /(?:^|\/)test\//u.test(path) || /\.test\.mjs$/u.test(path);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
