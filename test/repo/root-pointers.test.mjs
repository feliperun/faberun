import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
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
  test(`${name} points at AGENTS.md in the working tree`, () => {
    const path = join(REPO_DIR, name);
    // Git materializes a symlink as a regular file holding the target path
    // where the platform has no symlink of its own -- `core.symlinks=false`,
    // the default on a Windows checkout without Developer Mode. Both forms
    // are the same pointer; assert whichever one this checkout carries, and
    // let the index assertion below hold the invariant that travels.
    if (!lstatSync(path).isSymbolicLink()) {
      // guard-exempt: host-layout only a checkout without symlinks may carry the file form
      assert.equal(process.platform, "win32", `${name} is not a symlink`);
      assert.equal(readFileSync(path, "utf8"), "AGENTS.md");
      return;
    }
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
