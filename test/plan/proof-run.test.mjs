import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proveRequirements } from "../../src/plan/proof-run.mjs";

// Measured 2026-09-23 on evidence-you-can-recompute: `spec validate
// --run-proofs` reported R6 proven before any of R6 existed, because
// `node --test --test-name-pattern=<a name no test carries>` exits 0.
test("a proof whose test-name pattern matches no test fails", () => {
  const cwd = mkdtempSync(join(tmpdir(), "proof-run-pattern-"));
  writeFileSync(join(cwd, "real.test.mjs"), 'import test from "node:test";\ntest("the real behaviour holds", () => {});\n');
  /** @param {string} ref */
  const prove = (ref) => proveRequirements(cwd, [/** @type {any} */ ({ id: "R1", proof: { kind: "command", ref } })])[0];
  const vacuous = prove('node --test --test-name-pattern="a behaviour nobody wrote" real.test.mjs');
  assert.equal(vacuous.pass, false, "a pattern that matched nothing proved nothing");
  assert.match(vacuous.detail, /matched no test/u);
  assert.equal(prove('node --test --test-name-pattern="the real behaviour holds" real.test.mjs').pass, true);
  // Single quotes are POSIX shell syntax; cmd.exe passes them through and
  // splits the pattern at its space (measured 2026-09-23 on the Windows CI).
  const quoted = process.platform === "win32" ? '"real behaviour"' : "'real behaviour'";
  assert.equal(prove(`node --test --test-name-pattern=${quoted} real.test.mjs`).pass, true, "quotes and a partial pattern still match");
  assert.equal(prove("node --test real.test.mjs").pass, true, "a proof with no pattern is judged by its exit code alone");
});
