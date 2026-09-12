import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign, registerRun, renderHandoff } from "../../src/campaign/index.mjs";
import { readProjectionState } from "../../src/campaign/projection.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { briefFromState, materializeBrief } from "../../src/campaign/brief.mjs";
import { BRIEF_BYTES, BRIEF_FILE, HANDOFF_FILE, PROJECTION_FILE } from "../../src/campaign/layout.mjs";
import { renderCampaignHandoffSafely } from "../../src/engine/notify-queue.mjs";

// The operator brief: a pure, hard-bounded rendering of the campaign's durable
// facts, refreshed at the same seam that rewrites HANDOFF.md.

test("brief is deterministic", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-brief-deterministic-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "deterministic", goal: "Ship a deterministic brief" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Use a bounded brief" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "Is the brief rebuildable?" });
  appendJournal(created.path, { type: "intent", eventId: "i1", at, sessionId: "codex-1", text: "Take over the campaign" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Never drop the journal" });

  const campaign = readCampaign(created.path);
  const { state } = readProjectionState(created.path, campaign);
  const run = { id: "linked", exists: true, summary: "2 nodes · 2 done", controller: "active", phase: "P1", done: 2, total: 2, costUsd: 1.5, inputTokens: 1200, outputTokens: 340, attention: [] };
  const first = materializeBrief(created.path, briefFromState(campaign, state, [run]));
  const second = materializeBrief(created.path, briefFromState(campaign, state, [run]));
  assert.equal(second, first);
  assert.equal(readFileSync(join(created.path, BRIEF_FILE), "utf8"), first);
  assert.match(first, /Use a bounded brief/u);
  assert.match(first, /Goal: Ship a deterministic brief/u);
  assert.match(first, /Is the brief rebuildable\?/u);
  assert.match(first, /Take over the campaign/u);
  assert.match(first, /Never drop the journal/u);
  assert.match(first, /Phase: P1 · checkpoints: 2\/2/u);
  assert.match(first, /cost \$1\.500000/u);
});

test("brief bounded", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-brief-bounded-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "bounded", goal: "Prove the hard ceiling" });
  const at = new Date().toISOString();
  for (let index = 0; index < 12; index += 1) {
    appendJournal(created.path, { type: "open-question", eventId: `q-${index}`, at, sessionId: "codex-1", questionId: `q-${index}`, text: `question-${index} ${"Q".repeat(2000)}` });
    appendJournal(created.path, { type: "intent", eventId: `i-${index}`, at, sessionId: "codex-1", text: `intent-${index} ${"I".repeat(2000)}` });
    appendJournal(created.path, { type: "outcome", eventId: `o-${index}`, at, sessionId: "codex-1", text: `outcome-${index} ${"O".repeat(2000)}` });
  }
  const campaign = readCampaign(created.path);
  const { state } = readProjectionState(created.path, campaign);
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: `run-${String(index).padStart(2, "0")}`,
    exists: true,
    summary: `12 nodes · 12 done ${"S".repeat(200)}`,
    controller: "active",
    phase: "P2",
    done: 12,
    total: 12,
    costUsd: 2,
    inputTokens: 5000,
    outputTokens: 7000,
    attention: Array.from({ length: 6 }, (_, node) => ({ id: `node-${node}`, status: "failed", note: `note ${"N".repeat(200)}` })),
  }));

  const brief = materializeBrief(created.path, briefFromState(campaign, state, runs));
  assert.ok(Buffer.byteLength(brief, "utf8") <= BRIEF_BYTES);
  assert.match(brief, /^# campaign bounded brief/u);
  assert.match(brief, /earlier .* omitted/u);
});

test("brief rebuild from journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-brief-journal-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "journal", goal: "Prove journal rebuild" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "Is the handoff bounded?" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Never drop the journal" });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId: "codex-1", text: "Render the next handoff" });

  const campaign = readCampaign(created.path);
  assert.equal(existsSync(join(created.path, PROJECTION_FILE)), false);
  const fromJournal = materializeBrief(created.path, briefFromState(campaign, readProjectionState(created.path, campaign).state, []));
  assert.equal(existsSync(join(created.path, PROJECTION_FILE)), false);

  renderHandoff(created.path, runsDir);
  assert.equal(existsSync(join(created.path, PROJECTION_FILE)), true);
  const fromProjection = materializeBrief(created.path, briefFromState(campaign, readProjectionState(created.path, campaign).state, []));
  assert.equal(fromProjection, fromJournal);
  assert.match(fromJournal, /Is the handoff bounded\?/u);
  assert.match(fromJournal, /Use semantic budgeting/u);
});

test("brief refresh triggers", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-brief-refresh-"));
  const runsDir = join(directory, ".runs");
  const created = initializeCampaign(runsDir, { campaignId: "refresh", goal: "Prove the shared seam" });
  const runDir = join(runsDir, "linked-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done" }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    summary: "1 nodes · 1 done",
    controller: { state: "active" },
    nodes: [{ id: "build", status: "done", phase: "P1" }],
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
  }));
  registerRun(created.path, "linked-run");
  const campaignRef = () => ({ path: created.path, campaign: readCampaign(created.path) });

  assert.equal(renderCampaignHandoffSafely(campaignRef(), runsDir, runDir), true);
  assert.equal(existsSync(join(created.path, BRIEF_FILE)), true);
  assert.equal(existsSync(join(created.path, HANDOFF_FILE)), true);
  const first = readFileSync(join(created.path, BRIEF_FILE), "utf8");
  assert.match(first, /linked-run: 1 nodes · 1 done/u);

  appendJournal(created.path, {
    type: "constraint",
    eventId: "c-refresh",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Refresh the brief with the handoff",
  });
  assert.equal(renderCampaignHandoffSafely(campaignRef(), runsDir, runDir), true);
  const second = readFileSync(join(created.path, BRIEF_FILE), "utf8");
  assert.notEqual(second, first);
  assert.match(second, /Refresh the brief with the handoff/u);
});
