/**
 * Arm A's contract: the same corpus as the session arms, one faberun node per
 * requirement, with everything the product brings to a node -- a closed
 * packet, a write scope the tool boundary enforces, the proof as the node's
 * verification, a cross-vendor blocking judge with one revision, and the
 * product's own attempt bounds. The worker is the same model the session
 * arms run; what differs is the orchestration, which is the thing measured.
 */
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";

/** @typedef {import("./corpus.mjs").Requirement} Requirement */

/** The writer of every arm. `maxConcurrent` is the product's new per-runtime bound; three matches the contract's maxParallel. */
export const WORKER_MODEL = "claude-sonnet-5";
export const WORKER_RUNTIME = {
  harness: "claude",
  model: WORKER_MODEL,
  reasoning: "high",
  vendor: "anthropic-sonnet",
  permissionMode: "bypassPermissions",
  tier: 1,
  costRank: 1,
  maxConcurrent: 3,
};
/** The judge the improvement loop uses today, a different vendor from the writer. */
export const JUDGE_RUNTIME = {
  harness: "codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
  vendor: "openai-sol",
  sandbox: "read-only",
  tier: 1,
  costRank: 1,
};

/**
 * @param {{id: string, cwd: string, requirements: Requirement[], maxParallel?: number}} input
 * @returns {Record<string, unknown>}
 */
export function faberunContract({ id, cwd, requirements, maxParallel = 3 }) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId: "orchestration-arms",
    goal: `Arm A of the orchestration-arms campaign: ${requirements.length} open corpus requirement(s), one node each`,
    cwd,
    runtimeDefaults: { worker: "claude-sonnet-worker", judge: "codex-sol-judge" },
    runtimes: { "claude-sonnet-worker": WORKER_RUNTIME, "codex-sol-judge": JUDGE_RUNTIME },
    maxParallel,
    stallTimeoutSec: 900,
    timeoutSec: 3600,
    nodes: requirements.map((requirement) => ({
      id: requirement.id.toLowerCase(),
      type: "backend",
      phase: "corpus",
      dependsOn: [],
      taskPacket: {
        mode: "execution",
        objective: requirement.titulo,
        instructions: [
          requirement.objetivo,
          "Never edit or delete anything under spike/corpus/provas/: those are the acceptance proofs, and the controller runs them after you report.",
          "Return the worker result as the only JSON object of your final message.",
        ],
        readFiles: [...new Set([...requirement.gabarito, requirement.prova])],
        writeFiles: requirement.escopoEscrita,
        symbols: [],
        decisions: [],
        nonGoals: ["Do not change files outside the write scope."],
        verification: [{ argv: [process.execPath, "--test", requirement.prova], timeoutSec: 180 }],
      },
      // A judgment item is what makes the blocking judge run: with only the
      // deterministic proof the product settles the gate without a review,
      // and the arm would not carry the judge's cost the campaign charges it.
      definitionOfDone: [
        // A command proof's ref is the shell command the gate runs, not an
        // index into verification (measured in the smoke: ref "0" ran `0`).
        { id: "proof-passes", text: `The acceptance proof passes: ${requirement.comando}`, proof: { kind: "command", ref: requirement.comando } },
        { id: "requirement-met", text: `The requirement is met as stated, without collateral change: ${requirement.titulo}`, judgment: true },
      ],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
      timeoutSec: 2400,
    })),
  };
}
