import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpec } from "../../src/plan/spec.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const campaignsDir = join(rootDir, "docs", "campaigns");

/**
 * Every `.md` file directly under a `docs/campaigns/<id>/spec/` directory,
 * across every campaign that has one — the walk R4 requires, over records
 * this node neither rewrites nor rewrites the byte of.
 *
 * @returns {string[]} absolute paths
 */
function specMarkdownFiles() {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(campaignsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const specDir = join(campaignsDir, entry.name, "spec");
    if (!statSync(specDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const child of readdirSync(specDir, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".md")) files.push(join(specDir, child.name));
    }
  }
  return files.sort();
}

/**
 * Repo-relative paths of every campaign's structured `REQUIREMENTS.md`
 * sibling — the session arm's baseline the comparative arm
 * (`adversarial-planner` R17) reuses.
 *
 * @returns {string[]}
 */
export function structuredSpecPaths() {
  return specMarkdownFiles()
    .filter((path) => path.endsWith(join("spec", "REQUIREMENTS.md")))
    .map((path) => relative(rootDir, path));
}

/** @param {string} text @returns {boolean} */
function startsWithFrontMatter(text) {
  return text.split("\n")[0]?.trim() === "---";
}

test("existing specs validate", () => {
  const files = specMarkdownFiles();
  assert.ok(files.length > 0, "expected at least one spec document under docs/campaigns/");
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const isRequirements = path.endsWith(join("spec", "REQUIREMENTS.md"));
    const result = validateSpec(text, { cwd: rootDir, strict: isRequirements });
    if (isRequirements) {
      // A new REQUIREMENTS.md sibling must be structured and pass every
      // traceability rule, not merely be accepted.
      assert.equal(result.class, "structured", `${path} must classify as structured`);
    } else if (startsWithFrontMatter(text)) {
      // A handful of the owner's own originals already carry the format's
      // front matter (they are the model the format documents); that is not
      // a failure, it classifies structured like any other such document.
      assert.equal(result.class, "structured", `${path} carries front matter but did not classify as structured`);
    } else {
      assert.equal(result.class, "legacy", `${path} has no front matter but did not classify as legacy`);
    }
    assert.equal(result.ok, true, `${path} was not accepted: ${JSON.stringify(result.findings)}`);
  }

  const siblings = structuredSpecPaths();
  assert.ok(siblings.length >= 10, `expected at least 10 REQUIREMENTS.md siblings, found ${siblings.length}`);
});
