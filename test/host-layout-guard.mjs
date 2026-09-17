/**
 * A grep-shaped guard against machine-layout assumptions in test source: a
 * PATH rebuilt from an absolute system directory, a version-manager name
 * referenced in real code, `process.platform` steering an assertion, and a
 * fixture shebang that resolves `node` through the PATH shim instead of
 * `process.execPath`. Three of these shipped in six weeks (heartbeat speed,
 * `codex` on PATH, `node` outside `/usr/bin`) and each was fixed once and
 * came back elsewhere -- this is the test that keeps them fixed.
 */

/**
 * Build a same-length mask marking which characters of `text` sit outside any
 * string or comment literal. Mirrors `fixture-runtime-guard.mjs`'s
 * `structuralMask` so both guards treat comments and strings the same way.
 *
 * @param {string} text
 * @returns {boolean[]}
 */
function structuralMask(text) {
  const mask = new Array(text.length).fill(true);
  /** @type {null|'"'|"'"|'`'|'//'|'/*'} */
  let state = null;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === '"' || state === "'" || state === "`") {
      mask[index] = false;
      if (char === "\\") { mask[index + 1] = false; index += 2; continue; }
      if (char === state) state = null;
      index += 1;
      continue;
    }
    if (state === "//") {
      mask[index] = false;
      if (char === "\n") state = null;
      index += 1;
      continue;
    }
    if (state === "/*") {
      mask[index] = false;
      if (char === "*" && next === "/") { mask[index + 1] = false; state = null; index += 2; continue; }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { state = /** @type {'"'|"'"|'`'} */ (char); mask[index] = false; index += 1; continue; }
    if (char === "/" && next === "/") { state = "//"; mask[index] = false; index += 1; continue; }
    if (char === "/" && next === "*") { state = "/*"; mask[index] = false; index += 1; continue; }
    index += 1;
  }
  return mask;
}

/**
 * @param {string} source
 * @param {number} index
 * @returns {number} 1-based line number containing `index`
 */
function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

/**
 * @param {string} source
 * @param {number} index
 * @returns {string} the trimmed text of the line containing `index`
 */
function lineText(source, index) {
  const start = source.lastIndexOf("\n", index) + 1;
  const nextNewline = source.indexOf("\n", index);
  const end = nextNewline === -1 ? source.length : nextNewline;
  return source.slice(start, end).trim();
}

const EXEMPT_MARKER = /guard-exempt:\s*host-layout\b([^\n]*)/g;

/**
 * A `guard-exempt: host-layout <reason>` line exempts its own line and the
 * line right after it (the common shape is a comment placed directly above
 * the code it excuses). A marker with no reason text is itself a finding --
 * silence is not a valid excuse.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {{exemptLines: Set<number>, findings: {fileName: string, line: number, rule: string, text: string}[]}}
 */
function exemptionState(source, fileName) {
  const exemptLines = new Set();
  const findings = [];
  let match;
  const regex = new RegExp(EXEMPT_MARKER.source, "g");
  while ((match = regex.exec(source))) {
    const line = lineAt(source, match.index);
    const reason = match[1].replace(/\*\/\s*$/u, "").trim();
    if (reason.length === 0) {
      findings.push({ fileName, line, rule: "guard-exempt-missing-reason", text: lineText(source, match.index) });
      continue;
    }
    exemptLines.add(line);
    exemptLines.add(line + 1);
  }
  return { exemptLines, findings };
}

const PATH_ASSIGNMENT = /process\.env\.PATH\s*\+?=/g;
const SYSTEM_DIR_SEGMENT = /(?:^|[^\w.])(\/usr\/local\/bin|\/usr\/bin|\/bin|\/opt)(?:[^\w]|$)/u;

/**
 * @param {string} source
 * @param {boolean[]} mask
 * @param {string} fileName
 * @returns {{fileName: string, line: number, rule: string, text: string}[]}
 */
function findPathAssignments(source, mask, fileName) {
  const findings = [];
  const regex = new RegExp(PATH_ASSIGNMENT.source, "g");
  let match;
  while ((match = regex.exec(source))) {
    if (!mask[match.index]) continue;
    const semicolon = source.indexOf(";", match.index);
    const newline = source.indexOf("\n", match.index);
    const candidates = [semicolon, newline].filter((value) => value !== -1);
    const statementEnd = candidates.length ? Math.min(...candidates) : source.length;
    const statement = source.slice(match.index, statementEnd);
    if (SYSTEM_DIR_SEGMENT.test(statement)) {
      findings.push({ fileName, line: lineAt(source, match.index), rule: "path-from-system-directory", text: lineText(source, match.index) });
    }
  }
  return findings;
}

const VERSION_MANAGER_REFERENCE = /\b(?:asdf|nvm)\b|\.tool-versions/g;

/**
 * A version-manager name is host-specific wherever it appears -- in a
 * hard-coded shell command, a documented reason, or a bare identifier -- so
 * this is a plain grep over the raw source. The only way to keep one is the
 * shared `guard-exempt: host-layout <reason>` marker, applied uniformly by
 * {@link hostLayoutFindings}.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {{fileName: string, line: number, rule: string, text: string}[]}
 */
function findVersionManagerReferences(source, fileName) {
  const findings = [];
  const regex = new RegExp(VERSION_MANAGER_REFERENCE.source, "g");
  let match;
  while ((match = regex.exec(source))) {
    findings.push({ fileName, line: lineAt(source, match.index), rule: "version-manager-reference", text: lineText(source, match.index) });
  }
  return findings;
}

/**
 * @param {string} source
 * @param {boolean[]} mask
 * @param {string} fileName
 * @returns {{fileName: string, line: number, rule: string, text: string}[]}
 */
function findPlatformInAssertions(source, mask, fileName) {
  const findings = [];
  const platformReference = /process\.platform/g;
  let match;
  while ((match = platformReference.exec(source))) {
    if (!mask[match.index]) continue;
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const nextNewline = source.indexOf("\n", match.index);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    const assertOnLine = /\bassert\b/u.exec(source.slice(lineStart, lineEnd));
    if (!assertOnLine || !mask[lineStart + assertOnLine.index]) continue;
    findings.push({ fileName, line: lineAt(source, match.index), rule: "platform-in-assertion", text: lineText(source, match.index) });
  }
  return findings;
}

const FIXTURE_SHEBANG = "#!/usr/bin/env node";

/**
 * Checked on raw text, never the structural mask: a shebang lives inside a
 * string literal by construction, so masking it out would hide every one.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {{fileName: string, line: number, rule: string, text: string}[]}
 */
function findFixtureShebangs(source, fileName) {
  const findings = [];
  let index = source.indexOf(FIXTURE_SHEBANG);
  while (index !== -1) {
    findings.push({ fileName, line: lineAt(source, index), rule: "fixture-shebang", text: lineText(source, index) });
    index = source.indexOf(FIXTURE_SHEBANG, index + FIXTURE_SHEBANG.length);
  }
  return findings;
}

/**
 * @param {string} source
 * @param {string} fileName
 * @returns {{fileName: string, line: number, rule: string, text: string}[]}
 */
export function hostLayoutFindings(source, fileName) {
  const mask = structuralMask(source);
  const { exemptLines, findings: markerFindings } = exemptionState(source, fileName);
  const candidates = [
    ...findPathAssignments(source, mask, fileName),
    ...findVersionManagerReferences(source, fileName),
    ...findPlatformInAssertions(source, mask, fileName),
    ...findFixtureShebangs(source, fileName),
  ].filter((finding) => !exemptLines.has(finding.line));
  return [...markerFindings, ...candidates].sort((left, right) => left.line - right.line);
}
