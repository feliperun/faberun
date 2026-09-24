/**
 * Proof for the NOTIFY requirement: `appendInbox` in `src/notify/index.mjs`
 * must refuse an event whose `summary` is not a non-empty string, exactly as
 * it already refuses one with no `dedupeKey`.
 *
 * `InboxEntry` declares `summary`, and `JSON.stringify` drops an `undefined`
 * value, so a caller that omits it commits a record with no `summary` key at
 * all; `renderAgentSignalBlock` (`src/repo/signal.mjs`) then reads that key and
 * fails. The proof writes only into fresh temp directories and reads no clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInbox, readInbox } from "../../../src/notify/index.mjs";

/** @param {string} prefix @returns {string} */
function runsDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("appendInbox refuses an entry with no summary and commits nothing", () => {
  const dir = runsDir("inbox-no-summary-");
  assert.throws(
    () => appendInbox(dir, { type: "attention", campaignId: "c1", dedupeKey: "attention:c1:r1:build" }),
    /summary/u,
  );
  assert.equal(existsSync(join(dir, "inbox.jsonl")), false, "a refused entry must not create the inbox");
});

test("appendInbox refuses an empty summary", () => {
  const dir = runsDir("inbox-empty-summary-");
  assert.throws(
    () => appendInbox(dir, { type: "attention", campaignId: "c1", dedupeKey: "attention:c1:r1:build", summary: "" }),
    /summary/u,
  );
  assert.equal(existsSync(join(dir, "inbox.jsonl")), false, "a refused entry must not create the inbox");
});

test("a valid event still appends and the committed entry carries its summary", () => {
  const dir = runsDir("inbox-valid-summary-");
  const appended = appendInbox(dir, {
    type: "attention",
    campaignId: "c1",
    dedupeKey: "attention:c1:r1:build",
    summary: "node build needs you · run r1 · judge_unavailable",
  });
  assert.equal(appended.appended, true);
  const [entry] = readInbox(dir);
  assert.ok(Object.hasOwn(entry, "summary"), "every committed entry carries the schema's summary");
  assert.equal(entry.summary, "node build needs you · run r1 · judge_unavailable");
});
