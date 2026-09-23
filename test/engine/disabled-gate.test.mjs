import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

// Measured 2026-09-23 on evidence-you-can-recompute: every node carried
// `gate: false` and command proofs in its Definition of Done, and none of those
// proofs ran -- one `grep` that could only fail was reported done. A disabled
// gate turns off the judge, not the mechanical proofs the contract declares.
test("a node without a gate still runs its mechanical definition-of-done proofs", async () => {
  /** @param {string} id @param {number} exitCode */
  const run = async (id, exitCode) => {
    const directory = mkdtempSync(join(tmpdir(), `disabled-gate-${id}-`));
    const path = writeContract(directory, fixture({
      id, pollIntervalMs: 10,
      nodes: [{
        id: "build", type: "backend", taskPacket: packet(), gate: false,
        definitionOfDone: [{ id: "proof", text: "the proof command passes", proof: { kind: "command", ref: `node -e "process.exit(${exitCode})"` } }],
      }],
    }));
    return nodeState(await withFakeCodex(directory, "pass", () => runContract(path)));
  };
  const failing = await run("disabled-gate-fail", 3);
  assert.notEqual(failing.status, "done", "a failing mechanical proof cannot settle a gate-less node as done");
  assert.equal(failing.error?.code, "mechanical_gate_failed");
  const passing = await run("disabled-gate-pass", 0);
  assert.equal(passing.status, "done", passing.error?.message);
  assert.equal(passing.gate?.verdict, "pass", "the proof's verdict is recorded on the node");
});
