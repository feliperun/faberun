import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { renderStatusJson } from "../../src/report/render.mjs";
import { git } from "../../src/repo/worktree.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

// RM-052: `rec`'s suite wrote `rec-wav-test-<pid>.*` into its working
// directory, and 14 of them crossed the seal into the remediation branch, a
// pair for every node that ran the suite. What the verification leaves is
// reported and kept out of the seal; what the worker wrote still is not.
test("a file the verification leaves behind is reported and not sealed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "verification-artifact-"));
  const leave = [process.execPath, "-e", "require('node:fs').writeFileSync('rec-wav-test-4242.wav', 'x')"];
  const path = writeContract(directory, fixture({
    id: "verification-artifact-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: leave }] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "write-unexpected", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(state.verificationArtifacts, ["rec-wav-test-4242.wav"], "the node records what the verification left, by path");
  assert.deepEqual(state.scopeFindings?.unexpectedPaths, ["unexpected.txt"], "a worker's own stray write still goes through scopeFindings");
  const sealed = git(directory, ["ls-tree", "-r", "--name-only", "refs/faberun/verification-artifact-run/run"]).split("\n");
  assert.ok(!sealed.includes("rec-wav-test-4242.wav"), `the artifact crossed the seal: ${sealed.join(", ")}`);
  assert.ok(sealed.includes("unexpected.txt"), "a file the worker wrote before verification is still sealed");
  const status = JSON.parse(renderStatusJson(result.runDir));
  const node = status.nodes.find((/** @type {{id: string}} */ entry) => entry.id === "build");
  assert.deepEqual(node.verificationArtifacts, ["rec-wav-test-4242.wav"], "the status payload carries the finding");
  assert.match(node.note, /verification_artifact/u, "the node's note names the finding");
});
