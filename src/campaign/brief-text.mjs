/**
 * Campaign Brief text parsing and list normalization. Separate from the model
 * builder because these small Markdown readers are a distinct boundary from
 * the frozen-plan facts they shape into the brief.
 */

/** @typedef {{measure: string, target: string, evidence: string}} BriefSuccessCriterion */
/** @typedef {{risk: string, impact: string, mitigation: string}} BriefRisk */

/**
 * @param {string} body
 * @returns {string[]}
 */
export function bulletLines(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

/**
 * @param {string} body
 * @returns {BriefSuccessCriterion[]}
 */
export function successCriteriaRows(body) {
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return [];
  const header = tableCells(rows[0]).map((cell) => cell.toLowerCase());
  const measureIndex = header.findIndex((cell) => cell.includes("measure"));
  const targetIndex = header.findIndex((cell) => cell.includes("target"));
  const evidenceIndex = header.findIndex((cell) => cell.includes("evidence"));
  return rows.slice(2).map((row) => {
    const cells = tableCells(row);
    return {
      measure: measureIndex >= 0 ? cells[measureIndex] ?? "" : "",
      target: targetIndex >= 0 ? cells[targetIndex] ?? "" : "",
      evidence: evidenceIndex >= 0 ? cells[evidenceIndex] ?? "" : "",
    };
  }).filter((criterion) => criterion.measure.length > 0 || criterion.target.length > 0);
}

/**
 * @param {string} body
 * @returns {BriefRisk[]}
 */
export function riskRows(body) {
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return [];
  const header = tableCells(rows[0]).map((cell) => cell.toLowerCase());
  const riskIndex = header.findIndex((cell) => cell.includes("risk"));
  const impactIndex = header.findIndex((cell) => cell.includes("impact"));
  const mitigationIndex = header.findIndex((cell) => cell.includes("mitigation"));
  return rows.slice(2).map((row) => {
    const cells = tableCells(row);
    return {
      risk: riskIndex >= 0 ? cells[riskIndex] ?? "" : "",
      impact: impactIndex >= 0 ? cells[impactIndex] ?? "" : "",
      mitigation: mitigationIndex >= 0 ? cells[mitigationIndex] ?? "" : "",
    };
  }).filter((risk) => risk.risk.length > 0);
}

/** @param {string} row @returns {string[]} */
function tableCells(row) {
  const trimmed = row.trim();
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith("|") ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutTrailing.split("|").map((value) => value.trim());
}

/** @param {string} text @returns {string|null} */
export function firstSentence(text) {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  const match = /^(.*?[.!?])(?:\s|$)/u.exec(collapsed);
  return (match ? match[1] : collapsed).trim();
}

/** @param {unknown} value @returns {any[]} */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @template T @param {T[]} values @returns {T[]} */
export function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
