/**
 * Arms A and D: the corpus as a faberun contract, one node per requirement
 * with its dependencies, the packet's own text, symbols, decisions and
 * non-goals, its verification as deterministic Definition of Done items, and
 * -- for arm A -- a judgment item that makes the blocking cross-vendor judge
 * run. Arm D (`judge: false`) is the configuration the product documents for
 * a fully mechanical node: the proof is the gate and no judge is paid. The
 * worker is the same model the session arms run; what differs is the
 * orchestration, which is the thing measured.
 */
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

/** The writer of every arm. `maxConcurrent` is the product's per-runtime bound; three matches the contract's maxParallel. */
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

/** @param {string} id @returns {string} */
const slug = (id) => id.toLowerCase();

/**
 * @param {{id: string, cwd: string, corpus: CorpusSet, maxParallel?: number, judge?: boolean}} input
 * @returns {Record<string, unknown>}
 */
export function faberunContract({ id, cwd, corpus, maxParallel = 3, judge = true }) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId: "orchestration-arms",
    goal: `Arm ${judge ? "A" : "D"} of the orchestration-arms campaign on the ${corpus.kind} corpus: ${corpus.requirements.length} requirement(s), one node each`,
    cwd,
    runtimeDefaults: { worker: "claude-sonnet-worker", judge: "codex-sol-judge" },
    runtimes: { "claude-sonnet-worker": WORKER_RUNTIME, "codex-sol-judge": JUDGE_RUNTIME },
    maxParallel,
    stallTimeoutSec: 900,
    timeoutSec: 7200,
    nodes: corpus.requirements.map((requirement) => ({
      id: slug(requirement.id),
      type: "backend",
      phase: "corpus",
      dependsOn: requirement.dependsOn.map(slug),
      taskPacket: {
        mode: "execution",
        objective: requirement.objective,
        instructions: requirement.instructions,
        readFiles: requirement.readFiles,
        writeFiles: requirement.writeFiles,
        symbols: requirement.symbols,
        decisions: requirement.decisions,
        nonGoals: requirement.nonGoals,
        ...(requirement.scopeAcknowledged.length ? { scopeAcknowledged: requirement.scopeAcknowledged } : {}),
        verification: requirement.verification,
      },
      definitionOfDone: [
        // A verification proof's ref is the index into the packet's verification.
        ...requirement.verification.map((command, index) => ({
          id: `verification-${index}`,
          text: `passes: ${command.argv.slice(1).join(" ")}`,
          proof: { kind: "verification", ref: String(index) },
        })),
        ...(judge ? [{ id: "requirement-met", text: `The requirement is met as stated, without collateral change: ${requirement.title}`, judgment: true }] : []),
      ],
      gate: judge ? { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 } : false,
      timeoutSec: 3600,
    })),
  };
}
