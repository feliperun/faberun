import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The gate behind `docs/FIELD-OWNERSHIP.md`: every field of the two append-only
 * event records has one declared writer, and the writers derived from `src/`
 * must agree with the declaration. The document is the source; this test is
 * what forces it to stay true.
 *
 * The derivation reads the event-writing call sites rather than every
 * `name:`-looking property in the tree, because `node`, `status` and `at` are
 * object keys in almost every module and a whole-tree text scan would drown in
 * false writers. `appendTransitionEvent` is the base writer for `events.jsonl`;
 * each `appendTransitionEvent` caller owns the fields it puts in `details`;
 * `appendJournal` is the persistence funnel and each caller owns the event type
 * it emits.
 *
 * A field with more than one writer today is a measured ratchet, not a
 * correction: `DOUBLE_WRITER_CEILING` pins the count, and the assertion is an
 * equality so fixing a double writer fails the gate until the document and the
 * ceiling are lowered together.
 */

const SKILL_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(SKILL_DIR, "src");
const DOC_PATH = join(SKILL_DIR, "docs", "FIELD-OWNERSHIP.md");

/** Measured 2026-09-12: 11 `events.jsonl` fields plus one `journal.jsonl` event type. */
const DOUBLE_WRITER_CEILING = 12;

/** @typedef {{writers: string[], fields?: string[]}} DeclaredEntry */
/** @typedef {{journal?: Record<string, DeclaredEntry>, legacy?: Record<string, DeclaredEntry>, events?: Record<string, DeclaredEntry>}} OwnershipDoc */
/** @typedef {{path: string, label: string, text: string}} SourceFile */
/** @typedef {{key: string, value: string}} ObjectEntry */

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith(".mjs")) found.push(path);
  }
  return found;
}

const SOURCE_FILES = /** @type {SourceFile[]} */ (walk(SRC_DIR).map((path) => ({
  path,
  label: relative(SRC_DIR, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
})));

/** The index of the delimiter matching the one at `openIndex`. @param {string} text @param {number} openIndex @returns {number} */
function matchDelimiter(text, openIndex) {
  const open = text[openIndex];
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close) { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

/** Split `text` on a delimiter that is not nested in brackets or strings. @param {string} text @param {string} delimiter @returns {string[]} */
function splitTopLevel(text, delimiter) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(" || character === "[" || character === "{") { depth += 1; continue; }
    if (character === ")" || character === "]" || character === "}") { depth -= 1; continue; }
    if (character === delimiter && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** @param {string} text @returns {number} the first colon at bracket depth zero, or -1 */
function findTopLevelColon(text) {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === ":" && depth === 0) return index;
  }
  return -1;
}

/** Every call of `callee` in `text`, with its arguments split at top-level commas. The declaration itself is skipped. @param {string} text @param {string} callee @returns {{open: number, args: string[]}[]} */
function callArguments(text, callee) {
  /** @type {{open: number, args: string[]}[]} */
  const calls = [];
  const pattern = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, "gu");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    // `export function appendJournal(...)` also matches the callee pattern.
    if (/\bfunction\s*$/u.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
    const open = text.indexOf("(", match.index);
    const close = matchDelimiter(text, open);
    if (close < 0) continue;
    calls.push({ open, args: splitTopLevel(text.slice(open + 1, close), ",") });
  }
  return calls;
}

/** @param {string} text @returns {{name: string, startLine: number, endLine: number}[]} */
function functionRanges(text) {
  /** @type {{name: string, startLine: number, endLine: number}[]} */
  const ranges = [];
  const lines = text.split("\n");
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u;
  for (let index = 0; index < lines.length; index += 1) {
    const match = declaration.exec(lines[index]);
    if (!match) continue;
    let end = index;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      end = scan;
      if (/^[}\])]/u.test(lines[scan])) break;
    }
    ranges.push({ name: match[1], startLine: index, endLine: end });
  }
  return ranges;
}

/** The innermost function containing `line`, or `module`. @param {{name: string, startLine: number, endLine: number}[]} ranges @param {number} line @returns {string} */
function ownerOfLine(ranges, line) {
  /** @type {{name: string, startLine: number, endLine: number}|null} */
  let best = null;
  for (const range of ranges) {
    if (line < range.startLine || line > range.endLine) continue;
    if (!best || range.endLine - range.startLine < best.endLine - best.startLine) best = range;
  }
  return best ? best.name : "module";
}

/** Top-level `key: value` entries of an object literal, spreads and shorthands included as `value` empty. @param {string} expression @returns {ObjectEntry[]} */
function objectEntries(expression) {
  const text = expression.trim();
  /** @type {ObjectEntry[]} */
  const entries = [];
  if (!text.startsWith("{")) return entries;
  const end = matchDelimiter(text, 0);
  if (end < 0) return entries;
  for (const part of splitTopLevel(text.slice(1, end), ",")) {
    const item = part.trim();
    if (!item || item.startsWith("...")) continue;
    const colon = findTopLevelColon(item);
    let key = colon >= 0 ? item.slice(0, colon).trim() : item;
    key = key.replace(/^['"`]|['"`]$/gu, "");
    if (!/^[A-Za-z_$][\w$]*$/u.test(key)) continue;
    entries.push({ key, value: colon >= 0 ? item.slice(colon + 1).trim() : "" });
  }
  return entries;
}

/** Resolve `identifier` to the keys of its object literal and its later `identifier.field =` writes. @param {string} identifier @param {string} body @returns {Set<string>} */
function resolveIdentifierKeys(identifier, body) {
  const keys = new Set();
  const declaration = new RegExp(`const\\s+${identifier}\\s*=\\s*\\{`, "u");
  let text = body;
  let index = text.search(declaration);
  if (index < 0) {
    for (const file of SOURCE_FILES) {
      const found = file.text.search(declaration);
      if (found >= 0) { index = found; text = file.text; break; }
    }
  }
  if (index >= 0) {
    const brace = text.indexOf("{", index);
    const end = matchDelimiter(text, brace);
    if (end > brace) for (const entry of objectEntries(text.slice(brace, end + 1))) keys.add(entry.key);
  }
  const assignment = new RegExp(`\\b${identifier}\\.([A-Za-z_$][\\w$]*)\\s*=`, "gu");
  let match;
  while ((match = assignment.exec(text)) !== null) keys.add(match[1]);
  return keys;
}

/** The keys an argument expression writes, merging a `...spread` of a local variable. @param {string} expression @param {string} body @returns {Set<string>} */
function keysFromExpression(expression, body) {
  const text = expression.trim();
  if (text.startsWith("{")) {
    const keys = new Set(objectEntries(text).map((entry) => entry.key));
    const end = matchDelimiter(text, 0);
    if (end >= 0) {
      for (const part of splitTopLevel(text.slice(1, end), ",")) {
        const item = part.trim();
        const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/u.exec(item);
        if (spread) for (const key of resolveIdentifierKeys(spread[1], body)) keys.add(key);
      }
    }
    return keys;
  }
  if (/^[A-Za-z_$][\w$]*$/u.test(text)) return resolveIdentifierKeys(text, body);
  return new Set();
}

/** The value written to `type:` in an entry expression. @param {string} expression @param {string} body @returns {string} */
function typeValueOf(expression, body) {
  const text = expression.trim();
  if (text.startsWith("{")) {
    const found = objectEntries(text).find((entry) => entry.key === "type");
    return found ? found.value : "";
  }
  if (!/^[A-Za-z_$][\w$]*$/u.test(text)) return "";
  const declaration = new RegExp(`const\\s+${text}\\s*=\\s*\\{`, "u").exec(body);
  if (declaration) {
    const brace = body.indexOf("{", declaration.index);
    const end = matchDelimiter(body, brace);
    if (end > brace) {
      const found = objectEntries(body.slice(brace, end + 1)).find((entry) => entry.key === "type");
      if (found) return found.value;
    }
  }
  const assignment = new RegExp(`\\b${text}\\.type\\s*=\\s*([^;\\n]+)`, "u").exec(body);
  return assignment ? assignment[1].trim() : "";
}

/** @param {string} label @returns {SourceFile|undefined} */
const fileByLabel = (label) => SOURCE_FILES.find((file) => file.label === label);

/** The `--kind` values `note` accepts, from `cli/campaign.mjs`. @returns {string[]} */
function noteKinds() {
  const file = fileByLabel("cli/campaign.mjs");
  const match = file ? /const NOTE_KINDS = new Set\(\[([\s\S]*?)\]\)/u.exec(file.text) : null;
  return match ? [...match[1].matchAll(/"([^"]+)"/gu)].map((found) => found[1]) : [];
}

/** The accepted field set of every journal event type, from `ENTRY_SHAPES`. @returns {Map<string, string[]>} */
function journalFields() {
  const file = fileByLabel("campaign/journal.mjs");
  /** @type {Map<string, string[]>} */
  const shapes = new Map();
  const block = file ? /const ENTRY_SHAPES = \{([\s\S]*?)\n\};/u.exec(file.text) : null;
  if (!block) return shapes;
  for (const line of block[1].split("\n")) {
    const match = /^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\[([^\]]*)\]/u.exec(line);
    if (!match) continue;
    shapes.set(match[1] ?? match[2], [...match[3].matchAll(/"([^"]+)"/gu)].map((found) => found[1]));
  }
  return shapes;
}

/**
 * Every writer of every field of the two records, grouped by the record.
 * @returns {{events: Map<string, Set<string>>, journal: Map<string, Set<string>>, journalFields: Map<string, string[]>}}
 */
function deriveOwnership() {
  /** @type {Map<string, Set<string>>} */
  const events = new Map();
  /** @type {Map<string, Set<string>>} */
  const journal = new Map();
  const kinds = noteKinds();
  /** @param {Map<string, Set<string>>} map @param {string} key @param {string} owner */
  const record = (map, key, owner) => {
    if (!map.has(key)) map.set(key, new Set());
    /** @type {Set<string>} */ (map.get(key)).add(owner);
  };

  for (const file of SOURCE_FILES) {
    const text = file.text;
    const ranges = functionRanges(text);
    const lines = text.split("\n");
    /** @type {number[]} */
    const lineStart = [];
    let offset = 0;
    for (const line of lines) { lineStart.push(offset); offset += line.length + 1; }
    /** @param {number} position @returns {number} */
    const lineOf = (position) => {
      let low = 0;
      let high = lineStart.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lineStart[middle] <= position) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    /** @param {string} owner @returns {string} */
    const bodyOf = (owner) => {
      const range = ranges.find((candidate) => candidate.name === owner);
      return range ? lines.slice(range.startLine, range.endLine + 1).join("\n") : text;
    };

    // The base writer builds one `event` literal and conditionally overwrites
    // fields on it; that function itself owns every field it names.
    for (const range of ranges.filter((candidate) => candidate.name === "appendTransitionEvent")) {
      const body = lines.slice(range.startLine, range.endLine + 1).join("\n");
      const literal = body.search(/const\s+event\s*=\s*\{/u);
      if (literal >= 0) {
        const brace = body.indexOf("{", literal);
        const end = matchDelimiter(body, brace);
        if (end > brace) for (const entry of objectEntries(body.slice(brace, end + 1))) record(events, entry.key, "appendTransitionEvent");
      }
      const conditional = /\bevent\.([A-Za-z_$][\w$]*)\s*=/gu;
      let match;
      while ((match = conditional.exec(body)) !== null) record(events, match[1], "appendTransitionEvent");
    }

    // `details` at each call site: those fields are owned by the caller.
    for (const call of callArguments(text, "appendTransitionEvent")) {
      const owner = ownerOfLine(ranges, lineOf(call.open));
      if (owner === "appendTransitionEvent") continue;
      for (const key of keysFromExpression(call.args[4] ?? "", bodyOf(owner))) record(events, key, owner);
    }

    // Diagnostics appended straight to events.jsonl.
    for (const call of callArguments(text, "appendJsonl")) {
      if (!(call.args[0] ?? "").includes("events.jsonl")) continue;
      const owner = ownerOfLine(ranges, lineOf(call.open));
      for (const key of keysFromExpression(call.args[1] ?? "", bodyOf(owner))) record(events, key, owner);
    }

    // The journal emitter owns the event type it builds.
    for (const call of callArguments(text, "appendJournal")) {
      const owner = ownerOfLine(ranges, lineOf(call.open));
      if (owner === "appendJournal") continue;
      const typeValue = typeValueOf(call.args[1] ?? "", bodyOf(owner));
      const literal = /^"([^"]+)"$/u.exec(typeValue);
      const types = literal ? [literal[1]] : typeValue === "kind" ? kinds : [];
      for (const type of types) record(journal, type, owner);
    }
  }
  return { events, journal, journalFields: journalFields() };
}

const DERIVED = deriveOwnership();
const JOURNAL_FIELDS = DERIVED.journalFields;

const documentText = readFileSync(DOC_PATH, "utf8");
const afterMarker = documentText.split("<!-- FIELD-OWNERSHIP-SOURCE -->")[1] ?? "";
const jsonBlock = afterMarker.split("```json")[1];
const document = /** @type {OwnershipDoc} */ (JSON.parse(jsonBlock === undefined ? "" : jsonBlock.split("```")[0]));

test("single writer per field", () => {
  // Deriving from a regex is only trustworthy if it found the writers at all:
  // an empty derivation would make every "no disagreement" assertion vacuous.
  assert.ok(DERIVED.events.size > 20, `derived only ${DERIVED.events.size} events.jsonl fields`);
  assert.ok(JOURNAL_FIELDS.size > 10, `derived only ${JOURNAL_FIELDS.size} journal event types`);

  const declaredJournal = document.journal ?? {};
  const declaredLegacy = document.legacy ?? {};
  const declaredEvents = document.events ?? {};

  // --- journal.jsonl: one emitter per event type, field set matching the schema.
  const declaredTypes = new Set([...Object.keys(declaredJournal), ...Object.keys(declaredLegacy)]);
  assert.deepEqual(
    [...JOURNAL_FIELDS.keys()].filter((type) => !declaredTypes.has(type)).sort(),
    [],
    "journal event type(s) the document omits",
  );
  assert.deepEqual(
    [...declaredTypes].filter((type) => !JOURNAL_FIELDS.has(type)).sort(),
    [],
    "journal event type(s) the document invents",
  );
  for (const [type, fields] of JOURNAL_FIELDS) {
    const declared = declaredJournal[type] ?? declaredLegacy[type];
    assert.deepEqual(
      [...(declared.fields ?? [])].sort(),
      [...fields].sort(),
      `journal ${type} fields drift from ENTRY_SHAPES`,
    );
  }
  for (const [type, declared] of Object.entries(declaredJournal)) {
    assert.deepEqual(
      [...declared.writers].sort(),
      [...(DERIVED.journal.get(type) ?? new Set())].sort(),
      `journal ${type} writer(s) drift from src/`,
    );
  }
  for (const [type, declared] of Object.entries(declaredLegacy)) {
    assert.deepEqual(
      [...declared.writers].sort(),
      [...(DERIVED.journal.get(type) ?? new Set())].sort(),
      `legacy journal ${type} must stay unwritten`,
    );
  }

  // --- events.jsonl: one writer per field, field list matching the tree exactly.
  const declaredFields = new Set(Object.keys(declaredEvents));
  assert.deepEqual(
    [...DERIVED.events.keys()].filter((field) => !declaredFields.has(field)).sort(),
    [],
    "events.jsonl field(s) the document omits",
  );
  assert.deepEqual(
    [...declaredFields].filter((field) => !DERIVED.events.has(field)).sort(),
    [],
    "events.jsonl field(s) the document invents",
  );
  for (const [field, declared] of Object.entries(declaredEvents)) {
    assert.deepEqual(
      [...declared.writers].sort(),
      [...(DERIVED.events.get(field) ?? new Set())].sort(),
      `events.jsonl ${field} writer(s) drift from src/`,
    );
  }

  // --- the ratchet: multi-writer entries, pinned at the measured count.
  const multiWriter = [
    ...Object.entries(declaredEvents).filter(([, declared]) => declared.writers.length > 1).map(([field]) => `events.jsonl.${field}`),
    ...Object.entries(declaredJournal).filter(([, declared]) => declared.writers.length > 1).map(([type]) => `journal.jsonl.${type}`),
  ].sort();
  assert.ok(
    multiWriter.length <= DOUBLE_WRITER_CEILING,
    `${multiWriter.length} multi-writer entries, ceiling ${DOUBLE_WRITER_CEILING}:\n  ${multiWriter.join("\n  ")}`,
  );
  assert.deepEqual(
    multiWriter,
    [
      "events.jsonl.at",
      "events.jsonl.contractVersion",
      "events.jsonl.error",
      "events.jsonl.override",
      "events.jsonl.recovery",
      "events.jsonl.schemaVersion",
      "events.jsonl.summary",
      "events.jsonl.type",
      "events.jsonl.unexpectedPathCount",
      "events.jsonl.unexpectedPaths",
      "events.jsonl.verdict",
      "journal.jsonl.session.attached",
    ],
    "the measured multi-writer set changed; update docs/FIELD-OWNERSHIP.md and DOUBLE_WRITER_CEILING together",
  );
  assert.equal(
    multiWriter.length,
    DOUBLE_WRITER_CEILING,
    `the ratchet fell to ${multiWriter.length}; lower DOUBLE_WRITER_CEILING to match so it cannot drift back up.`,
  );
});
