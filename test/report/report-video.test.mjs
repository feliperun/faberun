import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ReportVideoError, buildNarration, generateReportVideo, renderReportSceneSvg } from "../../src/report/report-video.mjs";
import { makeRun } from "./run-fixture.mjs";

test("buildNarration phrases the run facts in the operator's language", () => {
  const payload = { run: "r", summary: "", totals: { costUsd: 1.5 }, nodes: [{ id: "a", status: "done" }, { id: "b", status: "blocked" }] };
  const pt = buildNarration(payload, {});
  assert.match(pt, /^Relatório da run r\./u);
  assert.match(pt, /1 de 2 nós concluídos/u);
  assert.match(pt, /1 nó precisa de você: b\./u);
  assert.match(pt, /Custo total: 1\.5 dólares\./u);

  const en = buildNarration(payload, { FABERUN_NOTIFY_LANG: "en" });
  assert.match(en, /^Report for run r\./u);
  assert.match(en, /1 of 2 nodes done/u);
  assert.match(en, /1 needs you: b\./u);
});

test("renderReportSceneSvg builds the graph over time and finishes fully revealed", () => {
  const scene = {
    title: "report-progress",
    nodes: [
      { id: "a", status: "done", dependsOn: [] },
      { id: "b", status: "blocked", dependsOn: ["a"] },
    ],
    done: 1,
    total: 2,
    cost: "$0.01",
    attention: ["b"],
  };
  const start = renderReportSceneSvg(scene, { t: 0 });
  const end = renderReportSceneSvg(scene, { t: 1 });

  for (const frame of [start, end]) {
    assert.match(frame, /<svg/u);
    assert.ok(frame.includes("report-progress"), "the title names the run");
    assert.ok(frame.includes(">a</text>"), "the source node is drawn");
    assert.ok(frame.includes(">b</text>"), "the dependent node is drawn");
  }
  assert.match(end, /<path d=/u, "the dependency edge is a path");
  assert.match(end, /opacity="1"/u, "everything is revealed at the end");
  assert.match(start, /opacity="0"/u, "nothing is revealed at the start");
});

test("generateReportVideo writes the narration and names a missing key without a video", async () => {
  const { runDir } = makeRun([{ id: "one", phase: "p", status: "done" }]);
  try {
    const result = await generateReportVideo(runDir, { env: {} });
    assert.equal(result.videoPath, null);
    assert.equal(result.code, "VIDEO_KEY_MISSING");
    assert.ok(readFileSync(result.narrationPath, "utf8").includes("Relatório da run report-progress"), "the narration survives the failure");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("generateReportVideo assembles frames and audio through the injected seams", async () => {
  const { runDir } = makeRun([
    { id: "a", phase: "p", status: "done", dependsOn: [] },
    { id: "b", phase: "p", status: "done", dependsOn: ["a"] },
  ]);
  /** @type {string[]} */
  const commands = [];
  /** @type {(command: string, args: string[]) => import("node:child_process").SpawnSyncReturns<string>} */
  const run = (command, args) => {
    commands.push(command);
    return { status: 0, stdout: command === "ffprobe" ? "1.0\n" : "", stderr: "", pid: 0, output: [], signal: null };
  };
  const synthesize = async (/** @type {string} */ _text) => Buffer.from("fake-audio");
  try {
    const result = await generateReportVideo(runDir, {
      env: { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE: "v" },
      synthesize,
      run,
    });
    assert.equal(result.code, null);
    assert.ok(result.videoPath && result.videoPath.endsWith("report.mp4"));
    assert.deepEqual(commands.filter((command) => command === "ffprobe").length, 1);
    assert.ok(commands.includes("rsvg-convert"), "frames are rasterised");
    assert.ok(commands.includes("ffmpeg"), "frames and audio are assembled");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a failing synthesis is a named code and removes no narration", async () => {
  const { runDir } = makeRun([{ id: "one", phase: "p", status: "done" }]);
  try {
    const result = await generateReportVideo(runDir, {
      env: { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE: "v" },
      synthesize: async () => { throw new ReportVideoError("VIDEO_TTS_FAILED", "boom"); },
    });
    assert.equal(result.videoPath, null);
    assert.equal(result.code, "VIDEO_TTS_FAILED");
    assert.ok(existsSync(result.narrationPath), "the narration source is kept");
    assert.equal(existsSync(join(runDir, "report.mp4")), false, "no partial video");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
