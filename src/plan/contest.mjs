/**
 * The contested-plan writer: end a planning pipeline the way every
 * no-valid-plan exit ends it — the contested `plan.json`, its stage line and
 * an open question on the campaign journal. Separate from `pipeline.mjs` and
 * `rounds.mjs` (measured 2026-09-24: pipeline.mjs was 742 of 800 lines)
 * because both the round loop and the pipeline's own outer catches reach this
 * same exit; a plain function they can each call, rather than a closure
 * either would have to own, is what makes that sharing possible without
 * `rounds.mjs` importing back from `pipeline.mjs`.
 */
import { join } from "node:path";
import { campaignCli } from "../cli/campaign.mjs";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {{status: "contested", plansDir: string, planPath: string, findings: PlanFindingOutput[], round: number}} ContestedPipelineResult */

/**
 * @param {{
 *   campaignId: string,
 *   phase: string,
 *   cwd: string,
 *   plansDir: string,
 *   sessionId: string,
 *   findings: PlanFindingOutput[],
 *   round: number,
 *   logStage: (stage: string, extra?: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<ContestedPipelineResult>}
 */
export async function contestPlan({ campaignId, phase, cwd, plansDir, sessionId, findings, round, logStage }) {
  const criticalFindings = findings.filter((finding) => finding.severity === "critical");
  const planPath = join(plansDir, "plan.json");
  writeJsonAtomic(planPath, { formatVersion: 1, status: "contested", rounds: round, findings });
  logStage("contested", { round, criticalCount: criticalFindings.length });
  await campaignCli([
    "note", campaignId, "--cwd", cwd, "--session-id", sessionId,
    "--kind", "open-question", "--question-id", `plan-${phase}-contested`,
    "--text", `Plan for phase ${phase} is contested after ${round} review round(s): ${criticalFindings.map((finding) => finding.text).join("; ")}`,
  ]);
  return { status: "contested", plansDir, planPath, findings, round };
}
