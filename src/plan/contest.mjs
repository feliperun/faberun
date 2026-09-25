/**
 * The contested-plan writer: end a planning pipeline the way every
 * no-valid-plan exit ends it — the contested `plan.json`, its stage line and
 * an open question on the campaign journal. Separate from `pipeline.mjs` and
 * `rounds.mjs` (measured 2026-09-24: pipeline.mjs was 742 of 800 lines)
 * because both the round loop and the pipeline's own outer catches reach this
 * same exit; a plain function they can each call, rather than a closure
 * either would have to own, is what makes that sharing possible without
 * `rounds.mjs` importing back from `pipeline.mjs`.
 *
 * `plan` and `resume` ride along on the written record so `faberun plan
 * --resolve` (R9, `src/plan/resolve.mjs`) can continue from exactly this
 * point without redrafting or re-collecting repo facts: `plan` is the last
 * plan a draft or revise actually validated (null when none ever did), and
 * `resume` is everything else `resolve.mjs` needs to reassemble and freeze
 * it — the same inputs this run itself was given.
 *
 * The open-question note carries a count and the finding ids only, never
 * their text (RM-105, measured 2026-09-24: two contests in the same campaign
 * joined every critical finding's text into one note and blew the journal's
 * per-entry cap, `entry.text is 4706 bytes, over the 2048-byte cap`). Every
 * finding's full text already lives in `plan.json`, which the note points at.
 */
import { join } from "node:path";
import { campaignCli } from "../cli/campaign.mjs";
import { writeJsonAtomic } from "../run/store.mjs";

/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./pipeline.mjs").VerificationSuites} VerificationSuites */
/** @typedef {{status: "contested", plansDir: string, planPath: string, findings: PlanFindingOutput[], round: number}} ContestedPipelineResult */
/**
 * @typedef {{
 *   campaignId: string,
 *   phase: string,
 *   specPath: string,
 *   specDigest: string,
 *   reviewRounds: number,
 *   runtimeDefaults: {worker?: string, judge?: string},
 *   runtimes: Record<string, Record<string, unknown>>,
 *   verification: VerificationSuites,
 *   packageMode: import("./sizing.mjs").PackageMode,
 *   targetedFix: boolean,
 *   approveBelow: "standard"|"high"|"none",
 *   repoFacts: import("./repo-facts.mjs").RepoFacts,
 * }} ContestResumeContext
 */
/** @typedef {{formatVersion: 1, status: "contested", rounds: number, findings: PlanFindingOutput[], plan: PlanOutput|null, resume: ContestResumeContext}} ContestedPlanRecord */

/**
 * @param {{
 *   campaignId: string,
 *   phase: string,
 *   cwd: string,
 *   plansDir: string,
 *   sessionId: string,
 *   findings: PlanFindingOutput[],
 *   round: number,
 *   plan: PlanOutput|null,
 *   resume: ContestResumeContext,
 *   logStage: (stage: string, extra?: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<ContestedPipelineResult>}
 */
export async function contestPlan({ campaignId, phase, cwd, plansDir, sessionId, findings, round, plan, resume, logStage }) {
  const criticalFindings = findings.filter((finding) => finding.severity === "critical");
  const planPath = join(plansDir, "plan.json");
  writeJsonAtomic(planPath, /** @type {ContestedPlanRecord} */ ({ formatVersion: 1, status: "contested", rounds: round, findings, plan, resume }));
  logStage("contested", { round, criticalCount: criticalFindings.length });
  const criticalIds = criticalFindings.map((finding) => finding.id);
  await campaignCli([
    "note", campaignId, "--cwd", cwd, "--session-id", sessionId,
    "--kind", "open-question", "--question-id", `plan-${phase}-contested`,
    "--text", `Plan for phase ${phase} is contested after ${round} review round(s) with ${criticalFindings.length} critical finding(s): ${criticalIds.join(", ")}. Each finding's node/requirement and resolution is in ${planPath}. Resolve with: faberun plan --resolve ${plansDir} --answer <finding-id>=accept and/or --answer <finding-id>=reject:<reason>.`,
  ]);
  return { status: "contested", plansDir, planPath, findings, round };
}
