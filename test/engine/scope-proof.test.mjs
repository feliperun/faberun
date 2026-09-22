/**
 * The one out-of-scope write that is not advisory: the one that landed on a
 * file the node's own proof cites. These cases drive `checkWorkerScope`
 * directly so the written path can be an ordinary implementation file, which
 * is what the end-to-end scope tests cannot control.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { checkWorkerScope, emptyScope, workerScope } from "../../src/engine/scope.mjs";
import { captureWorkspaceScope, captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
import { initializeGit } from "../helpers.mjs";

// The packet of `requirement-ids-reach-the-node`, the real node whose
// legitimate write to `src/plan/freeze.mjs` outside its declared scope was
// deferred to an advisory and approved by its judge. Its proofs are the honest
// adversary for the exception: three command proofs, four verification
// commands, and not one of them naming the file that was actually written.
const DEFINITION_OF_DONE = [
  { id: "dod.r10.contract-carries", text: "The contract validates the field", proof: { kind: "command", ref: "node --test test/contract/requirement-ids.test.mjs" } },
  { id: "dod.r10.engine-injects", text: "The engine injects the ids", proof: { kind: "command", ref: "node --test --test-name-pattern=\"requirement ids reach the node\" test/engine/worker-result.test.mjs" } },
  { id: "dod.r10.contract-version", text: "CONTRACT_VERSION still reads 0.3.0", proof: { kind: "command", ref: "grep -n \"0\\.3\\.0\" src/contract/index.mjs" } },
];
const VERIFICATION = [
  { argv: ["node", "--test", "--test-name-pattern=requirement ids reach the node", "test/engine/worker-result.test.mjs"] },
  { argv: ["node", "--test", "test/contract/requirement-ids.test.mjs"] },
  { argv: ["grep", "-n", "0\\.3\\.0", "src/contract/index.mjs"] },
  { argv: ["npm", "run", "typecheck"] },
];
const WORKSPACE_FILES = [
  "src/contract/index.mjs",
  "src/engine/state.mjs",
  "src/plan/freeze.mjs",
  "test/contract/requirement-ids.test.mjs",
  "test/engine/worker-result.test.mjs",
];

/**
 * Run the live worker scope gate over one out-of-scope write, as a completed
 * attempt whose controller verification passed: `deferViolation` is what that
 * attempt earns, and the question is whether this write may use it.
 *
 * @param {string} written
 * @param {{definitionOfDone?: typeof DEFINITION_OF_DONE, files?: string[]}} [options]
 * @returns {{deferred: boolean, state: import("../../src/contract/index.mjs").NodeSnapshot}}
 */
function writeOutsideScope(written, options = {}) {
  const definitionOfDone = options.definitionOfDone ?? DEFINITION_OF_DONE;
  const workspace = mkdtempSync(join(tmpdir(), "scope-proof-workspace-"));
  for (const path of [...WORKSPACE_FILES, ...options.files ?? []]) {
    mkdirSync(join(workspace, dirname(path)), { recursive: true });
    writeFileSync(join(workspace, path), `// ${path}\n`);
  }
  const taskPacket = {
    mode: "execution",
    objective: "Carry requirement ids to the node",
    instructions: ["Do the work"],
    readFiles: [],
    // Narrower than the real packet on purpose: the declared scope has to
    // exclude both of the paths under test for either write to be unexpected.
    writeFiles: ["src/engine/state.mjs"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: VERIFICATION,
  };
  // A workspace snapshot enumerates the tree through the repository index, so
  // the fixture has to be one.
  initializeGit(workspace);
  const node = { id: "requirement-ids-reach-the-node", definitionOfDone, taskPacket };
  const boundary = captureWorkspaceScope(workspace, workerScope(/** @type {any} */ (taskPacket)));
  const baseline = captureWorkspaceSnapshot(workspace);
  writeFileSync(join(workspace, written), "// rewritten by the worker\n");

  const state = /** @type {any} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: node.id,
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "scope-proof", nodeId: node.id },
    packetHash: "a".repeat(64),
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    result: null,
    gate: null,
    error: null,
    scope: emptyScope(boundary),
  });
  const job = /** @type {any} */ ({
    scopeChecked: false,
    state,
    node,
    cwd: workspace,
    scopeBaseline: baseline,
    invocation: { snapshotPath: null },
  });
  const runDir = mkdtempSync(join(tmpdir(), "scope-proof-run-"));
  const deferred = checkWorkerScope(/** @type {any} */ ({ cwd: workspace }), runDir, job, /** @type {any} */ (null), { deferViolation: true });
  assert.equal(job.scopeViolation, true, "the write is recorded as a scope violation either way");
  return { deferred, state };
}

test("an out-of-scope write no proof cites still defers to an advisory", () => {
  // The real case: an implementation file the requirement could not be met
  // without touching. `npm run typecheck` runs over it and the suite the
  // command proofs name exercises it, but neither of them names it, so the
  // deferral holds and the judge gets the finding.
  const { deferred, state } = writeOutsideScope("src/plan/freeze.mjs");
  assert.equal(deferred, true, "the node proceeds to verification and the gate");
  assert.equal(state.status, "running", "no terminal transition was taken");
  assert.equal(state.error, null);
  assert.deepEqual(state.scope?.unexpectedPaths, ["src/plan/freeze.mjs"], "the write is still recorded as out of scope");
});

test("an out-of-scope write onto a file a command proof names is terminal", () => {
  const { deferred, state } = writeOutsideScope("test/engine/worker-result.test.mjs");
  assert.equal(deferred, false, "the node never reaches the gate on an edited prover");
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(/** @type {string} */ (state.error?.message), /test\/engine\/worker-result\.test\.mjs/u, "the message names the path");
  assert.match(/** @type {string} */ (state.error?.message), /dod\.r10\.engine-injects/u, "the message names the proof the write compromised");
  assert.equal(state.scopeFindings, undefined, "a terminal violation is not recorded as an advisory finding");
});

test("a command proof naming a quoted path with a space still cites that path", () => {
  // The words of a command proof are recovered the way the shell it runs
  // under recovers them. Split on whitespace, this ref cited `"test/my` and
  // `dir/x.test.mjs"` -- two fragments naming no file -- so editing the very
  // prover the proof names read as an ordinary advisory.
  const quoted = "test/my dir/x.test.mjs";
  const { deferred, state } = writeOutsideScope(quoted, {
    files: [quoted],
    definitionOfDone: [
      { id: "dod.quoted", text: "The suite passes", proof: { kind: "command", ref: `node --test "${quoted}"` } },
    ],
  });
  assert.equal(deferred, false, "the node never reaches the gate on an edited prover");
  assert.equal(state.error?.code, "unexpected_write");
  assert.match(/** @type {string} */ (state.error?.message), /dod\.quoted/u, "the message names the proof the write compromised");
});
