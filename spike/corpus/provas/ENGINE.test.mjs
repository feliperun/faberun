// Proof for requirement ENGINE: the contract can declare an advisory ceiling on
// a node's declared read weight, and the controller's per-tick advisory pass
// emits it exactly like the cost and duration advisories.
//
// The declared read weight already exists (`declaredReadBytes` on the node
// snapshot, summed by the report surfaces), but there is no advisory for it:
// `contract.nodeAdvisory` accepts only `costUsd` and `durationSec`, and
// `nodeAdvisoryCrossings` knows only those two kinds.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../../src/contract/index.mjs";
import { emitNodeAdvisories, nodeAdvisoryCrossings } from "../../../src/engine/notify-queue.mjs";
import { runDirectory } from "../../../src/run/paths.mjs";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

test("a declared read weight at or above the advisory ceiling is a read crossing", () => {
  const policy = { readBytes: 4096 };
  assert.deepEqual(
    nodeAdvisoryCrossings({ id: "build", declaredReadBytes: 5000 }, policy, NOW_MS),
    [{ kind: "read", threshold: 4096, value: 5000 }],
    "a node over the declared read ceiling crosses it",
  );
  assert.deepEqual(
    nodeAdvisoryCrossings({ id: "build", declaredReadBytes: 4096 }, policy, NOW_MS),
    [{ kind: "read", threshold: 4096, value: 4096 }],
    "the ceiling is inclusive, exactly as the cost ceiling is",
  );
  assert.deepEqual(
    nodeAdvisoryCrossings({ id: "build", declaredReadBytes: 4095 }, policy, NOW_MS),
    [],
    "below the ceiling is not a crossing",
  );
  assert.deepEqual(
    nodeAdvisoryCrossings({ id: "build", declaredReadBytes: null }, policy, NOW_MS),
    [],
    "an unmeasured read weight never fabricates a crossing",
  );
});

test("the controller's per-tick pass emits a read advisory even when it is the only configured ceiling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-engine-read-advisory-"));
  const runDir = runDirectory(directory, "run-a");
  mkdirSync(runDir, { recursive: true });
  const states = new Map([["build", { id: "build", declaredReadBytes: 5000 }]]);
  try {
    const emitted = await emitNodeAdvisories(
      { campaignId: "camp", nodeAdvisory: { readBytes: 4096 }, nodes: [{ id: "build" }] },
      runDir,
      states,
    );
    assert.equal(emitted, 1, "one advisory for the one crossed read ceiling");
    const inbox = readFileSync(join(dirname(runDir), "inbox.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].dedupeKey, /node\.advisory:run-a:build:read:4096/u);
    assert.equal(inbox[0].summary, "node build crossed its advisory read weight 4096 bytes (declared 5000 bytes) · run run-a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the contract schema accepts a non-negative readBytes advisory ceiling", () => {
  const directory = mkdtempSync(join(tmpdir(), "faberun-engine-read-advisory-contract-"));
  try {
    writeFileSync(join(directory, "contract.json"), "{}\n");
    const contractPath = join(directory, "contract.json");
    const value = {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id: "read-advisory-run",
      campaignId: "read-advisory-campaign",
      goal: "Prove the read advisory ceiling is declarable",
      cwd: directory,
      runtimeDefaults: { worker: "luna", judge: "sol" },
      runtimes: {
        luna: { harness: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
        sol: { harness: "codex", model: "gpt-5.6-sol", reasoning: "xhigh", vendor: "openai-sol" },
      },
      nodeAdvisory: { readBytes: 4096 },
      nodes: [{
        id: "build",
        type: "backend",
        phase: "first-write",
        gate: false,
        taskPacket: {
          mode: "execution",
          objective: "Implement it",
          instructions: ["Implement the requested behavior"],
          readFiles: ["contract.json"],
          writeFiles: ["README.md"],
          symbols: [],
          decisions: [],
          nonGoals: [],
          verification: [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(0)"] : ["true"] }],
        },
      }],
    };
    const contract = validateContract(value, contractPath);
    assert.equal(contract.nodeAdvisory?.readBytes, 4096);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
