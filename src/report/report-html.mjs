/**
 * The run report's HTML boundary: the same contract `campaign-brief-html.mjs`
 * owns for the campaign brief — Markdown is the durable source, the portable
 * `.md.html` is a copy that only survives a build, check and round-trip — but
 * for `report`, the surface the operator reads a run's attempts, tokens and
 * cost from. It renders the ASCII table as a Markdown table and, when the
 * phase has a dependency topology, an inline SVG of the work graph instead of
 * a list, then hands the Markdown to that one renderer rather than opening a
 * second markdown→HTML path.
 *
 * It is a module apart from `render.mjs` because that file owns the terminal
 * and JSON surfaces and is already near the 800-line ceiling; the HTML copy is
 * a different audience (a browser, not a terminal) and a different lifetime
 * (a file beside the Markdown, not stdout).
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { renderReportJson } from "./render.mjs";
import { cell } from "./campaign-brief.mjs";
import { CampaignBriefRenderError, renderCampaignBriefHtml } from "./campaign-brief-html.mjs";
import { formatCost, formatRole } from "./role-usage.mjs";
import { compactTokens } from "../util.mjs";
import { writeTextAtomic } from "../run/store.mjs";

/** The durable source and its portable copy, beside `STATUS.md` in the run directory. */
const REPORT_MD_FILE = "report.md";
const REPORT_HTML_FILE = "report.md.html";

/** @typedef {{id: string, status: string, dependsOn: string[]}} GraphNode */
/** @typedef {import("./role-usage.mjs").RoleUsage} RoleUsage */
/** @typedef {import("./role-usage.mjs").CostProjection} CostProjection */
/** @typedef {{id: string, status: string, attempt: number, revisions: number, runtime: string|null, usage: {inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}|null, costUsd: number|null, costStatus: CostProjection["status"], note: string|null}} ReportNode */
/** @typedef {{run: string, summary: string, totals: {inputTokens: number, outputTokens: number, cacheReadInputTokens: number, costUsd: number|null, costStatus: CostProjection["status"]}, roles: {worker: RoleUsage, judge: RoleUsage}, nodes: ReportNode[]}} ReportPayload */

/**
 * The work graph as inline SVG, or null when every node is
 * dependency-independent and a list reads better than a diagram. The layout is
 * the same depth/row scheme the dashboard uses (`src/web/app.mjs`): a node's
 * column is its dependency depth, its row is its position among the siblings
 * at that depth. Self-contained: inline colours, no stylesheet, no external
 * reference, so the rendered copy stays offline.
 *
 * @param {GraphNode[]} nodes
 * @returns {string|null}
 */
export function renderReportGraphSvg(nodes) {
  const hasEdges = nodes.some((node) => (node.dependsOn ?? []).length > 0);
  if (!hasEdges) return null;
  const laidOut = layoutGraphNodes(nodes);
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  const maxDepth = laidOut.reduce((max, node) => Math.max(max, node.depth), 0);
  const maxRow = laidOut.reduce((max, node) => Math.max(max, node.row), 0);
  const width = NODE_MARGIN * 2 + (maxDepth + 1) * NODE_COL_WIDTH;
  const height = NODE_MARGIN * 2 + (maxRow + 1) * NODE_ROW_HEIGHT;
  const posOf = (/** @type {{depth: number, row: number}} */ node) => ({ x: NODE_MARGIN + node.depth * NODE_COL_WIDTH, y: NODE_MARGIN + node.row * NODE_ROW_HEIGHT });
  const edges = laidOut.flatMap((node) => (node.dependsOn ?? [])
    .filter((/** @type {string} */ dep) => byId.has(dep))
    .map((/** @type {string} */ dep) => {
      const from = posOf(/** @type {{depth: number, row: number}} */ (byId.get(dep)));
      const to = posOf(node);
      const x1 = from.x + NODE_BOX_W;
      const y1 = from.y + NODE_BOX_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_BOX_H / 2;
      const midX = (x1 + x2) / 2;
      return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#D97B4F" stroke-width="2"/>`;
    })).join("");
  const boxes = laidOut.map((node, index) => {
    const { x, y } = posOf(node);
    const clipId = `nodeclip${index}`;
    const colour = STATUS_COLOURS[node.status] ?? "#1F1F1F";
    return `<g><rect x="${x}" y="${y}" width="${NODE_BOX_W}" height="${NODE_BOX_H}" rx="8" fill="#F4E9D8" stroke="${colour}" stroke-width="2"/><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${NODE_BOX_W}" height="${NODE_BOX_H}"/></clipPath><g clip-path="url(#${clipId})"><text x="${x + 10}" y="${y + 22}" font-family="ui-monospace, monospace" font-size="12" fill="#1F1F1F">${escapeSvgText(truncateOneLine(node.id, NODE_ID_MAX_CHARS))}</text><text x="${x + 10}" y="${y + 40}" font-family="ui-sans-serif, sans-serif" font-size="12" fill="${colour}">${escapeSvgText(node.status)}</text></g></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="work graph">${edges}${boxes}</svg>`;
}

/**
 * `report`'s Markdown: the same facts `report --json` carries, laid out for a
 * browser. The node table mirrors the ASCII table's columns (with `USD`, the
 * one term both surfaces now share) and the work graph renders as a diagram
 * when there are dependencies, else as a list.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function renderReportMarkdown(runDir) {
  const payload = /** @type {ReportPayload} */ (JSON.parse(renderReportJson(runDir)));
  const dependsOn = readContractDependsOn(runDir);
  const graph = renderReportGraphSvg(payload.nodes.map((node) => ({ id: node.id, status: node.status, dependsOn: dependsOn.get(node.id) ?? [] })));
  const totals = payload.totals;
  const summary = `${payload.summary} · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)} · cost ${formatCost({ costUsd: totals.costUsd, status: totals.costStatus })}`;

  const header = "| NODE | STATE | TRY | REV | RUNTIME | IN | OUT | CACHE | USD | NOTE |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = payload.nodes.map((node) => {
    const usage = node.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
    return `| \`${cell(node.id)}\` | ${cell(node.status)} | ${node.attempt} | ${node.revisions} | ${cell(node.runtime ?? "-")} | ${compactTokens(usage.inputTokens)} | ${compactTokens(usage.outputTokens)} | ${compactTokens(usage.cacheReadInputTokens)} | ${cell(formatCost({ costUsd: node.costUsd, status: node.costStatus }))} | ${cell(node.note ?? "-")} |`;
  });

  const graphSection = graph
    ? `## Work graph\n\n${graph}`
    : `## Work graph\n\nDependency-independent nodes: ${payload.nodes.map((node) => `\`${node.id}\``).join(", ")}.`;

  const totalsLine = `totals · in ${compactTokens(totals.inputTokens)} · out ${compactTokens(totals.outputTokens)} · cache ${compactTokens(totals.cacheReadInputTokens)} · worker ${formatRole(payload.roles.worker)} · judge ${formatRole(payload.roles.judge)} · cost ${formatCost({ costUsd: totals.costUsd, status: totals.costStatus })}`;

  return [
    `# Report — ${payload.run}`,
    "",
    summary,
    "",
    graphSection,
    "",
    "## Nodes",
    "",
    header,
    separator,
    ...rows,
    "",
    "## Totals",
    "",
    totalsLine,
    "",
  ].join("\n");
}

/**
 * Write `report.md` (the durable source) and render its portable copy, exactly
 * as the campaign brief does: the Markdown is always written first, the HTML
 * only survives a successful build, check and round-trip, and a renderer
 * failure removes any prior HTML and reports the renderer's named code. The
 * text path — `renderReport` — is untouched and works without mdhtml.
 *
 * @param {string} runDir
 * @param {{mdhtmlBin?: string, cwd?: string, renderHtml?: (markdown: string, options: import("./campaign-brief-html.mjs").RenderCampaignBriefHtmlOptions) => import("./campaign-brief-html.mjs").RenderCampaignBriefHtmlResult}} [options]
 * @returns {{markdownPath: string, htmlPath: string|null, code: string|null}}
 */
export function generateReportHtml(runDir, options = {}) {
  const markdown = renderReportMarkdown(runDir);
  const markdownPath = join(runDir, REPORT_MD_FILE);
  const htmlPath = join(runDir, REPORT_HTML_FILE);
  writeTextAtomic(markdownPath, markdown);
  const renderHtml = options.renderHtml ?? renderCampaignBriefHtml;
  try {
    renderHtml(markdown, { outputPath: htmlPath, title: `Report — ${basename(runDir)}`, mdhtmlBin: options.mdhtmlBin, cwd: options.cwd });
  } catch (error) {
    rmSync(htmlPath, { force: true });
    const code = error instanceof CampaignBriefRenderError ? error.code : "REPORT_HTML_FAILED";
    return { markdownPath, htmlPath: null, code };
  }
  return { markdownPath, htmlPath, code: null };
}

/**
 * The contract's per-node `dependsOn`, read tolerantly: `renderReportJson` has
 * already validated the contract, so this fallback only guards a race where
 * the file changes between the two reads.
 *
 * @param {string} runDir
 * @returns {Map<string, string[]>}
 */
export function readContractDependsOn(runDir) {
  try {
    const contract = /** @type {{nodes?: {id?: unknown, dependsOn?: unknown}[]}} */ (JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")));
    return new Map((contract.nodes ?? []).map((node) => [
      String(node.id),
      Array.isArray(node.dependsOn) ? node.dependsOn.filter((dep) => typeof dep === "string") : [],
    ]));
  } catch {
    return new Map();
  }
}

const NODE_COL_WIDTH = 260;
const NODE_ROW_HEIGHT = 84;
const NODE_BOX_W = 220;
const NODE_BOX_H = 56;
const NODE_MARGIN = 16;
const NODE_ID_MAX_CHARS = 28;

/** One fill per terminal state, the same earthy palette the brief theme declares. */
/** @type {Record<string, string | undefined>} */
export const STATUS_COLOURS = {
  done: "#556B3F",
  "no-op": "#556B3F",
  running: "#D97B4F",
  pending: "#1F1F1F",
  blocked: "#B5522A",
  failed: "#B5522A",
  exhausted: "#B5522A",
  stalled: "#B5522A",
  canceled: "#B5522A",
};

/**
 * A node's column is its dependency depth; its row is its position among the
 * siblings at that depth (the dashboard's own scheme). Exported so the video
 * scene (`report-video.mjs`) reuses this one layout instead of carrying a
 * copy.
 *
 * @param {GraphNode[]} nodes
 * @returns {(GraphNode & {depth: number, row: number})[]}
 */
export function layoutGraphNodes(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthCache = new Map();
  /** @param {string} id @param {Set<string>} seen @returns {number} */
  const depthOf = (id, seen) => {
    if (depthCache.has(id)) return /** @type {number} */ (depthCache.get(id));
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    const deps = (node?.dependsOn ?? []).filter((dep) => byId.has(dep));
    const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)));
    depthCache.set(id, depth);
    return depth;
  };
  const rowCounters = new Map();
  return nodes.map((node) => {
    const depth = depthOf(node.id, new Set());
    const row = rowCounters.get(depth) ?? 0;
    rowCounters.set(depth, row + 1);
    return { ...node, depth, row };
  });
}

/** @param {string} value @returns {string} */
export function escapeSvgText(value) {
  return value.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** @param {string} value @param {number} max @returns {string} */
function truncateOneLine(value, max) {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}
