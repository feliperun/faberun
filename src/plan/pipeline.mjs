/**
 * The planning pipeline: `faberun plan` as successive ordinary runs (draft,
 * review, revise up to a round budget) followed by the deterministic stages
 * (sizing, routing, freeze), never as one long-lived process. Separate from
 * `template.mjs` (which only builds the one-node contracts) and from
 * `freeze.mjs` (which only turns a plan into a validated contract on disk):
 * this module sequences the draft and stages the sizing/routing/freeze
 * assembly both the round loop and the final freeze run through. The round
 * loop itself — checking each round's plan against the contract it would
 * freeze into, comparing a revision's write set against the plan it revised,
 * and the finding bookkeeping that decides when a round is done — lives in
 * `rounds.mjs`; the contested-plan exit every unresolvable path returns
 * through lives in `contest.mjs`. `launch` and `wait` are the only two seams
 * that touch a process or the wall clock, so a test drives the whole pipeline
 * through `runContract` in-process, deterministically.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CONTRACT_VERSION, DEFAULT_MAX_TURNS, PROTOCOL_SCHEMA_VERSION, validateContract } from "../contract/index.mjs";
import { discoveryOutput } from "../contract/worker-result.mjs";
import { readWorkerResultFile } from "../engine/result-file.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";
import { appendSeatAllowanceEvent, readJournal } from "../campaign/journal.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { campaignCli } from "../cli/campaign.mjs";
import { appendJsonl } from "../run/store.mjs";
import { allowanceDelta, allowanceEventFields, sampleAllowance } from "../seat/allowance.mjs";
import { askPlanningRuntimes, refusePlanningSilence, refuseUnplannableRuntimes } from "./preflight.mjs";
import { firstEligibleReviewer, reviewerProvenanceOf } from "./reviewer.mjs";
import { parseSpec, validateSpec } from "./spec.mjs";
import { collectRepoFacts } from "./repo-facts.mjs";
import { checkPlanProofs } from "./proof-check.mjs";
import { collectHumanSteps } from "./human-step.mjs";
import { RISK_TIERS, TASK_KIND_CATALOGUE_FILE, buildPlanningContract, renderTaskKindCatalogue, validatePlanOutput } from "./template.mjs";
import { MIN_WRITE_FILES, applySizingRules, provenParallelism } from "./sizing.mjs";
import { resolveRuntimes } from "./routing.mjs";
import { contentDigest, freezePlan, writeFrozenPlanRecord } from "./freeze.mjs";
import { availabilityOf, fileLineCount, highestOf, modelOf, toContractNode, toSizingNode } from "./pipeline-shape.mjs";
import { campaignTree, runDirectory } from "../run/paths.mjs";
import { contestPlan } from "./contest.mjs";
import { runReviewRounds } from "./rounds.mjs";

// `droppedWriteFindings` and `unresolvedFindings` are defined in
// `rounds.mjs`, the only module that calls them: this is a compatibility
// re-export, not a second home, kept because `test/plan/template.test.mjs`
// already names this path.
export { droppedWriteFindings, unresolvedFindings } from "./rounds.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").VerificationCommand} VerificationCommand */
/** @typedef {{sharedVerification?: VerificationCommand[], finalVerification?: VerificationCommand[]}} VerificationSuites */
/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./template.mjs").PlanPhase} PlanPhase */
/** @typedef {import("./sizing.mjs").PlanNode & {objective: string}} SizedPlanNode */
/** @typedef {{sizing: import("./sizing.mjs").SizingResult, routing: import("./routing.mjs").RoutingResult, nodes: JsonObject[], phases?: PlanPhase[]}} AssembledPlan */
/** @typedef {"standard"|"high"|"none"} ApproveBelow */
/** @typedef {(contractPath: string, contract: ValidatedContract) => Promise<void>|void} LaunchFn */
/** @typedef {(runtimes: Record<string, JsonObject>, runtimeDefaults: {worker?: string, judge?: string}, cwd: string) => Promise<import("../harnesses/index.mjs").ProbeResult[]>} AskFn */
/** @typedef {(runDir: string) => Promise<import("../engine/supervise.mjs").RunProgress>|import("../engine/supervise.mjs").RunProgress} WaitFn */
/** @typedef {{status: "frozen", plansDir: string, planPath: string, contractPath: string, approved: boolean, findings: PlanFindingOutput[], warnings: string[]}} FrozenPipelineResult */
/** @typedef {import("./contest.mjs").ContestedPipelineResult} ContestedPipelineResult */

/**
 * The session id every automated journal entry this pipeline writes carries.
 * There is no human session behind a `plan` invocation, so a fixed id names
 * the writer the same way `src/web/api.mjs`'s `WEB_SESSION_ID` names the web
 * surface's own automated writes.
 */
export const PLANNER_SESSION_ID = "planner";

/**
 * Where this pipeline stages the scratch files it must hand a discovery node
 * through `readFiles`: `<cwd>/<this>/<campaignId>/<phase>/`, gitignored. Kept
 * out of `RUNS_DIR_NAME` on purpose — a repository with nothing under the
 * home yet treats a present `.runs` as an unmigrated legacy layout
 * (`runsRoot` in `src/run/paths.mjs`), and this directory must never trip
 * that check.
 */
const PLAN_SCRATCH_DIR_NAME = ".faberun-plan";

/**
 * No taskKind/riskTier row is opinionated by default: absent an operator
 * `--runtime-defaults` instruction, every sized node routes through plain
 * availability discovery (`resolveRuntimes`'s cheapest worker, strongest
 * cross-vendor judge). A default table cannot safely name a `prefer` runtime
 * id without knowing the operator's own catalogue, so "small default" here
 * means empty rather than guessed.
 */
export const DEFAULT_ROUTING_TABLE = /** @type {import("./routing.mjs").RoutingRule[]} */ ([]);

/** The sizing budget a frozen node's verification is measured against, absent a project-specific one. */
export const DEFAULT_NODE_BUDGET_MS = 600_000;

const APPROVE_BELOW_VALUES = new Set(["standard", "high", "none"]);

/**
 * @param {{specPath: string, campaignId: string, phase: string, cwd?: string, reviewRounds?: number, approveBelow?: ApproveBelow, runtimeDefaults?: {worker?: string, judge?: string}, reviewers?: string[], runtimes: Record<string, JsonObject>, verification?: VerificationSuites, packageMode?: import("./sizing.mjs").PackageMode, targetedFix?: boolean, launch: LaunchFn, wait: WaitFn, ask?: AskFn}} options
 *   `targetedFix` allows a plan with a single node. Sizing refuses one by
 *   default because a phase that decomposes into one node is usually a plan
 *   that was never decomposed; a targeted fix is the case where one node is
 *   the honest answer, and the operator says so.
 * @returns {Promise<FrozenPipelineResult|ContestedPipelineResult>}
 */
export async function runPlanningPipeline(options) {
  const {
    specPath, campaignId, phase, runtimes, launch, wait,
    reviewRounds = 2, runtimeDefaults = {}, reviewers = [], verification = {}, targetedFix = false,
  } = options;
  const ask = options.ask ?? askPlanningRuntimes;
  // Implementation work is sized by what it writes; exploratory work -- an
  // audit, a review, a survey -- by what it reads, because it writes one
  // findings file whatever surface it covers.
  const packageMode = /** @type {import("./sizing.mjs").PackageMode} */ (options.packageMode ?? "implementation");
  if (packageMode !== "implementation" && packageMode !== "exploratory") throw new TypeError(`packageMode must be implementation or exploratory: ${String(packageMode)}`);
  const approveBelow = /** @type {ApproveBelow} */ (options.approveBelow ?? "standard");
  if (!APPROVE_BELOW_VALUES.has(approveBelow)) throw new TypeError(`approveBelow must be one of ${[...APPROVE_BELOW_VALUES].join(", ")}`);
  if (typeof launch !== "function") throw new TypeError("runPlanningPipeline requires a launch seam");
  if (typeof wait !== "function") throw new TypeError("runPlanningPipeline requires a wait seam");
  const cwd = resolve(options.cwd ?? ".");

  const campaignPath = campaignTree(cwd, campaignId);
  const campaign = readCampaign(campaignPath);
  if (campaign.status !== "active") throw new Error(`campaign is closed: ${campaignId}`);
  refuseUnplannableRuntimes(runtimes, runtimeDefaults, packageMode);
  refusePlanningSilence(await ask(runtimes, runtimeDefaults, cwd), cwd);

  const relativeSpecPath = repoRelativePath(cwd, specPath, "specPath");
  const specText = readFileSync(resolve(cwd, relativeSpecPath), "utf8");
  // Pinned now, from the same bytes every planning stage reads, so the frozen
  // record names the exact structured spec it was planned from.
  const specDigest = contentDigest(specText);
  const specValidation = validateSpec(specText, { cwd, strict: true });
  if (specValidation.class === "structured" && !specValidation.ok) {
    const detail = specValidation.findings.map((finding) => `${finding.rule}: ${finding.message}`).join("; ");
    throw new Error(`spec ${specPath} fails strict traceability: ${detail}`);
  }

  const plansDir = join(campaignTree(cwd, campaignId), "plans", phase);
  mkdirSync(plansDir, { recursive: true });
  const pipelineLog = join(plansDir, "pipeline.jsonl");
  /** @param {string} stage @param {Record<string, unknown>} [extra] */
  const logStage = (stage, extra = {}) => appendJsonl(pipelineLog, {
    type: "plan.stage", at: new Date().toISOString(), campaignId, phase, stage, ...extra,
  });

  // A discovery node's `readFiles` must resolve inside `cwd` (the task packet's
  // own containment rule), but `plansDir` lives under the home since R2 and no
  // longer nests inside the repository. Repo facts, the working plan and each
  // round's findings are relayed to a worker through `readFiles`, so they are
  // staged here instead, gitignored and disposable — the durable record stays
  // in `plansDir`.
  const scratchDir = join(cwd, PLAN_SCRATCH_DIR_NAME, campaignId, phase);
  mkdirSync(scratchDir, { recursive: true });

  // A requirement's `measure` command runs here, before any node exists, so
  // the draft stage reads what the planner measured instead of inferring it
  // from the spec's prose.
  const parsedSpec = parseSpec(specText);
  const repoFacts = collectRepoFacts(cwd, { requirements: parsedSpec.requirements });
  // R16: an operator step a requirement's constraints declare, detected once
  // here so both the freeze below and a caller inspecting the pipeline agree
  // on the same list.
  const humanSteps = collectHumanSteps(parsedSpec.requirements);
  const repoFactsPath = join(scratchDir, "repo-facts.json");
  writeFileSync(repoFactsPath, `${JSON.stringify(repoFacts, null, 2)}\n`);
  const relativeRepoFactsPath = relative(cwd, repoFactsPath);
  // The taskKind catalogue is staged like every other planning input. It used
  // to be handed over as faberun's own `src/plan/template.mjs`, which resolves
  // against the target repository and therefore exists in exactly one of them.
  const cataloguePath = join(scratchDir, TASK_KIND_CATALOGUE_FILE);
  writeFileSync(cataloguePath, renderTaskKindCatalogue());
  const relativeCataloguePath = relative(cwd, cataloguePath);
  logStage("repo-facts", { gitHead: repoFacts.gitHead });

  let n = 0;
  const nextN = () => { n += 1; return n; };

  /**
   * Build, validate, persist, launch and wait for one planning contract, and
   * return the discovery `output` its worker recorded. Every stage the
   * pipeline runs is an ordinary run: it lands in `usage.jsonl` exactly like
   * any other node, and this is the only place that reads its result back.
   *
   * @param {import("./template.mjs").PlanningKind} kind
   * @param {Record<string, unknown>} inputs
   * @returns {Promise<{contract: ValidatedContract, output: Record<string, unknown>}>}
   */
  const runStage = async (kind, inputs) => {
    // R19: a review or spec-review stage's runtime comes from the planner's
    // own reviewer list, resolved fresh at every stage so a refusal recorded
    // between rounds is not repeated.
    const reviewerId = kind === "review" || kind === "spec-review" ? firstEligibleReviewer(reviewers, runtimes) ?? undefined : undefined;
    // A stage number whose run already exists belongs to an earlier `plan` of
    // this phase and is skipped: measured 2026-09-25, re-planning a phase
    // reused `draft-1`, whose run the first attempt had left, and the launch
    // died at bootstrap on "run already exists".
    let contractPath, raw, validated;
    do {
      const stageN = nextN();
      contractPath = join(plansDir, "nodes", `${kind}-${stageN}.contract.json`);
      raw = buildPlanningContract(kind, {
        campaignId, phase, n: stageN, runtimes, runtimeDefaults, ...(reviewerId === undefined ? {} : { reviewerId }), cwd: relative(join(plansDir, "nodes"), cwd) || ".", ...inputs,
      });
      validated = validateContract(raw, contractPath);
    } while (existsSync(runDirectory(validated.cwd, validated.id)));
    mkdirSync(dirname(contractPath), { recursive: true });
    writeFileSync(contractPath, `${JSON.stringify(raw, null, 2)}\n`);
    await launch(contractPath, validated);
    const runDir = runDirectory(validated.cwd, validated.id);
    const progress = await wait(runDir);
    const classification = classifyRunProgress(progress);
    if (classification !== "succeeded") {
      logStage(kind, { runId: validated.id, failed: classification });
      throw new Error(`planning stage ${kind} did not succeed: run ${validated.id} ${classification}`);
    }
    const result = readWorkerResultFile(runDir, kind);
    const output = result ? discoveryOutput(result) : null;
    if (!output) {
      logStage(kind, { runId: validated.id, failed: "no_discovery_output" });
      throw new Error(`planning stage ${kind}: run ${validated.id} recorded no discovery output`);
    }
    return { contract: validated, output };
  };

  const draft = await runStage("draft", { specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, cataloguePath: relativeCataloguePath, packageMode });
  /** @type {PlanOutput|null} */
  let plan = null;
  // Everything still open against the plan in hand, accumulated across rounds
  // rather than replaced by each one: a reviewer who does not repeat the last
  // round's objection has not answered it. `unresolvedFindings` is what takes
  // a finding back out once the plan moved under it.
  /** @type {PlanFindingOutput[]} */
  let findings = [];
  try {
    plan = validatePlanOutput(draft.output.plan);
  } catch (error) {
    findings = [invalidPlanFinding("draft", error)];
  }
  logStage("draft", plan === null
    ? { runId: draft.contract.id, invalid: findings[0].text }
    : { runId: draft.contract.id, nodeCount: plan.nodes.length });

  // R15: a deterministic check for a DoD proof no node can satisfy, run once
  // against the drafted plan before the first review round grades it — a
  // finding this raises is exactly as actionable to a revise as a reviewer's
  // own, and raising it before review means review never spends a round
  // re-discovering what a mechanical check already knows for certain.
  if (plan !== null) {
    const proofFindings = checkPlanProofs(plan, repoFacts, cwd);
    if (proofFindings.length > 0) findings = [...findings, ...proofFindings];
    logStage("proof-check", { findingsCount: proofFindings.length });
  }

  const workingPlanPath = join(scratchDir, "plan.working.json");
  const relativeWorkingPlanPath = relative(cwd, workingPlanPath);

  /**
   * End the pipeline the way an unresolvable plan already ends: the contested
   * result, the outstanding findings that forced it, and an open question on
   * the campaign journal. Every no-valid-plan exit funnels through here.
   * `currentPlan` and the `resume` context ride along on the written record
   * so `faberun plan --resolve` (R9) can continue from it without redrafting
   * or re-collecting repo facts.
   *
   * @param {number} round
   * @param {PlanFindingOutput[]} currentFindings
   * @param {PlanOutput|null} currentPlan
   * @returns {Promise<ContestedPipelineResult>}
   */
  const contest = (round, currentFindings, currentPlan) => contestPlan({
    campaignId, phase, cwd, plansDir, sessionId: PLANNER_SESSION_ID, findings: currentFindings, round, logStage,
    plan: currentPlan ?? null,
    resume: {
      campaignId, phase, specPath: relativeSpecPath, specDigest, reviewRounds,
      runtimeDefaults, reviewers, runtimes, verification, packageMode, targetedFix, approveBelow, repoFacts,
    },
  });

  // Which deterministic stage is running, so the freeze-wrap catch below
  // names the stage that threw when the thrown error carries no `planStage`
  // of its own (`assembleFrozenPlan` tags sizing and routing failures; a
  // plain error reaching the catch after that call is `freezePlan`'s).
  let stage = "sizing";
  // The last review round entered, so the freeze-wrap catch contests with
  // the count of rounds that actually ran.
  let roundsRun = 0;

  /**
   * The one assembly a plan freezes through, one home for the expression the
   * in-round pre-flight and the final freeze must run identically. Delegates
   * to `assembleFrozenPlan`, exported below, so `resolve.mjs` can run the
   * exact same reshape over a plan it read back off disk instead of holding
   * it in this closure.
   *
   * @param {PlanOutput} currentPlan
   * @returns {AssembledPlan}
   */
  const assembleFrozenNodes = (currentPlan) => assembleFrozenPlan(currentPlan, { repoFacts, packageMode, targetedFix, phase, cwd, runtimes, runtimeDefaults });

  /**
   * The raw contract exactly as `freezePlan` will assemble and validate it.
   * Delegates to `frozenContractRawOf`, exported below for the same reason
   * as `assembleFrozenPlan`.
   *
   * @param {AssembledPlan} assembly
   * @returns {JsonObject}
   */
  const frozenContractRaw = (assembly) => frozenContractRawOf(assembly, { campaignId, phase, campaignGoal: campaign.goal, cwd, plansDir, runtimes, runtimeDefaults, verification });

  const roundsResult = await runReviewRounds({
    reviewRounds, plan, findings, cwd, plansDir, scratchDir, workingPlanPath, relativeWorkingPlanPath,
    relativeSpecPath, relativeRepoFactsPath, relativeCataloguePath, packageMode, repoFacts,
    runStage, assembleFrozenNodes, frozenContractRaw, contest,
    invalidPlanFinding, logStage,
  });
  if (!roundsResult.resolved) return roundsResult.result;
  plan = roundsResult.plan;
  findings = roundsResult.findings;
  roundsRun = roundsResult.roundsRun;
  // Reached only when no review round is configured (reviewRounds <= 0) and
  // the draft never validated: no revise exists to reach, so contested is the
  // end rather than a silent crash at sizing.
  if (plan === null) return await contest(0, findings, null);

  // The pre-flight ran this exact assembly through the same validator in the
  // round that just broke, so a failure here is nearly impossible — but
  // `nearly` is what this whole phase is about: an unanticipated failure
  // writes its stage line and takes the contested exit instead of leaving
  // pipeline.jsonl stopping between stages.
  /** @type {AssembledPlan|undefined} */
  let assembled;
  /** @type {import("./freeze.mjs").FrozenPlan|undefined} */
  let frozen;
  /** @type {string|undefined} */
  let highestRiskTier;
  // Warned at freeze, never refused: a plan for a repository with no ratchets
  // is legitimate, an unnoticed one is not. Observed 2026-09-20 on the first
  // contract this planner ever froze: it carried neither suite while the same
  // ratchets, on hand-authored contracts, were catching copied helpers
  // mid-run — and nothing said so.
  const freezeWarnings = verification.sharedVerification || verification.finalVerification
    ? []
    : ["the frozen contract carries neither sharedVerification nor finalVerification, so no repository ratchet runs on its nodes and no final check closes the phase; pass --verification <file> if the target repository has ratchets every node must run"];
  try {
    assembled = assembleFrozenNodes(plan);
    stage = "freeze";
    logStage("sizing", { transformations: assembled.sizing.transformations.length, nodeCount: assembled.sizing.plan.nodes.length, overheadMinutes: assembled.sizing.estimate.overheadMinutes });
    logStage("routing", { assignments: Object.keys(assembled.routing.assignments).length });
    highestRiskTier = highestOf(assembled.sizing.plan.nodes.map((node) => node.riskTier ?? RISK_TIERS[0]));
    frozen = freezePlan(frozenContractRaw(assembled), {
      outDir: plansDir,
      phases: assembled.phases,
      // The pipeline's own pinned spec bytes: a wrong or missing digest is the
      // first thing the Campaign Brief refuses on, never a summary.
      spec: { path: relativeSpecPath, digest: specDigest },
      humanSteps,
      facts: repoFacts,
      provenance: {
        targetGitHead: repoFacts.gitHead,
        planner: { runtimeId: runtimeDefaults.worker ?? "", model: modelOf(runtimes, runtimeDefaults.worker) },
        reviewer: reviewerProvenanceOf(reviewers, runtimes),
        sizing: assembled.sizing.transformations,
        findings,
      },
    });
    logStage("freeze", {
      contractId: `${campaignId}-${phase}`,
      highestRiskTier,
      ...(humanSteps.length ? { humanSteps: humanSteps.length } : {}),
      ...(freezeWarnings.length ? { warnings: freezeWarnings } : {}),
    });
  } catch (error) {
    // The stage line the pipeline would otherwise have stopped short of, the
    // failure carried as the critical finding that names it, and the
    // contested end every other unresolvable plan takes. `planStage` names a
    // sizing or routing failure precisely; anything else reaching here is
    // `freezePlan`'s, so the outer `stage` (bumped to "freeze" once assembly
    // itself succeeded) is the fallback.
    const failedStage = /** @type {{planStage?: string}} */ (error)?.planStage ?? stage;
    logStage(failedStage, { failed: error instanceof Error ? error.message : String(error) });
    findings = [...findings, invalidPlanFinding(failedStage, error)];
    // freezePlan removes contract.json itself when validation refuses it; a
    // failure after that write and before its return would otherwise leave a
    // contract.json no contested result may have.
    rmSync(join(plansDir, "contract.json"), { force: true });
    return await contest(roundsRun, findings, plan);
  }

  // A delta only means something between two samples of the same seat: freeze
  // re-samples the exact harness `campaign init` recorded at `sample: "start"`
  // (the operator's own seat), not the plan's worker runtime, which is very
  // often a different harness entirely (codex, dsh, agy, zcode workers under
  // a claude operator) and would make the delta null in the common case
  // instead of the rare one. With no start entry at all (a pipeline run with
  // no preceding `campaign init`, as in every replay-driven pipeline test)
  // there is no seat to re-sample, so freeze samples nothing and spends no
  // call.
  const journalEntries = /** @type {any[]} */ (readJournal(campaignPath));
  const startEntry = journalEntries.findLast((entry) => entry.type === "seat.allowance" && entry.sample === "start");
  const freezeHarness = startEntry?.harness ?? null;
  const freezeAllowance = await sampleAllowance({ harness: freezeHarness });
  const startAllowance = startEntry
    ? { remaining: startEntry.remaining ?? null, limit: startEntry.limit ?? null, resetsAt: startEntry.resetsAt ?? null, window: startEntry.window ?? null }
    : null;
  appendSeatAllowanceEvent(campaignPath, {
    sample: "freeze",
    harness: freezeHarness,
    delta: allowanceDelta(startAllowance, freezeAllowance),
    ...allowanceEventFields(freezeAllowance),
  });

  const approved = approveBelow === "high" ? true : approveBelow === "none" ? false : highestRiskTier !== "high";
  const planPath = join(plansDir, "plan.json");
  // The final bytes — status and approval included — are written first; the
  // sidecar then covers exactly those bytes, and nothing rewrites the plan
  // afterward. The written record is the plan.json the brief will read.
  writeFrozenPlan(plansDir, /** @type {import("./freeze.mjs").FrozenPlan} */ (frozen), { status: "frozen", approved });
  if (!approved) {
    await campaignCli([
      "note", campaignId, "--cwd", cwd, "--session-id", PLANNER_SESSION_ID,
      "--kind", "open-question", "--question-id", `plan-${phase}-approval`,
      "--text", `Plan for phase ${phase} carries a ${highestRiskTier}-risk node; approval is required under --approve-below ${approveBelow}.`,
    ]);
  }
  logStage("approval", { approved, approveBelow, highestRiskTier });

  return { status: "frozen", plansDir, planPath, contractPath: join(plansDir, "contract.json"), approved, findings, warnings: freezeWarnings };
}

/**
 * `path` made relative to `cwd`, refused when it escapes it: every planning
 * contract's readFiles must resolve inside the same cwd a run validates
 * against, so a spec outside the target repository can never be named there.
 *
 * @param {string} cwd
 * @param {string} path
 * @param {string} label
 * @returns {string}
 */
function repoRelativePath(cwd, path, label) {
  const relativePath = relative(cwd, resolve(cwd, path));
  if (relativePath.startsWith("..")) throw new Error(`${label} must be inside ${cwd}: ${path}`);
  return relativePath;
}

/**
 * The prefix `validateContract` throws its scope-closure refusal with
 * (src/contract/index.mjs owns the wording). Matched here because the only
 * channel the validator has is its message text, and that text is carried
 * verbatim — the finding below appends to it, never rewrites it.
 */
const SCOPE_CLOSURE_MESSAGE_PREFIX = "task packet scope does not close";

/**
 * The one sentence about scope closure the validator cannot know: the raw
 * message reads as "declare or acknowledge", and removing a write clears it
 * just as well — more cheaply, in fact, since fewer writes drag in fewer
 * importers and no judgement about which importer breaks. Measured
 * 2026-09-20 across three plans for one node: a revise took exactly that
 * cheap move, twice, and two workers then refused their packets with
 * context_missing for a file the shrink had taken away.
 */
const SCOPE_CLOSURE_RESOLUTION = "Resolve it by declaring each named file in writeFiles — or acknowledging it in scopeAcknowledged when the node must not change it — never by dropping a write the node needs: removing a file from writeFiles clears this failure too, and leaves the worker without a file the work requires.";

/**
 * A validatePlanOutput, validateFindings or in-round validateContract
 * rejection, shaped as the finding a review round already carries to revise,
 * so a structurally invalid plan, a review whose findings are not findings —
 * or a plan that would not survive freeze — reaches the stage that can act on
 * it instead of killing the pipeline between the run finishing and its stage
 * line. `nodeId` is "plan" because the validator's message names a path into
 * the plan, not one of its nodes. A scope-closure failure carries
 * `SCOPE_CLOSURE_RESOLUTION` after the validator's verbatim message, which
 * stays intact because it names the exact paths the reviser must act on.
 *
 * Used both outside any round (the draft validation above, and the freeze
 * catch inside `runPlanningPipeline`) and inside one, so `rounds.mjs` takes
 * it as an injected function rather than importing it, which would cycle
 * back into this module. Exported for `resolve.mjs`, which reaches the same
 * freeze catch from a plan read back off disk instead of one this module
 * just assembled.
 *
 * @param {string} label
 * @param {unknown} error
 * @returns {PlanFindingOutput}
 */
export function invalidPlanFinding(label, error) {
  const text = error instanceof Error ? error.message : String(error);
  const guided = text.startsWith(SCOPE_CLOSURE_MESSAGE_PREFIX) ? `${text} ${SCOPE_CLOSURE_RESOLUTION}` : text;
  return { id: `plan-shape-${label}`, severity: "critical", nodeId: "plan", text: guided };
}

/**
 * The phase declarations a reviewer saw, remapped onto the nodes sizing
 * actually produced. `applySizingRules` is the only stage that changes the
 * node set, and it only ever folds one node into another — a declaration that
 * named the folded-away node must name the node that absorbed it, or freeze
 * would refuse the record as an unknown assignment. A two-entry transformation
 * is a merge (`[child, parent]`); every one-entry transformation edits a node
 * in place. Resolution follows a chain, so a node folded into another that was
 * itself folded lands on the final owner, and duplicates collapse so a
 * declaration never lists the same node twice. A declaration in the legacy
 * shape (no `nodeIds`) is returned untouched.
 *
 * @param {PlanPhase[]|undefined} phases
 * @param {import("./sizing.mjs").SizingTransformation[]|undefined} transformations
 * @returns {PlanPhase[]|undefined}
 */
export function carryPhaseDeclarations(phases, transformations) {
  if (!phases || phases.length === 0) return phases;
  /** @type {Map<string, string>} */
  const parentOf = new Map();
  for (const transformation of transformations ?? []) {
    const nodes = transformation?.nodes;
    if (Array.isArray(nodes) && nodes.length === 2 && typeof nodes[0] === "string" && typeof nodes[1] === "string") {
      parentOf.set(nodes[0], nodes[1]);
    }
  }
  if (parentOf.size === 0) return phases;
  /** @param {string} id @returns {string} */
  const resolve = (id) => {
    let current = id;
    const seen = new Set();
    while (parentOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = /** @type {string} */ (parentOf.get(current));
    }
    return current;
  };
  return phases.map((phase) => {
    if (phase.nodeIds === undefined) return phase;
    return { ...phase, nodeIds: [...new Set(phase.nodeIds.map(resolve))] };
  });
}

/**
 * Tag an error with the sizing/routing sub-stage that threw it, so a catch
 * far from here (this module's own freeze-wrap, or `resolve.mjs`'s) can name
 * it precisely instead of defaulting to whichever stage it last saw start.
 *
 * @param {string} planStage
 * @param {unknown} error
 * @returns {Error}
 */
function taggedStageError(planStage, error) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  return Object.assign(wrapped, { planStage });
}

/**
 * The one assembly a plan freezes through: sizing reshapes the drafted
 * nodes, routing assigns worker and judge, and `toContractNode` renders the
 * contract shape. Exported (rather than kept a `runPlanningPipeline`
 * closure) so both the in-round pre-flight there and `resolve.mjs`'s
 * freeze-only resume run the identical reshape over a plan, wherever that
 * plan came from — a fresh draft/revise or one read back off a contested
 * `plan.json`.
 *
 * @param {PlanOutput} currentPlan
 * @param {{repoFacts: import("./repo-facts.mjs").RepoFacts, packageMode: import("./sizing.mjs").PackageMode, targetedFix: boolean, phase: string, cwd: string, runtimes: Record<string, JsonObject>, runtimeDefaults: {worker?: string, judge?: string}}} ctx
 * @returns {AssembledPlan}
 */
export function assembleFrozenPlan(currentPlan, ctx) {
  const { repoFacts, packageMode, targetedFix, phase, cwd, runtimes, runtimeDefaults } = ctx;
  let sizing;
  try {
    sizing = applySizingRules(
      { nodes: currentPlan.nodes.map(toSizingNode), justification: currentPlan.justification },
      { nodeBudgetMs: DEFAULT_NODE_BUDGET_MS, facts: repoFacts, minWriteFiles: MIN_WRITE_FILES, turnCeiling: DEFAULT_MAX_TURNS, packageMode, readVolume: (path) => fileLineCount(join(cwd, path)), targetedFix },
    );
  } catch (error) {
    throw taggedStageError("sizing", error);
  }
  let routing;
  try {
    routing = resolveRuntimes(sizing.plan.nodes, {
      table: [...DEFAULT_ROUTING_TABLE],
      runtimes: /** @type {Record<string, import("./routing.mjs").RoutingRuntime>} */ (runtimes),
      availability: availabilityOf(runtimes),
      runtimeDefaults,
    });
  } catch (error) {
    throw taggedStageError("routing", error);
  }
  return {
    sizing,
    routing,
    nodes: sizing.plan.nodes.map((node) => toContractNode(/** @type {SizedPlanNode} */ (node), phase, routing.assignments[node.id])),
    // The declarations a reviewer saw, remapped onto the nodes sizing
    // actually produced: a merge removes a node id, and a declaration that
    // named it must now name the node that absorbed it or freeze would see
    // an unknown assignment.
    phases: carryPhaseDeclarations(currentPlan.phases, sizing.transformations),
  };
}

/**
 * The raw contract exactly as `freezePlan` will assemble and validate it,
 * schemaVersion and contractVersion included. It takes the whole assembly
 * rather than its nodes because the contract carries a run-level conclusion
 * of sizing's too (`maxParallel`), and the in-round pre-flight must validate
 * the same bytes the freeze writes. Exported alongside `assembleFrozenPlan`
 * for the same reason.
 *
 * @param {AssembledPlan} assembly
 * @param {{campaignId: string, phase: string, campaignGoal: string, cwd: string, plansDir: string, runtimes: Record<string, JsonObject>, runtimeDefaults: {worker?: string, judge?: string}, verification: VerificationSuites}} ctx
 * @returns {JsonObject}
 */
export function frozenContractRawOf({ sizing, nodes }, ctx) {
  const { campaignId, phase, campaignGoal, cwd, plansDir, runtimes, runtimeDefaults, verification } = ctx;
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: `${campaignId}-${phase}`,
    campaignId,
    goal: campaignGoal,
    // `freezePlan` writes contract.json inside `outDir` (`plansDir`), so
    // `cwd` has to point back at the repo root from there, exactly like
    // `runStage` computes it for the nodes it writes under `plansDir/nodes/`.
    cwd: relative(plansDir, cwd) || ".",
    // Sizing's `parallelisable` conclusion, which nothing else carries: a
    // contract node has no `parallel` field, so a plan that says nothing here
    // freezes at the validator's default of 1 and every independent node it
    // proved waits for its turn. What the engine does with the number is the
    // scheduler's business; declaring it is this stage's.
    maxParallel: provenParallelism(sizing.plan),
    runtimes,
    runtimeDefaults,
    // The operator's ratchets, carried verbatim: which suites a repository
    // runs on every node is the operator's policy, supplied through
    // `--verification`, never derived from repository facts. Validated at the
    // flag boundary, so freeze neither re-derives nor edits them.
    ...(verification.sharedVerification ? { sharedVerification: verification.sharedVerification } : {}),
    ...(verification.finalVerification ? { finalVerification: verification.finalVerification } : {}),
    nodes,
  };
}

/**
 * Write the pipeline's final frozen plan record and the `plan.json.sha256`
 * sidecar over those exact bytes. This is the last write to plan.json: after
 * it returns, the sidecar and the plan agree, and neither may be rewritten.
 *
 * @param {string} outDir
 * @param {import("./freeze.mjs").FrozenPlan} frozen
 * @param {{status: "frozen", approved: boolean}} outcome
 * @returns {import("./freeze.mjs").FrozenPlan}
 */
export function writeFrozenPlan(outDir, frozen, outcome) {
  return writeFrozenPlanRecord(outDir, { ...frozen, ...outcome });
}
