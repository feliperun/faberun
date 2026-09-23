/**
 * Campaign Brief HTML owns the optional mdhtml boundary. Markdown remains the
 * durable source; this module either replaces the portable copy atomically or
 * removes it and reports a stable rendering failure.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderCampaignBriefMarkdown } from "./campaign-brief.mjs";

/** @typedef {import("../campaign/campaign-brief.mjs").BriefModel} BriefModel */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const MANIFEST_PATH = join(HERE, "mdhtml-release.json");
const THEME_FILE = "faberun-brief.theme.css";

/** @typedef {{file: string, sha256: string}} MdhtmlAsset */
/**
 * @typedef {object} MdhtmlRelease
 * @property {string} schema
 * @property {string} repo
 * @property {string} tag
 * @property {string} version
 * @property {number} major
 * @property {string} minimumVersion
 * @property {Record<string, MdhtmlAsset>} assets
 */
/** @typedef {{major: number, minor: number, patch: number, raw: string}} MdhtmlVersion */
/**
 * @typedef {object} RenderCampaignBriefHtmlOptions
 * @property {string} outputPath absolute destination ending in `.md.html`.
 * @property {string} [title]
 * @property {string} [mdhtmlBin]
 * @property {string} [cwd]
 */
/**
 * @typedef {object} RenderCampaignBriefHtmlResult
 * @property {string} html
 * @property {string} outputPath
 * @property {string} version
 */

/** A stable error surface for callers and CLI reporting. */
export class CampaignBriefRenderError extends Error {
  /** @param {string} code @param {string} message @param {{cause?: unknown}} [options] */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CampaignBriefRenderError";
    this.code = code;
  }
}

/** @returns {MdhtmlRelease} */
function releaseManifest() {
  const parsed = /** @type {MdhtmlRelease} */ (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  if (
    parsed.schema !== "faberun/mdhtml-release/1" ||
    parsed.repo !== "feliperun/md.html" ||
    parsed.tag !== `v${parsed.version}` ||
    parsed.version !== "1.1.3" ||
    parsed.major !== 1 ||
    parsed.minimumVersion !== "1.1.3" ||
    !parsed.assets ||
    Object.values(parsed.assets).some((asset) => !/^[0-9a-f]{64}$/u.test(asset.sha256))
  ) {
    throw new CampaignBriefRenderError("MDHTML_MANIFEST_INVALID", `invalid mdhtml release manifest at ${MANIFEST_PATH}`);
  }
  return parsed;
}

/** @param {string} output @returns {MdhtmlVersion | null} */
function parseVersion(output) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

/** @param {MdhtmlVersion | null} version @param {MdhtmlRelease} release */
function isCompatible(version, release) {
  const minimum = parseVersion(release.minimumVersion);
  if (!version || !minimum || version.major !== release.major || version.major !== minimum.major) return false;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

/** @returns {string} */
function assetKey() {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)) return `darwin-${process.arch}`;
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && process.arch === "x64") {
    return existsSync("/etc/alpine-release") ? "linux-x64-musl" : "linux-x64-gnu";
  }
  return "";
}

/** @returns {string} */
function binaryName() {
  return process.platform === "win32" ? "mdhtml.exe" : "mdhtml";
}

/** @returns {string} */
function cacheRoot() {
  return process.env.FABERUN_MDHTML_CACHE ?? join(homedir(), ".cache", "faberun", "mdhtml");
}

/** @returns {string} */
function provisionedBinary() {
  return join(cacheRoot(), releaseManifest().version, binaryName());
}

/** Download and install exactly the release described by the committed manifest. */
async function provisionMdhtml() {
  const release = releaseManifest();
  const key = assetKey();
  const asset = release.assets[key];
  if (!asset) {
    throw new CampaignBriefRenderError(
      "MDHTML_PROVISION_FAILED",
      `no ${release.repo} ${release.tag} asset for ${process.platform}/${process.arch}`,
    );
  }
  const versionDir = join(cacheRoot(), release.version);
  const binary = join(versionDir, binaryName());
  const stamp = join(versionDir, ".verified-sha256");
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === asset.sha256) return binary;

  const url = `https://github.com/${release.repo}/releases/download/${release.tag}/${asset.file}`;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new CampaignBriefRenderError(
      "MDHTML_PROVISION_FAILED",
      `could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new CampaignBriefRenderError(
      "MDHTML_PROVISION_FAILED",
      `checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`,
    );
  }

  mkdirSync(versionDir, { recursive: true });
  const archive = join(versionDir, asset.file);
  writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", versionDir], { encoding: "utf8" });
  rmSync(archive, { force: true });
  if (extracted.error || extracted.status !== 0 || !existsSync(binary)) {
    rmSync(binary, { force: true });
    rmSync(stamp, { force: true });
    throw new CampaignBriefRenderError(
      "MDHTML_PROVISION_FAILED",
      `could not extract ${asset.file}: ${extracted.error?.message ?? firstLine(extracted.stderr)}`,
    );
  }
  chmodSync(binary, 0o755);
  writeFileSync(stamp, `${asset.sha256}\n`, "utf8");
  return binary;
}

/**
 * Render through an installed mdhtml 1.x release. The destination is removed
 * before any renderer probe so an absent binary cannot leave a stale copy.
 *
 * @param {string} markdown
 * @param {RenderCampaignBriefHtmlOptions} options
 * @returns {RenderCampaignBriefHtmlResult}
 */
export function renderCampaignBriefHtml(markdown, options) {
  const outputPath = options.outputPath;
  mkdirSync(dirname(outputPath), { recursive: true });
  rmSync(outputPath, { force: true });
  const stage = mkdtempSync(join(dirname(outputPath), ".campaign-brief-render-"));
  try {
    const source = prepareSource(markdown, options.title);
    const sourcePath = join(stage, "campaign-brief.md");
    const htmlPath = join(stage, "campaign-brief.md.html");
    writeFileSync(sourcePath, source, "utf8");
    writeFileSync(join(stage, THEME_FILE), themeCss(), "utf8");

    const bin = resolveBinary(options.mdhtmlBin);
    const version = compatibleVersion(bin, options.cwd);
    runMdhtml(bin, ["build", sourcePath, "-o", htmlPath], options.cwd, "MDHTML_BUILD_FAILED");
    const checked = runMdhtml(bin, ["check", htmlPath], options.cwd, "MDHTML_CHECK_FAILED");
    assertCheck(checked.stdout);
    runMdhtml(bin, ["audit", htmlPath], options.cwd, "MDHTML_AUDIT_FAILED");

    const html = readFileSync(htmlPath, "utf8");
    assertTheme(html);
    assertOffline(html);
    const extractedPath = join(stage, "extracted.md");
    runMdhtml(bin, ["extract", htmlPath, "-o", extractedPath], options.cwd, "MDHTML_SOURCE_MISMATCH");
    if (readFileSync(extractedPath, "utf8") !== source) {
      throw new CampaignBriefRenderError("MDHTML_SOURCE_MISMATCH", "the rendered copy does not carry the source brief");
    }

    renameSync(htmlPath, outputPath);
    return { html, outputPath, version: version.raw };
  } catch (error) {
    rmSync(outputPath, { force: true });
    if (error instanceof CampaignBriefRenderError) throw error;
    throw new CampaignBriefRenderError("MDHTML_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** @param {string | undefined} explicit */
function resolveBinary(explicit) {
  if (explicit) return explicit;
  if (process.env.FABERUN_MDHTML_BIN) return process.env.FABERUN_MDHTML_BIN;
  const provisioned = provisionedBinary();
  return existsSync(provisioned) ? provisioned : "mdhtml";
}

/** @param {string} bin @param {string | undefined} cwd @returns {MdhtmlVersion} */
function compatibleVersion(bin, cwd) {
  const result = run(bin, ["--version"], cwd);
  if (result.error) {
    throw new CampaignBriefRenderError(
      "MDHTML_UNAVAILABLE",
      `mdhtml is not available at ${bin}: ${result.error.message}`,
    );
  }
  const version = parseVersion(result.stdout);
  const release = releaseManifest();
  if (result.status !== 0 || !isCompatible(version, release)) {
    throw new CampaignBriefRenderError(
      "MDHTML_INCOMPATIBLE",
      `mdhtml version ${version?.raw ?? "unknown"} is outside major ${release.major} at or above ${release.minimumVersion}`,
    );
  }
  return /** @type {MdhtmlVersion} */ (version);
}

/** @param {string} bin @param {string[]} args @param {string | undefined} cwd @param {string} code */
function runMdhtml(bin, args, cwd, code) {
  const result = run(bin, args, cwd);
  if (result.error) {
    const errno = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    const failure = errno === "ENOENT" ? "MDHTML_UNAVAILABLE" : code;
    throw new CampaignBriefRenderError(failure, `mdhtml ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CampaignBriefRenderError(code, `mdhtml ${args[0]} exited with ${result.status}: ${firstLine(result.stderr)}`);
  }
  return result;
}

/** @param {string} command @param {string[]} args @param {string | undefined} cwd */
function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32" && /\.(cmd|bat)$/iu.test(command),
  });
}

/** @param {string} output */
function assertCheck(output) {
  const portable = /portable:\s*(true|false)/iu.exec(output);
  const requests = /requests:\s*(\d+)/iu.exec(output);
  const diagnostic = /\b(?:E|W)-[A-Z]+-\d+\b/u.exec(output);
  if (portable?.[1].toLowerCase() === "false" || (requests && Number(requests[1]) !== 0) || diagnostic) {
    throw new CampaignBriefRenderError("MDHTML_CHECK_FAILED", `mdhtml check rejected portability: ${firstLine(output)}`);
  }
}

/** @param {string} html */
function assertTheme(html) {
  const lower = html.toLowerCase();
  for (const marker of ["#f4e9d8", "#1f1f1f", "#b5522a", "#93aa70", "ui-sans-serif", "ui-monospace"]) {
    if (!lower.includes(marker)) {
      throw new CampaignBriefRenderError("MDHTML_THEME_MISMATCH", `the rendered copy is missing ${marker}`);
    }
  }
}

/** @param {string} html */
function assertOffline(html) {
  const externalSubresource = /<(?:script|img|iframe|link)\b[^>]*(?:src|href)=["']https?:\/\//iu;
  const externalCss = /url\(\s*["']?https?:\/\//iu;
  if (externalSubresource.test(html) || externalCss.test(html)) {
    throw new CampaignBriefRenderError("MDHTML_OFFLINE_VIOLATION", "the rendered copy references a network resource");
  }
}

/** @param {string} markdown @param {string | undefined} title */
function prepareSource(markdown, title) {
  const body = stripFrontMatter(markdown);
  const resolvedTitle = title ?? /^#\s+(.+)$/mu.exec(body)?.[1].trim() ?? "Campaign brief";
  return [
    "---",
    `title: ${JSON.stringify(resolvedTitle)}`,
    `theme: ${THEME_FILE}`,
    "fonts: system",
    "toc: { depth: 2, position: side }",
    "---",
    "",
    body,
  ].join("\n");
}

/** @param {string} markdown */
function stripFrontMatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

/** @returns {string} */
function themeCss() {
  return `/* Faberun Campaign Brief theme; tokens are defined by DESIGN.md. */
:root, :root[data-mdhtml-theme="light"], :root[data-mdhtml-theme="system"] {
  --md-bg: #F4E9D8; --md-surface: #F4E9D8; --md-text: #1F1F1F;
  --md-muted: #556B3F; --md-border: #D97B4F; --md-accent: #B5522A; --md-focus: #B5522A;
  --md-font-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --md-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --md-radius: 8px; --md-shadow: none;
}
:root[data-mdhtml-theme="dark"] {
  --md-bg: #1F1F1F; --md-surface: #1F1F1F; --md-text: #F4E9D8;
  --md-muted: #93AA70; --md-border: #E0875F; --md-accent: #E0875F; --md-focus: #ECAB86;
}
@media (prefers-color-scheme: dark) {
  :root[data-mdhtml-theme="system"] {
    --md-bg: #1F1F1F; --md-surface: #1F1F1F; --md-text: #F4E9D8;
    --md-muted: #93AA70; --md-border: #E0875F; --md-accent: #E0875F; --md-focus: #ECAB86;
  }
}`;
}

/** @param {string} text */
function firstLine(text) {
  return text.trim().split("\n")[0] ?? "";
}

/** A representative real brief for the development/CI renderer proof. */
function exampleMarkdown() {
  /** @type {BriefModel} */
  const model = {
    identity: {
      campaign: "campaign-brief", specBaseline: "d9eae18", specDigest: "a".repeat(64),
      specPath: "docs/campaigns/campaign-brief/spec/SPEC.md", targetGitHead: "abc123",
      planPath: ".runs/campaigns/campaign-brief/plans/P1/plan.json", planDigest: "b".repeat(64),
      contractDigest: "c".repeat(64), journalCursor: 7, usageSampleCutoff: "2026-09-01T00:00:00.000Z",
    },
    opening: {
      intent: "Decide whether a frozen plan is worth executing.", expectedOutcome: "Markdown plus portable HTML.",
      successCriteria: [{ measure: "Approval artefact", target: "Markdown and HTML", evidence: "R6" }],
      humanFacts: ["Review the brief before execution."], calculatedFacts: ["R6 is covered."], gaps: [],
    },
    coverage: {
      rows: [{ requirementId: "R6", title: "Portable HTML", declaredNodeIds: ["render"],
        nodes: [{ id: "render", proof: "npm run check:campaign-brief-render" }], state: "covered", reasons: [] }],
      unknownIds: [], unknownDeclared: [], unknownStamped: [], gaps: [],
      specPath: "docs/campaigns/campaign-brief/spec/SPEC.md", planPath: ".runs/campaigns/campaign-brief/plans/P1/plan.json",
      covered: 1, uncovered: 0, outside: 0, traceabilityMissing: 0, total: 1,
    },
    graph: {
      nodes: [{ id: "render", runtimeId: "codex", model: "gpt-5", dependsOn: [], requirementIds: ["R6"] }],
      edges: [], independent: ["render"], blocking: [], maxParallel: 1, maxConcurrent: { codex: 1 },
      effectiveConcurrency: 1, dispatchableTogether: ["render"], dispatchNote: "one node", gaps: [],
    },
    decisions: {
      human: ["Review before execution."], delegated: [], journal: [],
      risks: [{ risk: "Styled HTML hides a gap", impact: "gap missed", mitigation: "retain semantic labels" }],
      evals: ["A failed renderer removes stale HTML."], gaps: [],
    },
    estimate: {
      cost: { status: "range", min: 1, max: 2, samples: 5, reason: null, sourceRuns: ["run-a"], method: null, provenance: "priced usage" },
      duration: { status: "range", min: 10, max: 20, samples: 5, reason: null, sourceRuns: ["run-a"], method: null, provenance: "elapsed times" },
      runtimes: ["codex"], models: ["gpt-5"], effectiveConcurrency: 1, nodeCount: 1, workerCount: 1,
      sampleCutoff: "2026-09-01T00:00:00.000Z", method: ["comparable samples"], assumptions: ["advisory"], gaps: [],
    },
    decisionState: "ready for human review",
  };
  return renderCampaignBriefMarkdown(model);
}

/** Provision, run controlled tests, then build/check/audit a real example. */
async function main() {
  const binary = await provisionMdhtml();
  const tests = run(process.execPath, ["--test", join(ROOT, "test", "report", "campaign-brief-render.test.mjs")], ROOT);
  if (tests.status !== 0) {
    throw new CampaignBriefRenderError(
      "CAMPAIGN_BRIEF_RENDER_CHECK_FAILED",
      `renderer fixture tests failed: ${firstLine(tests.stderr) || firstLine(tests.stdout)}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-render-example-"));
  try {
    const outputPath = join(dir, "campaign-brief.md.html");
    const result = renderCampaignBriefHtml(exampleMarkdown(), { outputPath, mdhtmlBin: binary });
    const fromDisk = readFileSync(pathToFileURL(outputPath), "utf8");
    for (const fact of ["ready for human review", "R6", "covered"]) {
      if (!fromDisk.includes(fact)) {
        throw new CampaignBriefRenderError("MDHTML_SOURCE_MISMATCH", `rendered example is missing ${fact}`);
      }
    }
    if (fromDisk !== result.html) throw new CampaignBriefRenderError("MDHTML_FAILED", "file URL bytes differ from the render result");
    process.stdout.write(`[ok] mdhtml ${result.version} · fixture tests, build, check, audit and offline file open passed\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof CampaignBriefRenderError ? error.code : "MDHTML_FAILED";
    process.stderr.write(`[fail] ${code} · ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
