/**
 * The faberun arms: the corpus as a contract, one node per requirement with
 * its dependencies, the packet's own text, symbols, decisions and non-goals,
 * its verification as deterministic Definition of Done items, and -- for arm
 * A alone -- a judgment item that makes the blocking cross-vendor judge run.
 * Arm D is the configuration the product documents for a fully mechanical
 * node: the proof is the gate and no judge is paid. Arms E to J are arm D
 * with the writer swapped, one model per arm across four harnesses, so the
 * round can say what each writer delivers per dollar under the same
 * orchestration: the owner's hypothesis is that a cheap writer that spends
 * more tokens still delivers for less in total than the frontier models.
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
/**
 * @param {string} model
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
const codexWriter = (model, extra = {}) => ({ harness: "codex", model, reasoning: "high", vendor: `openai-${model}`, sandbox: "workspace-write", tier: 1, costRank: 1, maxConcurrent: 3, ...extra });
/** The judge the improvement loop uses today, a different vendor from every writer that has a judge. */
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
 * What distinguishes the faberun arms: whether a judge is paid, and which
 * writer runs the nodes. List prices (USD per MTok, in / cached / out) from
 * the product's vendored models.dev seed, except gpt-6-astra, which the seed
 * predates and whose OpenAI list price (models.dev, read 2026-09-20) is
 * declared on the runtime. The GLM arm runs glm-5.3-flash: no 5.5 exists in
 * models.dev, the catalogue or this machine's ZCode history (checked
 * 2026-09-20), so the owner's "GLM 5.5 Flash" is taken as the newest flash.
 *
 *   claude-sonnet-5  2    / 0.2   / 10     (A to D)
 *   deepseek-flash   0.15 / 0.003 / 0.60   (E)
 *   claude-opus-5    5    / 0.5   / 25     (F)
 *   gpt-5.6-sol      4    / 0.4   / 20     (G)
 *   gpt-5.6-luna     0.2  / 0.02  / 1.2    (H)
 *   gpt-6-astra      10   / 1     / 50     (I)
 *   glm-5.3-flash    0.15 / 0.03  / 0.5    (J)
 *
 * @type {Record<string, {judge: boolean, runtimeId: string, runtime: Record<string, unknown>, model: string}>}
 */
export const FABERUN_ARMS = {
  A: { judge: true, runtimeId: "claude-sonnet-worker", runtime: WORKER_RUNTIME, model: WORKER_MODEL },
  D: { judge: false, runtimeId: "claude-sonnet-worker", runtime: WORKER_RUNTIME, model: WORKER_MODEL },
  E: { judge: false, runtimeId: "dsh-deepseek-flash-worker", runtime: DEEPSEEK_RUNTIME, model: DEEPSEEK_MODEL },
  F: { judge: false, runtimeId: "claude-opus-worker", runtime: { ...WORKER_RUNTIME, model: "claude-opus-5", vendor: "anthropic-opus" }, model: "claude-opus-5" },
  G: { judge: false, runtimeId: "codex-sol-worker", runtime: codexWriter("gpt-5.6-sol"), model: "gpt-5.6-sol" },
  H: { judge: false, runtimeId: "codex-luna-worker", runtime: codexWriter("gpt-5.6-luna"), model: "gpt-5.6-luna" },
  I: { judge: false, runtimeId: "codex-astra-worker", runtime: codexWriter("gpt-6-astra", { pricing: { inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50 } }), model: "gpt-6-astra" },
  J: { judge: false, runtimeId: "zcode-glm-flash-worker", runtime: { harness: "zcode", model: "glm-5.3-flash", vendor: "zhipu", permissionMode: "yolo", config: { "auth_token.env_key": "ZAI_API_KEY" }, tier: 1, costRank: 1, maxConcurrent: 3 }, model: "glm-5.3-flash" },
};
/** The arms that differ from D only by the writer. */
export const WRITER_ARMS = Object.keys(FABERUN_ARMS).filter((arm) => arm !== "A" && arm !== "D");

/** @param {string} id @returns {string} */
const slug = (id) => id.toLowerCase();

/**
 * @param {{id: string, cwd: string, corpus: CorpusSet, maxParallel?: number, arm?: string}} input an arm of FABERUN_ARMS
 * @returns {Record<string, unknown>}
 */
export function faberunContract({ id, cwd, corpus, maxParallel = 3, arm = "A" }) {
  const spec = FABERUN_ARMS[arm];
  if (!spec) throw new Error(`arm ${arm} is not a faberun arm`);
  const { judge, runtimeId, runtime, model } = spec;
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
      // Every faberun arm has the same revision budget, one; what differs is
      // whether a judge is paid. `review: "none"` dispatches no judge and keeps
      // the revision: a red verification starts one fresh attempt with the
      // failure in front of the worker, as it does under the blocking judge.
      // Measured 2026-09-20 with `gate: false`: a red verification ended the
      // node outright, and one timing test that flaked under three concurrent
      // workers cost arm E a node and its dependant with no second attempt.
      gate: judge ? { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 } : { review: "none", maxRevisions: 1 },
      timeoutSec: 3600,
    })),
  };
}
