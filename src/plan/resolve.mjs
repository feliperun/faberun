/**
 * `faberun plan --resolve` (R9): the operator's answer to a contested plan.
 * A contest already lists every critical finding with its id, the node or
 * requirement it concerns, and what would resolve it (`plan.json`, written by
 * `contest.mjs`); this module reads that record back, requires an
 * `accept`/`reject` decision for each critical finding, records every
 * decision on the campaign journal, and resumes at the review stage's own
 * exit — straight into the same sizing/routing/freeze assembly a fresh plan
 * runs through (`assembleFrozenPlan`/`frozenContractRawOf` in
 * `pipeline.mjs`) — without redrafting or asking a provider anything. The
 * operator's decision is what a review round would otherwise have to
 * produce: `accept` proceeds despite the finding, `reject:<reason>` dismisses
 * it with the operator's own reasoning; either way the finding stops
 * blocking freeze once it is answered. Separate from `pipeline.mjs` because
 * it starts from a `plan.json` a previous run already wrote instead of an
 * empty scratch directory, and needs none of that module's draft or provider
 * seams.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readCampaign } from "../campaign/record.mjs";
import { campaignCli } from "../cli/campaign.mjs";
import { campaignTree } from "../run/paths.mjs";
import { appendJsonl, readJson } from "../run/store.mjs";
import { freezePlan } from "./freeze.mjs";
import { highestOf, modelOf } from "./pipeline-shape.mjs";
import { PLANNER_SESSION_ID, assembleFrozenPlan, frozenContractRawOf, invalidPlanFinding, writeFrozenPlan } from "./pipeline.mjs";
import { contestPlan } from "./contest.mjs";
import { RISK_TIERS } from "./template.mjs";

/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./contest.mjs").ContestedPlanRecord} ContestedPlanRecord */
/** @typedef {import("./contest.mjs").ContestedPipelineResult} ContestedPipelineResult */
/** @typedef {import("./pipeline.mjs").FrozenPipelineResult} FrozenPipelineResult */
/** @typedef {{decision: "accept"|"reject", reason?: string}} FindingAnswer */

/**
 * `--answer <finding-id>=accept` or `--answer <finding-id>=reject:<reason>`,
 * one flag per critical finding, split on the first `=`. `reject` further
 * splits on the first `:` for its reason, which may itself contain `:`, and
 * the reason must not be empty — a bare `reject` names no rationale to record.
 *
 * @param {string[]} rawAnswers
 * @returns {Map<string, FindingAnswer>}
 */
export function parseAnswerFlags(rawAnswers) {
  /** @type {Map<string, FindingAnswer>} */
  const answers = new Map();
  for (const raw of rawAnswers) {
    const eq = raw.indexOf("=");
    if (eq < 0) throw new Error(`--answer must be <finding-id>=accept or <finding-id>=reject:<reason>: ${raw}`);
    const findingId = raw.slice(0, eq);
    const rest = raw.slice(eq + 1);
    if (!findingId) throw new Error(`--answer finding id must not be empty: ${raw}`);
    if (rest === "accept") {
      answers.set(findingId, { decision: "accept" });
      continue;
    }
    if (rest === "reject" || rest.startsWith("reject:")) {
      const reason = rest === "reject" ? "" : rest.slice("reject:".length);
      if (!reason) throw new Error(`--answer reject requires a reason: ${raw}`);
      answers.set(findingId, { decision: "reject", reason });
      continue;
    }
    throw new Error(`--answer must be <finding-id>=accept or <finding-id>=reject:<reason>: ${raw}`);
  }
  return answers;
}

/**
 * The decision text one operator answer becomes on the campaign journal:
 * bounded and self-contained, never the finding's own text — that already
 * lives in `plan.json`, and repeating it here is exactly the shape of
 * over-long note RM-105 fixed in `contest.mjs`.
 *
 * @param {PlanFindingOutput} finding
 * @param {FindingAnswer} answer
 * @returns {string}
 */
function decisionText(finding, answer) {
  const verb = answer.decision === "accept" ? "Accepted" : "Rejected";
  return answer.reason ? `${verb} finding ${finding.id} (${finding.nodeId}): ${answer.reason}` : `${verb} finding ${finding.id} (${finding.nodeId}).`;
}

/**
 * Resume a contested plan from the operator's answers.
 *
 * @param {{plansDir: string, cwd: string, answers: Map<string, FindingAnswer>}} options
 * @returns {Promise<FrozenPipelineResult|ContestedPipelineResult>}
 */
export async function resolvePlanningPipeline({ plansDir, cwd, answers }) {
  const planPath = join(plansDir, "plan.json");
  const record = /** @type {ContestedPlanRecord} */ (/** @type {unknown} */ (readJson(planPath)));
  if (record.status !== "contested") throw new Error(`plan at ${planPath} is not contested (status: ${record.status})`);
  if (!record.plan) throw new Error(`plan at ${planPath} has no plan to resume: the draft or revise that produced it never validated; run faberun plan again instead of --resolve`);
  if (!record.resume) throw new Error(`plan at ${planPath} predates faberun plan --resolve and carries no resume context; run faberun plan again`);
  const { campaignId, phase, specPath, specDigest, runtimeDefaults, runtimes, verification, packageMode, targetedFix, approveBelow, repoFacts } = record.resume;
  const plan = /** @type {PlanOutput} */ (record.plan);
  const findings = /** @type {PlanFindingOutput[]} */ (record.findings ?? []);
  const round = record.rounds ?? 0;

  const campaignPath = campaignTree(cwd, campaignId);
  const campaign = readCampaign(campaignPath);
  if (campaign.status !== "active") throw new Error(`campaign is closed: ${campaignId}`);

  const criticalFindings = findings.filter((finding) => finding.severity === "critical");
  const criticalIds = new Set(criticalFindings.map((finding) => finding.id));
  const unknown = [...answers.keys()].filter((id) => !criticalIds.has(id));
  if (unknown.length > 0) throw new Error(`--answer names finding(s) that are not open critical findings on this plan: ${unknown.join(", ")}`);
  const missing = criticalFindings.filter((finding) => !answers.has(finding.id)).map((finding) => finding.id);
  if (missing.length > 0) throw new Error(`every critical finding needs an --answer before the plan can resolve: ${missing.join(", ")}`);

  const pipelineLog = join(plansDir, "pipeline.jsonl");
  /** @param {string} stage @param {Record<string, unknown>} [extra] */
  const logStage = (stage, extra = {}) => appendJsonl(pipelineLog, { type: "plan.stage", at: new Date().toISOString(), campaignId, phase, stage, ...extra });

  for (const finding of criticalFindings) {
    const answer = /** @type {FindingAnswer} */ (answers.get(finding.id));
    await campaignCli([
      "note", campaignId, "--cwd", cwd, "--session-id", PLANNER_SESSION_ID,
      "--kind", "decision", "--decision-id", `plan-${phase}-${finding.id}`,
      "--text", decisionText(finding, answer),
    ]);
  }
  logStage("resolve", { round, answered: criticalFindings.length });

  const freezeWarnings = verification.sharedVerification || verification.finalVerification
    ? []
    : ["the frozen contract carries neither sharedVerification nor finalVerification, so no repository ratchet runs on its nodes and no final check closes the phase; pass --verification <file> if the target repository has ratchets every node must run"];
  let stage = "sizing";
  try {
    const assembled = assembleFrozenPlan(plan, { repoFacts, packageMode, targetedFix, phase, cwd, runtimes, runtimeDefaults });
    stage = "freeze";
    logStage("sizing", { transformations: assembled.sizing.transformations.length, nodeCount: assembled.sizing.plan.nodes.length, overheadMinutes: assembled.sizing.estimate.overheadMinutes });
    logStage("routing", { assignments: Object.keys(assembled.routing.assignments).length });
    const highestRiskTier = highestOf(assembled.sizing.plan.nodes.map((node) => node.riskTier ?? RISK_TIERS[0]));
    const frozen = freezePlan(frozenContractRawOf(assembled, { campaignId, phase, campaignGoal: campaign.goal, cwd, plansDir, runtimes, runtimeDefaults, verification }), {
      outDir: plansDir,
      phases: assembled.phases,
      spec: { path: specPath, digest: specDigest },
      facts: repoFacts,
      provenance: {
        targetGitHead: repoFacts.gitHead,
        planner: { runtimeId: runtimeDefaults.worker ?? "", model: modelOf(runtimes, runtimeDefaults.worker) },
        reviewer: { runtimeId: runtimeDefaults.judge ?? "", model: modelOf(runtimes, runtimeDefaults.judge) },
        sizing: assembled.sizing.transformations,
        findings,
      },
    });
    logStage("freeze", { contractId: `${campaignId}-${phase}`, highestRiskTier, ...(freezeWarnings.length ? { warnings: freezeWarnings } : {}) });

    const approved = approveBelow === "high" ? true : approveBelow === "none" ? false : highestRiskTier !== "high";
    writeFrozenPlan(plansDir, frozen, { status: "frozen", approved });
    if (!approved) {
      await campaignCli([
        "note", campaignId, "--cwd", cwd, "--session-id", PLANNER_SESSION_ID,
        "--kind", "open-question", "--question-id", `plan-${phase}-approval`,
        "--text", `Plan for phase ${phase} carries a ${highestRiskTier}-risk node; approval is required under --approve-below ${approveBelow}.`,
      ]);
    }
    logStage("approval", { approved, approveBelow, highestRiskTier });
    return { status: "frozen", plansDir, planPath, contractPath: join(plansDir, "contract.json"), approved, findings, warnings: freezeWarnings };
  } catch (error) {
    const failedStage = /** @type {{planStage?: string}} */ (error)?.planStage ?? stage;
    logStage(failedStage, { failed: error instanceof Error ? error.message : String(error) });
    const failureFinding = invalidPlanFinding(failedStage, error);
    rmSync(join(plansDir, "contract.json"), { force: true });
    return await contestPlan({
      campaignId, phase, cwd, plansDir, sessionId: PLANNER_SESSION_ID,
      findings: [...findings, failureFinding], round, plan, resume: record.resume, logStage,
    });
  }
}
