/**
 * The declared arms and the faberun contract built from one. Ported from
 * `spike/arms/contract.mjs`: the arm set lives in `arms.json` (the spike's
 * `FABERUN_ARMS` and the two session arms, with the same names and writers) so
 * the report is driven by a declaration rather than by code; this module owns
 * turning one corpus requirement list into the contract a faberun arm runs.
 * Why separate: the replay arm needs no contract, and the session arm needs
 * only the writer's runtime, so the contract shape has exactly one home.
 */
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { readFileSync } from "node:fs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */
/** @typedef {{name: string, runner: "faberun"|"session"|"replay", model: string, vendor?: string, harness?: string, judge?: boolean, subagents?: boolean, runtimeId?: string, runtime?: Record<string, unknown>, [key: string]: unknown}} PairedArm */
/** @typedef {{schemaVersion: number, seed: number, arms: PairedArm[]}} ArmSet */

/** The judge the orchestration-arms campaign uses, a different vendor from every writer that has a judge. */
export const JUDGE_RUNTIME = {
  harness: "codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
  vendor: "openai-sol",
  sandbox: "read-only",
  tier: 1,
  costRank: 1,
};

/** @param {string} file @returns {ArmSet} */
export function loadArms(file) {
  const spec = /** @type {any} */ (JSON.parse(readFileSync(file, "utf8")));
  if (!Array.isArray(spec.arms) || spec.arms.length === 0) throw new Error(`${file} declares no arms`);
  return { schemaVersion: spec.schemaVersion ?? 1, seed: Number(spec.seed ?? 20260923), arms: spec.arms };
}

/**
 * The faberun contract one arm runs: one node per requirement with its
 * dependencies, the packet's own text, and its verification as deterministic
 * Definition of Done items. A judged arm adds the one judgment item that
 * makes the blocking cross-vendor judge run; every other arm is the
 * configuration the product documents for a fully mechanical node, the proof
 * as the only gate with the same single revision a blocking judge gets.
 *
 * @param {{id: string, cwd: string, corpus: CorpusSet, maxParallel?: number, arm: PairedArm}} input
 * @returns {Record<string, unknown>}
 */
export function faberunContract({ id, cwd, corpus, maxParallel = 3, arm }) {
  const judge = arm.judge === true;
  const runtimeId = typeof arm.runtimeId === "string" ? arm.runtimeId : `${arm.name.toLowerCase()}-worker`;
  const runtime = /** @type {Record<string, unknown>} */ (arm.runtime ?? {});
  const model = arm.model;
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId: "orchestration-arms",
    goal: `Arm ${arm.name} of the orchestration-arms campaign on the ${corpus.id} corpus: ${corpus.requirements.length} requirement(s), one node each, writer ${model}${judge ? ", blocking judge" : ", proof-only gate"}`,
    cwd,
    runtimeDefaults: { worker: runtimeId, judge: "codex-sol-judge" },
    runtimes: { [runtimeId]: runtime, "codex-sol-judge": JUDGE_RUNTIME },
    maxParallel,
    stallTimeoutSec: 900,
    timeoutSec: 7200,
    nodes: corpus.requirements.map((requirement) => ({
      id: requirement.id.toLowerCase(),
      type: "backend",
      phase: "corpus",
      dependsOn: requirement.dependsOn.map((dependency) => dependency.toLowerCase()),
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
        ...requirement.verification.map((command, index) => ({
          id: `verification-${index}`,
          text: `passes: ${command.argv.slice(1).join(" ")}`,
          proof: { kind: "verification", ref: String(index) },
        })),
        ...(judge ? [{ id: "requirement-met", text: `The requirement is met as stated, without collateral change: ${requirement.title}`, judgment: true }] : []),
      ],
      // Every arm has the same revision budget, one; what differs is whether a
      // judge is paid. `review: "none"` dispatches no judge and keeps the
      // revision: a red verification starts one fresh attempt with the failure
      // in front of the worker. Measured 2026-09-20 with `gate: false`: a red
      // verification ended the node outright, and one timing test that flaked
      // under three concurrent workers cost arm E a node and its dependant.
      gate: judge ? { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 } : { review: "none", maxRevisions: 1 },
      timeoutSec: 3600,
    })),
  };
}
