/**
 * Corpus proof, HARNESSES: the `replay` adapter must carry `judgeCandidates`,
 * the provider-boundary count of verdict-shaped final messages.
 *
 * `replay` is the deterministic stand-in for a provider: it replays
 * already-normalized envelopes so everything after normalization can be
 * exercised with zero model calls. `judgeCandidates` is part of that canonical
 * envelope — `ProviderEnvelope` in `src/harnesses/index.mjs` declares it, codex
 * and dsh set it — and `src/contract/review-modes.mjs` reads it to decide that
 * a judge returning several verdicts earns exactly one bounded re-ask. Replay
 * drops it twice over: `canonicalEnvelope` in `src/harnesses/replay/index.mjs`
 * keeps only a fixed field list and discards the key, and the recording schema
 * in `src/harnesses/replay/bin.mjs` refuses the whole line with `envelope has
 * unknown field judgeCandidates`. A two-verdict judge therefore cannot be
 * recorded, and every test of the re-ask path has to use a codex fixture
 * instead of the deterministic stand-in.
 *
 * Fails on the tree before the requirement: the first test normalizes a replay
 * envelope carrying `judgeCandidates: 2` and gets `undefined` back, so the
 * review boundary sees one verdict where the recording said two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderResult } from "../../../src/harnesses/index.mjs";
import { judgeVerdictEvidence } from "../../../src/contract/review-modes.mjs";

const REPLAY_BIN = fileURLToPath(new URL("../../../src/harnesses/replay/bin.mjs", import.meta.url));

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
function recordedEnvelope(overrides = {}) {
  return {
    status: "done",
    result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] }),
    continuationId: null,
    usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 0 },
    costUsd: null,
    error: null,
    ...overrides,
  };
}

/** @param {Record<string, unknown>} envelope @returns {import("../../../src/harnesses/index.mjs").ProviderEnvelope} */
function replay(envelope) {
  return normalizeProviderResult("replay", JSON.stringify(envelope), 0, null);
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} envelope
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runRecording(name, envelope) {
  const directory = mkdtempSync(join(tmpdir(), "replay-judge-candidates-"));
  const recording = join(directory, `${name}.jsonl`);
  writeFileSync(recording, `${JSON.stringify({ envelope })}\n`);
  const result = spawnSync(process.execPath, [REPLAY_BIN, "--recording", recording], { encoding: "utf8", input: "" });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

test("a replayed envelope keeps the verdict count, which is what the review boundary reads", () => {
  const normalized = replay(recordedEnvelope({ judgeCandidates: 2 }));
  assert.equal(normalized.status, "done", "the envelope itself is still a completed turn");
  assert.equal(normalized.judgeCandidates, 2, "the recorded count must survive normalization");
  assert.deepEqual(
    judgeVerdictEvidence(normalized),
    { ok: false, reason: "the judge returned 2 separate verdicts" },
    "two recorded verdicts are the protocol defect the re-ask exists for; with the key dropped the judge looks clean",
  );
});

test("zero is a real count: a judge that returned no verdict keeps it", () => {
  const normalized = replay(recordedEnvelope({ judgeCandidates: 0 }));
  assert.ok(Object.hasOwn(normalized, "judgeCandidates"), "zero is a value, not an absence");
  assert.equal(normalized.judgeCandidates, 0);
  assert.equal(judgeVerdictEvidence(normalized).ok, false, "no verdict is a judge protocol defect, exactly as for a live harness");
});

test("an absent judgeCandidates is not invented on the normalized envelope", () => {
  const normalized = replay(recordedEnvelope());
  assert.equal(Object.hasOwn(normalized, "judgeCandidates"), false, "an optional field must not become an undefined-valued key");
});

test("a malformed judgeCandidates fails the envelope closed as invalid_output", () => {
  for (const malformed of ["two", -1, 1.5]) {
    const normalized = replay(recordedEnvelope({ judgeCandidates: malformed }));
    assert.equal(normalized.status, "failed", `judgeCandidates ${JSON.stringify(malformed)} is not a count`);
    assert.equal(normalized.error?.code, "invalid_output", `judgeCandidates ${JSON.stringify(malformed)} must fail closed, like a malformed usage`);
  }
});

test("the recording schema accepts judgeCandidates and refuses a malformed one", () => {
  const accepted = runRecording("accepted", recordedEnvelope({ judgeCandidates: 2 }));
  assert.equal(accepted.status, 0, accepted.stderr);
  const emitted = JSON.parse(accepted.stdout.trim().split("\n").at(-1) ?? "null");
  assert.equal(emitted.judgeCandidates, 2, "the recorded field reaches the adapter's stdout unchanged");

  const refused = runRecording("refused", recordedEnvelope({ judgeCandidates: "two" }));
  assert.equal(refused.status, 2, "a recording violating the envelope schema exits 2");
  assert.match(refused.stderr, /judgeCandidates/u, "the refusal names the offending field");
});
