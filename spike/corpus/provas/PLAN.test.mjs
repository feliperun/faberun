/**
 * Proof for the PLAN corpus requirement: a review finding may not name a node
 * that is not in the plan under review.
 *
 * `src/plan/template.mjs`'s review instruction already tells the reviewer that
 * "every finding's nodeId must name a node id that actually appears in the plan
 * under review", but `validateFindings` enforces only the field's shape, so a
 * finding attributed to a node the plan does not contain is accepted, persisted
 * to findings.json and handed to the revise stage. The first test below fails
 * at this commit for exactly that reason, and passes once `validateFindings`
 * takes the plan's node ids and refuses a finding outside them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFindings } from "../../../src/plan/template.mjs";

/** @param {string} nodeId */
function finding(nodeId) {
  return { id: "F1", severity: "major", nodeId, text: "the node's proof is missing" };
}

test("a finding whose nodeId is not a node of the plan under review is refused, naming the node id", () => {
  assert.throws(
    () => validateFindings([finding("ghost")], ["build", "docs"]),
    (error) => error instanceof Error && error.message.includes("ghost"),
    "a finding attributed to a node the plan does not contain must be refused by name",
  );
});

test("a finding whose nodeId is a node of the plan under review validates unchanged", () => {
  assert.deepEqual(validateFindings([finding("build")], ["build", "docs"]), [finding("build")]);
});

test("without the plan's node ids the shape-only validation is unchanged", () => {
  assert.deepEqual(validateFindings([finding("build")]), [finding("build")]);
});
