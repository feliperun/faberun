import test from "node:test";
import assert from "node:assert/strict";
import { verificationFailureVerdict } from "../../src/engine/judge-gate.mjs";

/**
 * The deterministic verification failure that reaches an operator as `exit=1`.
 * Node's test runner names the file it ran; when that file is outside the
 * node's declared write scope, the description must say so and say what to fix,
 * because no amount of worker code can change a test the packet withholds.
 */

/**
 * @param {{files?: string[], roots?: string[], fileRoots?: string[]}} boundary
 * @param {string} stderr
 * @returns {Parameters<typeof verificationFailureVerdict>[0]}
 */
function failedState(boundary, stderr) {
  return {
    scope: { boundary },
    verification: {
      commands: [{
        argv: ["node", "--test", "test/cli/cli.test.mjs"],
        passed: false,
        attempts: [{ exitCode: 1, stdout: "", stderr }],
      }],
    },
  };
}

test("verification failure names the undeclared test file", () => {
  const verdict = verificationFailureVerdict(failedState(
    { files: ["src/cli.mjs"], roots: [], fileRoots: [] },
    "test at test/cli/cli.test.mjs:3:1\n",
  ));
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.findings.length, 1);
  const [finding] = verdict.findings;
  // The description names the withheld file and tells the operator that the
  // contract, not the worker's code, is what has to change.
  assert.match(finding.description, /test\/cli\/cli\.test\.mjs/u);
  assert.match(finding.description, /writeFiles/u);
  assert.match(finding.description, /contract/u);
  assert.ok(Buffer.byteLength(finding.description, "utf8") <= 2 * 1024);
  // Evidence keeps exactly the argv and exit code it carried before.
  assert.match(finding.evidence, /node --test test\/cli\/cli\.test\.mjs/u);
  assert.match(finding.evidence, /exit=1/u);
});

test("verification failure keeps the plain message for a declared test file", () => {
  const verdict = verificationFailureVerdict(failedState(
    { files: ["test/cli/cli.test.mjs"], roots: [], fileRoots: [] },
    "test at test/cli/cli.test.mjs:3:1\n",
  ));
  assert.equal(verdict.findings[0].description, "deterministic verification failed");
});

test("verification failure keeps the plain message when no path is recognized", () => {
  const verdict = verificationFailureVerdict(failedState(
    { files: [], roots: [], fileRoots: [] },
    "not a node test location\n",
  ));
  assert.equal(verdict.findings[0].description, "deterministic verification failed");
});
