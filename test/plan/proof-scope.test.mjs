import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixture, packet } from "../helpers.mjs";
import { freezePlan } from "../../src/plan/freeze.mjs";

/**
 * AP1 of safe-to-hand-to-a-friend at the freeze: a Definition of Done proof
 * that filters node:test by name must name the file that holds the test, and
 * a named file nobody writes must hold a test the filter selects. Measured
 * 2026-09-26: the frozen proof `node --test --test-name-pattern="every harness
 * adapter declares the environment it reads"` named no file, ran every test
 * file in the tree, and two nodes exhausted on it.
 */

/** @param {Record<string, string>} files @returns {string} */
function repoWith(files) {
  const cwd = mkdtempSync(join(tmpdir(), "proof-scope-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return cwd;
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @param {string[]} [writeFiles]
 */
function freezeWithProof(cwd, ref, writeFiles = ["src/env.mjs"]) {
  const plan = fixture({
    id: "proof-scope",
    campaignId: "proof-scope-campaign",
    cwd,
    nodes: [{
      id: "declared-env-test",
      type: "backend",
      taskPacket: packet({ readFiles: ["README.md"], writeFiles }),
      definitionOfDone: [{ id: "d1", text: "the declared-env test passes", proof: { kind: "command", ref } }],
      gate: false,
    }],
  });
  return freezePlan(/** @type {any} */ (plan), { outDir: mkdtempSync(join(tmpdir(), "proof-scope-out-")), provenance: /** @type {any} */ ({ targetGitHead: null, planner: { runtimeId: "luna", model: "m" }, reviewer: { runtimeId: "sol", model: "m" }, sizing: [], findings: [] }) });
}

const TESTS = 'import { test } from "node:test";\ntest("every harness adapter declares the environment it reads", () => {});\n';

test("a name-filtered proof that names no test file is refused at the freeze", () => {
  const cwd = repoWith({ "README.md": "x\n", "src/env.mjs": "", "test/env.test.mjs": TESTS });
  assert.throws(
    () => freezeWithProof(cwd, 'node --test --test-name-pattern="every harness adapter declares the environment it reads"'),
    /names no test file/u,
  );
});

test("a name-filtered proof naming an existing file whose tests it does not select is refused at the freeze", () => {
  const cwd = repoWith({ "README.md": "x\n", "src/env.mjs": "", "test/env.test.mjs": TESTS });
  assert.throws(
    () => freezeWithProof(cwd, 'node --test --test-name-pattern="a test nobody wrote" test/env.test.mjs'),
    /selects no test in test\/env\.test\.mjs/u,
  );
});

test("a name-filtered proof freezes when it names a file that holds the test or that a node writes", () => {
  const cwd = repoWith({ "README.md": "x\n", "src/env.mjs": "", "test/env.test.mjs": TESTS });
  assert.doesNotThrow(() => freezeWithProof(cwd, 'node --test --test-name-pattern="every harness adapter declares" test/env.test.mjs'));
  assert.doesNotThrow(() => freezeWithProof(cwd, 'node --test --test-name-pattern="a test this node adds" test/new.test.mjs', ["src/env.mjs", "test/new.test.mjs"]));
});
