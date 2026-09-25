/**
 * The planning pipeline's review/revise rounds: draft a plan once, then
 * alternate review and revise up to `reviewRounds` times until no critical
 * finding remains or the round budget runs out, contesting through the round
 * that exhausts it. Separate from `pipeline.mjs` (measured 2026-09-24:
 * pipeline.mjs was 742 of 800 lines) because this is the one place a round's
 * finding bookkeeping — merge what is still open, drop what a revise
 * silently shrank, resolve what a revise touched — happens together with the
 * in-round freeze pre-flight. Every function this loop closes over
 * (`runStage`, `assembleFrozenNodes`, `frozenContractRaw`, `contest`,
 * `invalidPlanFinding`, `droppedWriteFindings`, `unresolvedFindings`,
 * `logStage`) is supplied by the caller rather than imported, so this module
 * never depends on `pipeline.mjs` at runtime and stays the deterministic half
 * a test can drive with fakes. `invalidPlanFinding`, `droppedWriteFindings`
 * and `unresolvedFindings` stay exported from `pipeline.mjs`, which also
 * raises the first outside any round and is what existing tests already
 * import the other two from — injecting them here keeps that one home
 * without this module importing back from it.
 */
import { join, relative } from "node:path";
import { validateContract } from "../contract/index.mjs";
import { writeJsonAtomic } from "../run/store.mjs";
import { assertTimeoutsCoverMeasured } from "./freeze.mjs";
import { validateFindings, validatePlanOutput } from "./template.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./template.mjs").PlanningKind} PlanningKind */
/** @typedef {import("./contest.mjs").ContestedPipelineResult} ContestedPipelineResult */
/** @typedef {import("./pipeline.mjs").AssembledPlan} AssembledPlan */
/** @typedef {(kind: PlanningKind, inputs: Record<string, unknown>) => Promise<{contract: ValidatedContract, output: Record<string, unknown>}>} RunStageFn */
/** @typedef {(round: number, findings: PlanFindingOutput[]) => Promise<ContestedPipelineResult>} ContestFn */
/** @typedef {(label: string, error: unknown) => PlanFindingOutput} InvalidPlanFindingFn */
/** @typedef {(previousPlan: PlanOutput|null, revisedPlan: PlanOutput|null) => PlanFindingOutput[]} DroppedWriteFindingsFn */
/** @typedef {(findings: PlanFindingOutput[], previousPlan: PlanOutput|null, revisedPlan: PlanOutput|null) => PlanFindingOutput[]} UnresolvedFindingsFn */
/** @typedef {{resolved: true, plan: PlanOutput|null, findings: PlanFindingOutput[], roundsRun: number} | {resolved: false, result: ContestedPipelineResult}} RoundsResult */

/**
 * `incoming` merged over `carried`, keyed by finding id. A finding both
 * rounds raise is the newer reviewer's own re-judgement of the same
 * objection, severity included, so it replaces the carried copy instead of
 * duplicating it — this merge never rewrites a severity of its own. Carried
 * findings keep their order and come first, so the oldest outstanding
 * objection is at the top of the file the reviser reads.
 *
 * @param {PlanFindingOutput[]} carried
 * @param {PlanFindingOutput[]} incoming
 * @returns {PlanFindingOutput[]}
 */
function mergeFindings(carried, incoming) {
  const merged = new Map(carried.map((finding) => [finding.id, finding]));
  for (const finding of incoming) merged.set(finding.id, finding);
  return [...merged.values()];
}

/**
 * Run the review/revise rounds against a draft plan, in place of the pipeline
 * running them itself. Returns `resolved: true` with the plan and findings a
 * round's break (no critical finding left) or an exhausted `reviewRounds`
 * without a review ever running (the draft never validated) leaves behind, or
 * `resolved: false` with the `contest` result the round that hit the budget
 * produced — `pipeline.mjs` returns that result as its own.
 *
 * @param {{
 *   reviewRounds: number,
 *   plan: PlanOutput|null,
 *   findings: PlanFindingOutput[],
 *   cwd: string,
 *   plansDir: string,
 *   scratchDir: string,
 *   workingPlanPath: string,
 *   relativeWorkingPlanPath: string,
 *   relativeSpecPath: string,
 *   relativeRepoFactsPath: string,
 *   relativeCataloguePath: string,
 *   packageMode: import("./sizing.mjs").PackageMode,
 *   repoFacts: import("./repo-facts.mjs").RepoFacts,
 *   runStage: RunStageFn,
 *   assembleFrozenNodes: (plan: PlanOutput) => AssembledPlan,
 *   frozenContractRaw: (assembly: AssembledPlan) => JsonObject,
 *   contest: ContestFn,
 *   invalidPlanFinding: InvalidPlanFindingFn,
 *   droppedWriteFindings: DroppedWriteFindingsFn,
 *   unresolvedFindings: UnresolvedFindingsFn,
 *   logStage: (stage: string, extra?: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<RoundsResult>}
 */
export async function runReviewRounds(options) {
  const {
    reviewRounds, cwd, plansDir, scratchDir, workingPlanPath, relativeWorkingPlanPath,
    relativeSpecPath, relativeRepoFactsPath, relativeCataloguePath, packageMode, repoFacts,
    runStage, assembleFrozenNodes, frozenContractRaw, contest,
    invalidPlanFinding, droppedWriteFindings, unresolvedFindings, logStage,
  } = options;
  let plan = options.plan;
  let findings = options.findings;
  // The revise's write-drops, merged into `findings` below each round; see
  // that merge for why.
  /** @type {PlanFindingOutput[]} */
  let droppedWrites = [];
  let roundsRun = 0;

  for (let round = 1; round <= reviewRounds; round += 1) {
    roundsRun = round;
    if (plan) {
      // The reviewer grades a structurally valid plan; an invalid one skips
      // review and reaches revise through the validator's finding instead.
      writeJsonAtomic(workingPlanPath, plan);
      const review = await runStage("review", { specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, planPath: relativeWorkingPlanPath });
      /** @type {PlanFindingOutput|null} */
      let invalidFindings = null;
      try {
        // Merged over what is still open, never substituted for it: a round's
        // reviewer grades the plan in front of it and may simply not mention
        // an objection the last round raised, which a plain assignment here
        // threw away.
        findings = mergeFindings(findings, validateFindings(review.output.findings));
      } catch (error) {
        // The review said nothing usable about the plan, so the plan cannot be
        // treated as clean: the malformed-output finding is critical and
        // drives the same revise-or-contest path a real critical finding does,
        // with the still-outstanding findings riding along.
        invalidFindings = invalidPlanFinding(`review-r${round}`, error);
        findings = [...findings, invalidFindings];
      }
      // The contract this plan would freeze into is checked here, inside the
      // round and after the review's findings merged into the open ones,
      // because freeze runs after the last one: caught here, a plan that
      // cannot freeze still has a revise left to fix it. The failure is a
      // critical finding, never an auto-filled acknowledgement — scope
      // closure exists to force the per-file decision (declare a write, or
      // acknowledge a read-only importer), and the revise worker, which can
      // read the repository, makes it from the validator's own message.
      /** @type {PlanFindingOutput|null} */
      let freezeFailure = null;
      try {
        assertTimeoutsCoverMeasured(validateContract(frozenContractRaw(assembleFrozenNodes(plan)), join(plansDir, "contract.json")), repoFacts);
      } catch (error) {
        freezeFailure = invalidPlanFinding(`freeze-r${round}`, error);
        findings = [...findings, freezeFailure];
      }
      logStage("review", {
        round,
        runId: review.contract.id,
        findingsCount: findings.length,
        criticalCount: findings.filter((finding) => finding.severity === "critical").length,
        ...(freezeFailure === null ? {} : { freezeFailed: freezeFailure.text }),
        ...(invalidFindings === null ? {} : { invalid: invalidFindings.text }),
      });
    }
    // The revise's write-drops from the previous round land here — after the
    // review above, before the critical check below — so a drop survives into
    // the same revise-or-contest decision a review finding reaches. Merged by
    // id: a drop the last round already carried and this revise made again is
    // one finding, not two.
    findings = mergeFindings(findings, droppedWrites);
    const criticalFindings = findings.filter((finding) => finding.severity === "critical");
    if (criticalFindings.length === 0) break;
    if (round === reviewRounds) return { resolved: false, result: await contest(round, findings) };
    const findingsPath = join(scratchDir, `findings-round-${round}.json`);
    writeJsonAtomic(findingsPath, findings);
    const revise = await runStage("revise", {
      specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, cataloguePath: relativeCataloguePath, findingsPath: relative(cwd, findingsPath), packageMode,
    });
    // Kept for the write-drop comparison: the plan the revise revised, against
    // the plan it produced.
    const planBeforeRevise = plan;
    /** @type {PlanFindingOutput|null} */
    let invalid = null;
    try {
      plan = validatePlanOutput(revise.output.plan);
    } catch (error) {
      // The revise output was rejected wholesale, so the round's review
      // findings are still outstanding and ride along to the next round.
      invalid = invalidPlanFinding(`revise-r${round}`, error);
      plan = null;
      findings = [...findings, invalid];
    }
    // Null when the revise output was refused: there is no revised write set
    // to compare, and the refused-output finding already drives the round.
    droppedWrites = droppedWriteFindings(planBeforeRevise, plan);
    // What the next round starts from: the findings this revise did not move
    // the plan under. Everything else — a node it changed, a node it removed,
    // and the pipeline's own shape findings, which the next round re-derives
    // — is dropped here rather than carried forever.
    findings = unresolvedFindings(findings, planBeforeRevise, plan);
    logStage("revise", {
      round,
      runId: revise.contract.id,
      droppedWrites: droppedWrites.length,
      carriedFindings: findings.length,
      ...(invalid === null ? {} : { invalid: invalid.text }),
    });
  }
  return { resolved: true, plan, findings, roundsRun };
}
