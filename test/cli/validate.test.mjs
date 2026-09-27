import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateContract } from "../../src/contract/index.mjs";
import { composeAssignments } from "../../src/engine/runtime-discovery.mjs";
import { allRuntimesAvailable, assertRuntimeAssignment } from "../../src/engine/assignment.mjs";
import { validateContractFile } from "../../src/cli/contract.mjs";
import { packet, writeFixture } from "../contract/helpers.mjs";

// R35: `faberun validate` must run the launch-time runtime assignment over the
// contract with every runtime given as available, so the refusals a launch
// makes from the contract alone happen at authoring time. Discovery cannot
// rescue these: no probe changes whether a composed worker/judge pair has a
// cross-vendor candidate.

const NO_CROSS_VENDOR_JUDGE = /runtime_assignment_judge_unavailable: no available cross-vendor judge for node build and worker solo/u;

test("validate refuses what runtime assignment would refuse", () => {
  const refusedFixture = writeFixture({
    runtimeDefaults: {},
    runtimes: { solo: { harness: "codex", model: "gpt-5.6-luna" } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  // Authoring validation alone accepts this contract: it declares no worker or
  // judge, so there is no pair for the declared-field vendor check to read.
  const contract = validateContract(JSON.parse(readFileSync(refusedFixture.path, "utf8")), refusedFixture.path);
  // The launch-time assignment composes the single runtime into both roles,
  // and no available runtime can judge a node it also works.
  assert.throws(() => composeAssignments(contract, allRuntimesAvailable(contract)), NO_CROSS_VENDOR_JUDGE);
  // `faberun validate` runs that same assignment with every runtime available
  // and refuses with the launch's own reason, before printing `valid`.
  assert.throws(() => validateContractFile(refusedFixture.path), NO_CROSS_VENDOR_JUDGE);

  // A contract the assignment can satisfy is still valid: validate refuses
  // exactly what the launch would, no more.
  const acceptedFixture = writeFixture({
    runtimeDefaults: {},
    runtimes: {
      luna: { harness: "codex", model: "gpt-5.6-luna", costRank: 1 },
      opus: { harness: "claude", model: "opus", costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  });
  const satisfiable = validateContract(JSON.parse(readFileSync(acceptedFixture.path, "utf8")), acceptedFixture.path);
  assert.doesNotThrow(() => assertRuntimeAssignment(satisfiable));
});
