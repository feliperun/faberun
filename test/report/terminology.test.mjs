import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { renderReport, renderStatus } from "../../src/report/render.mjs";
import { makeRun } from "./run-fixture.mjs";

/**
 * One concept, one term: the cost column is the same entity in `status` and in
 * `report`, so it must carry one name in both tables. The two surfaces used to
 * disagree — `status` headed the money column `USD` and `report` headed the
 * same column `COST` — and a reader moving between them had to re-learn which
 * was which.
 */
test("the cost column carries one term across status and report", () => {
  const { runDir } = makeRun([{ id: "one", phase: "p", status: "done" }]);
  try {
    const status = renderStatus(runDir);
    const report = renderReport(runDir);
    assert.match(status, /USD\s+GATE/u, "status names the money column USD");
    assert.match(report, /USD\s+NOTE/u, "report names the same column USD, not COST");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
