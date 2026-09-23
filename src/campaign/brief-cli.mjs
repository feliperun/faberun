/**
 * `faberun campaign brief generate`: the R7 sharing surface. The campaign CLI
 * parses argv and dispatches here; every artifact path, the artifact write
 * order, the stale-HTML cleanup and the renderer failure report live in this
 * module.
 *
 * Generation is deliberately the operator's explicit act. `generate` verifies
 * the pinned plan, contract and spec through `buildBriefModel`, writes the
 * Markdown source beside `plan.json`, then asks the optional external renderer
 * for the portable sibling copy. A successful render and check replaces the
 * HTML atomically; an absent or failing renderer leaves the Markdown usable,
 * removes any prior HTML for that phase, and exits with the renderer's named
 * error. Nothing here writes the spec, the plan, the contract, the
 * `operator-brief.md` continuity capsule or an external service.
 *
 * The usage cutoff is read from recorded evidence -- the newest completed
 * execution node in this project's pool -- not the wall clock, so regenerating
 * from the same snapshots produces the same bytes.
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildBriefModel } from "./campaign-brief.mjs";
import { resolveCampaign } from "./index.mjs";
import { readProjectionState } from "./projection.mjs";
import { renderCampaignBriefMarkdown } from "../report/campaign-brief.mjs";
import { CampaignBriefRenderError, renderCampaignBriefHtml } from "../report/campaign-brief-html.mjs";
import { estimateBriefExpense } from "../report/campaign-brief-estimate.mjs";
import { collectCompletedExecutionNodes } from "../run/usage.mjs";
import { runsRoot } from "../run/paths.mjs";
import { writeTextAtomic } from "../run/store.mjs";

const MARKDOWN_FILE = "campaign-brief.md";
const HTML_FILE = "campaign-brief.md.html";
// A cutoff far enough ahead that the wide pool carries every recorded node;
// the pool that feeds the estimate is then filtered to the real 90-day window
// around the newest recorded completion, not this sentinel.
const WIDE_WINDOW_DAYS = 36_500;
const WIDE_CUTOFF = "9999-12-31T23:59:59.999Z";

/** @typedef {import("./campaign-brief.mjs").BriefModel} BriefModel */
/** @typedef {import("../report/campaign-brief-html.mjs").RenderCampaignBriefHtmlOptions} RenderCampaignBriefHtmlOptions */
/** @typedef {import("../report/campaign-brief-html.mjs").RenderCampaignBriefHtmlResult} RenderCampaignBriefHtmlResult */
/** @typedef {import("../run/usage.mjs").CompletedExecutionPool} CompletedExecutionPool */

/**
 * @typedef {object} BriefGenerateOptions
 * @property {string} campaignId
 * @property {unknown} phase
 * @property {string} [cwd]
 * @property {string} [runsDir] resolved runs root; defaults to `runsRoot(cwd)`.
 * @property {string} [mdhtmlBin]
 * @property {(markdown: string, options: RenderCampaignBriefHtmlOptions) => RenderCampaignBriefHtmlResult} [renderHtml] injectable renderer for tests.
 * @property {(line: string) => void} [stdout]
 * @property {(line: string) => void} [stderr]
 */

/**
 * @typedef {object} BriefGenerateResult
 * @property {BriefModel} model
 * @property {string} markdownPath absolute
 * @property {string|null} htmlPath absolute when the render succeeded, else null
 * @property {string|null} code the renderer's named error, or null on success
 */

/**
 * Generate the Campaign Brief for one frozen phase plan. The Markdown is
 * always written before the renderer is asked, and the HTML only survives a
 * successful build, check, audit and source round-trip. A renderer failure is
 * reported on stderr with its stable code, the Markdown path is printed, and
 * any prior HTML for the phase is removed.
 *
 * @param {BriefGenerateOptions} options
 * @returns {BriefGenerateResult}
 */
export function generateCampaignBrief(options) {
  const campaignId = options.campaignId;
  const cwd = resolve(options.cwd ?? ".");
  const runsDir = options.runsDir ?? runsRoot(cwd);
  const { path: campaignPath, campaign } = resolveCampaign(runsDir, campaignId);
  const phase = requirePhase(options.phase);
  const planDir = join(campaignPath, "plans", phase);
  const markdownPath = join(planDir, MARKDOWN_FILE);
  const htmlPath = join(planDir, HTML_FILE);
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));

  const { state, cursor: journalCursor } = readProjectionState(campaignPath, campaign);
  const pool = collectCompletedExecutionNodes({ runsRoot: runsDir, cutoff: WIDE_CUTOFF, windowDays: WIDE_WINDOW_DAYS });
  const usageSampleCutoff = newestCompletedAt(pool);
  const contract = readContractTolerant(join(planDir, "contract.json"));
  const estimate = contract === null ? undefined : estimateBriefExpense({ contract, cutoff: usageSampleCutoff, pool });
  const model = buildBriefModel({
    campaignId,
    planPath: join(planDir, "plan.json"),
    cwd,
    projection: state,
    journalCursor,
    usageSampleCutoff,
    estimate,
  });

  const markdown = renderCampaignBriefMarkdown(model);
  writeTextAtomic(markdownPath, markdown);

  const renderHtml = options.renderHtml ?? renderCampaignBriefHtml;
  try {
    renderHtml(markdown, { outputPath: htmlPath, title: `Campaign brief — ${campaignId}`, mdhtmlBin: options.mdhtmlBin, cwd });
  } catch (error) {
    const code = error instanceof CampaignBriefRenderError ? error.code : "CAMPAIGN_BRIEF_RENDER_FAILED";
    rmSync(htmlPath, { force: true });
    stderr(`[fail] ${code} · ${error instanceof Error ? error.message : String(error)}`);
    stdout(`[brief] markdown · ${markdownPath}`);
    process.exitCode = 1;
    return { model, markdownPath, htmlPath: null, code };
  }
  stdout(`[brief] markdown · ${markdownPath}`);
  stdout(`[brief] html · ${htmlPath}`);
  return { model, markdownPath, htmlPath, code: null };
}

/**
 * `--phase` names one directory under `<campaignDir>/plans/`; anything with a
 * path separator or a dot segment would escape it.
 *
 * @param {unknown} value
 * @returns {string}
 */
function requirePhase(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("campaign brief generate requires --phase <phase>");
  }
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new TypeError("--phase must be a single path segment");
  }
  return value;
}

/**
 * The newest completion in the wide pool, as the recorded usage cutoff. A pool
 * with no readable completion has no cutoff, which the estimate reports as
 * `insufficient data` rather than inventing one.
 *
 * @param {CompletedExecutionPool} pool
 * @returns {string|null}
 */
function newestCompletedAt(pool) {
  let newest = null;
  for (const node of pool.nodes) {
    if (typeof node.completedAt !== "string") continue;
    const completedMs = Date.parse(node.completedAt);
    if (!Number.isFinite(completedMs)) continue;
    if (newest === null || completedMs > newest) newest = completedMs;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

/**
 * Read the sibling contract the plan froze, tolerating anything unreadable:
 * `buildBriefModel` owns the refusal and names the exact missing or mismatched
 * input, so a malformed contract here simply supplies no estimate and lets the
 * model raise its typed error.
 *
 * @param {string} path
 * @returns {Record<string, any>|null}
 */
function readContractTolerant(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
