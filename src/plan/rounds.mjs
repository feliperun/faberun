/**
 * The planning pipeline's review/revise rounds: draft a plan once, then
 * alternate review and revise up to `reviewRounds` times until no critical
 * finding remains, the round budget runs out, or a round's own revise did not
 * lower the critical count review found the round before it while leaving one
 * of that round's criticals standing (R14) — every one
 * of those ends contested, through the round that reached it. Separate from
 * `pipeline.mjs` (measured 2026-09-24:
 * pipeline.mjs was 742 of 800 lines) because this is the one place a round's
 * finding bookkeeping — merge what is still open, drop what a revise
 * silently shrank, resolve what a revise touched — happens together with the
 * in-round freeze pre-flight — whose own rules are `preflight.mjs`'s
 * (`freezePreflight`), imported rather than restated, so the rules a round
 * grades against are the rules the freeze applies. `droppedWriteFindings` and
 * `unresolvedFindings`
 * live here rather than in `pipeline.mjs` because nothing outside this loop
 * ever calls them. `runStage`, `assembleFrozenNodes`, `frozenContractRaw`,
 * `contest`, `invalidPlanFinding` and `logStage` are supplied by the caller
 * rather than imported, because `invalidPlanFinding` is also raised outside
 * any round (the draft validation and the freeze catch in `pipeline.mjs`)
 * and the rest close over pipeline state (`plansDir`, `runtimes`, the
 * campaign) this module has no reason to hold; injecting them keeps this
 * module free of a runtime dependency on `pipeline.mjs`, so a test can drive
 * it with fakes.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { writeJsonAtomic } from "../run/store.mjs";
import { stableJson } from "../util.mjs";
import { freezePreflight } from "./preflight.mjs";
import { reviseContextFor } from "./revise-context.mjs";
import { applyPlanPatch, validateFindings, validatePlanOutput } from "./template.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanOutputNode} PlanOutputNode */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./template.mjs").PlanningKind} PlanningKind */
/** @typedef {import("./contest.mjs").ContestedPipelineResult} ContestedPipelineResult */
/** @typedef {import("./pipeline.mjs").AssembledPlan} AssembledPlan */
/** @typedef {(kind: PlanningKind, inputs: Record<string, unknown>) => Promise<{contract: ValidatedContract, output: Record<string, unknown>}>} RunStageFn */
/** @typedef {(round: number, findings: PlanFindingOutput[], plan: PlanOutput|null) => Promise<ContestedPipelineResult>} ContestFn */
/** @typedef {(label: string, error: unknown) => PlanFindingOutput} InvalidPlanFindingFn */
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
 * The findings still open against the plan a revise produced. A review round
 * is under no obligation to repeat what the last one found, so replacing the
 * finding set each round silently drops any objection the new reviewer is
 * quiet about: a spike run froze a plan carrying a defect round 1 had named
 * and round 2 did not repeat, and the worker refused the packet with
 * context_missing.
 *
 * What counts as resolved is read off the two plans, never off the reviewer's
 * silence. A finding whose node the revise removed is moot. A finding whose
 * node the revise changed at all was acted on — the next review grades the
 * changed node and can object again in its own words. A finding against a
 * node the revise left identical was not addressed, and stays open. That rule
 * is also what keeps a carried finding from making convergence impossible:
 * every one of them clears the moment the reviser touches the node it names,
 * so a plan that answers its objections still freezes inside the round
 * budget, and a plan that does not still ends contested at it. A finding
 * naming no node of the plan — the pipeline's own `nodeId: "plan"` shape and
 * freeze failures — is re-derived from scratch by the next round's pre-flight,
 * so carrying it would double it.
 *
 * @param {PlanFindingOutput[]} findings everything open at the end of the round
 * @param {PlanOutput|null} previousPlan the plan the revise revised
 * @param {PlanOutput|null} revisedPlan the plan the revise produced, null when its output was refused
 * @returns {PlanFindingOutput[]}
 */
export function unresolvedFindings(findings, previousPlan, revisedPlan) {
  // No revised plan to measure against: the refused-output finding drives the
  // next round and everything raised so far is still outstanding.
  if (!revisedPlan) return findings;
  const before = new Map((previousPlan?.nodes ?? []).map((node) => [node.id, stableJson(node)]));
  const after = new Map(revisedPlan.nodes.map((node) => [node.id, stableJson(node)]));
  return findings.filter((finding) => after.has(finding.nodeId) && before.get(finding.nodeId) === after.get(finding.nodeId));
}

/**
 * The write files the plan going into a revise declared that the revised plan
 * no longer declares, one finding per (node id, path). This is the check the
 * scope-closure validator cannot make: a shrink satisfies closure without a
 * judgement about any importer, so the cheap move needs a comparator of its
 * own. Severity is critical — a drop is not automatically wrong, but it is
 * always worth a second look, and only a critical finding reaches the round
 * loop's revise-or-contest decision; major would ride along in the findings
 * file while the plan froze. Nodes are matched by id alone: a node the
 * revision renamed or removed entirely is out of scope, because tracking
 * identity across a rename is a judgement about the graph this check does
 * not make — a removed node's writes were reviewed as a removal, not as a
 * silent shrink.
 *
 * Membership is judged against the whole revised plan, not against the node
 * that used to hold the path. A revise that splits one node in two and hands
 * a file to the new sibling has not dropped that file: it is still declared,
 * still reviewable, and the graph change is visible in the plan. Measured
 * 2026-09-21 on durable-state-integrity phase 1, where a per-node test made
 * exactly that move a critical and contested a sound plan — the draft's only
 * node wrote src/repo/worktree.mjs and src/engine/cancel.mjs, and the revise
 * layered them into worktree-preserve-ref-verb and
 * cancel-preserves-integrated-heads, which is the decomposition this
 * repository's own layering asks for.
 *
 * Only a path that exists in the repository can be dropped. A file the plan
 * itself invented and the revise then renamed is a rename, not a lost write:
 * no importer, test or reader depends on a name nothing has created yet.
 * Measured 2026-09-25 on the 3a gate rerun: two of six drops were exactly
 * that (env-guard.mjs renamed env-declaration.mjs, a probe-results note moved
 * to the ledger), and each counted as a critical against a revise that had
 * resolved every critical its review raised.
 *
 * @param {PlanOutput|null} previousPlan the plan the revise revised, null when the draft never validated
 * @param {PlanOutput|null} revisedPlan the plan the revise produced, null when its output was refused
 * @param {string} cwd the repository the plan writes into
 * @returns {PlanFindingOutput[]}
 */
export function droppedWriteFindings(previousPlan, revisedPlan, cwd) {
  if (!previousPlan || !revisedPlan) return [];
  const before = new Map(previousPlan.nodes.map((node) => [node.id, new Set(node.writeFiles)]));
  const stillDeclared = new Set(revisedPlan.nodes.flatMap((node) => node.writeFiles));
  /** @type {PlanFindingOutput[]} */
  const findings = [];
  for (const node of revisedPlan.nodes) {
    const previousWrites = before.get(node.id);
    if (!previousWrites) continue;
    let dropped = 0;
    for (const path of previousWrites) {
      if (stillDeclared.has(path) || !existsSync(join(cwd, path))) continue;
      dropped += 1;
      findings.push({
        id: `dropped-write-${node.id}-${dropped}`,
        severity: "critical",
        nodeId: node.id,
        text: `Node ${node.id} no longer declares ${path} in writeFiles, which the plan this revise revised did declare, and no other node in the revised plan declares it either. Declare it again on whichever node owns the work: the resolution to a scope-closure finding is to declare or acknowledge the dragged-along file, never to drop a write the node needs — a smaller write set clears the same finding while leaving the worker unable to do the work. Moving the file to another node is a resolution; removing it from the plan is not.`,
      });
    }
  }
  return findings;
}

/**
 * The finding a round's break condition raises when a revise did not lower
 * the critical count the reviewer found: `round`'s own count sits at or above
 * `history[history.length - 2]`'s, the round right before it. Carries the
 * whole per-round history rather than just the two counts being compared, so
 * the contested record and the campaign journal note it drives both show the
 * shape of the whole attempt, not just the round that finally gave up on it.
 *
 * @param {number} round
 * @param {number[]} history critical counts, one per round measured so far, this round's last
 * @returns {PlanFindingOutput}
 */
function revisionNotConvergingFinding(round, history) {
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  return {
    id: `revision-not-converging-r${round}`,
    severity: "critical",
    nodeId: "plan",
    text: `Round ${round} review still finds ${current} critical finding(s), no fewer than round ${round - 1}'s ${previous}. Critical count by round: ${history.join(", ")}. The revise is not resolving what review keeps objecting to, so the pipeline stops here instead of spending the round(s) still in budget.`,
  };
}

/**
 * Run the review/revise rounds against a draft plan, in place of the pipeline
 * running them itself. Returns `resolved: true` with the plan and findings a
 * round's break (no critical finding left) or an exhausted `reviewRounds`
 * without a review ever running (the draft never validated) leaves behind, or
 * `resolved: false` with the `contest` result the round that hit the budget,
 * failed to converge (R14), or lost both of a round's revise attempts to
 * `validatePlanOutput` produced — `pipeline.mjs` returns that result as its
 * own.
 *
 * @param {{
 *   reviewRounds: number,
 *   plan: PlanOutput|null,
 *   rejectedDraft?: unknown,
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
 *   logStage: (stage: string, extra?: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<RoundsResult>}
 */
export async function runReviewRounds(options) {
  const {
    reviewRounds, cwd, plansDir, scratchDir, workingPlanPath, relativeWorkingPlanPath,
    relativeSpecPath, relativeRepoFactsPath, relativeCataloguePath, packageMode, repoFacts,
    runStage, assembleFrozenNodes, frozenContractRaw, contest,
    invalidPlanFinding, logStage,
  } = options;
  let plan = options.plan;
  let findings = options.findings;
  // A draft that never validated is still the plan its first revise repairs.
  if (plan === null) writeJsonAtomic(workingPlanPath, options.rejectedDraft ?? null);
  // The revise's write-drops, merged into `findings` below each round; see
  // that merge for why.
  /** @type {PlanFindingOutput[]} */
  let droppedWrites = [];
  let roundsRun = 0;
  // The critical count review found each round it actually ran, oldest
  // first: what R14's stop condition compares one round against the one
  // before it. A revise retry (`reviseOnce` below) never appends here — only
  // a round whose own review ran counts toward this history, because a retry
  // spends no round.
  /** @type {number[]} */
  const criticalHistory = [];
  // How many of the last round's criticals the revise left standing: each
  // one names a node the revise did not change (`unresolvedFindings`). R14
  // stops only when this is non-zero, because a count alone cannot tell a
  // revise that ignored an objection from one that answered every objection
  // and a fresh review found new ones. Measured 2026-09-25 on the 3a gate
  // rerun: round 1 raised 2 criticals, the revise answered both (0 carried),
  // round 2's review raised 2 different ones, and a count-only R14 stopped a
  // plan with two rounds still in budget.
  let carriedCritical = 0;

  /**
   * The deterministic checks and the two mechanical repairs, both read from
   * `preflight.mjs` rather than restated here: the same set the pipeline ran on
   * the draft runs again on every plan this loop grades, so a revise is held to
   * the rules the freeze applies and this loop can never disagree with the
   * freeze it stands in front of about what those rules are.
   *
   * @type {import("./preflight.mjs").PlanCheckContext}
   */
  const preflightContext = { repoFacts, cwd, plansDir, assembleFrozenNodes, frozenContractRaw };

  /**
   * Run the revise stage once, validate its output and run the freeze
   * pre-flight on it, and on a rejection run it a second time with the
   * check's message appended to the same round's findings — the one retry
   * R14 grants before a round contests. Every shape rejection this reaches is
   * one `validatePlanOutput` has no deterministic fix for: R21 already normalizes the one shape variant that used to need
   * one (a text `proof.ref`) inside the validator itself, so nothing here has
   * a mechanical repair to apply instead of asking the worker again. Neither
   * attempt is charged against `reviewRounds`; the caller's own round counter
   * is untouched either way.
   *
   * @param {number} round
   * @param {PlanFindingOutput[]} findingsForRevise
   * @returns {Promise<{plan: PlanOutput, runId: string, firstInvalid: PlanFindingOutput|null} | {plan: null, finding: PlanFindingOutput, firstInvalid: PlanFindingOutput}>}
   */
  const reviseOnce = async (round, findingsForRevise) => {
    const path = join(scratchDir, `findings-round-${round}.json`);
    writeJsonAtomic(path, findingsForRevise);
    // The revise edits the plan the findings were raised against, which the
    // round wrote to the working plan before review (or the draft's rejected
    // output, below). Measured 2026-09-25 on the 3a gate: a revise handed only
    // the findings redrafted the plan from scratch, renamed files and dropped
    // six writes, and its retry fixed one validator error while introducing
    // another.
    //
    // RM-110: a revise returns a patch over the nodes it changes rather than
    // the whole plan, so answering one finding costs the size of that
    // finding's nodes instead of the phase's. Two calls died on the full-plan
    // shape at 65,932 and 66,821 output tokens against the 65,536 ceiling.
    //
    // R4, campaign-efficiency phase 4: once there is a validated plan to
    // patch, the reviser also stops reading that plan, and reads no
    // repository facts. Its context is the findings' nodes, the dependencies
    // those nodes need, and the plan's own declarations (`reviseContextFor`),
    // and a context over the packet ceiling is refused by name — the explicit
    // overflow error R4 asks for on the reviser side — never truncated and
    // never silently widened back to the whole plan; the refusal is the
    // finding the round contests on. The patch still applies to the full
    // plan this loop holds; only the reading narrowed. A first round whose
    // draft never validated has no node list to narrow, so that round's
    // revise reads the rejected draft and returns a whole plan.
    const base = plan;
    const patchMode = base !== null;
    /** @type {PlanFindingOutput|null} */
    let contextFailure = null;
    /** @type {string|null} */
    let contextPath = null;
    if (patchMode) {
      const contextFile = join(scratchDir, `revise-context-round-${round}.json`);
      try {
        writeJsonAtomic(contextFile, reviseContextFor(/** @type {import("./template.mjs").PlanOutput} */ (base), findingsForRevise));
        contextPath = relative(cwd, contextFile);
      } catch (error) {
        contextFailure = invalidPlanFinding(`revise-r${round}-context`, error);
      }
    }
    if (contextFailure !== null) {
      logStage("revise", { round, contextOverBudget: contextFailure.text });
      return { plan: null, finding: contextFailure, firstInvalid: contextFailure };
    }
    const stageInputs = { specPath: relativeSpecPath, cataloguePath: relativeCataloguePath, packageMode, ...(patchMode ? { revisePatch: true } : {}) };
    const revise = await runStage("revise", { ...stageInputs, findingsPath: relative(cwd, path), planPath: /** @type {string} */ (patchMode ? contextPath : relativeWorkingPlanPath) });
    /**
     * The plan a revise's output produced, before any validation: the merged
     * patch when the reviser patched a plan, its own `output.plan` when there
     * was no plan to patch. Null only when the merge itself was refused, so
     * the retry falls back to the plan the first attempt read.
     *
     * @param {unknown} onto
     * @param {Record<string, unknown>} output
     * @returns {unknown}
     */
    const revisionFrom = (onto, output) => (patchMode ? applyPlanPatch(/** @type {{nodes: PlanOutputNode[]} & Record<string, unknown>} */ (onto), output.patch) : output.plan);
    // The whole deterministic check R14 names runs on the revise's output:
    // the shape validator, and the freeze pre-flight a review round would
    // otherwise only reach a round later. Measured 2026-09-26 on the 3a gate:
    // four rounds with no critical from review each contested on a
    // scope-closure gap the same revise had just opened, because the revise
    // learned of it only after the next review had spent its round.
    /** @type {{nodes: PlanOutputNode[]} & Record<string, unknown>|null} */
    let revision = null;
    /** @type {PlanOutput|null} */
    let structurallyValid = null;
    /** @type {PlanFindingOutput} */
    let firstInvalid;
    try {
      revision = /** @type {{nodes: PlanOutputNode[]} & Record<string, unknown>} */ (revisionFrom(base, revise.output));
      structurallyValid = validatePlanOutput(revision);
      const failure = freezePreflight(structurallyValid, preflightContext).failure;
      if (failure === null) return { plan: structurallyValid, runId: revise.contract.id, firstInvalid: null };
      firstInvalid = invalidPlanFinding(`revise-r${round}-attempt1`, failure);
    } catch (error) {
      firstInvalid = invalidPlanFinding(`revise-r${round}-attempt1`, error);
    }
    const retryPath = join(scratchDir, `findings-round-${round}-retry.json`);
    const retryFindings = [...findingsForRevise, firstInvalid];
    writeJsonAtomic(retryPath, retryFindings);
    // The retry repairs the revision the check refused, not the plan before
    // it: that revision already carries this round's resolutions, and only
    // the check's message is left to answer.
    const retryFrom = revision ?? base;
    /** @type {string} */
    let retryPlanPath;
    if (patchMode) {
      // A validator message names the refused attempt's nodes by their index
      // in its patch, and no finding names them by id: the nodes the first
      // attempt changed ride into the retry's context beside the findings'
      // own.
      /** @type {string[]} */
      let firstAttemptNodes = [];
      if (revision !== null) {
        const before = new Map(base.nodes.map((node) => [node.id, stableJson(node)]));
        firstAttemptNodes = revision.nodes.filter((node) => before.get(node.id) !== stableJson(node)).map((node) => node.id);
      }
      const retryContextFile = join(scratchDir, `revise-context-round-${round}-retry.json`);
      try {
        writeJsonAtomic(retryContextFile, reviseContextFor(/** @type {{nodes: PlanOutputNode[]} & Record<string, unknown>} */ (retryFrom), retryFindings, firstAttemptNodes));
        retryPlanPath = relative(cwd, retryContextFile);
      } catch (error) {
        // The retry's context does not fit either: the first attempt's own
        // output, when it validated, still goes to review rather than
        // contesting a round over a retry it cannot hand a context to.
        if (structurallyValid !== null) return { plan: structurallyValid, runId: revise.contract.id, firstInvalid };
        const finding = invalidPlanFinding(`revise-r${round}-context-retry`, error);
        logStage("revise", { round, contextOverBudget: finding.text });
        return { plan: null, finding, firstInvalid };
      }
    } else {
      const rejectedFile = join(scratchDir, `plan-round-${round}-rejected.json`);
      writeJsonAtomic(rejectedFile, retryFrom);
      retryPlanPath = relative(cwd, rejectedFile);
    }
    const retry = await runStage("revise", { ...stageInputs, findingsPath: relative(cwd, retryPath), planPath: retryPlanPath });
    try {
      // A retry that validates goes to review even if the freeze pre-flight
      // still refuses it: that round's own pre-flight raises it again. Its
      // patch applies to the revision the first attempt produced, which is
      // the plan the retry was handed.
      return { plan: validatePlanOutput(revisionFrom(revision ?? base, retry.output)), runId: retry.contract.id, firstInvalid };
    } catch (secondError) {
      // The first attempt still validated: it goes to review rather than
      // contesting a round over a retry that made things worse.
      if (structurallyValid !== null) return { plan: structurallyValid, runId: revise.contract.id, firstInvalid };
      return { plan: null, finding: invalidPlanFinding(`revise-r${round}-attempt2`, secondError), firstInvalid };
    }
  };

  for (let round = 1; round <= reviewRounds; round += 1) {
    roundsRun = round;
    // Only a round whose plan a review actually graded has a critical count
    // R14 can compare: an invalid plan skips review, and its one critical says
    // the plan did not validate. Measured 2026-09-25 on the 3a gate: an invalid
    // draft counted 1, the first real review counted 2 (one of them the
    // scope-closure pre-flight), and R14 stopped the plan after 2 of 4 rounds.
    const reviewed = plan !== null;
    if (plan) {
      // R14's mechanical repairs with a single answer, and the freeze rules
      // they answer to, all measured before the review is dispatched: the
      // reviewer grades — and freeze checks — the plan that would ship, and
      // the failure below is measured against the bytes the reviewer read.
      const checks = freezePreflight(plan, preflightContext);
      if (checks.raised.length) logStage("timeouts-raised", { round, raised: checks.raised });
      if (checks.declared.length) logStage("guards-declared", { round, declared: checks.declared });
      plan = checks.plan;
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
      // The contract this plan would freeze into was checked above, before the
      // review ran, and its failure rides on this round's line and findings
      // because freeze runs after the last round: caught here, a plan that
      // cannot freeze still has a revise left to fix it. The failure is a
      // critical finding, never an auto-filled acknowledgement — scope
      // closure exists to force the per-file decision (declare a write, or
      // acknowledge a read-only importer), and the revise worker, which can
      // read the repository, makes it from the validator's own message.
      /** @type {PlanFindingOutput|null} */
      let freezeFailure = null;
      if (checks.failure !== null) {
        freezeFailure = invalidPlanFinding(`freeze-r${round}`, checks.failure);
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
    // R14: a round that ends with as many or more criticals than the round
    // before it, while the revise left one of that round's criticals
    // standing, is not converging — the revise already had it in front of
    // it, and spending the rounds still in budget would not change that.
    // Checked before the round-budget exit below, so the more informative
    // finding wins when a round is both the last one and a non-improvement
    // over the one before it.
    const previousCritical = reviewed ? criticalHistory[criticalHistory.length - 1] : undefined;
    if (reviewed) criticalHistory.push(criticalFindings.length);
    if (previousCritical !== undefined && criticalFindings.length >= previousCritical && carriedCritical > 0) {
      const notConverging = revisionNotConvergingFinding(round, criticalHistory);
      findings = [...findings, notConverging];
      logStage("revision-not-converging", { round, criticalHistory });
      return { resolved: false, result: await contest(round, findings, plan) };
    }
    if (round === reviewRounds) return { resolved: false, result: await contest(round, findings, plan) };
    // Kept for the write-drop and unresolved-finding comparisons below: the
    // plan the revise revises, against whichever attempt's output validates.
    const planBeforeRevise = plan;
    const revised = await reviseOnce(round, findings);
    if (revised.plan === null) {
      // Both this round's revise attempts were rejected: the round contests
      // rather than carrying the still-unrevised plan into another round.
      findings = [...findings, revised.finding];
      logStage("revise", { round, retried: true, invalid: revised.finding.text, firstInvalid: revised.firstInvalid.text });
      return { resolved: false, result: await contest(round, findings, plan) };
    }
    plan = revised.plan;
    droppedWrites = droppedWriteFindings(planBeforeRevise, plan, cwd);
    // What the next round starts from: the findings this revise did not move
    // the plan under. Everything else — a node it changed, a node it removed,
    // and the pipeline's own shape findings, which the next round re-derives
    // — is dropped here rather than carried forever.
    findings = unresolvedFindings(findings, planBeforeRevise, plan);
    carriedCritical = findings.filter((finding) => finding.severity === "critical").length;
    logStage("revise", {
      round,
      runId: revised.runId,
      droppedWrites: droppedWrites.length,
      carriedFindings: findings.length,
      ...(revised.firstInvalid === null ? {} : { retried: true, firstInvalid: revised.firstInvalid.text }),
    });
  }
  return { resolved: true, plan, findings, roundsRun };
}

/**
 * A hard round budget around any discovery pass: at most `rounds` calls to
 * `step`, stopping at the first result whose `accepted` flag is true. The
 * reauthor flow spends this budget widening a refused packet; the planning
 * pipeline's own review/revise loop keeps its bespoke bookkeeping and does not
 * use it. `step` receives the round number and the results so far, so a round
 * can feed the previous rounds' findings into its own prompt.
 *
 * @template T
 * @param {number} rounds a positive integer; the budget is never exceeded
 * @param {(round: number, history: T[]) => T|Promise<T>} step
 * @returns {Promise<{accepted: boolean, roundsUsed: number, last: T|null, history: T[]}>}
 */
export async function runBoundedRounds(rounds, step) {
  if (!Number.isInteger(rounds) || rounds < 1) throw new TypeError(`rounds must be a positive integer: ${String(rounds)}`);
  /** @type {T[]} */
  const history = [];
  for (let round = 1; round <= rounds; round += 1) {
    const result = await step(round, history);
    history.push(result);
    if (/** @type {{accepted?: boolean}} */ (result).accepted === true) {
      return { accepted: true, roundsUsed: round, last: result, history };
    }
  }
  return { accepted: false, roundsUsed: rounds, last: history.at(-1) ?? null, history };
}
