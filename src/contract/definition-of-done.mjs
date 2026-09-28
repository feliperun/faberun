import { rejectUnknown, requireId, requireString } from "./assert.mjs";
import { errorMessage, shellWords } from "../util.mjs";
import { Script } from "node:vm";
/**
 * Schema 2 Definition of Done items. Each item is an object that names an
 * observable outcome and declares how it is proven: mechanically through a
 * `proof` (a verification `command`, a workspace `path`, or a `verification`
 * entry reused by reference) or by judge `judgment`. The schema-1 string item
 * is rejected; there is no converter and no dual acceptance.
 */

/** @typedef {{kind: "command"|"path"|"verification", ref: string}} DefinitionOfDoneProof */

/** @typedef {{id: string, text: string, proof?: DefinitionOfDoneProof, judgment?: true, reason?: string}} DefinitionOfDoneItem */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number, commands?: {argv: string[]}[], nodeId?: string}} [options]
 * @returns {DefinitionOfDoneItem[]}
 */
export function validateDefinitionOfDone(value, label, options = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of Definition of Done objects`);
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof item === "string") {
      throw new TypeError(`${itemLabel} must be an object, not a schema-1 string item`);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`${itemLabel} must be an object with id, text, and proof or judgment: true`);
    }
    const record = /** @type {Record<string, unknown>} */ (item);
    rejectUnknown(record, new Set(["id", "text", "proof", "judgment", "reason"]), itemLabel);
    requireId(record.id, `${itemLabel}.id`);
    requireString(record.text, `${itemLabel}.text`);
    if (record.judgment !== undefined && record.judgment !== true) {
      throw new TypeError(`${itemLabel}.judgment must be true when present`);
    }
    if (record.reason !== undefined) {
      if (record.judgment !== true) throw new TypeError(`${itemLabel}.reason requires judgment: true`);
      requireString(record.reason, `${itemLabel}.reason`);
    }
    const proof = record.proof === undefined
      ? undefined
      : validateProof(record.proof, `${itemLabel}.proof`, options);
    if (proof === undefined && record.judgment !== true) {
      throw new TypeError(`${itemLabel} must declare proof or judgment: true`);
    }
    return {
      id: /** @type {string} */ (record.id),
      text: /** @type {string} */ (record.text),
      ...(proof === undefined ? {} : { proof }),
      ...(record.judgment === true ? { judgment: true } : {}),
      ...(record.reason === undefined ? {} : { reason: /** @type {string} */ (record.reason) }),
    };
  });
}

/**
 * Report judgment items that do not explain what mechanical verification cannot
 * observe. These remain advisory because `contract validate` has no strict
 * traceability flag; a later strict contract command can promote these codes.
 *
 * @param {DefinitionOfDoneItem[]} items
 * @param {number} index
 * @returns {string[]}
 */
export function judgmentReasonWarnings(items, index) {
  const judgmentItems = items.filter((item) => item.judgment === true);
  const warnings = items.flatMap((item, itemIndex) => item.judgment === true && item.reason === undefined
    ? [`nodes[${index}] (definitionOfDone[${itemIndex}]): judgment_without_reason: judgment item must say what no command verifies`]
    : []);
  const hasMechanicalProof = items.some((item) => item.proof !== undefined);
  if (judgmentItems.length > 0 && hasMechanicalProof && judgmentItems.every((item) => item.reason === undefined)) {
    warnings.push(
      `nodes[${index}]: judgment_beside_mechanical_proof: every judgment item shares this node with mechanical-proof items but declares no reason`,
    );
  }
  return warnings;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number, commands?: {argv: string[]}[], nodeId?: string}} options
 * @returns {DefinitionOfDoneProof}
 */
function validateProof(value, label, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object with kind and ref`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, new Set(["kind", "ref"]), label);
  const kind = record.kind;
  if (kind !== "command" && kind !== "path" && kind !== "verification") {
    throw new TypeError(`${label}.kind must be "command", "path", or "verification"`);
  }
  if (kind === "verification") return { kind, ref: validateVerificationRef(record.ref, label, options) };
  requireString(record.ref, `${label}.ref`);
  return { kind, ref: /** @type {string} */ (record.ref) };
}

/**
 * A `verification` proof reuses a recorded controller verification result by
 * position. It is authored as either the zero-based index or, when the
 * node's verification commands are known to the caller (`options.commands`),
 * the exact text of one of them -- the shape a planning model actually wrote
 * (measured in `choose-the-judges` R5). A text ref is resolved to its index
 * and normalized the same way a numeric ref is, so nothing downstream ever
 * compares command strings again.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number, commands?: {argv: string[]}[], nodeId?: string}} options
 * @returns {string}
 */
function validateVerificationRef(value, label, options) {
  if (typeof value === "string" && options.commands !== undefined && !isIndexLike(value)) {
    return resolveTextRef(value, label, options);
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!isIndexLike(text)) {
    throw new TypeError(`${label}.ref must be the zero-based index of a verification command, or the exact text of one`);
  }
  return checkedIndex(Number.parseInt(/** @type {string} */ (text).trim(), 10), label, options);
}

/** @param {unknown} text @returns {boolean} */
function isIndexLike(text) {
  return typeof text === "string" && /^\d+$/u.test(text.trim());
}

/**
 * @param {string} value
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number, commands?: {argv: string[]}[], nodeId?: string}} options
 * @returns {string}
 */
function resolveTextRef(value, label, options) {
  const commands = /** @type {{argv: string[]}[]} */ (options.commands);
  const index = commands.findIndex((command) => command.argv.join(" ") === value);
  if (index === -1) {
    const node = options.nodeId ?? "this node";
    const existing = commands.length === 0
      ? "(no verification commands)"
      : commands.map((command, position) => `${position}: ${command.argv.join(" ")}`).join("\n");
    throw new TypeError(`${label}.ref "${value}" names no verification command of ${node}; its verification commands are:\n${existing}`);
  }
  return checkedIndex(index, label, options);
}

/**
 * @param {number} index
 * @param {string} label
 * @param {{verificationCount?: number, recordableCount?: number}} options
 * @returns {string}
 */
function checkedIndex(index, label, options) {
  if (typeof options.verificationCount === "number" && index >= options.verificationCount) {
    throw new TypeError(`${label}.ref ${index} names no verification command: the packet declares ${options.verificationCount}`);
  }
  if (typeof options.recordableCount === "number" && index >= options.recordableCount) {
    throw new TypeError(`${label}.ref ${index} cannot be reused at gate time: only the first ${options.recordableCount} verification commands are recorded on the node`);
  }
  return String(index);
}

/**
 * A `kind: "command"` proof's `ref` runs through a shell (`judge-gate.mjs`'s
 * `proveCommand`), while a task packet's `verification` entries run as argv
 * arrays -- the opposite quoting convention for the same author intent.
 * Measured 2026-09-22: six DoD refs on one campaign wrote
 * `--test-name-pattern=a b c` the way an argv array would take it, the shell
 * split it into three words, and the gate rejected work whose identical
 * command had just passed as verification. Nothing warned the author, because
 * a shell that receives extra bare words after an unquoted flag value does not
 * itself know they were meant to be one argument.
 *
 * This flags the same shape rather than every proof: a node:test filter flag
 * (the flags `declaredTestFilters` in judge-gate.mjs recognizes) whose
 * unquoted value is immediately followed by bare words is the pattern the
 * incident measured, and it is precise enough that a legitimate `ref` rarely
 * has trailing bare words right after such a flag by accident.
 *
 * @param {DefinitionOfDoneItem[]} items
 * @param {number} index
 * @returns {string[]}
 */
export function unquotedFilterValueWarnings(items, index) {
  /** @type {string[]} */
  const warnings = [];
  items.forEach((item, itemIndex) => {
    if (item.proof?.kind !== "command") return;
    const tokens = item.proof.ref.split(/\s+/u).filter(Boolean);
    for (const flag of TEST_FILTER_FLAGS) {
      for (let position = 0; position < tokens.length; position++) {
        const prefix = `${flag}=`;
        if (!tokens[position].startsWith(prefix)) continue;
        const value = tokens[position].slice(prefix.length);
        if (/^['"]/u.test(value)) continue;
        let end = position + 1;
        while (end < tokens.length && !tokens[end].startsWith("-")) end++;
        if (end === position + 1) continue;
        const spilled = [value, ...tokens.slice(position + 1, end)].join(" ");
        warnings.push(
          `nodes[${index}] (definitionOfDone[${itemIndex}]): proof.ref's ${flag} value "${spilled}" is unquoted; ` +
          `kind: "command" runs through a shell, unlike taskPacket.verification's argv, so the space splits it into extra words -- quote it as ${flag}="${spilled}"`,
        );
      }
    }
  });
  return warnings;
}

/**
 * The body of an inline `node -e`/`node --eval` script named by a command
 * proof's shell command, or null when the command carries none. The proof runs
 * through a shell, so the body is the next shell word with its quotes removed:
 * `shellWords` expands and escapes nothing, which is also how the shell hands
 * the body to node. `-e` belongs to other commands too (`grep -e` the common
 * one), so a scan only starts at a token that names the node binary.
 *
 * @param {string} commandText
 * @returns {string|null}
 */
export function inlineScriptBody(commandText) {
  const tokens = shellWords(commandText);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isNodeExecutable(tokens[index])) continue;
    for (let position = index + 1; position < tokens.length; position += 1) {
      const token = tokens[position];
      if (SHELL_SEPARATORS.has(token)) break;
      if (token === "-e" || token === "--eval") {
        const body = tokens[position + 1];
        return body === undefined || SHELL_SEPARATORS.has(body) ? null : body;
      }
      if (token.startsWith("--eval=")) return token.slice("--eval=".length);
      if (token.startsWith("-e=")) return token.slice("-e=".length);
    }
  }
  return null;
}

/**
 * The syntax error a `node -e`/`node --eval` body names, or null when the
 * command is not an inline script or its body parses. `vm.Script` is node's
 * own grammar for `-e`; the two shapes node's module wrapper accepts but a
 * classic script does not -- top-level `await` and static ESM syntax -- are
 * re-tried or allowed rather than refused, so a valid proof is never refused
 * for a body this check cannot parse. A genuine error in the tail of an
 * awaited body still surfaces through the async re-try.
 *
 * @param {string} commandText
 * @returns {string|null}
 */
export function inlineScriptParseError(commandText) {
  const body = inlineScriptBody(commandText);
  return body === null ? null : scriptSyntaxError(body);
}

/**
 * Refuse a contract whose command proof is an inline script that does not
 * parse, naming the node and the Definition of Done item. The launch calls
 * this before the first dispatch: a body the parser rejects can never exit 0,
 * so every attempt would be spent on work no delivery could satisfy.
 *
 * @param {{id?: unknown, definitionOfDone?: {id?: unknown, proof?: {kind?: unknown, ref?: unknown}}[]}[]} nodes
 * @returns {void}
 */
export function assertInlineScriptProofsParse(nodes) {
  for (const node of nodes) {
    for (const item of node.definitionOfDone ?? []) {
      if (item.proof?.kind !== "command" || typeof item.proof.ref !== "string") continue;
      const parseError = inlineScriptParseError(item.proof.ref);
      if (parseError === null) continue;
      const nodeName = node.id === undefined ? "a node" : `node ${node.id}`;
      throw new TypeError(`${nodeName}, Definition of Done item "${item.id}": the proof command's inline script does not parse: ${parseError}`);
    }
  }
}

/**
 * The quote a command proof's text leaves open, or null when every quote it
 * opens is closed. `kind: "command"` goes through `/bin/sh -c`, so a text with
 * an odd number of `'` or `"` is refused by the shell before the command runs,
 * with `unexpected EOF while looking for matching`. Measured 2026-09-27 (AP13
 * of safe-to-hand-to-friend): the freeze accepted
 * `node --test --test-name-pattern=a stranger's first campaign completes
 * offline test/…` — an apostrophe inside an unquoted test title — the node did
 * the work and passed its own test in 15 s, and both attempts were spent on a
 * command `/bin/sh` never ran.
 *
 * This is a quote scanner, not a shell parser: it reports the two failures a
 * proof can carry without expanding anything (an open quote, or nothing at
 * all), and leaves every other shell construct to the shell. A `$'…'` string
 * and a quote inside a here-document are the constructs it does not model.
 *
 * @param {string} commandText
 * @returns {string|null}
 */
export function unclosedQuote(commandText) {
  /** @type {string|null} */
  let quote = null;
  let escaped = false;
  for (const character of commandText) {
    if (escaped) { escaped = false; continue; }
    // Outside double quotes a backslash escapes the next character; a
    // backslash inside single quotes is literal, which POSIX also gives it.
    if (quote !== "'" && character === "\\") { escaped = true; continue; }
    if (quote === null && (character === "'" || character === '"')) { quote = character; continue; }
    if (quote === character) quote = null;
  }
  return quote;
}

/**
 * Refuse a contract whose command proof the shell cannot parse, naming the
 * node, the item and the open quote. The freeze and the launch both call it:
 * a command no attempt can run is the same waste as an inline script that
 * cannot parse, and cheaper to refuse than to discover.
 *
 * @param {{id?: unknown, definitionOfDone?: {id?: unknown, proof?: {kind?: unknown, ref?: unknown}}[]}[]} nodes
 * @returns {void}
 */
export function assertProofCommandsParse(nodes) {
  for (const node of nodes) {
    for (const item of node.definitionOfDone ?? []) {
      if (item.proof?.kind !== "command" || typeof item.proof.ref !== "string") continue;
      const quote = unclosedQuote(item.proof.ref);
      if (quote === null) continue;
      const nodeName = node.id === undefined ? "a node" : `node ${node.id}`;
      throw new TypeError(`${nodeName}, Definition of Done item "${item.id}": the proof command leaves a ${quote} open, so /bin/sh refuses it before it runs ("unexpected EOF while looking for matching \`${quote}'"). Quote the value, as in --test-name-pattern="<title>".`);
    }
  }
}

/** @param {string} token @returns {boolean} */
function isNodeExecutable(token) {
  const base = (token.split(/[\\/]/u).pop() ?? token).toLowerCase();
  return base === "node" || base === "nodejs" || base === "node.exe";
}

/**
 * @param {string} body
 * @returns {string|null}
 */
function scriptSyntaxError(body) {
  try {
    void new Script(body);
    return null;
  } catch (error) {
    const message = errorMessage(error);
    if (AWAIT_OUTSIDE_ASYNC.test(message)) {
      try {
        // The rest of the body still has to parse, so an unparsable tail is
        // refused even when the head needed the async wrapper to parse at all.
        void new Script(`(async () => {\n${body}\n})`);
        return null;
      } catch (wrapped) {
        const wrappedMessage = errorMessage(wrapped);
        return MODULE_SYNTAX.test(wrappedMessage) ? null : wrappedMessage;
      }
    }
    // node's `-e` accepts static imports, exports and `import.meta`; no stable
    // API parses a module here, so a module-only diagnostic is not a syntax
    // error this check can prove and the body is allowed.
    return MODULE_SYNTAX.test(message) ? null : message;
  }
}

/** vm.Script's diagnostics for syntax node's `-e` module wrapper accepts. */
const AWAIT_OUTSIDE_ASYNC = /await is only valid in async functions|^Unexpected reserved word$/u;
const MODULE_SYNTAX = /Cannot use import statement outside a module|Cannot use 'import\.meta' outside a module|Unexpected token 'export'/u;
/** Shell tokens that end one command, so a later `-e` is not this node's. */
const SHELL_SEPARATORS = new Set(["&&", "||", "|", ";", "&", ">", ">>", "<"]);

/** The node:test filter flags a `kind: "command"` proof's shell can split on an unquoted value. */
const TEST_FILTER_FLAGS = ["--test-name-pattern", "--test-skip-pattern"];
