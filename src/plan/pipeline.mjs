/**
 * The planning pipeline: `faberun plan` as successive ordinary runs (draft,
 * review, revise up to a round budget) followed by the deterministic stages
 * (sizing, routing, freeze), never as one long-lived process. Separate from
 * `template.mjs` (which only builds the one-node contracts) and from
 * `freeze.mjs` (which only turns a plan into a validated contract on disk):
 * this module is the one place that sequences those runs, checks each round's
 * plan against the contract it would freeze into while a revise can still
 * act on the failure, compares a revision's write set against the plan it
 * revised so scope closure cannot be satisfied by shrinking the work, and
 * decides when a plan is contested instead of frozen. `launch` and `wait`
 * are the only two seams that touch a process or the wall clock, so a test
 * drives the whole pipeline through `runContract` in-process, deterministically.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CONTRACT_VERSION, DEFAULT_MAX_TURNS, PROTOCOL_SCHEMA_VERSION, validateContract } from "../contract/index.mjs";
import { discoveryOutput } from "../contract/worker-result.mjs";
import { readWorkerResultFile } from "../engine/result-file.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";
import { appendSeatAllowanceEvent, readJournal } from "../campaign/journal.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { campaignCli } from "../cli/campaign.mjs";
import { appendJsonl, writeJsonAtomic } from "../run/store.mjs";
import { allowanceDelta, allowanceEventFields, sampleAllowance } from "../seat/allowance.mjs";
import { parseSpec, validateSpec } from "./spec.mjs";
import { collectRepoFacts } from "./repo-facts.mjs";
import { RISK_TIERS, buildPlanningContract, validateFindings, validatePlanOutput } from "./template.mjs";
import { MIN_WRITE_FILES, applySizingRules } from "./sizing.mjs";
import { resolveRuntimes } from "./routing.mjs";
import { freezePlan } from "./freeze.mjs";
import { campaignTree, runDirectory } from "../run/paths.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").VerificationCommand} VerificationCommand */
/** @typedef {{sharedVerification?: VerificationCommand[], finalVerification?: VerificationCommand[]}} VerificationSuites */
/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./sizing.mjs").PlanNode & {objective: string}} SizedPlanNode */
/** @typedef {"standard"|"high"|"none"} ApproveBelow */
/** @typedef {(contractPath: string, contract: ValidatedContract) => Promise<void>|void} LaunchFn */
/** @typedef {(runDir: string) => Promise<import("../engine/supervise.mjs").RunProgress>|import("../engine/supervise.mjs").RunProgress} WaitFn */
/** @typedef {{status: "frozen", plansDir: string, planPath: string, contractPath: string, approved: boolean, findings: PlanFindingOutput[], warnings: string[]}} FrozenPipelineResult */
/** @typedef {{status: "contested", plansDir: string, planPath: string, findings: PlanFindingOutput[], round: number}} ContestedPipelineResult */

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
 * @param {{specPath: string, campaignId: string, phase: string, cwd?: string, reviewRounds?: number, approveBelow?: ApproveBelow, runtimeDefaults?: {worker?: string, judge?: string}, runtimes: Record<string, JsonObject>, verification?: VerificationSuites, launch: LaunchFn, wait: WaitFn}} options
 * @returns {Promise<FrozenPipelineResult|ContestedPipelineResult>}
 */
export async function runPlanningPipeline(options) {
  const {
    specPath, campaignId, phase, runtimes, launch, wait,
    reviewRounds = 2, runtimeDefaults = {}, verification = {},
  } = options;
  const approveBelow = /** @type {ApproveBelow} */ (options.approveBelow ?? "standard");
  if (!APPROVE_BELOW_VALUES.has(approveBelow)) throw new TypeError(`approveBelow must be one of ${[...APPROVE_BELOW_VALUES].join(", ")}`);
  if (typeof launch !== "function") throw new TypeError("runPlanningPipeline requires a launch seam");
  if (typeof wait !== "function") throw new TypeError("runPlanningPipeline requires a wait seam");
  const cwd = resolve(options.cwd ?? ".");

  const campaignPath = campaignTree(cwd, campaignId);
  const campaign = readCampaign(campaignPath);
  if (campaign.status !== "active") throw new Error(`campaign is closed: ${campaignId}`);

  const relativeSpecPath = repoRelativePath(cwd, specPath, "specPath");
  const specText = readFileSync(resolve(cwd, relativeSpecPath), "utf8");
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
  const repoFactsPath = join(scratchDir, "repo-facts.json");
  writeFileSync(repoFactsPath, `${JSON.stringify(repoFacts, null, 2)}\n`);
  const relativeRepoFactsPath = relative(cwd, repoFactsPath);
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
    const stageN = nextN();
    const contractPath = join(plansDir, "nodes", `${kind}-${stageN}.contract.json`);
    mkdirSync(dirname(contractPath), { recursive: true });
    const relativeCwd = relative(dirname(contractPath), cwd) || ".";
    const raw = buildPlanningContract(kind, {
      campaignId, phase, n: stageN, runtimes, runtimeDefaults, cwd: relativeCwd, ...inputs,
    });
    const validated = validateContract(raw, contractPath);
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

  const draft = await runStage("draft", { specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath });
  /** @type {PlanOutput|null} */
  let plan = null;
  /** @type {PlanFindingOutput[]} */
  let findings = [];
  // The writes the most recent revise dropped, computed where the revise's
  // output is validated and held for the next round: appended there, after the
  // review has replaced `findings`, so a drop is never cleaned away by a fresh
  // review passing over a plan that no longer declares the write.
  /** @type {PlanFindingOutput[]} */
  let droppedWrites = [];
  try {
    plan = validatePlanOutput(draft.output.plan);
  } catch (error) {
    findings = [invalidPlanFinding("draft", error)];
  }
  logStage("draft", plan === null
    ? { runId: draft.contract.id, invalid: findings[0].text }
    : { runId: draft.contract.id, nodeCount: plan.nodes.length });

  const workingPlanPath = join(scratchDir, "plan.working.json");
  const relativeWorkingPlanPath = relative(cwd, workingPlanPath);

  /**
   * End the pipeline the way an unresolvable plan already ends: the contested
   * result, the outstanding findings that forced it, and an open question on
   * the campaign journal. Every no-valid-plan exit funnels through here.
   *
   * @param {number} round
   * @returns {Promise<ContestedPipelineResult>}
   */
  const contest = async (round) => {
    const criticalFindings = findings.filter((finding) => finding.severity === "critical");
    const planPath = join(plansDir, "plan.json");
    writeJsonAtomic(planPath, { formatVersion: 1, status: "contested", rounds: round, findings });
    logStage("contested", { round, criticalCount: criticalFindings.length });
    await campaignCli([
      "note", campaignId, "--cwd", cwd, "--session-id", PLANNER_SESSION_ID,
      "--kind", "open-question", "--question-id", `plan-${phase}-contested`,
      "--text", `Plan for phase ${phase} is contested after ${round} review round(s): ${criticalFindings.map((finding) => finding.text).join("; ")}`,
    ]);
    return { status: "contested", plansDir, planPath, findings, round };
  };

  // Which deterministic stage is running, advanced by `assembleFrozenNodes`
  // so the freeze-wrap catch below names the stage that threw.
  let stage = "sizing";
  // The last review round entered, so the freeze-wrap catch contests with
  // the count of rounds that actually ran.
  let roundsRun = 0;

  /**
   * The one assembly a plan freezes through, one home for the expression the
   * in-round pre-flight and the final freeze must run identically: sizing
   * reshapes the drafted nodes, routing assigns worker and judge, and
   * `toContractNode` renders the contract shape. Local and cheap — no I/O,
   * no model — so running it once per round costs nothing. It advances
   * `stage` as it goes; see the declaration above.
   *
   * @param {PlanOutput} currentPlan
   * @returns {{sizing: import("./sizing.mjs").SizingResult, routing: import("./routing.mjs").RoutingResult, nodes: JsonObject[]}}
   */
  const assembleFrozenNodes = (currentPlan) => {
    stage = "sizing";
    const sizing = applySizingRules(
      { nodes: currentPlan.nodes.map(toSizingNode), justification: currentPlan.justification },
      { nodeBudgetMs: DEFAULT_NODE_BUDGET_MS, facts: repoFacts, minWriteFiles: MIN_WRITE_FILES, turnCeiling: DEFAULT_MAX_TURNS },
    );
    stage = "routing";
    const routing = resolveRuntimes(sizing.plan.nodes, {
      table: [...DEFAULT_ROUTING_TABLE],
      runtimes: /** @type {Record<string, import("./routing.mjs").RoutingRuntime>} */ (runtimes),
      availability: availabilityOf(runtimes),
      runtimeDefaults,
    });
    stage = "freeze";
    return {
      sizing,
      routing,
      nodes: sizing.plan.nodes.map((node) => toContractNode(/** @type {SizedPlanNode} */ (node), phase, routing.assignments[node.id])),
    };
  };

  /**
   * The raw contract exactly as `freezePlan` will assemble and validate it,
   * schemaVersion and contractVersion included. `validateContract` never
   * reads the path it is given — only `dirname(resolve(contractPath))` to
   * resolve `raw.cwd` — so the pre-flight passes the path the contract will
   * occupy, `contract.json` inside `plansDir`, and validates in memory
   * without writing or deleting anything.
   *
   * @param {JsonObject[]} nodes
   * @returns {JsonObject}
   */
  const frozenContractRaw = (nodes) => ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: `${campaignId}-${phase}`,
    campaignId,
    goal: campaign.goal,
    // `freezePlan` writes contract.json inside `outDir` (`plansDir`), so
    // `cwd` has to point back at the repo root from there, exactly like
    // `runStage` computes it for the nodes it writes under `plansDir/nodes/`.
    cwd: relative(plansDir, cwd) || ".",
    runtimes,
    runtimeDefaults,
    // The operator's ratchets, carried verbatim: which suites a repository
    // runs on every node is the operator's policy, supplied through
    // `--verification`, never derived from repository facts. Validated at the
    // flag boundary, so freeze neither re-derives nor edits them.
    ...(verification.sharedVerification ? { sharedVerification: verification.sharedVerification } : {}),
    ...(verification.finalVerification ? { finalVerification: verification.finalVerification } : {}),
    nodes,
  });

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
        findings = validateFindings(review.output.findings);
      } catch (error) {
        // The review said nothing usable about the plan, so the plan cannot be
        // treated as clean: the malformed-output finding is critical and
        // drives the same revise-or-contest path a real critical finding does,
        // with the still-outstanding findings riding along.
        invalidFindings = invalidPlanFinding(`review-r${round}`, error);
        findings = [...findings, invalidFindings];
      }
      // The contract this plan would freeze into is checked here, inside the
      // round and after the review's findings replaced the previous round's,
      // because freeze runs after the last one: caught here, a plan that
      // cannot freeze still has a revise left to fix it. The failure is a
      // critical finding, never an auto-filled acknowledgement — scope
      // closure exists to force the per-file decision (declare a write, or
      // acknowledge a read-only importer), and the revise worker, which can
      // read the repository, makes it from the validator's own message.
      /** @type {PlanFindingOutput|null} */
      let freezeFailure = null;
      try {
        validateContract(frozenContractRaw(assembleFrozenNodes(plan).nodes), join(plansDir, "contract.json"));
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
    // The revise's write-drops land here — after the review above replaced
    // `findings`, before the critical check below — so a drop survives into
    // the same revise-or-contest decision a review finding reaches.
    findings = [...findings, ...droppedWrites];
    const criticalFindings = findings.filter((finding) => finding.severity === "critical");
    if (criticalFindings.length === 0) break;
    if (round === reviewRounds) return await contest(round);
    const findingsPath = join(scratchDir, `findings-round-${round}.json`);
    writeJsonAtomic(findingsPath, findings);
    const revise = await runStage("revise", {
      specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, findingsPath: relative(cwd, findingsPath),
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
    logStage("revise", { round, runId: revise.contract.id, droppedWrites: droppedWrites.length, ...(invalid === null ? {} : { invalid: invalid.text }) });
  }
  // Reached only when no review round is configured (reviewRounds <= 0) and
  // the draft never validated: no revise exists to reach, so contested is the
  // end rather than a silent crash at sizing.
  if (plan === null) return await contest(0);

  // The pre-flight ran this exact assembly through the same validator in the
  // round that just broke, so a failure here is nearly impossible — but
  // `nearly` is what this whole phase is about: an unanticipated failure
  // writes its stage line and takes the contested exit instead of leaving
  // pipeline.jsonl stopping between stages.
  /** @type {{sizing: import("./sizing.mjs").SizingResult, routing: import("./routing.mjs").RoutingResult, nodes: JsonObject[]}|undefined} */
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
    logStage("sizing", { transformations: assembled.sizing.transformations.length, nodeCount: assembled.sizing.plan.nodes.length, overheadMinutes: assembled.sizing.estimate.overheadMinutes });
    logStage("routing", { assignments: Object.keys(assembled.routing.assignments).length });
    highestRiskTier = highestOf(assembled.sizing.plan.nodes.map((node) => node.riskTier ?? RISK_TIERS[0]));
    frozen = freezePlan(frozenContractRaw(assembled.nodes), {
      outDir: plansDir,
      provenance: {
        targetGitHead: repoFacts.gitHead,
        planner: { runtimeId: runtimeDefaults.worker ?? "", model: modelOf(runtimes, runtimeDefaults.worker) },
        reviewer: { runtimeId: runtimeDefaults.judge ?? "", model: modelOf(runtimes, runtimeDefaults.judge) },
        sizing: assembled.sizing.transformations,
        findings,
      },
    });
    logStage("freeze", { contractId: `${campaignId}-${phase}`, highestRiskTier, ...(freezeWarnings.length ? { warnings: freezeWarnings } : {}) });
  } catch (error) {
    // The stage line the pipeline would otherwise have stopped short of, the
    // failure carried as the critical finding that names it, and the
    // contested end every other unresolvable plan takes.
    logStage(stage, { failed: error instanceof Error ? error.message : String(error) });
    findings = [...findings, invalidPlanFinding(stage, error)];
    // freezePlan removes contract.json itself when validation refuses it; a
    // failure after that write and before its return would otherwise leave a
    // contract.json no contested result may have.
    rmSync(join(plansDir, "contract.json"), { force: true });
    return await contest(roundsRun);
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
  writeJsonAtomic(planPath, { ...frozen, status: "frozen", approved });
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
 * @param {string} label
 * @param {unknown} error
 * @returns {PlanFindingOutput}
 */
function invalidPlanFinding(label, error) {
  const text = error instanceof Error ? error.message : String(error);
  const guided = text.startsWith(SCOPE_CLOSURE_MESSAGE_PREFIX) ? `${text} ${SCOPE_CLOSURE_RESOLUTION}` : text;
  return { id: `plan-shape-${label}`, severity: "critical", nodeId: "plan", text: guided };
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
 * @param {PlanOutput|null} previousPlan the plan the revise revised, null when the draft never validated
 * @param {PlanOutput|null} revisedPlan the plan the revise produced, null when its output was refused
 * @returns {PlanFindingOutput[]}
 */
export function droppedWriteFindings(previousPlan, revisedPlan) {
  if (!previousPlan || !revisedPlan) return [];
  const before = new Map(previousPlan.nodes.map((node) => [node.id, new Set(node.writeFiles)]));
  /** @type {PlanFindingOutput[]} */
  const findings = [];
  for (const node of revisedPlan.nodes) {
    const previousWrites = before.get(node.id);
    if (!previousWrites) continue;
    let dropped = 0;
    for (const path of previousWrites) {
      if (node.writeFiles.includes(path)) continue;
      dropped += 1;
      findings.push({
        id: `dropped-write-${node.id}-${dropped}`,
        severity: "critical",
        nodeId: node.id,
        text: `Node ${node.id} no longer declares ${path} in writeFiles, which the plan this revise revised did declare. Declare it again: the resolution to a scope-closure finding is to declare or acknowledge the dragged-along file, never to drop a write the node needs — a smaller write set clears the same finding while leaving the worker unable to do the work.`,
      });
    }
  }
  return findings;
}

/**
 * Every declared runtime treated as available. Live discovery (probing a
 * harness for real exhaustion) is a separate concern this pipeline does not
 * take on; a campaign that needs it can inject a table row and prune its
 * `runtimes` catalogue instead.
 *
 * @param {Record<string, JsonObject>} runtimes
 * @returns {Record<string, {available: true, exhaustedUntil: null}>}
 */
function availabilityOf(runtimes) {
  return Object.fromEntries(Object.keys(runtimes).map((id) => [id, { available: true, exhaustedUntil: null }]));
}

/**
 * @param {Record<string, JsonObject>} runtimes
 * @param {string|undefined} id
 * @returns {string}
 */
function modelOf(runtimes, id) {
  const model = id ? runtimes[id]?.model : undefined;
  return typeof model === "string" ? model : "";
}

/**
 * @param {string[]} riskTiers
 * @returns {string}
 */
function highestOf(riskTiers) {
  return riskTiers.reduce((highest, tier) => (RISK_TIERS.indexOf(tier) > RISK_TIERS.indexOf(highest) ? tier : highest), RISK_TIERS[0]);
}

/**
 * A draft or revise output node (flat `readFiles`/`writeFiles`/`verification`)
 * turned into the shape `applySizingRules` merges and splits: those fields move
 * under `taskPacket`, alongside `sizing.mjs`'s own `writeFiles`/`verification`
 * expectations, while `objective` rides along as a passthrough field a merge
 * never touches.
 *
 * @param {import("./template.mjs").PlanOutputNode} node
 * @returns {SizedPlanNode}
 */
function toSizingNode(node) {
  return /** @type {SizedPlanNode} */ ({
    id: node.id,
    dependsOn: node.dependsOn,
    taskKind: node.taskKind,
    riskTier: node.riskTier,
    objective: node.objective,
    expectedTurns: node.expectedTurns,
    definitionOfDone: node.definitionOfDone,
    taskPacket: {
      readFiles: node.readFiles,
      writeFiles: node.writeFiles,
      scopeAcknowledged: node.scopeAcknowledged,
      verification: node.verification,
    },
  });
}

/**
 * A sized plan node's classification and shape, turned into the contract node
 * `freezePlan` validates. `riskTier: "low"` gets no gate; `standard` an
 * advisory one; `high` a blocking one, which `validateGate` requires `major`
 * in `failOn` for.
 *
 * @param {SizedPlanNode} node
 * @param {string} phase
 * @param {{worker: string|null, judge: string|null}|undefined} assignment
 * @returns {JsonObject}
 */
function toContractNode(node, phase, assignment) {
  const riskTier = /** @type {string} */ (node.riskTier);
  const gate = riskTier === "low"
    ? false
    : {
      review: riskTier === "high" ? "blocking" : "advisory",
      failOn: riskTier === "high" ? ["major", "critical"] : ["critical"],
      ...(assignment?.judge ? { runtime: assignment.judge } : {}),
    };
  return {
    id: node.id,
    type: node.taskKind,
    phase,
    dependsOn: node.dependsOn ?? [],
    ...(assignment?.worker ? { runtime: assignment.worker } : {}),
    taskPacket: {
      mode: "execution",
      objective: node.objective,
      instructions: [node.objective],
      readFiles: node.taskPacket.readFiles ?? [],
      writeFiles: node.taskPacket.writeFiles ?? [],
      // Carried, never computed here: the drafter decided which importers it
      // will not change, and scope closure exists to force that decision on a
      // person rather than answer it for them (src/repo/scope-closure.mjs).
      scopeAcknowledged: node.taskPacket.scopeAcknowledged ?? [],
      symbols: [],
      decisions: [],
      nonGoals: [],
      verification: node.taskPacket.verification,
    },
    definitionOfDone: node.definitionOfDone ?? [],
    gate,
  };
}
