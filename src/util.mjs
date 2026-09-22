import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
/**
 * Utilities with no domain of their own, collected here because they were
 * copy-pasted instead. `errorMessage` stood as five byte-identical definitions
 * (engine/node, harnesses/catalogue, host/preflight, notify/index,
 * notify/os-macos) and `excerpt`/`delay` were exported from modules that have
 * nothing to do with either.
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line of provider or git prose, safe to put in a status field: control
 * characters folded to spaces, whitespace collapsed, capped at 120 characters.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function excerpt(text) {
  if (typeof text !== "string") return null;
  const clean = text.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return null;
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/**
 * The string `code` an error carries, or undefined. Eight copies of this lived
 * across the tree under five behaviours -- one returned a code of any type, one
 * demanded `instanceof Error`, one returned an HTTP `status` before the code.
 * Checked 2026-09-11: every one of the ~30 call sites compares the result
 * against a string literal (`"ENOENT"`, `"EEXIST"`, `"ENOSPC"`, `"EPERM"`,
 * `"ENOTDIR"`), and the `status` branch was dead at both of its two call sites,
 * so the strictest reading is the one they all already assumed.
 *
 * @param {unknown} error
 * @returns {string|undefined}
 */
export function errorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = /** @type {{code: unknown}} */ (error).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Key-sorted JSON with no whitespace: two values that differ only in key order
 * serialize identically, which is what makes it usable for comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The exit status a spawned command failed with, or undefined when it never ran
 * (`execFileSync` throws ENOENT with a null status) or when the error is not a
 * spawn failure at all.
 *
 * This is not `errorCode`, and conflating the two is a live hazard: `git
 * check-ignore` reports "not ignored" by exiting 1, so four git probes in
 * `contract/index.mjs` compare against the number 1. Merging them into one
 * "error code" -- as this tree nearly did on 2026-09-11 -- makes every one of
 * those probes answer "unknown" forever, silently. `tsc` caught it; grep had
 * not.
 *
 * @param {unknown} error
 * @returns {number|undefined}
 */
export function exitStatus(error) {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = /** @type {{status: unknown}} */ (error).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function boundedUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
export function fail(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}
/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isContained(root, target) {
  const distance = relative(root, target);
  return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
}
/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function tailText(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/**
 * @param {string} value
 * @returns {string}
 */
export function collapseLines(value) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, " ")
    .replace(/\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function boundedText(value, maxBytes) {
  const text = String(value);
  if (maxBytes <= 0) return "…";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = [];
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes + 3 > maxBytes) break;
    chars.push(char);
    bytes += charBytes;
  }
  return `${chars.join("")}…`;
}

/**
 * Truncate by grapheme-ish unit, not by byte or UTF-16 code unit: slicing a
 * string in the middle of an astral character produces a lone surrogate, which
 * some notification transports reject outright.
 *
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

/**
 * A token count for a fixed-width column. `-` for absent or zero, because a
 * blank cell and a real zero are different facts and only one of them is worth
 * reading.
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function compactTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function compactCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "-";
}

/**
 * Read JSON, or null when the file is absent or unparseable. For readers that
 * display a run they do not own -- the web surface, the campaign CLI -- where a
 * half-written file is a normal race, not an error.
 *
 * @param {string} path
 * @returns {unknown}
 */
export function readJsonTolerant(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Split a command string into the words a POSIX shell would pass as argv, for
 * the two readers handed a command as a display string rather than an argv: a
 * Definition of Done `command` proof, whose words `engine/scope.mjs` matches
 * against the files the node wrote, and the node:test filters one declares
 * (`engine/judge-gate.mjs`). Quotes group and are stripped; whitespace
 * outside them separates.
 *
 * Deliberately not a shell: no expansion, no substitution, no operators, and
 * no backslash escape -- on Windows a backslash is a path separator and
 * `C:\Users\x` must survive this intact. The question both callers ask is
 * "which words does this command name", and a quoted path holding a space is
 * one word: splitting it on whitespace produced two fragments that matched no
 * file, so a proof naming a real path read as naming none.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function shellWords(text) {
  /** @type {string[]} */
  const words = [];
  /** @type {string|null} */
  let current = null;
  /** @type {string|null} */
  let quote = null;
  for (const character of text) {
    if (quote === null && /\s/u.test(character)) {
      if (current !== null) words.push(current);
      current = null;
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      current ??= "";
      continue;
    }
    if (quote === character) {
      quote = null;
      continue;
    }
    current = (current ?? "") + character;
  }
  if (current !== null) words.push(current);
  return words;
}
