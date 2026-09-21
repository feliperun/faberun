/**
 * One run on disk for the report renderers: a contract copy, a run record and
 * one node snapshot per spec, under a scratch home. Shared by the message and
 * the roll-up tests so both read the same shape the controller writes.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

/**
 * @param {Record<string, unknown>[]} nodeSpecs each carrying at least id, phase, status
 * @returns {{runDir: string}}
 */
export function makeRun(nodeSpecs) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-progress-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodeSpecs.map((spec) => ({ id: spec.id, type: "backend", taskPacket: packet(), gate: false, phase: spec.phase })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(directory, "report-progress");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: nodeSpecs[0]?.startedAt ?? "2026-01-01T00:00:00.000Z",
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  for (const spec of nodeSpecs) {
    const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((node) => node.id === spec.id));
    // `spec.phase` is the campaign phase group, already baked into the
    // contract node above; the raw snapshot's own `phase` is the node's
    // execution phase (`worker`/`judge`/`complete`, a disjoint enum) and is
    // derived from its status here unless a test overrides it explicitly.
    const { id, phase: _campaignPhase, ...overrides } = spec;
    const status = /** @type {string} */ (spec.status ?? "pending");
    const snapshotPhase = overrides.phase ?? (["done", "no-op", "canceled", "blocked", "failed", "exhausted", "stalled"].includes(status) ? "complete" : "worker");
    writeFileSync(join(runDir, "nodes", `${id}.json`), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id,
      type: planNode.type,
      sourceIdentity: planNode.sourceIdentity,
      packetHash: planNode.packetHash,
      status: "pending",
      phase: snapshotPhase,
      attempt: 1,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      result: null,
      gate: null,
      error: null,
      ...overrides,
    }, null, 2)}\n`);
  }
  return { runDir };
}

/** @param {string} summary */
export const doneResult = (summary) => ({ status: "done", summary, verification: [], artifacts: [], missingContext: [] });
