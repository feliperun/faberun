import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerRun } from "../../src/campaign/index.mjs";
import { campaignDir, CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { PROGRESS_MESSAGE_MAX_BYTES, renderRunProgress } from "../../src/report/message.mjs";
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
    assert.match(message, /next two ~2m$/mu);
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
    writeFileSync(checkPath, JSON.stringify({ checkedAt: "2026-09-21T00:00:00.000Z", current: "0.0.1", latest: "99.0.0" }));
    const newer = renderRunProgress(runDir, { type: "node.terminal", runId: "report-progress", nodeId: "one", status: "done", attempt: 1 });
    assert.match(newer, /^⬆️ faberun 99\.0\.0 available · run faberun update$/mu);
    assert.ok(newer.trimEnd().endsWith("faberun update"), "the update line is the last line, after the signature");

    writeFileSync(checkPath, JSON.stringify({ checkedAt: "2026-09-21T00:00:00.000Z", current: "0.0.1", latest: "0.0.1" }));
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
    assert.match(message, /^💸 /mu, "tokens appear on the milestone, not on every node");
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
