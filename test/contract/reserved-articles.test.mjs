/**
 * The reserved constitution articles: the common law is written by this
 * repository, never by a run. Validation refuses any write set that claims a
 * reserved name while letting contracts add their own references/local-*.md,
 * so no node can overwrite the articles mid-campaign.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateContract } from "../../src/contract/index.mjs";
import { RESERVED_ARTICLES, RESERVED_OWNER_DECISIONS, uncoveredReservedOwnerDecisions } from "../../src/contract/articles.mjs";
import { packet, writeFixture } from "./helpers.mjs";

/**
 * @param {string[]} writeFiles
 * @returns {string} contract path
 */
function articleFixture(writeFiles) {
  const { path } = writeFixture({
    nodes: [{ id: "build", type: "backend", gate: false, taskPacket: packet({ writeFiles }) }],
  });
  return path;
}

test("reserved article names", () => {
  assert.deepEqual(RESERVED_ARTICLES, [
    "references/rules.md",
    "references/engineering.md",
    "references/workflow.md",
    "references/handoffs.md",
  ]);
  for (const article of RESERVED_ARTICLES) {
    // Both the bare article path and the same name reached through the skill's
    // directory are a claim on the reserved article.
    for (const declared of [article, `skills/faberun/${article}`]) {
      const path = articleFixture([declared, "output.txt"]);
      const escaped = declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.throws(
        () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
        new RegExp(`${escaped}.*local-`, "u"),
        `${declared} must be refused with the local- prefix in the message`,
      );
    }
  }
});

test("local articles are allowed", () => {
  const path = articleFixture(["skills/faberun/references/local-boot.md", "output.txt"]);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(
    contract.nodes[0].taskPacket.writeFiles,
    ["skills/faberun/references/local-boot.md", "output.txt"],
  );
});

/**
 * The one owner-decision list both prompts read. A packet covers a decision by
 * naming it in `decisions`; only the uncovered ones are refused by the worker
 * and failed by the judge, so the two sides can never disagree about the list.
 */
test("reserved owner decisions", () => {
  assert.deepEqual(RESERVED_OWNER_DECISIONS, [
    "license",
    "pricing",
    "branding",
    "publication",
    "third-party data",
  ]);
  assert.deepEqual(uncoveredReservedOwnerDecisions([]), RESERVED_OWNER_DECISIONS);
  assert.deepEqual(
    uncoveredReservedOwnerDecisions(["license: MIT", "Pricing is free"]),
    ["branding", "publication", "third-party data"],
  );
  assert.deepEqual(uncoveredReservedOwnerDecisions([...RESERVED_OWNER_DECISIONS]), []);
});
