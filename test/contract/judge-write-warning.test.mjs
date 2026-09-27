import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { judgeWriteWarnings } from "../../src/contract/runtime.mjs";
import { writesWorkspace } from "../../src/harnesses/index.mjs";

/** @param {Record<string, unknown>} fields */
const claude = (fields) => /** @type {any} */ ({ harness: "claude", model: "claude-opus-5-5", ...fields });

test("a claude judge in plan mode cannot write its workspace", () => {
  assert.equal(writesWorkspace(claude({ permissionMode: "plan" })), false);
  assert.equal(writesWorkspace(claude({})), true);
  assert.equal(writesWorkspace(claude({ permissionMode: "bypassPermissions" })), true);
});

test("a claude judge that declares a writing mode is warned, and one in plan mode is not", () => {
  const runtimes = { writer: claude({ permissionMode: "bypassPermissions" }), reader: claude({ permissionMode: "plan" }) };
  assert.deepEqual(judgeWriteWarnings(runtimes, { judge: "reader" }, []), []);
  const [warning] = judgeWriteWarnings(runtimes, {}, [{ gate: { runtime: "writer" } }]);
  assert.match(warning, /judge runtime writer declares permissionMode bypassPermissions/);
});
