/**
 * The three PreToolUse decisions the tool policy hook carries but does not
 * yet apply: a write outside the declared scope, a whole-file read above the
 * line threshold, and the same read done through `Bash` (`cat`/`less`/`more`,
 * or `head`/`tail` with no explicit limit). Kept out of tool-policy-hook.mjs
 * so that module stays the wiring (argv, settings, event dispatch) and this
 * one stays the judgment calls, each a pure function of policy and payload.
 *
 * The two read decisions only deny what they can measure: a file that is
 * missing, unreadable, or not a regular file passes through, because the hook
 * must never be the reason a model cannot see the tool's own error. The write
 * decision is different in kind -- scope membership is a fact about the path,
 * not about the disk -- so it judges a target that does not exist yet exactly
 * like one that does. Creating a new file outside the declared scope is the
 * ordinary violation, and skipping it would leave the decision firing only on
 * overwrites.
 *
 * A write made through `Bash` (`>`, `sed -i`, `tee`) is deliberately not
 * caught here: sniffing shell syntax for a write is a race no static read of
 * `command` wins, and the post-hoc scope gate in `engine/scope.mjs` already
 * catches the effect once the attempt completes.
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";

/**
 * Tool name to the payload field carrying the path it would write.
 *
 * A tool that is not a key here is not judged at all, and Claude Code reads a
 * hook that says nothing as an allow. That makes the map the enforcement
 * boundary rather than a lookup table, so `test/host/tool-policy.test.mjs`
 * pins it against the tool list the adapter actually offers: adding a
 * write-capable tool to `DEFAULT_CLAUDE_TOOLS` without adding it here fails
 * the suite instead of silently opening the scope.
 */
export const WRITE_SCOPE_FIELDS = { Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

/** Tools the adapter offers that cannot write, so their absence above is correct. */
export const READ_ONLY_TOOLS = new Set(["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"]);

/** Bash commands that read a whole file by default. */
const WHOLE_FILE_READERS = new Set(["cat", "less", "more"]);

/** Bash commands that read a whole file only when given no explicit limit. */
const BOUNDED_BY_DEFAULT_READERS = new Set(["head", "tail"]);

/** A command containing any of these is a pipeline, redirection or chain: the named file is a filter's input, not read-tool evidence. */
const SHELL_COMPOSITION_TOKENS = ["|", ">>", ">", "<", "&&", "||", ";"];

/**
 * DECISION 1: deny a `Write`, `Edit`, or `NotebookEdit` call whose target path
 * is neither a declared write file nor beneath a declared write root. An empty
 * scope (no writeFiles and no writeRoots) is the absence of a declared scope,
 * not a closed one, and denies nothing. Existence is not consulted: a path is
 * in the declared scope or it is not, and a file the attempt is about to
 * create is exactly the case worth catching before it exists.
 *
 * @param {{workspace: string|null, writeFiles: string[], writeRoots: string[]}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function writeScopeDecision(policy, payload) {
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const field = /** @type {Record<string, string>} */ (WRITE_SCOPE_FIELDS)[name];
  if (!field) return null;
  const writeFiles = policy.writeFiles ?? [];
  const writeRoots = policy.writeRoots ?? [];
  if (!writeFiles.length && !writeRoots.length) return null;
  const workspace = typeof policy.workspace === "string" ? policy.workspace : "";
  if (!workspace) return null;
  const input = payload?.tool_input;
  const rawPath = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input)[field] : undefined;
  if (typeof rawPath !== "string" || !rawPath) return null;
  // Both spellings are offered to the match: the path as declared, and the
  // path the filesystem actually reaches. A symlink pointing elsewhere inside
  // the workspace is a legitimate scope (git reports the target's spelling,
  // which is why `repo/workspace.mjs` accepts both too); one pointing outside
  // is the escape below.
  const spellings = workspaceSpellings(workspace, rawPath);
  if (spellings.reachesWorkspace && spellings.readings.some((rel) => inDeclaredScope(rel, writeFiles, writeRoots))) return null;
  return denyPreTool(writeScopeDenialReason(writeFiles, writeRoots));
}

/**
 * Whether one workspace-relative spelling sits in the declared scope.
 * Comparison is Unicode-normalized because a macOS path round-trips between
 * NFC and NFD and a worker that renormalizes a filename it is entitled to
 * write should not meet an opaque denial. A declared root keeps matching with
 * a trailing slash, which is an easy thing to type into a contract and used to
 * break every write under that root.
 *
 * @param {string|null} rel
 * @param {string[]} writeFiles
 * @param {string[]} writeRoots
 * @returns {boolean}
 */
function inDeclaredScope(rel, writeFiles, writeRoots) {
  if (rel === null) return false;
  const target = rel.normalize("NFC");
  if (writeFiles.some((file) => file.normalize("NFC") === target)) return true;
  return writeRoots.some((declared) => {
    const root = declared.normalize("NFC").replace(/\/+$/u, "");
    return root !== "" && (target === root || target.startsWith(`${root}/`));
  });
}

/**
 * @param {string[]} writeFiles
 * @param {string[]} writeRoots
 * @returns {string}
 */
function writeScopeDenialReason(writeFiles, writeRoots) {
  const declared = [...writeFiles, ...writeRoots.map((root) => `${root}/`)];
  const shown = declared.slice(0, 12);
  const omitted = declared.length - shown.length;
  const remainder = omitted > 0 ? ` (and ${omitted} more not shown)` : "";
  return `write denied: this path is outside the declared write scope. Declared write paths: ${shown.join(", ")}${remainder}. Write only to one of those.`;
}

/**
 * DECISION 2: deny a `Read` call that would read an entire file above
 * `policy.maxReadLines` with neither `offset` nor `limit`. A file that cannot
 * be measured -- missing, unreadable, not a regular file -- passes through.
 *
 * @param {{maxReadLines: number|null}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function readThresholdDecision(policy, payload) {
  if (typeof payload?.tool_name !== "string" || payload.tool_name !== "Read") return null;
  const maxReadLines = policy.maxReadLines;
  if (typeof maxReadLines !== "number" || maxReadLines <= 0) return null;
  const input = payload?.tool_input;
  if (!input || typeof input !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (input);
  if (record.offset !== undefined || record.limit !== undefined) return null;
  const rawPath = record.file_path;
  if (typeof rawPath !== "string" || !rawPath) return null;
  const lines = countLines(rawPath);
  if (lines === null || lines <= maxReadLines) return null;
  return denyPreTool(readThresholdDenialReason(lines, maxReadLines));
}

/**
 * DECISION 3: deny the same whole-file read done through `Bash` -- a single
 * `cat`/`less`/`more` invocation, or `head`/`tail` with no explicit limit --
 * over a file above the threshold. A command carrying a pipe, redirection, or
 * chain passes without analysis: the named file is then a filter's input, not
 * evidence entering the model's context.
 *
 * @param {{maxReadLines: number|null}} policy
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
export function bashReadDecision(policy, payload) {
  if (typeof payload?.tool_name !== "string" || payload.tool_name !== "Bash") return null;
  const maxReadLines = policy.maxReadLines;
  if (typeof maxReadLines !== "number" || maxReadLines <= 0) return null;
  const input = payload?.tool_input;
  const command = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input).command : undefined;
  if (typeof command !== "string" || !command.trim()) return null;
  if (SHELL_COMPOSITION_TOKENS.some((token) => command.includes(token))) return null;
  const tokens = command.trim().split(/\s+/u);
  const program = basename(tokens[0] ?? "");
  const args = tokens.slice(1);
  if (WHOLE_FILE_READERS.has(program)) {
    return bashTargetDenial(args, maxReadLines);
  }
  if (BOUNDED_BY_DEFAULT_READERS.has(program) && !hasExplicitLimit(args)) {
    return bashTargetDenial(args, maxReadLines);
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {number} maxReadLines
 * @returns {{hookSpecificOutput: Record<string, unknown>}|null}
 */
function bashTargetDenial(args, maxReadLines) {
  const target = [...args].reverse().find((token) => !token.startsWith("-"));
  if (!target) return null;
  const lines = countLines(target);
  if (lines === null || lines <= maxReadLines) return null;
  return denyPreTool(readThresholdDenialReason(lines, maxReadLines, true));
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function hasExplicitLimit(args) {
  return args.some((arg) => arg === "-n" || arg === "-c" || /^-[nc]\d+$/u.test(arg) || /^-\d+$/u.test(arg));
}

/**
 * @param {number} lines
 * @param {number} maxReadLines
 * @param {boolean} [viaBash]
 * @returns {string}
 */
function readThresholdDenialReason(lines, maxReadLines, viaBash = false) {
  const retry = viaBash
    ? "rerun with an explicit limit (head -n, tail -n) or use the Read tool with an offset and limit"
    : "reread it with an offset and limit instead of the whole file";
  return `read denied: this file has ${lines} lines, above the ${maxReadLines}-line read threshold; ${retry}.`;
}

/**
 * Where a target path actually lands, and the workspace-relative spellings it
 * can be judged under: the one the caller wrote, and the one the filesystem
 * reaches through any symlink on the way. A path the filesystem does not
 * reach inside the workspace is refused whatever it was spelled as; a path
 * that does is in scope if either spelling is.
 *
 * Lexical containment alone was an escape, reproduced 2026-09-13 against the
 * real provider: declare `writeRoots: ["src/pkg"]` where `src/pkg` is a
 * symlink to a directory outside the repository, and `Write` to
 * `src/pkg/new.txt` passed the prefix test and landed outside the workspace.
 * The provider's own refusal does not cover it either — that one lstats the
 * exact target, so a symlinked *intermediate directory* never trips it.
 *
 * @param {string} workspace
 * @param {string} rawPath
 * @returns {{reachesWorkspace: boolean, readings: (string|null)[]}}
 */
function workspaceSpellings(workspace, rawPath) {
  const root = realPath(workspace) ?? workspace;
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath);
  const resolved = resolveThroughLinks(absolute);
  const reached = resolved === null ? null : containedRelativePath(root, resolved);
  // The declared spelling is measured against both readings of the workspace
  // root. A caller naming an absolute path uses the root it was handed, which
  // on macOS is routinely a symlink (`/var` to `/private/var`), and measuring
  // that against the resolved root alone reads every path as an escape.
  const declared = containedRelativePath(root, absolute) ?? containedRelativePath(workspace, absolute);
  return { reachesWorkspace: reached !== null, readings: [declared, reached] };
}

/**
 * @param {string} root
 * @param {string} absolute
 * @returns {string|null} the forward-slash relative path, or null when it is not inside the root
 */
function containedRelativePath(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return sep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

/**
 * Resolve the longest existing prefix of a path through the filesystem and
 * re-append the components that do not exist yet, so a file about to be
 * created is judged at the location it will actually occupy. `null` when
 * containment cannot be proven — an unreadable component denies rather than
 * passes, since the whole point is to refuse what cannot be shown to be
 * inside.
 *
 * @param {string} absolute
 * @returns {string|null}
 */
function resolveThroughLinks(absolute) {
  /** @type {string[]} */
  const tail = [];
  let current = absolute;
  for (;;) {
    const real = realPath(current);
    if (real !== null) return tail.length ? resolve(real, ...tail) : real;
    const parent = dirname(current);
    if (parent === current) return null;
    tail.unshift(basename(current));
    current = parent;
  }
}

/** @param {string} path @returns {string|null} */
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    // Missing, unreadable, or a non-directory component: the caller walks up
    // to the nearest existing ancestor, and gives up when there is none.
    return null;
  }
}

/**
 * Count lines in a file without loading it fully into memory: newline bytes
 * plus one more line when the file does not end on a newline. `null` means
 * the path does not exist, is not a regular file, or cannot be read -- the
 * caller must pass the invocation through rather than fabricate a denial for
 * evidence it cannot prove.
 *
 * @param {string} path
 * @returns {number|null}
 */
function countLines(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    if (stats.size === 0) return 0;
    const buffer = Buffer.alloc(64 * 1024);
    let lines = 0;
    let position = 0;
    let lastByte = -1;
    while (position < stats.size) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 0x0a) lines += 1;
      }
      lastByte = buffer[read - 1];
      position += read;
    }
    return lastByte === 0x0a ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} reason
 * @returns {{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string}}}
 */
function denyPreTool(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
