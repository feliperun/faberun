import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, isVerdictCandidate } from "../../src/harnesses/protocol.mjs";

// Unit coverage for extractJson/isVerdictCandidate, split out of
// normalize.test.mjs because that file is at its 800-line ceiling.

test("extracts a verdict glued directly to prose on one line", () => {
  // The shape that broke extraction, measured 2026-09-17: a judge's final
  // message with no newline before its JSON, and two nested `findings`
  // objects pushing the bracket count past a naive "first `{` wins" scan.
  // The exact production text (5662 characters) is not reproduced here; this
  // rebuilds its structure — prose immediately followed by `{`, with nested
  // objects inside the verdict — at comparable size.
  const verdict = {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "x".repeat(400),
    findings: [
      { severity: "critical", description: "y".repeat(2500), evidence: "z".repeat(1500) },
      { severity: "critical", description: "w".repeat(900), evidence: "v".repeat(300) },
    ],
  };
  const message = `Confirmed. Now write the verdict JSON.${JSON.stringify(verdict)}`;
  assert.ok(message.length > 5000, "the rebuilt case stays comparable in size to the measured message");
  const extracted = extractJson(message);
  assert.equal(extracted, JSON.stringify(verdict));
  assert.equal(isVerdictCandidate(message), true);
});

test("still extracts a verdict on its own line after prose", () => {
  const message = `I inspected the diff and ran the tests.\n${JSON.stringify({ verdict: "pass" })}`;
  assert.equal(extractJson(message), JSON.stringify({ verdict: "pass" }));
  assert.equal(isVerdictCandidate(message), true);
});

test("returns null for a message with no JSON at all", () => {
  assert.equal(extractJson("Confirmed. No further action needed."), null);
  assert.equal(isVerdictCandidate("Confirmed. No further action needed."), false);
});

test("two verdict objects, one per message, each still count as a candidate", () => {
  const messages = [JSON.stringify({ verdict: "fail" }), JSON.stringify({ verdict: "pass" })];
  const candidates = messages.filter((text) => isVerdictCandidate(text));
  assert.equal(candidates.length, 2, "a genuine change of mind must still be visible as two candidates");
});

test("extracts a fenced JSON block unchanged", () => {
  const message = "Here is the verdict:\n```json\n" + JSON.stringify({ verdict: "fail" }) + "\n```\n";
  assert.equal(extractJson(message), JSON.stringify({ verdict: "fail" }));
});

test("a nested verdict-shaped object glued to prose is still one candidate", () => {
  // Bracket offsets inside the nested `findings` objects must not be mistaken
  // for the outer object's start: the scan backs off to the true outermost
  // `{` when the inner slices fail to parse on their own.
  const message = `Confirmed.${JSON.stringify({ verdict: "fail", findings: [{ severity: "minor", description: "d", evidence: "e" }] })}`;
  const extracted = extractJson(message);
  assert.ok(extracted);
  assert.equal(JSON.parse(extracted).verdict, "fail");
  assert.equal(isVerdictCandidate(message), true);
});
