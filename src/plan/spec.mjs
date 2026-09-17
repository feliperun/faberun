/**
 * The spec format (skills/faberun/references/spec-format.md): parsing and
 * deterministic validation of the document a spec author hands the planner.
 * Separate from `contract/` because a spec is pre-planning input, never an
 * authored contract, and from `engine/` because nothing here dispatches,
 * schedules, or reaches a provider — this module invokes no model.
 */
import { git } from "../repo/worktree.mjs";

/** @typedef {"command"|"path"|"judgment"} ProofKind */
/** @typedef {{kind: ProofKind, ref?: string}} SpecProof */
/** @typedef {{id: string|null, title: string, statement: string|null, proof: SpecProof|null, constraints: string|null, line: number}} SpecRequirement */
/** @typedef {Record<string, string>} SpecFrontMatter */
/** @typedef {{heading: string, body: string, line: number}} SpecSection */
/** @typedef {{frontMatter: SpecFrontMatter|null, sections: Map<string, SpecSection>, requirements: SpecRequirement[]}} ParsedSpec */
/** @typedef {{rule: string, severity: "advisory"|"blocking", message: string, line: number}} SpecFinding */
/** @typedef {{class: "structured"|"legacy", ok: boolean, findings: SpecFinding[]}} SpecValidation */

/**
 * Section headings the format recognizes, in the language the reference
 * proposal actually writes them (skills/faberun/references/spec-format.md):
 * the section's role is what a rule checks, never the language of the
 * heading text.
 */
const SECTION_ALIASES = new Map([
  ["intenção", "intent"],
  ["intencao", "intent"],
  ["requisitos", "requirements"],
  ["não-objetivos", "non-goals"],
  ["nao-objetivos", "non-goals"],
  ["restrições", "constraints"],
  ["restricoes", "constraints"],
  ["critério de sucesso", "success criteria"],
  ["criterio de sucesso", "success criteria"],
  ["riscos", "risks"],
]);

/** @param {string} raw @returns {string} */
function normalizeHeading(raw) {
  const key = raw.trim().toLowerCase();
  return SECTION_ALIASES.get(key) ?? key;
}

/**
 * @param {string[]} lines
 * @returns {{data: SpecFrontMatter, end: number}|null}
 */
function extractFrontMatter(lines) {
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return null;
  /** @type {SpecFrontMatter} */
  const data = {};
  for (let i = 1; i < end; i += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(lines[i]);
    if (!match) continue;
    data[match[1]] = unquote(match[2].trim());
  }
  return { data, end };
}

/** @param {string} value @returns {string} */
function unquote(value) {
  return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

/**
 * Every level-2 (`## `) section from `startIndex` to the end of the document.
 * A level-3 (`### `) heading, which a requirement block owns, is left inside
 * its parent section's body.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {Map<string, SpecSection>}
 */
function extractSections(lines, startIndex) {
  /** @type {Map<string, SpecSection>} */
  const sections = new Map();
  let i = startIndex;
  while (i < lines.length) {
    const match = /^##\s+(.+?)\s*$/u.exec(lines[i]);
    if (!match) { i += 1; continue; }
    const heading = match[1];
    const bodyStart = i + 1;
    let end = bodyStart;
    while (end < lines.length && !/^##\s+/u.test(lines[end])) end += 1;
    sections.set(normalizeHeading(heading), { heading, body: lines.slice(bodyStart, end).join("\n"), line: bodyStart + 1 });
    i = end;
  }
  return sections;
}

/**
 * A `- **key:** value` bullet, and any following non-blank, non-bullet line as
 * its wrapped continuation.
 *
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
function parseBullets(lines) {
  /** @type {Map<string, string>} */
  const bullets = new Map();
  let currentKey = null;
  for (const line of lines) {
    const match = /^-\s+\*\*([a-zA-Z-]+):\*\*\s?(.*)$/u.exec(line);
    if (match) {
      currentKey = match[1].toLowerCase();
      bullets.set(currentKey, match[2].trim());
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { currentKey = null; continue; }
    if (currentKey && !trimmed.startsWith("-")) bullets.set(currentKey, `${bullets.get(currentKey)} ${trimmed}`.trim());
  }
  return bullets;
}

/**
 * `command: <shell command>`, `path: <repo-relative path>`, or
 * `judgment: true`, optionally wrapped in one pair of backticks (the shape
 * the reference proposal writes).
 *
 * @param {string|undefined} raw
 * @returns {SpecProof|null}
 */
function parseProof(raw) {
  if (!raw) return null;
  const unwrapped = /^`(.*)`$/u.exec(raw.trim());
  const value = unwrapped ? unwrapped[1] : raw.trim();
  const match = /^(command|path|judgment):\s*(.*)$/u.exec(value);
  if (!match) return null;
  const kind = /** @type {ProofKind} */ (match[1]);
  return kind === "judgment" ? { kind } : { kind, ref: match[2].trim() };
}

/**
 * @param {SpecSection|undefined} section
 * @returns {SpecRequirement[]}
 */
function extractRequirements(section) {
  if (!section) return [];
  const lines = section.body.split("\n");
  /** @type {SpecRequirement[]} */
  const requirements = [];
  let i = 0;
  while (i < lines.length) {
    const match = /^###\s+(.+?)\s*$/u.exec(lines[i]);
    if (!match) { i += 1; continue; }
    const heading = match[1];
    const blockLine = section.line + i + 1;
    let end = i + 1;
    while (end < lines.length && !/^###\s+/u.test(lines[end])) end += 1;
    const bullets = parseBullets(lines.slice(i + 1, end));
    const idMatch = /^(R\d+)\.\s*(.*)$/u.exec(heading);
    requirements.push({
      id: idMatch ? idMatch[1] : null,
      title: idMatch ? idMatch[2].trim() : heading,
      statement: bullets.get("statement") ?? null,
      proof: parseProof(bullets.get("proof")),
      constraints: bullets.get("constraints") ?? null,
      line: blockLine,
    });
    i = end;
  }
  return requirements;
}

/**
 * Parse a spec document into its front matter, sections and requirements.
 * Pure text processing: no file I/O, no git, no model.
 *
 * @param {string} text
 * @returns {ParsedSpec}
 */
export function parseSpec(text) {
  const lines = text.split("\n");
  const frontMatter = extractFrontMatter(lines);
  const sections = extractSections(lines, frontMatter ? frontMatter.end + 1 : 0);
  const requirements = extractRequirements(sections.get("requirements"));
  return { frontMatter: frontMatter?.data ?? null, sections, requirements };
}

/**
 * @param {string} body
 * @returns {string[]}
 */
function tableRows(body) {
  return body.split("\n").filter((line) => line.trim().startsWith("|"));
}

/** @param {string} row @returns {string[]} */
function splitRow(row) {
  return row.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

/**
 * A Success criteria table with no Baseline column at all, or a data row
 * whose Baseline cell is empty or a bare dash.
 *
 * @param {SpecSection} section
 * @returns {SpecFinding[]}
 */
function baselineColumnFindings(section) {
  const rows = tableRows(section.body);
  if (rows.length < 2) return [];
  const header = splitRow(rows[0]);
  const baselineIndex = header.findIndex((cell) => /baseline/iu.test(cell));
  if (baselineIndex === -1) {
    return [{ rule: "success-criteria-missing-baseline", severity: "advisory", message: "Success criteria table has no Baseline column", line: section.line }];
  }
  /** @type {SpecFinding[]} */
  const findings = [];
  for (let i = 2; i < rows.length; i += 1) {
    const value = splitRow(rows[i])[baselineIndex]?.trim();
    if (!value || value === "-" || value === "—") {
      findings.push({ rule: "success-criteria-missing-baseline", severity: "advisory", message: `Success criteria row ${i - 1} has no Baseline value`, line: section.line + i });
    }
  }
  return findings;
}

/**
 * `git@host:owner/repo.git` and `https://host/owner/repo.git` both reduce to
 * the same lowercase `owner/repo` suffix for comparison.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeRemoteUrl(url) {
  return url.trim().replace(/\.git$/u, "").replace(/^git@([^:]+):/u, "https://$1/").toLowerCase();
}

/**
 * Whether `ref` names a commit that actually exists in `cwd`. `git rev-parse
 * <ref>` alone is not enough: given a 40-hex string it echoes the string back
 * unverified even when no such object exists, so this peels it as `^{commit}`
 * instead, which fails for an absent or non-commit object.
 *
 * @param {string} cwd
 * @param {string} ref
 * @returns {boolean}
 */
function resolvesToCommit(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `target` (an `owner/repo` slug) names the repository this `cwd`'s
 * `origin` remote points at. Checked against the remote name only, never a
 * network call.
 *
 * @param {string} cwd
 * @param {string} target
 * @returns {boolean}
 */
function targetMatchesOrigin(cwd, target) {
  let url;
  try {
    url = git(cwd, ["remote", "get-url", "origin"]);
  } catch {
    return false;
  }
  return normalizeRemoteUrl(url).endsWith(`/${target.toLowerCase()}`);
}

/**
 * Validate a spec's traceability rules: no model call, ever
 * (skills/faberun/references/spec-format.md). A document without front matter
 * is classified `legacy` and accepted outright, exempt from every rule below.
 *
 * Advisory by default — every violation is recorded and `ok` stays `true` —
 * and blocking under `strict`, where any violation makes `ok` `false`.
 *
 * @param {string} text
 * @param {{cwd?: string, strict?: boolean}} [options]
 * @returns {SpecValidation}
 */
export function validateSpec(text, options = {}) {
  const parsed = parseSpec(text);
  if (!parsed.frontMatter) {
    return {
      class: "legacy",
      ok: true,
      findings: [{ rule: "legacy-document", severity: "advisory", message: "no front matter: accepted as a legacy-class document, not scored against the structured rules", line: 1 }],
    };
  }
  const cwd = options.cwd ?? process.cwd();
  const strict = options.strict === true;
  /** @type {SpecFinding[]} */
  const findings = [];
  if (!parsed.sections.has("non-goals")) {
    findings.push({ rule: "missing-non-goals", severity: "advisory", message: "spec has no Non-goals section", line: 1 });
  }
  for (const requirement of parsed.requirements) {
    if (!requirement.id) {
      findings.push({ rule: "requirement-missing-id", severity: "advisory", message: `requirement "${requirement.title}" has no stable R<n> id`, line: requirement.line });
    }
    if (!requirement.proof) {
      findings.push({ rule: "requirement-missing-proof", severity: "advisory", message: `requirement ${requirement.id ?? requirement.title} has no proof`, line: requirement.line });
    }
  }
  const successCriteria = parsed.sections.get("success criteria");
  if (successCriteria) findings.push(...baselineColumnFindings(successCriteria));
  if (typeof parsed.frontMatter.baseline === "string" && !resolvesToCommit(cwd, parsed.frontMatter.baseline)) {
    findings.push({ rule: "baseline-unresolved", severity: "advisory", message: `baseline "${parsed.frontMatter.baseline}" does not resolve to a commit`, line: 1 });
  }
  if (typeof parsed.frontMatter.target === "string" && !targetMatchesOrigin(cwd, parsed.frontMatter.target)) {
    findings.push({ rule: "target-unresolved", severity: "advisory", message: `target "${parsed.frontMatter.target}" does not match the origin remote`, line: 1 });
  }
  const graded = findings.map((finding) => (strict ? { ...finding, severity: /** @type {const} */ ("blocking") } : finding));
  return { class: "structured", ok: !graded.some((finding) => finding.severity === "blocking"), findings: graded };
}
