/**
 * Proof for the CONTRACT corpus requirement: a Definition of Done item id may
 * not repeat inside one node's checklist.
 *
 * A Definition of Done id is the only handle a judge has for the item it
 * addresses (engine/prompts.mjs renders it as `[id]`), and the key the
 * deterministic proof results are matched by (`results.find(entry => entry.id
 * === item.id)`), so a repeated id silently binds one item to another item's
 * result. `validateDefinitionOfDone` validates each item in isolation today and
 * accepts the duplicate; the first test below fails at this commit for exactly
 * that reason, and passes once the duplicate is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDefinitionOfDone } from "../../../src/contract/definition-of-done.mjs";

test("a Definition of Done id repeated inside one node is refused, naming the repeated id", () => {
  const items = [
    { id: "works", text: "The requested behavior works", proof: { kind: "path", ref: "src/x.mjs" } },
    { id: "works", text: "The reviewer is convinced by the change", judgment: true },
  ];
  assert.throws(
    () => validateDefinitionOfDone(items, "nodes[0].definitionOfDone"),
    (error) => error instanceof Error && error.message.includes("works"),
    "two items sharing an id must be refused with the repeated id in the message",
  );
});

test("distinct ids inside one node validate unchanged", () => {
  const validated = validateDefinitionOfDone(
    [
      { id: "works", text: "The requested behavior works", proof: { kind: "path", ref: "src/x.mjs" } },
      { id: "reviewed", text: "The reviewer is convinced by the change", judgment: true },
    ],
    "nodes[0].definitionOfDone",
  );
  assert.deepEqual(validated.map((item) => item.id), ["works", "reviewed"]);
});

test("the same id in two different nodes is not a duplicate: the check is per checklist", () => {
  const checklist = () => [{ id: "works", text: "The requested behavior works", proof: { kind: "path", ref: "src/x.mjs" } }];
  assert.doesNotThrow(() => validateDefinitionOfDone(checklist(), "nodes[0].definitionOfDone"));
  assert.doesNotThrow(() => validateDefinitionOfDone(checklist(), "nodes[1].definitionOfDone"));
});
