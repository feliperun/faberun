/**
 * The run report's video boundary: the reading ladder's fourth rung, an
 * animated explainer. It is programmatic, in the 3Blue1Brown sense — the scene
 * is a pure function of the report's facts and a time, rendered as SVG frames,
 * rasterised by librsvg and assembled with ffmpeg around an ElevenLabs
 * narration — rather than manim, which no machine in the fleet has. The
 * narration script (text) is the durable source; the mp3 and mp4 are derived
 * copies, so a missing key, voice, rasteriser or ffmpeg is a named failure that
 * leaves the script behind and changes nothing else.
 *
 * Every seam (the ElevenLabs HTTP call, the rasteriser, ffprobe and ffmpeg) is
 * injectable, so a test proves the whole pipeline with fakes and never spends
 * a real synthesis credit.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_LANG_ENV } from "../notify/index.mjs";
import { renderReportJson } from "./render.mjs";
import { escapeSvgText, layoutGraphNodes, readContractDependsOn, STATUS_COLOURS } from "./report-html.mjs";
import { compactCost } from "../util.mjs";
import { writeTextAtomic } from "../run/store.mjs";

/** The durable source and its derived copies, beside `STATUS.md` in the run directory. */
const NARRATION_FILE = "report.narration.txt";
const VIDEO_FILE = "report.mp4";

/** Video frame rate; the animation is gradual fades, so this is plenty smooth. */
const FPS = 15;
const WIDTH = 1280;
const HEIGHT = 720;

/** @typedef {import("./report-html.mjs").GraphNode} GraphNode */
/** @typedef {{run: string, summary: string, totals: {costUsd: number|null}, nodes: {id: string, status: string}[]}} VideoPayload */
/** @typedef {{title: string, nodes: GraphNode[], done: number, total: number, cost: string|null, attention: string[]}} Scene */
/** @typedef {{apiKey: string, voice: string, model: string}} ElevenLabsOptions */
/** @typedef {{t: number}} Frame */

/**
 * A stable error surface for callers and CLI reporting.
 */
export class ReportVideoError extends Error {
  /** @param {string} code @param {string} message @param {{cause?: unknown}} [options] */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReportVideoError";
    this.code = code;
  }
}

/**
 * The spoken script, deterministic from the report's own facts, in the
 * operator's language. The title is the run id; the body names the counts, the
 * attention nodes and the spend. No model is asked to phrase it — the same
 * discipline as the watcher's progress line, so the same run yields the same
 * narration.
 *
 * @param {VideoPayload} payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildNarration(payload, env = process.env) {
  const lang = (env[NOTIFY_LANG_ENV] ?? "").trim() === "en" ? "en" : "pt";
  const attention = payload.nodes.filter((node) => !QUIET.has(node.status)).map((node) => node.id);
  const done = doneCount(payload);
  const cost = payload.totals.costUsd === null ? null : String(payload.totals.costUsd);
  if (lang === "en") {
    const attentionLine = attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} you: ${attention.join(", ")}.` : "Nothing needs you.";
    return `Report for run ${payload.run}. ${done} of ${payload.nodes.length} nodes done. ${attentionLine} Total cost: ${cost ?? "unknown"} dollars.`;
  }
  const attentionLine = attention.length ? `${attention.length} ${attention.length === 1 ? "nó precisa" : "nós precisam"} de você: ${attention.join(", ")}.` : "Nada precisa de você.";
  return `Relatório da run ${payload.run}. ${done} de ${payload.nodes.length} nós concluídos. ${attentionLine} Custo total: ${cost ?? "desconhecido"} dólares.`;
}

/** Node states that wait on a person; everything else is quiet. */
const QUIET = new Set(["pending", "running", "done", "no-op"]);

/** @param {VideoPayload} payload @returns {number} */
function doneCount(payload) {
  return payload.nodes.filter((node) => node.status === "done" || node.status === "no-op").length;
}

/**
 * One SVG frame of the scene at a normalised time `t` in [0, 1]. The work
 * graph builds up node by node in topological order, each fading in with its
 * status colour, while the title holds and the progress strip and spend
 * surface near the end. Self-contained: inline colours, no external reference.
 *
 * @param {Scene} scene
 * @param {Frame} frame
 * @returns {string}
 */
export function renderReportSceneSvg(scene, frame) {
  const t = clamp(frame.t, 0, 1);
  const titleOpacity = ramp(t, 0.02, 0.08);
  const footerOpacity = ramp(t, 0.55, 0.08);

  const laidOut = layoutGraphNodes(scene.nodes);
  const revealOf = revealSchedule(laidOut);
  const maxDepth = laidOut.reduce((max, node) => Math.max(max, node.depth), 0);
  const maxRow = laidOut.reduce((max, node) => Math.max(max, node.row), 0);
  const naturalW = GRAPH_MARGIN * 2 + (maxDepth + 1) * GRAPH_COL_WIDTH;
  const naturalH = GRAPH_MARGIN * 2 + (maxRow + 1) * GRAPH_ROW_HEIGHT;
  const regionW = WIDTH - 160;
  const regionH = 400;
  const scale = Math.min(regionW / naturalW, regionH / naturalH, 1);
  const tx = (WIDTH - naturalW * scale) / 2;
  const ty = 120 + (regionH - naturalH * scale) / 2;

  const byId = new Map(laidOut.map((node) => [node.id, node]));
  const edges = laidOut.flatMap((node) => (node.dependsOn ?? [])
    .filter((/** @type {string} */ dep) => byId.has(dep))
    .map((/** @type {string} */ dep) => {
      const from = posOf(/** @type {{depth: number, row: number}} */ (byId.get(dep)));
      const to = posOf(node);
      const x1 = from.x + GRAPH_BOX_W;
      const y1 = from.y + GRAPH_BOX_H / 2;
      const x2 = to.x;
      const y2 = to.y + GRAPH_BOX_H / 2;
      const midX = (x1 + x2) / 2;
      const opacity = ramp(t, revealOf.get(node.id) ?? 0, FADE);
      return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#D97B4F" stroke-width="2" opacity="${opacity}"/>`;
    })).join("");
  const boxes = laidOut.map((node, index) => {
    const { x, y } = posOf(node);
    const colour = STATUS_COLOURS[node.status] ?? "#1F1F1F";
    const opacity = ramp(t, revealOf.get(node.id) ?? 0, FADE);
    const clipId = `clip${index}`;
    return `<g opacity="${opacity}"><rect x="${x}" y="${y}" width="${GRAPH_BOX_W}" height="${GRAPH_BOX_H}" rx="8" fill="#F4E9D8" stroke="${colour}" stroke-width="2"/><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${GRAPH_BOX_W}" height="${GRAPH_BOX_H}"/></clipPath><g clip-path="url(#${clipId})"><text x="${x + 10}" y="${y + 24}" font-family="ui-monospace, monospace" font-size="14" fill="#1F1F1F">${escapeSvgText(node.id)}</text><text x="${x + 10}" y="${y + 44}" font-family="ui-sans-serif, sans-serif" font-size="13" fill="${colour}">${escapeSvgText(node.status)}</text></g></g>`;
  }).join("");

  const barW = WIDTH - 160;
  const fillW = Math.round((scene.done / Math.max(1, scene.total)) * barW);
  const statusText = `${scene.done}/${scene.total} · ${scene.cost ?? "-"}`;
  const attentionText = scene.attention.length ? `⚠ ${scene.attention.join(", ")}` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="#F4E9D8"/>`
    + `<text x="80" y="86" font-family="ui-sans-serif, sans-serif" font-size="40" fill="#1F1F1F" opacity="${titleOpacity}">${escapeSvgText(scene.title)}</text>`
    + `<g transform="translate(${tx} ${ty}) scale(${scale})">${edges}${boxes}</g>`
    + `<g opacity="${footerOpacity}">`
    + `<rect x="80" y="${HEIGHT - 120}" width="${barW}" height="20" rx="10" fill="#1F1F1F" opacity="0.12"/>`
    + `<rect x="80" y="${HEIGHT - 120}" width="${fillW}" height="20" rx="10" fill="#B5522A"/>`
    + `<text x="80" y="${HEIGHT - 140}" font-family="ui-sans-serif, sans-serif" font-size="26" fill="#1F1F1F">${escapeSvgText(statusText)}</text>`
    + (attentionText ? `<text x="80" y="${HEIGHT - 70}" font-family="ui-sans-serif, sans-serif" font-size="22" fill="#B5522A">${escapeSvgText(attentionText)}</text>` : "")
    + `</g>`
    + `</svg>`;
}

const GRAPH_COL_WIDTH = 260;
const GRAPH_ROW_HEIGHT = 84;
const GRAPH_BOX_W = 220;
const GRAPH_BOX_H = 56;
const GRAPH_MARGIN = 16;
/** How long one node takes to fade in, in normalised time. */
const FADE = 0.06;

/**
 * The reveal instant of each node, in topological order (depth first, then
 * row): the first fades in at 0.12 and the last at 0.80, leaving a tail for
 * the counters.
 *
 * @param {(GraphNode & {depth: number, row: number})[]} laidOut
 * @returns {Map<string, number>}
 */
function revealSchedule(laidOut) {
  const order = [...laidOut].sort((a, b) => a.depth - b.depth || a.row - b.row);
  return new Map(order.map((node, index) => [node.id, 0.12 + 0.68 * (index / Math.max(1, laidOut.length - 1))]));
}

/** @param {{depth: number, row: number}} node @returns {{x: number, y: number}} */
function posOf(node) {
  return { x: GRAPH_MARGIN + node.depth * GRAPH_COL_WIDTH, y: GRAPH_MARGIN + node.row * GRAPH_ROW_HEIGHT };
}

/** @param {number} t @param {number} start @param {number} dur @returns {number} */
function ramp(t, start, dur) {
  return clamp((t - start) / dur, 0, 1);
}

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Synthesize the narration as MP3 bytes through ElevenLabs. The key is read
 * from the environment, never stored; the request carries it only as a header.
 *
 * @param {string} text
 * @param {ElevenLabsOptions} options
 * @param {{fetch?: typeof fetch}} [io]
 * @returns {Promise<Buffer>}
 */
export async function synthesizeSpeech(text, options, io = {}) {
  const fetchImpl = io.fetch ?? fetch;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voice)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": options.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: options.model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (error) {
    throw new ReportVideoError("VIDEO_TTS_FAILED", `ElevenLabs request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new ReportVideoError("VIDEO_TTS_FAILED", `ElevenLabs returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new ReportVideoError("VIDEO_TTS_FAILED", "ElevenLabs returned no audio");
  return bytes;
}

/** @param {string} command @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
function spawnRun(command, args) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The duration of the narration in milliseconds, read by ffprobe so the frames
 * fill exactly the audio.
 *
 * @param {string} audioPath
 * @param {(command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<string>} run
 * @returns {number}
 */
function probeDurationMs(audioPath, run) {
  const result = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath]);
  const seconds = Number((result.stdout ?? "").trim());
  if (result.status !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new ReportVideoError("VIDEO_PROBE_FAILED", "could not measure the narration duration");
  }
  return Math.round(seconds * 1000);
}

/**
 * The full pipeline: narration script (durable) → ElevenLabs MP3 → SVG frames
 * → PNG frames via rsvg-convert → an MP4 via ffmpeg. The script is written
 * first and survives every later failure; a missing key, voice or tool is a
 * named code on the result, with any partial video removed, rather than a
 * throw — the same contract as `generateReportHtml`.
 *
 * @param {string} runDir
 * @param {{apiKey?: string, voice?: string, model?: string, env?: NodeJS.ProcessEnv, synthesize?: typeof synthesizeSpeech, run?: (command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<string>}} options
 * @returns {Promise<{narrationPath: string, videoPath: string|null, code: string|null}>}
 */
export async function generateReportVideo(runDir, options) {
  const env = options.env ?? process.env;
  const run = options.run ?? spawnRun;
  const synthesize = options.synthesize ?? synthesizeSpeech;

  const payload = /** @type {VideoPayload} */ (JSON.parse(renderReportJson(runDir)));
  const scene = buildScene(runDir, payload);
  const narration = buildNarration(payload, env);
  const narrationPath = join(runDir, NARRATION_FILE);
  const videoPath = join(runDir, VIDEO_FILE);
  writeTextAtomic(narrationPath, narration);

  try {
    const apiKey = options.apiKey || env.ELEVENLABS_API_KEY || "";
    const voice = options.voice || env.ELEVENLABS_VOICE || "";
    if (!apiKey) throw new ReportVideoError("VIDEO_KEY_MISSING", "ELEVENLABS_API_KEY is not set");
    if (!voice) throw new ReportVideoError("VIDEO_VOICE_MISSING", "ELEVENLABS_VOICE is not set");

    const audio = await synthesize(narration, { apiKey, voice, model: options.model ?? "eleven_multilingual_v2" });
    const stage = mkdtempSync(join(tmpdir(), "report-video-"));
    try {
      const audioPath = join(stage, "narration.mp3");
      writeFileSync(audioPath, audio);
      const durationMs = probeDurationMs(audioPath, run);
      const frameCount = Math.max(2, Math.round((durationMs / 1000) * FPS));
      const framesDir = join(stage, "frames");
      mkdirSync(framesDir, { recursive: true });
      for (let i = 0; i < frameCount; i += 1) {
        const svg = renderReportSceneSvg(scene, { t: frameCount === 1 ? 1 : i / (frameCount - 1) });
        const base = join(framesDir, `frame-${String(i).padStart(4, "0")}`);
        writeFileSync(`${base}.svg`, svg, "utf8");
        const raster = run("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), `${base}.svg`, "-o", `${base}.png`]);
        if (raster.status !== 0) throw new ReportVideoError("VIDEO_RASTER_FAILED", `rsvg-convert failed: ${raster.stderr || raster.stdout}`);
      }
      const assemble = run("ffmpeg", [
        "-y", "-framerate", String(FPS), "-i", join(framesDir, "frame-%04d.png"),
        "-i", audioPath, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath,
      ]);
      if (assemble.status !== 0) throw new ReportVideoError("VIDEO_ASSEMBLE_FAILED", `ffmpeg failed: ${assemble.stderr || assemble.stdout}`);
      return { narrationPath, videoPath, code: null };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(videoPath, { force: true });
    const code = error instanceof ReportVideoError ? error.code : "REPORT_VIDEO_FAILED";
    return { narrationPath, videoPath: null, code };
  }
}

/**
 * The scene the frames render from: the report's graph, its counts, its spend
 * and the nodes that wait on a person.
 *
 * @param {string} runDir
 * @param {VideoPayload} payload
 * @returns {Scene}
 */
function buildScene(runDir, payload) {
  const dependsOn = readContractDependsOn(runDir);
  const nodes = payload.nodes.map((node) => ({ id: node.id, status: node.status, dependsOn: dependsOn.get(node.id) ?? [] }));
  return {
    title: payload.run,
    nodes,
    done: doneCount(payload),
    total: payload.nodes.length,
    cost: typeof payload.totals.costUsd === "number" ? compactCost(payload.totals.costUsd) : null,
    attention: payload.nodes.filter((node) => !QUIET.has(node.status)).map((node) => node.id),
  };
}
