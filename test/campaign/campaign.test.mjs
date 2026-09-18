import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addContractToCampaign,
  assertContractManifestIntact,
  authoredContractDigest,
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  parkCampaign,
  promoteRunInCampaign,
  recordPromotion,
  registerRun,
  renderHandoff,
  replaceContractInCampaign,
  resolveCampaign,
} from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { appendJournal, appendSeatAllowanceEvent, readJournal, validateJournalEntry } from "../../src/campaign/journal.mjs";
import { CAMPAIGN_FILE, HANDOFF_BYTES, HANDOFF_FILE, JOURNAL_FILE, JOURNAL_TEXT_BYTES, PROJECTION_FILE } from "../../src/campaign/layout.mjs";
import { allowanceEventFields } from "../../src/seat/allowance.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// Campaign lifecycle: init, discover, resolve, journal append, close.
// Projection and handoff rendering are in projection.test.mjs.

test("semantic budget keeps critical sections and evicts oldest low-priority history above 16 KiB", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-budget-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "budget", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId, decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });

  mkdirSync(join(runsDir, "attention-run", "nodes"), { recursive: true });
  writeFileSync(join(runsDir, "attention-run", "nodes", "a.json"), JSON.stringify({ id: "a", status: "failed", error: { message: "boom" } }));
  writeFileSync(join(runsDir, "attention-run", "nodes", "b.json"), JSON.stringify({ id: "b", status: "done" }));
  registerRun(created.path, "attention-run");

  for (let index = 0; index < 4; index += 1) {
    appendJournal(created.path, { type: "intent", eventId: `i-${index}`, at, sessionId, text: `intent-${String(index).padStart(3, "0")} ${"B".repeat(2040)}` });
  }
  for (let index = 0; index < 10; index += 1) {
    appendJournal(created.path, { type: "outcome", eventId: `o-${index}`, at, sessionId, text: `outcome-${String(index).padStart(3, "0")} ${"A".repeat(2040)}` });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /\[d1\] Use semantic budgeting/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.match(handoff, /codex codex-1/u);
  assert.match(handoff, /attention-run: 2 nodes · 1 failed · 1 done/u);
  assert.match(handoff, /a: failed · boom/u);
  assert.doesNotMatch(handoff, /outcome-000 /u);
  assert.match(handoff, /outcome-009 /u);
  assert.match(handoff, /earlier attempts and outcomes omitted/u);
});

test("many linked runs cannot starve critical handoff sections", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-run-flood-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "runflood", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId, decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });
  for (let index = 0; index < 600; index += 1) {
    const runId = `run-${String(index).padStart(3, "0")}`;
    mkdirSync(join(runsDir, runId, "nodes"), { recursive: true });
    writeFileSync(join(runsDir, runId, "nodes", "node.json"), JSON.stringify({ id: "node", status: "done" }));
    registerRun(created.path, runId);
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Ship the durable handoff/u);
  assert.match(handoff, /## Latest next action/u);
  // Stamped with session and timestamp so a superseded next action is visibly stale.
  assert.match(handoff, /- Render the next handoff[^\n]* · [^\n]+ · \d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
  assert.match(handoff, /## Session lineage/u);
  assert.match(handoff, /codex codex-1/u);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /\[d1\] Use semantic budgeting/u);
  assert.match(handoff, /## User constraints/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /## Open questions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.match(handoff, /run-599: 1 nodes · 1 done/u);
  assert.doesNotMatch(handoff, /run-000:/u);
  assert.match(handoff, /earlier run summaries omitted/u);
});

test("attention-needed run states survive budget pressure with an omission note", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-attention-flood-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "attention", goal: "Preserve attention states" });
  registerRun(created.path, "flood-run");
  mkdirSync(join(runsDir, "flood-run", "nodes"), { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    writeFileSync(
      join(runsDir, "flood-run", "nodes", `node-${String(index).padStart(3, "0")}.json`),
      JSON.stringify({ id: `node-${String(index).padStart(3, "0")}`, status: "failed", error: { message: "N".repeat(200) } }),
    );
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /- flood-run: 400 nodes · 400 failed/u);
  assert.match(handoff, /node-399: failed/u);
  assert.doesNotMatch(handoff, /node-000: failed/u);
  assert.match(handoff, /earlier attention-needed run states omitted/u);
});

test("active decisions and unresolved questions beyond twenty are preserved when they fit", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-beyond-cap-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "beyond", goal: "Prove no silent truncation" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  for (let index = 0; index < 30; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(2, "0")}`,
    });
    appendJournal(created.path, {
      type: "open-question", eventId: `q-${index}`, at, sessionId,
      questionId: `q-${index}`, text: `question-${String(index).padStart(2, "0")}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /\[d-0\] decision-00/u);
  assert.match(handoff, /\[d-29\] decision-29/u);
  assert.match(handoff, /question-00/u);
  assert.match(handoff, /question-29/u);
  assert.doesNotMatch(handoff, /earlier active decisions omitted/u);
  assert.doesNotMatch(handoff, /earlier open questions omitted/u);
});

test("decisions evicted by the projection cap still produce an omission summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-evicted-decisions-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "evicted", goal: "Prove eviction summary" });
  const at = new Date().toISOString();
  for (let index = 0; index < 120; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId: "codex-1",
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /\[d-119\] decision-119/u);
  assert.doesNotMatch(handoff, /\[d-19\] decision-019/u);
  assert.match(handoff, /- 20 earlier active decisions omitted/u);
});

test("a critical section larger than the whole budget keeps its latest entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-critical-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "critical", goal: "Ship the durable handoff" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  // 20 active decisions at ~2 KiB each: the section alone exceeds the 16 KiB budget.
  for (let index = 0; index < 20; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")} ${"C".repeat(2040)}`,
    });
  }

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /\[d-19\] decision-019/u);
  assert.doesNotMatch(handoff, /\[d-0\] decision-000/u);
  assert.match(handoff, /earlier active decisions omitted/u);
});

test("fitHandoff shrinks entry text until every critical entry survives", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-shrink-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "shrink", goal: "Preserve every critical entry" });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "transcript.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  // 20 large active decisions exhaust the budget for later critical sections.
  for (let index = 0; index < 20; index += 1) {
    appendJournal(created.path, {
      type: "decision", eventId: `d-${index}`, at, sessionId,
      decisionId: `d-${index}`, text: `decision-${String(index).padStart(3, "0")} ${"C".repeat(2040)}`,
    });
  }
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId, text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId, questionId: "q1", text: "Is the handoff bounded?" });

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /Is the handoff bounded\?/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});

test("oldest low-priority history is evicted first with a bounded omission summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-evict-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "evict", goal: "Prove eviction" });
  const at = new Date().toISOString();
  for (let index = 0; index < 25; index += 1) {
    appendJournal(created.path, {
      type: "outcome", eventId: `out-${index}`, at, sessionId: "codex-1",
      text: `outcome-${String(index).padStart(3, "0")} ${"A".repeat(2040)}`,
    });
  }
  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.doesNotMatch(handoff, /outcome-000 /u);
  assert.match(handoff, /outcome-024 /u);
  assert.match(handoff, /earlier attempts and outcomes omitted/u);
});

test("resolved questions leave the active handoff projection", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-question-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "questions", goal: "Prove resolution" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "What is the budget?" });
  appendJournal(created.path, { type: "open-question", eventId: "q2", at, sessionId: "codex-1", questionId: "q2", text: "Who owns discovery?" });
  appendJournal(created.path, { type: "question.resolved", eventId: "r1", at, sessionId: "codex-1", questionId: "q1", text: "16 KiB, semantically" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.match(handoff, /Who owns discovery\?/u);
  assert.doesNotMatch(handoff, /What is the budget\?/u);
  assert.doesNotMatch(handoff, /16 KiB, semantically/u);
});

test("campaigns close and implicit discovery considers only active campaigns", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-close-"));
  const runsDir = runsRoot(directory);
  initializeCampaign(runsDir, { campaignId: "alpha", goal: "First" });
  const beta = initializeCampaign(runsDir, { campaignId: "beta", goal: "Second" });
  assert.throws(() => closeCampaign(beta.path), /no recorded retrospective/u);
  appendJournal(beta.path, {
    type: "retrospective",
    eventId: "beta-retro",
    at: new Date().toISOString(),
    sessionId: "codex-1",
    text: "Retrospective: shipped Second; no follow-ups.",
  });
  const closed = closeCampaign(beta.path);
  assert.equal(closed.campaign.status, "closed");
  assert.equal(resolveCampaign(runsDir).campaign.id, "alpha");
  assert.throws(() => closeCampaign(beta.path), /already closed/u);
  assert.throws(() => registerRun(beta.path, "late-run"), /closed/u);
  const { campaigns } = discoverCampaigns(runsDir);
  const betaEntry = campaigns.find((entry) => entry.campaign.id === "beta");
  assert.ok(betaEntry, "beta campaign discovered");
  assert.equal(betaEntry.campaign.status, "closed");
  const journal = readJournal(beta.path);
  const last = journal.at(-1);
  assert.ok(last, "journal has a closing entry");
  assert.equal(last.type, "campaign.closed");
});

test("corrupt campaign entries are surfaced instead of silently dropped", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-corrupt-"));
  const runsDir = runsRoot(directory);
  initializeCampaign(runsDir, { campaignId: "good", goal: "Healthy" });
  mkdirSync(join(runsDir, "campaigns", "bad"), { recursive: true });
  writeFileSync(join(runsDir, "campaigns", "bad", "campaign.json"), "{ not json");
  mkdirSync(join(runsDir, "campaigns", "nocamp"), { recursive: true });
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  assert.equal(campaigns.length, 1);
  assert.deepEqual(corrupt.map((entry) => entry.id).sort(), ["bad", "nocamp"]);
  assert.throws(() => resolveCampaign(runsDir), /corrupt campaign entries: bad, nocamp/u);
});

test("journal appends are idempotent by event id", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-dedupe-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "dedupe", goal: "Prove idempotency" });
  const at = new Date().toISOString();
  const first = appendJournal(created.path, { type: "intent", eventId: "intent-retry", at, sessionId: "codex-1", text: "Material intent" });
  const second = appendJournal(created.path, { type: "intent", eventId: "intent-retry", at, sessionId: "codex-1", text: "Material intent" });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const journal = readJournal(created.path);
  assert.equal(journal.filter((entry) => entry.type === "intent").length, 1);
  const handoff = renderHandoff(created.path, runsDir);
  assert.equal(handoff.match(/Material intent/gu)?.length ?? 0, 1);
});

test("liveness journal entries validate, dedupe by event id and stay out of the projection and handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-liveness-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "amb", goal: "Prove ambient facts stay out of the handoff" });
  const at = new Date().toISOString();
  const fact = {
    type: "liveness",
    eventId: "live-1",
    at,
    campaignId: "amb",
    runId: "run-1",
    nodeId: "node-1",
    phase: "P2",
    checkpointsDone: 3,
    checkpointsTotal: 7,
    runtime: "codex",
    state: "running",
    lastProgressAt: at,
    attention: null,
  };
  assert.doesNotThrow(() => validateJournalEntry(fact));
  const first = appendJournal(created.path, fact);
  const second = appendJournal(created.path, { ...fact, eventId: "live-1" });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const journal = readJournal(created.path);
  assert.equal(journal.filter((entry) => entry.type === "liveness").length, 1);
  assert.throws(
    () => appendJournal(created.path, { ...fact, eventId: "live-2", extra: "not allowed" }),
    (error) => error instanceof TypeError && /unexpected field extra/u.test(error.message),
  );
  appendJournal(created.path, { type: "intent", eventId: "i-1", at, sessionId: "codex-1", text: "Continue after liveness" });
  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(existsSync(join(created.path, PROJECTION_FILE)));
  const projection = JSON.parse(readFileSync(join(created.path, PROJECTION_FILE), "utf8"));
  assert.doesNotMatch(JSON.stringify(projection.projection), /live-1|node-1/u);
  assert.match(handoff, /Continue after liveness/u);
  assert.doesNotMatch(handoff, /live-1|node-1/u);
  const handoffFile = readFileSync(join(created.path, HANDOFF_FILE), "utf8");
  assert.doesNotMatch(handoffFile, /live-1|node-1/u);
});

test("readJournal ignores the pre-diet weightedUsed and weightedCap fields on a historical liveness fact", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-legacy-liveness-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "legacy", goal: "Keep an old journal readable" });
  const at = new Date().toISOString();
  const legacyLine = JSON.stringify({
    type: "liveness",
    eventId: "live-legacy-1",
    at,
    campaignId: "legacy",
    runId: "run-1",
    nodeId: "scope-advisory",
    phase: "worker",
    checkpointsDone: 0,
    checkpointsTotal: 3,
    runtime: "sonnet",
    state: "running",
    weightedUsed: 0,
    weightedCap: 6_000_000,
    lastProgressAt: at,
    attention: null,
  });
  appendFileSync(join(created.path, JOURNAL_FILE), `${legacyLine}\n`);
  const journal = readJournal(created.path);
  const entry = journal.find((item) => item.eventId === "live-legacy-1");
  assert.ok(entry, "the legacy liveness line is read, not rejected");
  assert.equal(/** @type {Record<string, unknown>} */ (entry).weightedUsed, undefined, "the legacy field is dropped, not carried forward");
});

test("handoff projection recovers from deletion and corruption", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-projection-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "proj", goal: "Prove recovery" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Keep the journal" });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId: "codex-1", text: "Recover the projection" });
  const first = renderHandoff(created.path, runsDir);
  assert.ok(existsSync(join(created.path, PROJECTION_FILE)));
  assert.match(first, /Keep the journal/u);
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Append-only" });
  const second = renderHandoff(created.path, runsDir);
  assert.match(second, /Append-only/u);
  unlinkSync(join(created.path, PROJECTION_FILE));
  assert.equal(renderHandoff(created.path, runsDir), second);
  writeFileSync(join(created.path, PROJECTION_FILE), "{ not json");
  assert.equal(renderHandoff(created.path, runsDir), second);
});

test("journal text is normalized and bounded so entries cannot inject headings", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-normalize-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "normalize", goal: "Prove normalization" });
  const at = new Date().toISOString();
  appendJournal(created.path, { type: "intent", eventId: "i1", at, sessionId: "codex-1", text: "## Fake heading\nline two" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "X".repeat(10000) });
  const journal = readJournal(created.path);
  const constraint = journal.find((entry) => entry.type === "constraint");
  assert.ok(constraint, "constraint entry present");
  assert.ok(constraint.text !== undefined, "constraint entry has text");
  assert.ok(Buffer.byteLength(constraint.text, "utf8") <= JOURNAL_TEXT_BYTES);
  const handoff = renderHandoff(created.path, runsDir);
  assert.doesNotMatch(handoff, /^## Fake/mu);
  assert.match(handoff, /Fake heading line two/u);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
});

test("attention-needed linked-run states survive when critical sections exhaust the budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-attention-critical-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "attentioncritical", goal: "G".repeat(4000) });
  const at = new Date().toISOString();
  const sessionId = "codex-1";
  appendJournal(created.path, {
    type: "session.attached", eventId: "s1", at, sessionId, tool: "codex",
    transcript: join(directory, "t.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
  });
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId, text: "Render the next handoff" });
  for (let index = 0; index < 100; index += 1) {
    appendJournal(created.path, { type: "decision", eventId: `d-${index}`, at, sessionId, decisionId: `d-${index}`, text: `decision-${index} ${"C".repeat(2040)}` });
    appendJournal(created.path, { type: "open-question", eventId: `q-${index}`, at, sessionId, questionId: `q-${index}`, text: `question-${index} ${"D".repeat(2040)}` });
  }
  for (let index = 0; index < 60; index += 1) {
    appendJournal(created.path, { type: "constraint", eventId: `c-${index}`, at, sessionId, text: `constraint-${index} ${"E".repeat(2040)}` });
  }
  mkdirSync(join(runsDir, "attention-run", "nodes"), { recursive: true });
  writeFileSync(join(runsDir, "attention-run", "nodes", "a.json"), JSON.stringify({ id: "a", status: "failed", error: { message: "boom" } }));
  registerRun(created.path, "attention-run");

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Linked runs/u);
  assert.match(handoff, /attention-run: 1 nodes · 1 failed/u);
  assert.match(handoff, /a: failed · boom/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});

test("large valid identifiers cannot starve later critical sections", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-large-ids-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "largeids", goal: "Ship" });
  const at = new Date().toISOString();
  const big = "Y".repeat(20000);
  for (let index = 0; index < 60; index += 1) {
    appendJournal(created.path, {
      type: "session.attached", eventId: `s-${index}`, at, sessionId: `${big}-${index}`, tool: "codex",
      transcript: join(directory, "t.jsonl"), transcriptUnavailable: false, format: "jsonl", cursor: "1",
    });
  }
  appendJournal(created.path, { type: "next", eventId: "n1", at, sessionId: "codex-1", text: "Render the next handoff" });
  appendJournal(created.path, { type: "decision", eventId: "d1", at, sessionId: "codex-1", decisionId: "d1", text: "Use semantic budgeting" });
  appendJournal(created.path, { type: "constraint", eventId: "c1", at, sessionId: "codex-1", text: "Never drop active decisions" });
  appendJournal(created.path, { type: "open-question", eventId: "q1", at, sessionId: "codex-1", questionId: "q1", text: "Is the handoff bounded?" });

  const handoff = renderHandoff(created.path, runsDir);
  assert.ok(Buffer.byteLength(handoff, "utf8") <= HANDOFF_BYTES);
  assert.match(handoff, /## Latest next action/u);
  assert.match(handoff, /Render the next handoff/u);
  assert.match(handoff, /## Session lineage/u);
  assert.match(handoff, /## Active decisions/u);
  assert.match(handoff, /Use semantic budgeting/u);
  assert.match(handoff, /## User constraints/u);
  assert.match(handoff, /Never drop active decisions/u);
  assert.match(handoff, /## Open questions/u);
  assert.doesNotMatch(handoff, /none fits the remaining budget/u);
});

// ---------------------------------------------------------------------------
// The chain's campaign fields: an ordered contract manifest, a landing branch,
// and a durable promotion record (phase 3, rule 1).
// ---------------------------------------------------------------------------

test("a campaign carries an ordered contract manifest and a landing branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-manifest-"));
  const runsDir = runsRoot(directory);
  const contracts = [
    { path: join(directory, "phase-1.json"), digest: "a".repeat(64) },
    { path: join(directory, "phase-2.json"), digest: "b".repeat(64) },
  ];
  const created = initializeCampaign(runsDir, {
    campaignId: "manifest",
    goal: "Chain three contracts",
    contracts,
    landBranch: "campaign/custom",
  });
  assert.deepEqual(created.campaign.contracts, contracts, "the manifest keeps its authored order and digests");
  assert.equal(created.campaign.landBranch, "campaign/custom");
  const reread = readCampaign(created.path);
  assert.deepEqual(reread.contracts, contracts);
  assert.equal(reread.landBranch, "campaign/custom");
  assert.deepEqual(reread.promotions, []);

  // The default is never main.
  const other = initializeCampaign(runsDir, { campaignId: "defaulted", goal: "Default the branch" });
  assert.equal(other.campaign.landBranch, "campaign/defaulted");
  assert.deepEqual(other.campaign.contracts, []);
});

test("a malformed contract manifest is refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-manifest-bad-"));
  const runsDir = runsRoot(directory);
  assert.throws(
    () => initializeCampaign(runsDir, { campaignId: "bad-digest", goal: "g", contracts: [{ path: "/tmp/x.json", digest: "not-a-sha" }] }),
    /digest must be a SHA-256 hash/u,
  );
  assert.throws(
    () => initializeCampaign(runsDir, { campaignId: "bad-path", goal: "g", contracts: [{ path: "", digest: "a".repeat(64) }] }),
    /path must be a non-empty string/u,
  );
});

test("the manifest digest is the contract's authored bytes and refuses tampering", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-authored-"));
  const contractPath = join(directory, "contract.json");
  writeFileSync(contractPath, "{}\n");
  const entry = { path: contractPath, digest: authoredContractDigest(contractPath) };
  assert.doesNotThrow(() => assertContractManifestIntact(entry));
  writeFileSync(contractPath, "{ \"tampered\": true }\n");
  assert.throws(
    () => assertContractManifestIntact(entry),
    (/** @type {Error & {code?: string}} */ error) => error.code === "contract_authored_bytes_changed" && /changed after it was authored/u.test(error.message),
  );
});

test("recording a promotion is idempotent by run and sha", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-promotion-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "promote", goal: "Record a promotion" });
  const at = new Date().toISOString();
  const entry = { runId: "run-1", branch: "campaign/promote", sha: "c".repeat(40), previousSha: "d".repeat(40), at };
  recordPromotion(path, entry);
  recordPromotion(path, entry);
  const campaign = readCampaign(path);
  assert.equal(campaign.promotions.length, 1);
  assert.equal(campaign.promotions[0].sha, entry.sha);
});

test("promoting the same run twice through the campaign records one promotion", () => {
  const repo = mkdtempSync(join(tmpdir(), "runner-campaign-promote-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "test"], { stdio: "ignore" });
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "commit.gpgSign=false", "commit", "-qm", "base"], { stdio: "ignore" });
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "run.txt"), "run\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "commit.gpgSign=false", "commit", "-qm", "run"], { stdio: "ignore" });
  const runHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const runsDir = runsRoot(mkdtempSync(join(tmpdir(), "runner-campaign-promote-")));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "promote-twice", goal: "Promote once, replay once" });

  const first = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(first.status, "promoted");
  const second = promoteRunInCampaign({ campaignPath, repo, runId: "run-1", runHead, baseSha: base, finalVerificationPassed: true });
  assert.equal(second.status, "already_promoted");

  const promotions = readCampaign(campaignPath).promotions;
  assert.equal(promotions.length, 1, "a replayed promotion does not add a second record");
});

test("campaign init's seat.allowance start event carries the window field when a sample is available", () => {
  // `campaign init` (src/cli/campaign.mjs) builds this event through
  // `allowanceEventFields` exactly this way; this proves the window a sample
  // measured reaches the journal rather than being dropped at the call site.
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-allowance-window-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "allowance-window", goal: "Prove campaign init threads the sampled window" });
  const sample = { remaining: 0.23, limit: 1, resetsAt: "2026-09-17T00:00:00.000Z", window: "seven_day" };
  appendSeatAllowanceEvent(created.path, { sample: "start", harness: "claude", delta: null, ...allowanceEventFields(sample) });

  const startEvent = /** @type {any[]} */ (readJournal(created.path)).find((event) => event.type === "seat.allowance" && event.sample === "start");
  assert.ok(startEvent, "seat.allowance start event recorded");
  assert.equal(startEvent.window, "seven_day");
});

test("a parked campaign records attention and refuses a malformed one", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-attention-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "parked", goal: "Park with attention" });
  const at = new Date().toISOString();
  parkCampaign(path, {
    code: "run_parked",
    message: "contract c run parked: node build failed [boom]",
    at,
    contractId: "c",
    node: "build",
    status: "failed",
  });
  const campaign = readCampaign(path);
  assert.equal(campaign.status, "active", "a parked campaign stays active until an operator closes it");
  assert.equal(campaign.attention?.code, "run_parked");
  assert.equal(campaign.attention?.node, "build");
  assert.equal(campaign.attention?.status, "failed");
  assert.equal(campaign.updatedAt, at);

  const record = JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8"));
  record.attention = { code: "run_parked", at };
  writeFileSync(join(path, CAMPAIGN_FILE), JSON.stringify(record));
  assert.throws(() => readCampaign(path), /campaign\.attention\.message/u);
});

// ---------------------------------------------------------------------------
// A contract can join an active campaign, or replace one, without a hand
// edit of campaign.json (state-location-and-routing-economics phase 1f).
// ---------------------------------------------------------------------------

test("adding a contract to an active campaign leaves the manifest intact", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-add-contract-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "add", goal: "Add a contract" });
  const contractPath = join(directory, "phase-1.json");
  writeFileSync(contractPath, "{}\n");

  const { campaign, added } = addContractToCampaign(path, contractPath);
  assert.equal(added, true);
  assert.equal(campaign.contracts.length, 1);
  assert.equal(campaign.contracts[0].path, contractPath);
  assert.doesNotThrow(() => assertContractManifestIntact(campaign.contracts[0]), "the manifest entry the product's own integrity check accepts");

  const reread = readCampaign(path);
  assert.deepEqual(reread.contracts, campaign.contracts);
});

test("adding the same contract twice is not an error", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-add-contract-twice-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "add-twice", goal: "Add a contract twice" });
  const contractPath = join(directory, "phase-1.json");
  writeFileSync(contractPath, "{}\n");

  const first = addContractToCampaign(path, contractPath);
  assert.equal(first.added, true);
  const second = addContractToCampaign(path, contractPath);
  assert.equal(second.added, false, "the same path with unchanged bytes writes nothing");
  assert.equal(readCampaign(path).contracts.length, 1, "the manifest is not duplicated");
});

test("adding a contract path that does not exist fails with a message naming the path", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-add-contract-missing-"));
  const runsDir = runsRoot(directory);
  const { path } = initializeCampaign(runsDir, { campaignId: "add-missing", goal: "Add a missing contract" });
  const missing = join(directory, "does-not-exist.json");

  assert.throws(
    () => addContractToCampaign(path, missing),
    (/** @type {Error} */ error) => !(error instanceof TypeError) && error.message === `contract not found: ${missing}`,
  );
});

test("replacing a contract swaps the entry and drops the attention that named it", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-replace-contract-"));
  const runsDir = runsRoot(directory);
  const oldPath = join(directory, "phase-2.json");
  writeFileSync(oldPath, "{}\n");
  const { path } = initializeCampaign(runsDir, {
    campaignId: "replace",
    goal: "Replace a contract",
    contracts: [{ path: oldPath, digest: authoredContractDigest(oldPath) }],
  });
  const at = new Date().toISOString();
  parkCampaign(path, {
    code: "run_parked",
    message: "contract phase-2 run parked: node build failed [boom]",
    at,
    contractPath: oldPath,
    contractId: "phase-2",
    runId: "phase-2",
    node: "build",
    status: "failed",
  });
  assert.ok(readCampaign(path).attention, "the campaign is parked before the replace");

  const newPath = join(directory, "phase-2-fixed.json");
  writeFileSync(newPath, "{ \"fixed\": true }\n");
  const { campaign, replaced, clearedAttention } = replaceContractInCampaign(path, oldPath, newPath);
  assert.equal(replaced.path, newPath);
  assert.equal(replaced.digest, authoredContractDigest(newPath));
  assert.equal(campaign.contracts.length, 1);
  assert.equal(campaign.contracts[0].path, newPath);
  assert.ok(clearedAttention, "the attention naming the replaced contract is reported as cleared");
  assert.equal(clearedAttention?.code, "run_parked");

  const reread = readCampaign(path);
  assert.equal(reread.attention, undefined, "the campaign is no longer parked");
});

test("replacing a contract that does not match the parked attention leaves it in place", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-replace-contract-unrelated-attention-"));
  const runsDir = runsRoot(directory);
  const oldPath = join(directory, "phase-1.json");
  writeFileSync(oldPath, "{}\n");
  const { path } = initializeCampaign(runsDir, {
    campaignId: "replace-unrelated",
    goal: "Replace a contract that is not the parked one",
    contracts: [{ path: oldPath, digest: authoredContractDigest(oldPath) }],
  });
  const at = new Date().toISOString();
  parkCampaign(path, {
    code: "run_parked",
    message: "contract other run parked: node build failed [boom]",
    at,
    contractPath: join(directory, "other.json"),
    contractId: "other",
    node: "build",
    status: "failed",
  });

  const newPath = join(directory, "phase-1-fixed.json");
  writeFileSync(newPath, "{ \"fixed\": true }\n");
  const { clearedAttention } = replaceContractInCampaign(path, oldPath, newPath);
  assert.equal(clearedAttention, null);
  assert.ok(readCampaign(path).attention, "an attention naming a different contract is left alone");
});

test("replacing a contract path that does not exist fails with a message naming the path", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-replace-contract-missing-"));
  const runsDir = runsRoot(directory);
  const oldPath = join(directory, "phase-1.json");
  writeFileSync(oldPath, "{}\n");
  const { path } = initializeCampaign(runsDir, {
    campaignId: "replace-missing",
    goal: "Replace with a missing contract",
    contracts: [{ path: oldPath, digest: authoredContractDigest(oldPath) }],
  });
  const missing = join(directory, "does-not-exist.json");

  assert.throws(
    () => replaceContractInCampaign(path, oldPath, missing),
    (/** @type {Error} */ error) => !(error instanceof TypeError) && error.message === `contract not found: ${missing}`,
  );
});
