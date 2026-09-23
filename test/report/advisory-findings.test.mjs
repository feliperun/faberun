import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderFindings, renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { doneResult, makeRun } from "./run-fixture.mjs";

process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

// A gate that accepts a node whose findings sit below `failOn` is behaving as
// declared. The defect was the finding becoming unreadable afterwards.
// Measured 2026-09-21: a synthesis node's gate verdict was `fail` with a real
// finding under the threshold; STATUS said `passed`, the JSON note was cut at
// 64 characters before the "However," that carried it, and `faberun findings`
// answered "no findings or blocking questions to act on".
const ADVISORY_GATE = {
  verdict: "fail",
  maxSeverity: "minor",
  summary: "The synthesis covers every required section and cites its sources. However, the cost table totals $7.53 while the per-node column sums to $7.09, so one node's spend is unaccounted for.",
  findings: [{ severity: "minor", description: "the cost table does not reconcile with the per-node column", evidence: "report table row 7 vs totals line" }],
};

/** @returns {string} the run directory of a one-node run whose gate accepted a node carrying a finding */
function advisoryRun() {
  return makeRun([{
    id: "synthesis",
    phase: "p",
    status: "done",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    result: doneResult("synthesis written"),
    gate: ADVISORY_GATE,
  }]).runDir;
}

test("findings lists a judge finding the gate accepted, named as an advisory", () => {
  const output = renderFindings(advisoryRun());
  assert.match(output, /## synthesis \(advisory · the node done\)/u);
  assert.match(output, /\[minor\] the cost table does not reconcile/u);
  assert.match(output, /Evidence: report table row 7/u);
  assert.doesNotMatch(output, /no findings or blocking questions to act on/u);
});

test("a run with no findings at all still says there is nothing to act on", () => {
  const { runDir } = makeRun([
    { id: "solo", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("done") },
  ]);
  assert.equal(renderFindings(runDir), "no findings or blocking questions to act on\n");
});

test("STATUS names the advisory instead of reporting that nothing needs anyone", () => {
  const status = renderStatus(advisoryRun());
  assert.doesNotMatch(status, /Nothing needs you right now\./u);
  assert.match(status, /- \[~\] synthesis: done with 1 judge finding below the gate's threshold \(minor\)\./u);
  assert.match(status, /faberun findings/u);
});

test("the GATE cell distinguishes a clean pass from a pass that carried findings", () => {
  assert.match(renderStatus(advisoryRun()), /passed ~1/u);

  const { runDir } = makeRun([
    { id: "clean", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("done"), gate: { verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] } },
  ]);
  const clean = renderStatus(runDir);
  assert.match(clean, /passed/u);
  assert.doesNotMatch(clean, /passed ~/u);
  assert.match(clean, /Nothing needs you right now\./u);
});

test("the JSON payload carries the gate verdict, severity and finding count uncut", () => {
  const payload = JSON.parse(renderStatusJson(advisoryRun()));
  const node = payload.nodes.find((/** @type {{id: string}} */ entry) => entry.id === "synthesis");

  assert.deepEqual(
    { verdict: node.gate.verdict, maxSeverity: node.gate.maxSeverity, findingCount: node.gate.findingCount },
    { verdict: "fail", maxSeverity: "minor", findingCount: 1 },
  );
  // The bounded note is what the tables show; the gate summary beside it is
  // the one that must survive whole, adversative clause included.
  assert.match(node.gate.summary, /However, the cost table totals \$7\.53/u);
  assert.ok(node.note === null || node.note.length <= 64, `the table note stays bounded: ${node.note}`);
});
