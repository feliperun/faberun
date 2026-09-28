/**
 * R5: the getting-started guide is executed, not only read. Each command and
 * output pair `docs/GETTING-STARTED.md` marks is run against a throwaway
 * repository, under an isolated `FABERUN_HOME`, with the `replay` harness
 * standing in for every provider; the machine-varying paths are normalized to
 * `<home>`, `<project>` and `<run>` before the comparison.
 *
 * The integration test is the named proof `npm run docs:check` also runs. The
 * two smaller tests keep the guide's markers and the normalization honest
 * independently of any spawned CLI, so a broken marker fails with a useful
 * message instead of only a diverged output.
 *
 * `grep` is the guide's own verification command and the walkthrough runs it
 * verbatim, so the integration proof is POSIX-only for the same reason every
 * other test that leans on a POSIX tool is.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUIDE_PATH, checkGettingStarted, normalizeWalkthroughOutput, parseWalkthrough } from "../../src/cli/walkthrough.mjs";

const GREP_IS_POSIX = "the walkthrough runs the guide's POSIX grep verification";

test("the getting started walkthrough matches the CLI it describes", { skip: process.platform === "win32" ? GREP_IS_POSIX : false }, () => {
  const result = checkGettingStarted();
  assert.equal(
    result.ok,
    true,
    `docs/GETTING-STARTED.md diverged from the CLI:\n${JSON.stringify(result.mismatches, null, 2)}${result.error ? `\n${result.error}` : ""}`,
  );
  assert.deepEqual(result.mismatches, []);
});

test("the getting started guide marks commands and the outputs checked against them", () => {
  const steps = parseWalkthrough(readFileSync(GUIDE_PATH, "utf8"));
  const commands = steps.filter((step) => step.type === "command");
  const checked = commands.filter((step) => step.output !== null);
  assert.ok(commands.length > 0, "GETTING-STARTED.md must mark at least one command to run");
  assert.ok(checked.length > 0, "GETTING-STARTED.md must mark at least one output to check");
  assert.ok(steps.some((step) => step.type === "contract"), "GETTING-STARTED.md must mark the contract it walks through");
});

test("the walkthrough normalizes the home, project and run paths", () => {
  const normalized = normalizeWalkthroughOutput(
    "campaign · /tmp/faberun-home/projects/6f8a/runs/campaigns/hello · /tmp/faberun-repo/.gitignore · [run] hello done · /tmp/faberun-home/projects/6f8a/runs/hello",
    {
      home: "/tmp/faberun-home",
      project: "/tmp/faberun-repo",
      projectId: "6f8a",
      runId: "hello",
      runDir: "/tmp/faberun-home/projects/6f8a/runs/hello",
    },
  );
  assert.equal(
    normalized,
    "campaign · <home>/projects/<project>/runs/campaigns/hello · <project>/.gitignore · [run] hello done · <home>/projects/<project>/runs/<run>",
  );
});
