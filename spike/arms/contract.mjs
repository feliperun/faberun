/**
 * Arms A, D and E: the corpus as a faberun contract, one node per requirement
 * with its dependencies, the packet's own text, symbols, decisions and
 * non-goals, its verification as deterministic Definition of Done items, and
 * -- for arm A -- a judgment item that makes the blocking cross-vendor judge
 * run. Arm D is the configuration the product documents for a fully
 * mechanical node: the proof is the gate and no judge is paid. Arm E is arm D
 * with the worker swapped for DeepSeek Flash through dsh: the same
 * orchestration, a writer whose list price is 13x lower on input and 17x on
 * output than the session arms' model, so the round can say whether a cheaper
 * writer that spends more tokens still delivers the corpus for less.
 */
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

/** The writer of arms A to D. `maxConcurrent` is the product's per-runtime bound; three matches the contract's maxParallel. */
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
/**
 * Arm E's writer: the dsh runtime the improvement loop used for DeepSeek, with
 * no fallback (a fallback to another model would contaminate the arm). dsh
 * reports no cost, so the product prices its token counts from the vendored
 * models.dev seed (deepseek-flash: 0.15 / 0.003 / 0.60 USD per MTok, in /
 * cached / out; claude-sonnet-5: 2 / 0.2 / 10).
 */
export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_RUNTIME = {
  harness: "dsh",
  model: DEEPSEEK_MODEL,
  reasoning: "high",
  vendor: "deepseek",
  sandbox: "workspace-write",
  config: { provider: "deepseek-official", "api_key.env_key": "DEEPSEEK_API_KEY" },
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
 * What distinguishes the three faberun arms: whether a judge is paid, and
 * which writer runs the nodes.
 *
 * @type {Record<"A"|"D"|"E", {judge: boolean, runtimeId: string, runtime: Record<string, unknown>, model: string}>}
 */
export const FABERUN_ARMS = {
  A: { judge: true, runtimeId: "claude-sonnet-worker", runtime: WORKER_RUNTIME, model: WORKER_MODEL },
  D: { judge: false, runtimeId: "claude-sonnet-worker", runtime: WORKER_RUNTIME, model: WORKER_MODEL },
  E: { judge: false, runtimeId: "dsh-deepseek-flash-worker", runtime: DEEPSEEK_RUNTIME, model: DEEPSEEK_MODEL },
};

/** @param {string} id @returns {string} */
const slug = (id) => id.toLowerCase();

/**
 * @param {{id: string, cwd: string, corpus: CorpusSet, maxParallel?: number, arm?: "A"|"D"|"E"}} input
 * @returns {Record<string, unknown>}
 */
export function faberunContract({ id, cwd, corpus, maxParallel = 3, arm = "A" }) {
  const { judge, runtimeId, runtime, model } = FABERUN_ARMS[arm];
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId: "orchestration-arms",
    goal: `Arm ${arm} of the orchestration-arms campaign on the ${corpus.kind} corpus: ${corpus.requirements.length} requirement(s), one node each, writer ${model}${judge ? ", blocking judge" : ", proof-only gate"}`,
    cwd,
    runtimeDefaults: { worker: runtimeId, judge: "codex-sol-judge" },
    runtimes: { [runtimeId]: runtime, "codex-sol-judge": JUDGE_RUNTIME },
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
