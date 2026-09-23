import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPacket, validateContract } from "../../src/contract/index.mjs";
import { parseDiscoveryResult } from "../../src/contract/worker-result.mjs";
import { packet, writeFixture } from "./helpers.mjs";

// Deferred reads (Phase 1): a readFiles entry may name a file a transitive
// dependency produces, which contract loading resolves once the dependency
// graph is known. scopeAcknowledged defers identically (Phase 2). Every other
// caller of validateTaskPacket still rejects a missing path inline.

/** @param {Record<string, unknown>} [overrides] */
function autonomousPacket(overrides = {}) {
  return {
    mode: "autonomous",
    objective: "Implement it",
    instructions: ["Inspect as needed and make the change"],
    readFiles: [],
    writeRoots: ["src"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [],
    ...overrides,
  };
}

test("a direct dependency's writeFiles satisfies a deferred missing read (case 1)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["a.txt"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ readFiles: ["a.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes.length, 2);
  assert.deepEqual(contract.nodes[1].taskPacket.readFiles, ["a.txt"]);
});

test("a transitive dependency's writeFiles satisfies a deferred missing read (case 2)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["a.txt"] }), gate: false },
      { id: "c", type: "backend", dependsOn: ["a"], taskPacket: packet({ writeFiles: ["c.txt"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["c"], taskPacket: packet({ readFiles: ["a.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes.length, 3);
  assert.deepEqual(contract.nodes[2].taskPacket.readFiles, ["a.txt"]);
});

test("the reader may be declared before its producer (case 3)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ readFiles: ["a.txt"], writeFiles: ["b.txt"] }), gate: false },
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["a.txt"] }), gate: false },
    ],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes.length, 2);
  assert.deepEqual(contract.nodes[0].taskPacket.readFiles, ["a.txt"]);
});

test("a read produced by a non-dependency node is rejected with today's message (case 4)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["a.txt"] }), gate: false },
      { id: "b", type: "backend", taskPacket: packet({ readFiles: ["a.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /nodes\[1\]\.taskPacket\.readFiles\[0\] does not exist: a\.txt/u,
  );
});

test("a node reading its own write is rejected (case 5)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "b", type: "backend", taskPacket: packet({ readFiles: ["b.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /nodes\[0\]\.taskPacket\.readFiles\[0\] does not exist: b\.txt/u,
  );
});

test("a path under a directory writeRoots is valid; the same path under a file root is rejected (case 6)", () => {
  // A directory-shaped root authorizes everything beneath it.
  const directoryRoot = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: autonomousPacket({ writeRoots: ["out"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ readFiles: ["out/generated.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  mkdirSync(join(directoryRoot.directory, "out"));
  const accepted = validateContract(JSON.parse(readFileSync(directoryRoot.path, "utf8")), directoryRoot.path);
  assert.deepEqual(accepted.nodes[1].taskPacket.readFiles, ["out/generated.txt"]);

  // The same writeRoots entry, now naming a regular file, authorizes exactly
  // that path and nothing beneath it: the read is rejected, not deferred.
  const fileRoot = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: autonomousPacket({ writeRoots: ["out"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ readFiles: ["out/generated.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  writeFileSync(join(fileRoot.directory, "out"), "a file, not a directory\n");
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(fileRoot.path, "utf8")), fileRoot.path),
    /not a directory/u,
  );
});

test("a deferred read still rejects escapes, absolute paths, and broken symlinks (case 7)", () => {
  const escape = writeFixture({
    nodes: [{ id: "b", type: "backend", taskPacket: packet({ readFiles: ["../outside.txt"], writeFiles: ["b.txt"] }), gate: false }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(escape.path, "utf8")), escape.path),
    /escapes cwd/u,
  );

  const absolute = writeFixture({
    nodes: [{ id: "b", type: "backend", taskPacket: packet({ readFiles: ["/tmp/outside.txt"], writeFiles: ["b.txt"] }), gate: false }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(absolute.path, "utf8")), absolute.path),
    /must be relative to cwd/u,
  );

  const broken = writeFixture({
    nodes: [{ id: "b", type: "backend", taskPacket: packet({ readFiles: ["broken-link.txt"], writeFiles: ["b.txt"] }), gate: false }],
  });
  symlinkSync("does-not-exist-target.txt", join(broken.directory, "broken-link.txt"));
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(broken.path, "utf8")), broken.path),
    /is a broken symbolic link/u,
  );
});

test("a discovery result naming a missing read is still rejected (case 8)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-discovery-missing-read-"));
  const produced = {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the behavior"],
    readFiles: ["missing.txt"],
    writeFiles: ["output.txt"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [{ argv: ["node", "--check", "output.txt"] }],
  };
  const result = {
    status: "done",
    summary: "produced a packet",
    verification: [],
    artifacts: [JSON.stringify(produced)],
    missingContext: [],
  };
  assert.throws(
    () => parseDiscoveryResult(JSON.stringify(result), cwd),
    /nodes\[0\]\.taskPacket\.readFiles\[0\] does not exist: missing\.txt/u,
  );
});

test("packetHash is identical whether the read is present or dependency-produced (case 9)", () => {
  const present = writeFixture({
    nodes: [
      { id: "b", type: "backend", taskPacket: packet({ readFiles: ["shared.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  writeFileSync(join(present.directory, "shared.txt"), "shared\n");
  const presentContract = validateContract(JSON.parse(readFileSync(present.path, "utf8")), present.path);

  const deferred = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["shared.txt"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ readFiles: ["shared.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  const deferredContract = validateContract(JSON.parse(readFileSync(deferred.path, "utf8")), deferred.path);

  assert.deepEqual(deferredContract.nodes[1].taskPacket, presentContract.nodes[0].taskPacket);
  assert.equal(hashPacket(deferredContract.nodes[1].taskPacket), hashPacket(presentContract.nodes[0].taskPacket));
  assert.equal(deferredContract.nodes[1].packetHash, presentContract.nodes[0].packetHash);
});

test("a direct dependency's writeFiles satisfies a deferred scopeAcknowledged entry (acknowledged 1)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ writeFiles: ["ack.txt"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["a"], taskPacket: packet({ scopeAcknowledged: ["ack.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[1].taskPacket.scopeAcknowledged, ["ack.txt"]);
});

test("a transitive dependency's writeRoots satisfies a deferred scopeAcknowledged entry (acknowledged 2)", () => {
  const { directory, path } = writeFixture({
    nodes: [
      { id: "a", type: "backend", taskPacket: autonomousPacket({ writeRoots: ["out"] }), gate: false },
      { id: "c", type: "backend", dependsOn: ["a"], taskPacket: packet({ writeFiles: ["c.txt"] }), gate: false },
      { id: "b", type: "backend", dependsOn: ["c"], taskPacket: packet({ scopeAcknowledged: ["out/generated.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  mkdirSync(join(directory, "out"));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[2].taskPacket.scopeAcknowledged, ["out/generated.txt"]);
});

test("a scopeAcknowledged path no dependency declares is rejected naming its index (acknowledged 3)", () => {
  const { path } = writeFixture({
    nodes: [
      { id: "b", type: "backend", taskPacket: packet({ scopeAcknowledged: ["missing.txt"], writeFiles: ["b.txt"] }), gate: false },
    ],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /nodes\[0\]\.taskPacket\.scopeAcknowledged\[0\] does not exist: missing\.txt/u,
  );
});
