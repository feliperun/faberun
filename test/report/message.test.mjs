import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerRun } from "../../src/campaign/index.mjs";
import { campaignDir, CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { PROGRESS_MESSAGE_MAX_BYTES, chooseShape, renderRunProgress, renderRunProgressShapes } from "../../src/report/message.mjs";
import { doneResult, makeRun } from "./run-fixture.mjs";

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// must never touch the operator's real install root, so the file points it at
// a scratch home before the first run is made (the roll-up tests do the same).
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

test("a three-node run with two settled nodes renders the percentages, the count and the next node", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("first node shipped the schema") },
    { id: "two", phase: "p", status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z", result: doneResult("second node shipped the migration") },
    { id: "three", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "two", status: "done", attempt: 1 });
    assert.match(message, /^✅ two · done in 2m · \$-$/mu);
    assert.match(message, /^▰▰▰▰▰▰▰▱▱▱ 2\/3 nodes · next three ~1m$/mu);
    assert.match(message, /^📦 asked  Implement it$/mu);
    assert.match(message, /^🐦 faberun · test-campaign$/mu, "a run outside any readable campaign signs with the id alone instead of 0% of nothing");
    assert.match(message, /^   proof  no judge$/mu);
    assert.match(message, /^   done   second node shipped the migration$/mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the estimate ignores a running node's partial span", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("first node done") },
    // A running node's own elapsed span, if it were folded into the mean,
    // would push the estimate to roughly two hours; it must not appear.
    { id: "two", phase: "p", status: "running", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T02:01:00.000Z" },
    { id: "three", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /running two ~2m$/mu, "the unsettled node is running, so it is named running, with the estimate beside it");
    assert.doesNotMatch(message, /h\d/u, "no hour-scale estimate leaked in from the running node's partial span");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node message names the worker's model and says when no judge ran", () => {
  const { runDir } = makeRun([
    {
      id: "one",
      phase: "p",
      status: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      result: doneResult("done"),
      invocations: [
        {
          id: "inv-worker", pid: 1, processGroupId: null, processStartToken: null, harness: "codex", phase: "worker", planPhase: "p", runtimeFingerprint: "codex/gpt-5.6-luna",
          runId: "report-progress", campaignId: "test-campaign", nodeId: "one", model: "gpt-5.6-luna", reasoning: null,
          sandbox: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", deadlineAt: "2026-01-01T00:10:00.000Z",
          closedAt: "2026-01-01T00:01:00.000Z", signal: null, role: "worker", continuationMode: "fresh", status: "closed",
          promptPath: "prompt.txt", stdoutPath: "stdout.txt", stderrPath: "stderr.txt", executable: "codex", exitCode: 0,
          usage: { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0 }, costUsd: 0.01, continuationId: null,
        },
        {
          id: "inv-judge", pid: 2, processGroupId: null, processStartToken: null, harness: "agy", phase: "judge", planPhase: "p", runtimeFingerprint: "agy/gemini-3.1-pro-high",
          runId: "report-progress", campaignId: "test-campaign", nodeId: "one", model: "gemini-3.1-pro-high", reasoning: null,
          sandbox: null, startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:01:30.000Z", deadlineAt: "2026-01-01T00:10:00.000Z",
          closedAt: "2026-01-01T00:01:30.000Z", signal: null, role: "judge", continuationMode: "fresh", status: "closed",
          promptPath: "prompt.txt", stdoutPath: "stdout.txt", stderrPath: "stderr.txt", executable: "agy", exitCode: 0,
          usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 }, costUsd: null, continuationId: null,
        },
      ],
    },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /^✅ one · done in 1m · \$- · gpt-5.6-luna$/mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an attention event renders the command that unblocks it", () => {
  const { runDir } = makeRun([
    {
      id: "build",
      phase: "p",
      status: "blocked",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      result: { status: "blocked_context", summary: "missing config", verification: [], artifacts: [], missingContext: ["missing.txt"] },
    },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "attention", runId: "report-progress", nodeId: "build", status: "blocked" });
    assert.match(message, /^👀 build needs you · blocked · attempt 1 · 1m · \$-$/mu);
    assert.match(message, /^⚠️ why    missing: missing\.txt$/mu, "the reason comes first: what the worker asked for");
    assert.ok(message.includes(`   do     faberun resume ${runDir} --answer build=<answer-file>`), "the exact command, ready to paste");
    assert.match(message, /^▱▱▱▱▱▱▱▱▱▱ 0\/1 nodes · 1 waiting on you$/mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the campaign total sums cost across every linked run, not just this phase's", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("done") },
  ]);
  const runsDir = dirname(runDir);
  const campaignPath = campaignDir(runsDir, "test-campaign");
  registerRun(campaignPath, "report-progress");
  writeFileSync(join(runDir, "usage.jsonl"), `${JSON.stringify({ costUsd: 0.02 })}\n`);

  // A prior phase's own run, linked to the same campaign, its usage.jsonl the
  // only place its spend lives once its own run directory is otherwise gone.
  const priorPhaseRunDir = join(runsDir, "phase-one");
  mkdirSync(priorPhaseRunDir, { recursive: true });
  writeFileSync(join(priorPhaseRunDir, "usage.jsonl"), `${JSON.stringify({ costUsd: 0.05 })}\n`);
  registerRun(campaignPath, "phase-one");

  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /^🐦 faberun · test-campaign 100% · \$0\.07 · /mu, "the signature carries the campaign's cumulative cost, two decimals");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a message whose worker summary is enormous stays under the ceiling with the rest of the blocks intact", () => {
  const hugeSummary = "x".repeat(4000);
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult(hugeSummary) },
    { id: "two", phase: "p", status: "pending" },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.ok(Buffer.byteLength(message, "utf8") <= PROGRESS_MESSAGE_MAX_BYTES);
    assert.match(message, /^▰▰▰▰▰▱▱▱▱▱ 1\/2 nodes · next two ~1m$/mu);
    assert.match(message, /^✅ one · done in 1m · \$-$/mu);
    assert.match(message, /^   proof  no judge$/mu);
    assert.match(message, /^   done   x+…$/mu, "the worker's words are cut at the sentence ceiling, never mid-message");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("labels follow the operator's language: a Portuguese campaign goal renders Portuguese wording, quoted text stays as written", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("Adicionado o verbo de ref preservado.") },
    { id: "two", phase: "p", status: "pending" },
  ]);
  const runsDir = dirname(runDir);
  // The fixture's campaign record already exists; the operator's goal is
  // what the message reads its language from, so it is rewritten here.
  const campaignPath = campaignDir(runsDir, "test-campaign");
  const record = JSON.parse(readFileSync(join(campaignPath, CAMPAIGN_FILE), "utf8"));
  writeFileSync(join(campaignPath, CAMPAIGN_FILE), `${JSON.stringify({ ...record, goal: "Garantir que o cancelamento não perca trabalho já integrado e que as notas do journal sejam recusadas em vez de cortadas" }, null, 2)}\n`);
  registerRun(campaignPath, "report-progress");
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(message, /^✅ one · concluído em 1m · \$-$/mu);
    assert.match(message, /^📦 pedido  Implement it$/mu, "the plan's own objective keeps its language; only the label is translated");
    assert.match(message, /^   feito   Adicionado o verbo de ref preservado\.$/mu);
    assert.match(message, /^   prova   sem juiz$/mu);
    assert.match(message, /1\/2 nós · próximo two/u);
    assert.match(message, /^🐦 faberun · test-campaign 50% · /mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the update line appears only when the cached check names a release newer than the one running, and never touches the network", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("done") },
  ]);
  const checkPath = join(/** @type {string} */ (process.env.FABERUN_HOME), "update-check.json");
  try {
    writeFileSync(checkPath, JSON.stringify({ checkedAt: new Date().toISOString(), current: "0.0.1", latest: "99.0.0" }));
    const newer = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(newer, /^⬆️ faberun 99\.0\.0 available · run faberun update$/mu);
    assert.ok(newer.trimEnd().endsWith("faberun update"), "the update line is the last line, after the signature");

    writeFileSync(checkPath, JSON.stringify({ checkedAt: new Date().toISOString(), current: "0.0.1", latest: "0.0.1" }));
    const current = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.doesNotMatch(current, /⬆️/u);
  } finally {
    rmSync(checkPath, { force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a run message lists what each node delivered in one sentence each, totals the proof, and signs with the rule", () => {
  const { runDir } = makeRun([
    {
      id: "one",
      phase: "p",
      status: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      result: doneResult("First node shipped the schema. Then a second sentence nobody needs in a notification."),
      verification: { passed: true, completed: true, commands: [{ argv: ["npm", "test"], passed: true }, { argv: ["npm", "run", "typecheck"], passed: true }] },
      gate: { verdict: "pass", maxSeverity: "none", summary: "every deterministic item passed", findings: [] },
    },
    { id: "two", phase: "p", status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z", result: doneResult("Second node shipped the migration."), revisions: 1 },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "run.terminal", runId: "report-progress" });
    assert.match(message, /^🏁 run report-progress · 2\/2 done · 3m · \$-$/mu);
    assert.match(message, /^📦 delivered$/mu);
    assert.match(message, /^   • one — First node shipped the schema\.$/mu, "one sentence per node, the first, never the whole summary");
    assert.match(message, /^   • two — Second node shipped the migration\.$/mu);
    assert.match(message, /^   proof  2 checks green · 1 judge passes · 1 revisions$/mu);
    assert.doesNotMatch(message, /^💸 /mu, "no role metered a token in this fixture, so the tokens line is left out rather than printed as dashes");
    assert.match(message, /^──────────────────────────────$/mu);
    assert.match(message, /^🐦 faberun · /mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node that passed its checks and its judge says so in the proof line, in the worker's own outcome words", () => {
  const { runDir } = makeRun([
    {
      id: "one",
      phase: "p",
      status: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:08:00.000Z",
      result: doneResult("Shipped."),
      verification: { passed: true, completed: true, commands: [{ argv: ["npm", "test"], passed: true }, { argv: ["npm", "run", "typecheck"], passed: true }, { argv: ["npm", "run", "check"], passed: true }] },
      gate: { verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] },
      revisions: 1,
    },
  ]);
  try {
    const message = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 2 });
    assert.match(message, /^✅ one · done in 8m · \$-$/mu);
    assert.match(message, /^   proof  3 checks green · judge pass · 1 revisions$/mu);
    assert.match(message, /^▰▰▰▰▰▰▰▰▰▰ 1\/1 nodes · complete$/mu);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a run that delivered nothing says so, meters no tokens, and a node still running is named running, not next", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "blocked", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", error: { code: "context_missing", message: "the worker asked for schema.sql" }, result: { status: "blocked_context", summary: "need the schema", verification: [], artifacts: [], missingContext: ["schema.sql"] } },
    { id: "two", phase: "p", status: "running", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z" },
  ]);
  try {
    const run = renderRunProgress(runDir, { type: "run.terminal", runId: "report-progress" });
    assert.match(run, /^🏁 run report-progress · 0\/2 done · 2m · \$- · 1 needs you$/mu);
    assert.match(run, /^📦 delivered\n   nothing delivered$/mu);
    assert.doesNotMatch(run, /^💸 /mu, "no metered token, no tokens line");

    const node = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "blocked" });
    assert.match(node, /^⛔ one · blocked after 1m · \$- · context_missing$/mu);
    assert.match(node, /^▱▱▱▱▱▱▱▱▱▱ 0\/2 nodes · running two ~1m$/mu, "the unsettled node is running, so it is not 'next'; the estimate still comes from the settled span");

    const forced = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "two", status: "running" });
    assert.match(forced, /^▶️ two · running · \$-$/mu, "an event forced on a running node never claims it is done");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
// --- The mobile shape -------------------------------------------------------
//
// The operator reads these walking, with the phone in one hand (his words,
// 2026-09-30): the shape is asserted by what it drops as much as by what it
// keeps, because every one of those drops is what makes it scannable.

/**
 * @param {string} shape
 * @param {() => void} body
 */
function withShape(shape, body) {
  const saved = process.env.FABERUN_NOTIFY_SHAPE;
  process.env.FABERUN_NOTIFY_SHAPE = shape;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.FABERUN_NOTIFY_SHAPE;
    else process.env.FABERUN_NOTIFY_SHAPE = saved;
  }
}

test("the mobile shape puts the campaign's phases and percent first, and quotes nothing", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("First node shipped the schema. Then a sentence nobody needs.") },
    { id: "two", phase: "p", status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z", result: doneResult("Second node shipped the migration.") },
  ]);
  const runsDir = dirname(runDir);
  registerRun(campaignDir(runsDir, "test-campaign"), "report-progress");
  try {
    withShape("mobile", () => {
      const message = renderRunProgress(runDir, { type: "run.terminal", runId: "report-progress" });
      const lines = message.split("\n");
      assert.match(lines[0], /^📊 test-campaign · 1\/1 phases · 100%$/u, "the campaign's own phases and percent lead: the number that answers 'how far along is this' without reading");
      assert.match(lines[1], /^🏁 run report-progress · 2\/2 ✅ · ⏱️ 3m · \$-/u);
      assert.equal(lines.length, 2, "no line survives that is not one of: progress, the event, who waits");
      assert.doesNotMatch(message, /▰/u, "the bar belongs to the full shape; a bar is measured, not glanced");
      assert.doesNotMatch(message, /─/u, "no rule");
      assert.doesNotMatch(message, /shipped the schema/u, "no worker summary is quoted");
      assert.doesNotMatch(message, /^📦 delivered$/mu, "no delivered list");
      assert.doesNotMatch(message, /^🐦 /mu, "no signature line: the full shape's footer is a paragraph's tail, not a glance");
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the mobile shape reports who waits on a person on the last line, and writes the command nowhere", () => {
  const { runDir } = makeRun([
    { id: "build", phase: "p", status: "blocked", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", error: { code: "context_missing", message: "the worker asked for schema.sql" }, result: { status: "blocked_context", summary: "need the schema", verification: [], artifacts: [], missingContext: ["schema.sql"] } },
    { id: "two", phase: "p", status: "done", startedAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z", result: doneResult("Shipped.") },
  ]);
  try {
    withShape("mobile", () => {
      const run = renderRunProgress(runDir, { type: "run.terminal", runId: "report-progress" });
      assert.match(run.split("\n").pop() ?? "", /^👉 1 needs you$/u, "the ask is the last line, so it is the one line a person has to read");

      const attention = renderRunProgress(runDir, { type: "attention", runId: "report-progress", nodeId: "build", status: "blocked" });
      const lines = attention.split("\n");
      assert.match(lines[0], /^👀 build · needs you · context_missing$/u);
      assert.match(lines[1], /^⏱️ attempt 1 · 1m · \$-/u);
      assert.equal(lines.length, 2);
      assert.doesNotMatch(attention, /faberun resume/u, "a path that would be truncated is a wrong command; it stays in the full shape, which is what the session that can run it reads");
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the mobile shape names the phase only on a run that belongs to no campaign", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("Shipped.") },
    { id: "two", phase: "p", status: "pending" },
  ]);
  try {
    withShape("mobile", () => {
      const node = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done" });
      const lines = node.split("\n");
      assert.match(lines[0], /^✅ one · done in 1m · \$-/u);
      assert.match(lines[1], /^📦 1\/2 nodes$/u);
      assert.equal(lines.length, 2);
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an unknown shape falls back to the full one instead of losing the message", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("Shipped.") },
  ]);
  try {
    assert.equal(chooseShape({}), "full", "the shape nobody asked for is the one that always worked");
    assert.equal(chooseShape({ FABERUN_NOTIFY_SHAPE: "  mobile  " }), "mobile", "the value is the operator's, trimmed");
    assert.equal(chooseShape({ FABERUN_NOTIFY_SHAPE: "compact" }), "full");
    withShape("compact", () => {
      const message = renderRunProgress(runDir, { type: "run.terminal", runId: "report-progress" });
      assert.match(message, /^🏁 run report-progress · 1\/1 done/u, "a typo in the shell renders the full shape, it does not throw where a notification is being built");
      assert.match(message, /^🐦 faberun · /mu);
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
test("both shapes come out of one call, and the variable still decides which one the summary is", () => {
  const { runDir } = makeRun([
    { id: "one", phase: "p", status: "done", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", result: doneResult("Shipped.") },
    { id: "two", phase: "p", status: "pending" },
  ]);
  const event = { type: /** @type {const} */ ("run.terminal"), runId: "report-progress" };
  try {
    withShape("full", () => {
      const shapes = renderRunProgressShapes(runDir, event);
      assert.match(shapes.summary, /^🏁 run report-progress · 1\/2 done · /mu);
      assert.match(shapes.summary, /^🐦 faberun · /mu, "the summary is what the operator asked for: full");
      assert.match(shapes.mobile, /^🏁 run report-progress · 1\/2 ✅ · /mu, "the short one is handed beside it, whatever the operator asked for");
      assert.equal(shapes.mobile, withShape("mobile", () => renderRunProgress(runDir, event)), "the short shape handed to a transport is the same renderer the variable selects, reached by name instead of by environment");
    });
    withShape("mobile", () => {
      const shapes = renderRunProgressShapes(runDir, event);
      assert.equal(shapes.summary, shapes.mobile, "an operator whose every audience is a phone sets the variable and the summary follows");
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
