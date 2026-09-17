import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AGENTS.md is the single source of guidance; AGENT.md, CLAUDE.md, CURSOR.md
 * and GEMINI.md must stay symlinks to it, both on disk and in git, so a
 * pointer that drifts into a real file fails here rather than in review.
 */

const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));

const rootPointerNames = ["AGENT.md", "CLAUDE.md", "CURSOR.md", "GEMINI.md"];

for (const name of rootPointerNames) {
  test(`${name} is a symlink to AGENTS.md on disk`, () => {
    const path = join(REPO_DIR, name);
    assert.ok(lstatSync(path).isSymbolicLink(), `${name} is not a symlink`);
    assert.equal(readlinkSync(path), "AGENTS.md");
  });

  test(`${name} is tracked as a symlink in git`, () => {
    const output = execFileSync("git", ["ls-files", "-s", name], { cwd: REPO_DIR, encoding: "utf8" });
    assert.ok(output.startsWith("120000"), `git ls-files -s ${name} did not report mode 120000:\n${output}`);
  });
}

test("AGENTS.md itself is a regular file", () => {
  assert.ok(lstatSync(join(REPO_DIR, "AGENTS.md")).isFile());
});
