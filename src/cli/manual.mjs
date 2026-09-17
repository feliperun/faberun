/**
 * Regenerates the derivable parts of docs/COMMANDS.md — verb and operation
 * headings, synopsis lines and flag-table rows — from the option tables the
 * CLI itself dispatches on. Every other line (description paragraphs,
 * reads/writes prose, examples, Related lines, and the four fixed sections)
 * is copied through unchanged, so the manual's prose stays hand-authored
 * while its command surface cannot drift from the code silently.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_OPTIONS } from "../cli.mjs";
import CAMPAIGN_OPERATIONS from "./campaign.mjs";
import SEAT_OPERATIONS from "./seat.mjs";
import CONTRACT_OPERATIONS from "./contract.mjs";
import SKILLS_OPERATIONS from "./skills.mjs";
import SPEC_OPERATIONS from "./spec.mjs";

/** @typedef {{type: "string"|"boolean", multiple?: boolean}} FlagSpec */
/** @typedef {{flags?: Record<string, FlagSpec>, operations?: Record<string, Record<string, FlagSpec>>}} VerbSurface */
/** @typedef {{verbs: Record<string, VerbSurface>}} Surface */

const MANUAL_PATH = fileURLToPath(new URL("../../docs/COMMANDS.md", import.meta.url));

/**
 * `campaign`, `seat`, `contract`, `skills` and `spec` are dispatched before
 * `COMMAND_OPTIONS` is ever consulted (`cli.mjs` routes them by `argv[0]`), so
 * they carry no flags of their own — only the operations their own module
 * declares. Their top-level `## faberun <verb>` section is therefore never
 * regenerated; it is hand-authored overview prose, preserved verbatim.
 *
 * @type {Record<string, Record<string, Record<string, FlagSpec>>>}
 */
const CONTAINER_OPERATIONS = {
  campaign: CAMPAIGN_OPERATIONS,
  seat: SEAT_OPERATIONS,
  contract: CONTRACT_OPERATIONS,
  skills: SKILLS_OPERATIONS,
  spec: SPEC_OPERATIONS,
};

/**
 * The real command surface, read from the same option tables `cli.mjs`
 * parses argv against. `supervise campaign` is `campaign.mjs`'s `supervise`
 * operation reached through a second spelling (`cli.mjs` routes
 * `argv = ["supervise", "campaign", …]` into `campaignCli`), so it shares that
 * operation's flags rather than declaring its own.
 *
 * @returns {Surface}
 */
export function collectSurface() {
  /** @type {Record<string, VerbSurface>} */
  const verbs = {};
  for (const [verb, flags] of Object.entries(COMMAND_OPTIONS)) verbs[verb] = { flags };
  if (verbs.supervise) verbs.supervise.operations = { campaign: CAMPAIGN_OPERATIONS.supervise };
  for (const [verb, operations] of Object.entries(CONTAINER_OPERATIONS)) verbs[verb] = { operations };
  return { verbs };
}

const VERB_HEADING = /^## faberun ([a-z][a-z-]*)$/u;
const TABLE_HEADER = "| Flag | Value | Effect | Default |";
const TABLE_SEPARATOR = "| --- | --- | --- | --- |";
/** The start of a flag token in a synopsis line: `--flag` or `[--flag`. */
const FLAG_TOKEN = /\[?--/u;

/**
 * Regenerate the derivable parts of a command manual. A verb absent from
 * `surface` is dropped; one present in `surface` but absent from `current` is
 * appended as a skeleton section.
 *
 * @param {string} current
 * @param {Surface} surface
 * @returns {string}
 */
export function renderManual(current, surface) {
  const lines = current.split("\n");
  /** @type {string[]} */
  const output = [];
  const seenVerbs = new Set();
  let i = 0;
  while (i < lines.length) {
    const match = VERB_HEADING.exec(lines[i]);
    if (!match) {
      output.push(lines[i]);
      i += 1;
      continue;
    }
    const verb = match[1];
    let end = i + 1;
    while (end < lines.length && !/^## /u.test(lines[end])) end += 1;
    const entry = surface.verbs[verb];
    if (entry) {
      output.push(...renderVerbBlock(verb, lines.slice(i, end), entry));
      seenVerbs.add(verb);
    }
    i = end;
  }
  for (const [verb, entry] of Object.entries(surface.verbs)) {
    if (!seenVerbs.has(verb)) output.push(...renderVerbBlock(verb, [`## faberun ${verb}`], entry));
  }
  return output.join("\n");
}

/**
 * @param {string} verb
 * @param {string[]} block
 * @param {VerbSurface} entry
 * @returns {string[]}
 */
function renderVerbBlock(verb, block, entry) {
  const heading = block[0] ?? `## faberun ${verb}`;
  const { body, operationBlocks } = splitOperations(verb, block.slice(1));
  const renderedBody = entry.flags
    ? renderFlaggedBody(`faberun ${verb}`, body, entry.flags)
    : body.length
      ? body
      : renderFlaggedBody(`faberun ${verb}`, [], {});
  const renderedOperations = renderOperations(verb, operationBlocks, entry.operations ?? {});
  return [heading, ...renderedBody, ...renderedOperations];
}

/**
 * Splits a verb's body into the part before its first `### faberun <verb>
 * <op>` heading and the operation sub-blocks that follow, each running to the
 * next `### ` heading.
 *
 * @param {string} verb
 * @param {string[]} lines
 * @returns {{body: string[], operationBlocks: {op: string, block: string[]}[]}}
 */
function splitOperations(verb, lines) {
  const opHeading = new RegExp(`^### faberun ${verb} ([a-z][a-z-]*)$`, "u");
  const firstOpIndex = lines.findIndex((line) => opHeading.test(line));
  if (firstOpIndex === -1) return { body: lines, operationBlocks: [] };
  const body = lines.slice(0, firstOpIndex);
  /** @type {{op: string, block: string[]}[]} */
  const operationBlocks = [];
  let i = firstOpIndex;
  while (i < lines.length) {
    const match = opHeading.exec(lines[i]);
    if (!match) break;
    let end = i + 1;
    while (end < lines.length && !/^###? /u.test(lines[end])) end += 1;
    operationBlocks.push({ op: match[1], block: lines.slice(i, end) });
    i = end;
  }
  return { body, operationBlocks };
}

/**
 * @param {string} verb
 * @param {{op: string, block: string[]}[]} operationBlocks
 * @param {Record<string, Record<string, FlagSpec>>} operations
 * @returns {string[]}
 */
function renderOperations(verb, operationBlocks, operations) {
  const output = [];
  const seen = new Set();
  for (const { op, block } of operationBlocks) {
    if (!Object.hasOwn(operations, op)) continue;
    output.push(block[0] ?? `### faberun ${verb} ${op}`, ...renderFlaggedBody(`faberun ${verb} ${op}`, block.slice(1), operations[op]));
    seen.add(op);
  }
  for (const [op, flags] of Object.entries(operations)) {
    if (seen.has(op)) continue;
    output.push(`### faberun ${verb} ${op}`, ...renderFlaggedBody(`faberun ${verb} ${op}`, [], flags));
  }
  return output;
}

/**
 * Regenerates a section's synopsis fence and flag table in place; every
 * other line is untouched.
 *
 * @param {string} prefix
 * @param {string[]} body
 * @param {Record<string, FlagSpec>} flags
 * @returns {string[]}
 */
function renderFlaggedBody(prefix, body, flags) {
  const positional = extractPositional(prefix, body);
  const synopsis = renderSynopsis(prefix, positional, flags);
  const fence = findFence(body, "```text");
  const withSynopsis = fence
    ? [...body.slice(0, fence.start), "```text", synopsis, "```", ...body.slice(fence.end + 1)]
    : ["```text", synopsis, "```", ...body];
  return replaceFlagTable(withSynopsis, flags);
}

/**
 * The positional placeholder a synopsis names, kept verbatim from the
 * current text (including its own brackets, when optional) — everything
 * before the first flag token.
 *
 * @param {string} prefix
 * @param {string[]} body
 * @returns {string}
 */
function extractPositional(prefix, body) {
  const fence = findFence(body, "```text");
  if (!fence) return "";
  const inner = body[fence.start + 1] ?? "";
  if (!inner.startsWith(prefix)) return "";
  const remainder = inner.slice(prefix.length).trim();
  const flagToken = FLAG_TOKEN.exec(remainder);
  return flagToken ? remainder.slice(0, flagToken.index).trim() : remainder;
}

/**
 * @param {string} prefix
 * @param {string} positional
 * @param {Record<string, FlagSpec>} flags
 * @returns {string}
 */
function renderSynopsis(prefix, positional, flags) {
  const parts = [prefix];
  if (positional) parts.push(positional);
  for (const [name, spec] of Object.entries(flags)) {
    if (spec.type === "boolean") parts.push(`[--${name}]`);
    else if (spec.multiple) parts.push(`[--${name} <a>...]`);
    else parts.push(`[--${name} <value>]`);
  }
  return parts.join(" ");
}

/**
 * @param {string[]} lines
 * @param {string} opener
 * @returns {{start: number, end: number}|null}
 */
function findFence(lines, opener) {
  const start = lines.indexOf(opener);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "```") end += 1;
  return { start, end };
}

/**
 * @param {string[]} lines
 * @param {Record<string, FlagSpec>} flags
 * @returns {string[]}
 */
function replaceFlagTable(lines, flags) {
  const headerIndex = lines.indexOf(TABLE_HEADER);
  const existingRows = headerIndex === -1 ? new Map() : parseRows(lines, headerIndex + 2);
  const newRows = buildRows(flags, existingRows);
  if (headerIndex === -1) {
    const fenceEnd = lines.indexOf("```");
    const insertAt = fenceEnd === -1 ? lines.length : fenceEnd + 1;
    return [...lines.slice(0, insertAt), TABLE_HEADER, TABLE_SEPARATOR, ...newRows, ...lines.slice(insertAt)];
  }
  let rowsEnd = headerIndex + 2;
  while (rowsEnd < lines.length && lines[rowsEnd].startsWith("|")) rowsEnd += 1;
  return [...lines.slice(0, headerIndex), TABLE_HEADER, TABLE_SEPARATOR, ...newRows, ...lines.slice(rowsEnd)];
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {Map<string, {value: string, effect: string, default: string}>}
 */
function parseRows(lines, start) {
  /** @type {Map<string, {value: string, effect: string, default: string}>} */
  const map = new Map();
  let i = start;
  while (i < lines.length && lines[i].startsWith("|")) {
    const cells = lines[i].trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
    if (cells.length === 4) map.set(flagKeyOf(cells[0]), { value: cells[1], effect: cells[2], default: cells[3] });
    i += 1;
  }
  return map;
}

/** @param {string} cell @returns {string} */
function flagKeyOf(cell) {
  const match = /`--([a-z-]+)`/u.exec(cell);
  return match ? match[1] : "—";
}

/**
 * @param {Record<string, FlagSpec>} flags
 * @param {Map<string, {value: string, effect: string, default: string}>} existingRows
 * @returns {string[]}
 */
function buildRows(flags, existingRows) {
  const names = Object.keys(flags);
  if (names.length === 0) {
    const existing = existingRows.get("—");
    return [existing ? `| — | ${existing.value} | ${existing.effect} | ${existing.default} |` : "| — | — | No flags. | — |"];
  }
  return names.map((name) => {
    const existing = existingRows.get(name);
    const value = existing ? existing.value : "<value>";
    const effect = existing ? existing.effect : "";
    const fallback = existing ? existing.default : "—";
    return `| \`--${name}\` | ${value} | ${effect} | ${fallback} |`;
  });
}

/**
 * A minimal, dependency-free diff summary: every line index where the two
 * texts disagree, capped so a large rewrite does not flood the console.
 *
 * @param {string} current
 * @param {string} next
 * @returns {string}
 */
function diffSummary(current, next) {
  const a = current.split("\n");
  const b = next.split("\n");
  const max = Math.max(a.length, b.length);
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < max && lines.length < 40; i += 1) {
    if (a[i] !== b[i]) lines.push(`line ${i + 1}:\n- ${a[i] ?? "<eof>"}\n+ ${b[i] ?? "<eof>"}`);
  }
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  const mode = argv[0];
  if (mode !== "--write" && mode !== "--check") {
    process.stderr.write("usage: manual.mjs --write|--check\n");
    process.exitCode = 2;
    return;
  }
  const current = readFileSync(MANUAL_PATH, "utf8");
  const next = renderManual(current, collectSurface());
  if (next === current) return;
  if (mode === "--write") {
    writeFileSync(MANUAL_PATH, next);
    return;
  }
  process.stderr.write(`docs/COMMANDS.md is out of date; run \`npm run docs\`.\n${diffSummary(current, next)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2));
