import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CampaignBriefRenderError } from "../../src/report/campaign-brief-html.mjs";
import { generateReportHtml, renderReportGraphSvg, renderReportMarkdown } from "../../src/report/report-html.mjs";
import { makeRun } from "./run-fixture.mjs";

test("renderReportGraphSvg draws a dependency edge and declines an independent graph", () => {
  const svg = renderReportGraphSvg([
    { id: "a", status: "done", dependsOn: [] },
    { id: "b", status: "running", dependsOn: ["a"] },
  ]);
  assert.ok(svg, "two nodes with a dependency render a diagram");
  assert.match(svg, /<svg/u);
  assert.match(svg, /<path/u, "the edge is a path, not a list");
  assert.ok(svg.includes("a</text>"), "the source node id is drawn");
  assert.ok(svg.includes("b</text>"), "the dependent node id is drawn");

  assert.equal(
    renderReportGraphSvg([{ id: "a", status: "done", dependsOn: [] }]),
    null,
    "an independent graph reads as a list, not a diagram",
  );
});

test("renderReportMarkdown lays out the report for a browser, with the diagram when there is a topology", () => {
  const { runDir } = makeRun([
    { id: "a", phase: "p", status: "done", dependsOn: [] },
    { id: "b", phase: "p", status: "done", dependsOn: ["a"] },
  ]);
  try {
    const markdown = renderReportMarkdown(runDir);
    assert.match(markdown, /^# Report — report-progress$/mu);
    assert.match(markdown, /^## Work graph$/mu);
    assert.match(markdown, /<svg/u, "a dependency topology renders as an inline diagram");
    assert.match(markdown, /^## Nodes$/mu);
    assert.match(markdown, /\| NODE \| STATE \| TRY \| REV \| RUNTIME \| IN \| OUT \| CACHE \| USD \| NOTE \|/u);
    assert.match(markdown, /\| `a` \| done \|/u);
    assert.match(markdown, /^## Totals$/mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("renderReportMarkdown lists the nodes when every one is dependency-independent", () => {
  const { runDir } = makeRun([{ id: "one", phase: "p", status: "done" }]);
  try {
    const markdown = renderReportMarkdown(runDir);
    assert.match(markdown, /Dependency-independent nodes: `one`\./u);
    assert.doesNotMatch(markdown, /<svg/u, "no topology, no diagram");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("generateReportHtml writes the Markdown source then the HTML copy, and names a renderer failure", () => {
  const { runDir } = makeRun([{ id: "one", phase: "p", status: "done" }]);
  const htmlPath = join(runDir, "report.md.html");
  try {
    const ok = generateReportHtml(runDir, {
      renderHtml: (_markdown, options) => ({ html: "<!doctype html><html>ok</html>", outputPath: options.outputPath, version: "1.1.3" }),
    });
    assert.equal(ok.code, null);
    assert.equal(ok.htmlPath, htmlPath);
    assert.ok(readFileSync(ok.markdownPath, "utf8").includes("# Report — report-progress"));

    writeFileSync(htmlPath, "stale copy");
    const failing = generateReportHtml(runDir, {
      renderHtml: () => { throw new CampaignBriefRenderError("MDHTML_UNAVAILABLE", "no renderer"); },
    });
    assert.equal(failing.htmlPath, null);
    assert.equal(failing.code, "MDHTML_UNAVAILABLE");
    assert.ok(existsSync(failing.markdownPath), "the Markdown source survives a renderer failure");
    assert.equal(existsSync(htmlPath), false, "a failed render removes the prior HTML copy");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
