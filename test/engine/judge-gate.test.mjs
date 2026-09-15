import test from "node:test";
import assert from "node:assert/strict";
import { judgeRequired, judgeSkippedByScope, verificationFailureVerdict } from "../../src/engine/judge-gate.mjs";
import { judgePrompt } from "../../src/engine/prompts.mjs";

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

/**
 * The `skipWhen` rule from Phase 6: both conditions must hold to skip the judge
 * even when a Definition of Done item carries `judgment: true`. One test per
 * half, plus one proving it composes with `reviewMode` rather than replacing a
 * gate whose review mode is `none`.
 */

/**
 * A gated node carrying one judgment item and a `skipWhen` rule, typed so the
 * two predicates can both accept it.
 *
 * @param {"none"|"advisory"|"blocking"} review
 * @returns {{definitionOfDone: import("../../src/contract/definition-of-done.mjs").DefinitionOfDoneItem[], gate: {review: "none"|"advisory"|"blocking", enabled: true, skipWhen: {verificationGreen: true, maxChangedPaths: number}}}}
 */
function skipNode(review) {
  return {
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
    gate: { review, enabled: true, skipWhen: { verificationGreen: true, maxChangedPaths: 2 } },
  };
}

test("skipWhen skips the judge when verification is green and the change is small, even with a judgment item", () => {
  const node = skipNode("blocking");
  // The ordinary rule does require a judge for this node; skipWhen is what
  // overrides it, and it is the only reason the judge is skipped.
  assert.equal(judgeRequired(node), true, "a judgment item under a blocking gate would normally be judged");
  assert.equal(judgeSkippedByScope(node, { verification: { passed: true }, scope: { changedPaths: ["a", "b"] } }), true);
});

test("skipWhen falls through when either condition fails and ordinary judgment logic applies", () => {
  const node = skipNode("blocking");
  // Red verification: the skip does not fire even though the change is small.
  assert.equal(judgeSkippedByScope(node, { verification: { passed: false }, scope: { changedPaths: ["a"] } }), false);
  // Too many changed paths: the skip does not fire even though verification is green.
  assert.equal(judgeSkippedByScope(node, { verification: { passed: true }, scope: { changedPaths: ["a", "b", "c"] } }), false);
  // A missing scope count is not a small change; the ordinary rule still runs.
  assert.equal(judgeSkippedByScope(node, { verification: { passed: true }, scope: null }), false);
  // A gate with no skipWhen is unchanged.
  assert.equal(judgeSkippedByScope(/** @type {any} */ ({ gate: { review: "blocking" } }), { verification: { passed: true }, scope: { changedPaths: [] } }), false);
});

test("skipWhen composes with reviewMode instead of replacing a review mode of none", () => {
  const node = skipNode("none");
  // The gate settles mechanically because its review mode is none; skipWhen is
  // irrelevant to that outcome and must not make the node look judged.
  assert.equal(judgeRequired(node), false);
  assert.equal(judgeSkippedByScope(node, { verification: { passed: false }, scope: { changedPaths: ["a", "b", "c"] } }), false);
  assert.equal(judgeSkippedByScope(node, { verification: { passed: true }, scope: { changedPaths: [] } }), true);
});

/**
 * The judge prompt's verification evidence: green commands send `{argv,
 * passed}`, red commands send a bounded output tail, and the whole prompt stays
 * inside the 64 KiB dispatch guard even when the recorded verification state is
 * far larger.
 */

/** @returns {Parameters<typeof judgePrompt>[0]} */
function promptNode() {
  return {
    id: "build",
    definitionOfDone: [],
    taskPacket: { mode: "execution", objective: "Prove the prompt stays bounded", instructions: [], writeFiles: ["README.md"], verification: [{ argv: ["true"] }] },
  };
}

test("the judge prompt carries argv and passed for green commands and no output bodies", () => {
  const verification = {
    passed: true,
    commands: [
      { argv: ["node", "--test", "a"], passed: true, attempts: [{ exitCode: 0, stdout: "GREEN-STDOUT-BODY", stderr: "GREEN-STDERR-BODY" }] },
      { argv: ["true"], passed: true, attempts: [{ exitCode: 0, stdout: "x".repeat(4096) }] },
    ],
  };
  const prompt = judgePrompt(promptNode(), null, { verification });
  assert.match(prompt, /"argv":\["node","--test","a"\],"passed":true/u);
  assert.doesNotMatch(prompt, /GREEN-STDOUT-BODY/u, "a green command's stdout is not sent");
  assert.doesNotMatch(prompt, /GREEN-STDERR-BODY/u, "a green command's stderr is not sent");
  assert.doesNotMatch(prompt, /"stdout"/u, "green commands carry no output field at all");
  assert.doesNotMatch(prompt, /"stderr"/u, "green commands carry no output field at all");
});

test("the judge prompt carries the bounded tail of a red command", () => {
  const verification = {
    passed: false,
    commands: [
      { argv: ["false"], passed: false, attempts: [{ exitCode: 1, timedOut: false, stdout: "RED-STDOUT-TAIL", stderr: "RED-STDERR-TAIL" }] },
    ],
  };
  const prompt = judgePrompt(promptNode(), null, { verification });
  assert.match(prompt, /RED-STDOUT-TAIL/u);
  assert.match(prompt, /RED-STDERR-TAIL/u);
  assert.match(prompt, /"exitCode":1/u);
});

test("a verification set that would overflow the judge-prompt guard is bounded to fit", () => {
  // Seven commands, each with three attempts carrying the full 2 KiB per stream
  // the state records: the raw state is well past the 64 KiB dispatch guard.
  const commands = Array.from({ length: 7 }, (_value, index) => ({
    argv: ["cmd", String(index)],
    passed: false,
    attempts: Array.from({ length: 3 }, (_attempt, attempt) => ({
      exitCode: 1,
      stdout: "o".repeat(2048),
      stderr: "e".repeat(2048),
      timedOut: false,
    })),
  }));
  const verification = { passed: false, commands };
  const rawBytes = Buffer.byteLength(JSON.stringify(verification), "utf8");
  assert.ok(rawBytes > 64 * 1024, `the raw verification state exceeds 64 KiB (${rawBytes})`);
  const prompt = judgePrompt(promptNode(), null, { verification });
  assert.ok(Buffer.byteLength(prompt, "utf8") < 64 * 1024, `the compacted judge prompt fits (${Buffer.byteLength(prompt, "utf8")})`);
});
