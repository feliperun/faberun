import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { appendJournal, readJournal } from "../../src/campaign/journal.mjs";
import { GOAL_TEXT_BYTES, JOURNAL_FILE, JOURNAL_TEXT_BYTES } from "../../src/campaign/layout.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// The write path refuses text over the byte cap instead of truncating it: a
// silently shortened entry lies about its own write, so an over-long note is
// the author's to cut. Reading entries that the old write path stored
// truncated must keep working -- they are the record of what was stored.

test("a note one byte over the cap is refused, naming the cap and the size received", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-over-by-one-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "over-by-one", goal: "Prove the refusal" });
  const at = new Date().toISOString();
  assert.throws(
    () => appendJournal(created.path, { type: "intent", eventId: "i1", at, sessionId: "codex-1", text: "N".repeat(JOURNAL_TEXT_BYTES + 1) }),
    (error) => error instanceof TypeError
      && error.message === `entry.text is ${JOURNAL_TEXT_BYTES + 1} bytes, over the ${JOURNAL_TEXT_BYTES}-byte cap; cut 1 bytes and retry`,
    "the message names the received size, the cap, and how much to cut",
  );
  assert.equal(
    readJournal(created.path).some((entry) => entry.eventId === "i1"),
    false,
    "the refused note is not written",
  );
});

test("a note exactly at the cap is stored whole", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-at-cap-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "at-cap", goal: "Prove the boundary" });
  const at = new Date().toISOString();
  const text = "M".repeat(JOURNAL_TEXT_BYTES);
  appendJournal(created.path, { type: "intent", eventId: "i1", at, sessionId: "codex-1", text });
  const stored = readJournal(created.path).find((entry) => entry.eventId === "i1");
  assert.ok(stored, "the note is stored");
  assert.equal(stored.text, text, "not one byte is dropped at the cap");
});

test("a goal over its cap is refused with the same message shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-over-goal-"));
  const runsDir = runsRoot(directory);
  assert.throws(
    () => initializeCampaign(runsDir, { campaignId: "over-goal", goal: "G".repeat(GOAL_TEXT_BYTES + 1) }),
    (error) => error instanceof TypeError
      && error.message === `goal is ${GOAL_TEXT_BYTES + 1} bytes, over the ${GOAL_TEXT_BYTES}-byte cap; cut 1 bytes and retry`,
    "the goal refusal names the received size and the cap like any entry text",
  );
});

test("an entry stored truncated by the old write path still reads back", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-campaign-pre-cap-"));
  const runsDir = runsRoot(directory);
  const created = initializeCampaign(runsDir, { campaignId: "pre-cap", goal: "Prove the read path" });
  const at = new Date().toISOString();
  // The shape the old write path produced: the first bytes of a note that did
  // not fit, closed with the ellipsis, over the cap a current append would
  // refuse. It exists only from before this change.
  const truncated = `${"old ".repeat(520)}…`;
  appendFileSync(join(created.path, JOURNAL_FILE), `${JSON.stringify({ type: "decision", eventId: "d-old", at, sessionId: "codex-1", decisionId: "d-old", text: truncated })}\n`);
  const entry = readJournal(created.path).find((candidate) => candidate.eventId === "d-old");
  assert.ok(entry, "the historical entry is read, not rejected");
  assert.equal(entry.text, truncated, "the stored bytes are returned exactly as stored");
});
