import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deterministicGate } from "../../src/engine/judge-gate.mjs";

/**
 * A Definition of Done command proof that restricts which tests run used to be
 * judged by exit code alone, and node's runner exits 0 when its filter selects
 * nothing: the gate passed a proof that measured nothing. These tests pin the
 * refusal -- filtered commands run with the TAP reporter appended and are
 * refused on the zero-plan line -- and pin that unfiltered commands keep the
 * plain exit-code judgement.
 */

const FIXTURES = {
  "sample.test.mjs": 'import { test } from "node:test";\ntest("real", () => {});\n',
  "print-zero-plan.mjs": 'console.log("1..0");\n',
  "exit-1.mjs": "process.exitCode = 1;\n",
};

/** @returns {string} */
function proofWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "proof-selected-no-test-"));
  for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(directory, name), source);
  return directory;
}

/**
 * Run command proofs through the same deterministic gate the controller uses.
 *
 * @param {string} cwd
 * @param {Array<[string, string]>} proofs id and command string pairs
 */
async function proveAll(cwd, proofs) {
  return deterministicGate(
    {
      definitionOfDone: proofs.map(([id, ref]) => ({
        id,
        text: `proof ${id}`,
        proof: { kind: "command", ref },
      })),
    },
    cwd,
    false,
    30_000,
  );
}

/** @param {Array<{id: string, pass: boolean, detail: string}>} results @param {string} id */
function byId(results, id) {
  const result = results.find((item) => item.id === id);
  assert.ok(result, `proof ${id} produced no result`);
  return result;
}

test("a test filter that matches tests is an ordinary pass", async () => {
  const gate = await proveAll(proofWorkspace(), [
    ["matches", "node --test --test-name-pattern=real sample.test.mjs"],
  ]);
  const result = byId(gate.results, "matches");
  assert.equal(result.pass, true);
  assert.equal(result.detail, "exit 0", "a matching filter keeps the plain exit detail");
  assert.equal(gate.verdict.verdict, "pass");
});

test("a test filter that matches nothing refuses the proof and names the filter", async () => {
  const gate = await proveAll(proofWorkspace(), [
    ["equals-form", "node --test --test-name-pattern=zzz-no-match sample.test.mjs"],
    ["space-form", 'node --test --test-name-pattern "zzz-no-match" sample.test.mjs'],
  ]);
  assert.equal(gate.verdict.verdict, "fail");
  const findings = gate.verdict.findings.map((finding) => finding.description).join("\n");
  for (const id of ["equals-form", "space-form"]) {
    const result = byId(gate.results, id);
    assert.equal(result.pass, false);
    assert.match(result.detail, /zzz-no-match/u, "the detail names the filter value");
    assert.match(result.detail, /selected no test/u);
    assert.doesNotMatch(result.detail, /^exit 0:/u, "not an ordinary command failure: the command succeeded");
    assert.match(findings, new RegExp(`\\[${id}\\]`), "the gate verdict cites the failed item");
  }
});

test("a command with no filter is judged by exit code exactly as before", async () => {
  const gate = await proveAll(proofWorkspace(), [
    // Prints a zero-plan line of its own: with no filter declared, output is
    // not inspected and the command passes on its exit code.
    ["prints-plan", "node print-zero-plan.mjs"],
    ["fails", "node exit-1.mjs"],
  ]);
  const prints = byId(gate.results, "prints-plan");
  assert.equal(prints.pass, true);
  assert.equal(prints.detail, "exit 0");
  const fails = byId(gate.results, "fails");
  assert.equal(fails.pass, false);
  assert.match(fails.detail, /^exit 1/u);
});
