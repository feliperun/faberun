/**
 * Corpus proof, HOST: `findExecutable` in `src/host/preflight.mjs` must answer
 * whether a path is a runnable binary, not whether a path exists.
 *
 * That one function is the whole of faberun's answer to "is this binary on
 * this machine?": `doctor` renders it as `binary codex`, the banner counts the
 * harness binaries with it, and `src/cli/skills.mjs` decides whether a skill's
 * binary is installed with it. Today it tests `existsSync` only, so a directory
 * named `codex`, or a file with no execute bit, is reported as a present
 * binary; the operator learns otherwise when the spawn fails with EACCES or
 * EISDIR. The `zcode` adapter already resolves a command the honest way
 * (`resolvesOnPath` in `src/harnesses/zcode/index.mjs` uses `accessSync` with
 * `constants.X_OK`), and this is the same question.
 *
 * Fails on the tree before the requirement: the directory named like the
 * searched command is returned as a binary path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../../../src/host/preflight.mjs";

// On Windows there is no execute bit, and as root X_OK is granted whatever the
// mode; the directory case below is meaningful on every host, the mode cases
// only where the mode is actually consulted.
const EXECUTE_BIT_IS_MEANINGFUL = process.platform !== "win32" && process.getuid?.() !== 0;

test("a path that exists but cannot be executed is not a binary", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-find-executable-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    assert.equal(findExecutable("codex"), null, "an empty PATH directory holds no binary");

    // A directory is executable in the X_OK sense (it is traversable) but is
    // not a program; reporting it sends doctor, the banner and skills to a
    // path that cannot be spawned.
    mkdirSync(join(directory, "claude"));
    assert.equal(findExecutable("claude"), null, "a directory named like a command is not a binary");

    const file = join(directory, "codex");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);
    if (!EXECUTE_BIT_IS_MEANINGFUL) {
      context.diagnostic("running as root or on Windows: skipping the execute-bit assertions");
      return;
    }
    assert.equal(findExecutable("codex"), null, "a file with no execute bit cannot be spawned and is not on PATH as a binary");
    assert.equal(findExecutable(file), null, "the absolute-path spelling answers the same question");

    chmodSync(file, 0o755);
    assert.equal(findExecutable("codex"), file, "an executable file is the answer, named by the directory it was found in");
    assert.equal(findExecutable(file), file, "and the absolute-path spelling finds the same file");

    const link = join(directory, "agy");
    symlinkSync(file, link);
    assert.equal(findExecutable("agy"), link, "a symlink that points at an executable file is an executable binary");
  } finally {
    process.env.PATH = previousPath;
  }
});
