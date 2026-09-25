import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertLaunchBaseClean } from "../../src/repo/source-identity.mjs";
import { SIGNAL_END, SIGNAL_START } from "../../src/repo/signal-block.mjs";

/**
 * R17: a launch checks `AGENTS.md` by content, not by git status. The
 * runner's own managed signal block must never block a launch, but a human
 * edit anywhere else in the same file — even one sitting alongside a block
 * rewrite — is refused exactly like any other uncommitted path.
 */

/** @param {string} directory @param {string} message @returns {void} */
function commitAll(directory, message) {
  execFileSync("git", ["-C", directory, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", message], { stdio: "ignore" });
}

test("the managed signal block alone does not block a launch", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-managed-block-"));
  execFileSync("git", ["-C", directory, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "test"]);
  const committed = `# AGENTS.md\n\nHuman guidance.\n\n${SIGNAL_START}\nold state\n${SIGNAL_END}\n`;
  writeFileSync(join(directory, "AGENTS.md"), committed);
  writeFileSync(join(directory, "a.txt"), "one\n");
  commitAll(directory, "base");

  // A block-only rewrite, exactly what the runner does as run state changes,
  // does not block a launch.
  writeFileSync(join(directory, "AGENTS.md"), `# AGENTS.md\n\nHuman guidance.\n\n${SIGNAL_START}\nnew state, more of it\n${SIGNAL_END}\n`);
  assert.doesNotThrow(() => assertLaunchBaseClean(directory, undefined));

  // A line edited outside the block, alongside that same block rewrite, is
  // refused as an uncommitted path: the whole file counts, not just the block.
  writeFileSync(join(directory, "AGENTS.md"), `# AGENTS.md\n\nChanged human guidance.\n\n${SIGNAL_START}\nnew state, more of it\n${SIGNAL_END}\n`);
  assert.throws(
    () => assertLaunchBaseClean(directory, undefined),
    (/** @type {Error & {code?: string}} */ error) => {
      assert.equal(error.code, "dirty_work_tree");
      assert.match(error.message, /uncommitted path/u);
      return true;
    },
  );

  // Restore AGENTS.md exactly and dirty an unrelated tracked file instead:
  // refused as before, unaffected by this AGENTS.md-specific check.
  writeFileSync(join(directory, "AGENTS.md"), committed);
  writeFileSync(join(directory, "a.txt"), "dirty\n");
  assert.throws(() => assertLaunchBaseClean(directory, undefined), /uncommitted path/u);
});
