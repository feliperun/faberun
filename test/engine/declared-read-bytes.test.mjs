import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { declaredReadBytes } from "../../src/engine/dispatch.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

// The declared weight of a node's readFiles at dispatch time, recorded on the
// node snapshot as `declaredReadBytes`: the worker prompt lists these paths
// and the worker reads them itself, so their combined byte size is the one
// quantity the controller can measure about a packet's reference load.

test("dispatch records the summed byte size of the node's declared readFiles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-declared-read-bytes-"));
  const first = "a".repeat(37);
  const second = "b".repeat(101);
  writeFileSync(join(directory, "first.txt"), first);
  writeFileSync(join(directory, "second.txt"), second);
  const path = writeContract(directory, fixture({
    id: "declared-read-bytes-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["first.txt", "second.txt"] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.declaredReadBytes, first.length + second.length);
});

test("declaredReadBytes counts a missing declared file as zero rather than throwing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "runner-declared-read-bytes-missing-"));
  writeFileSync(join(workspace, "present.txt"), "12345");
  mkdirSync(join(workspace, "nested"));
  writeFileSync(join(workspace, "nested", "child.txt"), "1234567");
  assert.equal(
    declaredReadBytes(["present.txt", "missing.txt", "nested/child.txt"], workspace),
    5 + 7,
  );
  assert.equal(declaredReadBytes([], workspace), 0);
});
