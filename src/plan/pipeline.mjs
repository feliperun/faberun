/**
 * The planning pipeline: `faberun plan` as successive ordinary runs (draft,
 * review, revise up to a round budget) followed by the deterministic stages
 * (sizing, routing, freeze), never as one long-lived process. Separate from
 * `template.mjs` (which only builds the one-node contracts) and from
 * `freeze.mjs` (which only turns a plan into a validated contract on disk):
 * this module is the one place that sequences those runs, decides when a
 * plan is contested instead of frozen, and records the operator-approval
 * open-question. `launch` and `wait` are the only two seams that touch a
 * process or the wall clock, so a test drives the whole pipeline through
 * `runContract` in-process, deterministically.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { validateContract } from "../contract/index.mjs";
import { discoveryOutput } from "../contract/worker-result.mjs";
import { readWorkerResultFile } from "../engine/result-file.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";
import { appendSeatAllowanceEvent, readJournal } from "../campaign/journal.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { campaignCli } from "../cli/campaign.mjs";
import { appendJsonl, writeJsonAtomic } from "../run/store.mjs";
import { allowanceDelta, allowanceEventFields, sampleAllowance } from "../seat/allowance.mjs";
import { validateSpec } from "./spec.mjs";
import { collectRepoFacts } from "./repo-facts.mjs";
import { RISK_TIERS, buildPlanningContract, validateFindings, validatePlanOutput } from "./template.mjs";
import { applySizingRules } from "./sizing.mjs";
import { resolveRuntimes } from "./routing.mjs";
import { freezePlan } from "./freeze.mjs";
import { campaignTree, runDirectory } from "../run/paths.mjs";

/** @typedef {import("../contract/index.mjs").JsonObject} JsonObject */
/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("./sizing.mjs").PlanNode & {objective: string}} SizedPlanNode */
/** @typedef {"standard"|"high"|"none"} ApproveBelow */
/** @typedef {(contractPath: string, contract: ValidatedContract) => Promise<void>|void} LaunchFn */
/** @typedef {(runDir: string) => Promise<import("../engine/supervise.mjs").RunProgress>|import("../engine/supervise.mjs").RunProgress} WaitFn */
/** @typedef {{status: "frozen", plansDir: string, planPath: string, contractPath: string, approved: boolean, findings: PlanFindingOutput[]}} FrozenPipelineResult */
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
 * @param {{specPath: string, campaignId: string, phase: string, cwd?: string, reviewRounds?: number, approveBelow?: ApproveBelow, runtimeDefaults?: {worker?: string, judge?: string}, runtimes: Record<string, JsonObject>, launch: LaunchFn, wait: WaitFn}} options
 * @returns {Promise<FrozenPipelineResult|ContestedPipelineResult>}
 */
export async function runPlanningPipeline(options) {
  const {
    specPath, campaignId, phase, runtimes, launch, wait,
    reviewRounds = 2, runtimeDefaults = {},
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

  const repoFacts = collectRepoFacts(cwd);
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
      throw new Error(`planning stage ${kind} did not succeed: run ${validated.id} ${classification}`);
    }
    const result = readWorkerResultFile(runDir, kind);
    const output = result ? discoveryOutput(result) : null;
    if (!output) throw new Error(`planning stage ${kind}: run ${validated.id} recorded no discovery output`);
    return { contract: validated, output };
  };

  const draft = await runStage("draft", { specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath });
  let plan = validatePlanOutput(draft.output.plan);
  logStage("draft", { runId: draft.contract.id, nodeCount: plan.nodes.length });

  const workingPlanPath = join(scratchDir, "plan.working.json");
  writeJsonAtomic(workingPlanPath, plan);
  const relativeWorkingPlanPath = relative(cwd, workingPlanPath);

  /** @type {PlanFindingOutput[]} */
  let findings = [];
  for (let round = 1; round <= reviewRounds; round += 1) {
    const review = await runStage("review", { specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, planPath: relativeWorkingPlanPath });
    findings = validateFindings(review.output.findings);
    const criticalFindings = findings.filter((finding) => finding.severity === "critical");
    logStage("review", { round, runId: review.contract.id, findingsCount: findings.length, criticalCount: criticalFindings.length });
    if (criticalFindings.length === 0) break;
    if (round === reviewRounds) {
      const planPath = join(plansDir, "plan.json");
      writeJsonAtomic(planPath, { formatVersion: 1, status: "contested", rounds: round, findings });
      logStage("contested", { round, criticalCount: criticalFindings.length });
      await campaignCli([
        "note", campaignId, "--cwd", cwd, "--session-id", PLANNER_SESSION_ID,
        "--kind", "open-question", "--question-id", `plan-${phase}-contested`,
        "--text", `Plan for phase ${phase} is contested after ${round} review round(s): ${criticalFindings.map((finding) => finding.text).join("; ")}`,
      ]);
      return { status: "contested", plansDir, planPath, findings, round };
    }
    const findingsPath = join(scratchDir, `findings-round-${round}.json`);
    writeJsonAtomic(findingsPath, findings);
    const revise = await runStage("revise", {
      specPath: relativeSpecPath, repoFactsPath: relativeRepoFactsPath, findingsPath: relative(cwd, findingsPath),
    });
    plan = validatePlanOutput(revise.output.plan);
    writeJsonAtomic(workingPlanPath, plan);
    logStage("revise", { round, runId: revise.contract.id });
  }

  const sizing = applySizingRules(
    { nodes: plan.nodes.map(toSizingNode), justification: plan.justification },
    { nodeBudgetMs: DEFAULT_NODE_BUDGET_MS, facts: repoFacts },
  );
  logStage("sizing", { transformations: sizing.transformations.length, nodeCount: sizing.plan.nodes.length });

  const routingRuntimes = /** @type {Record<string, import("./routing.mjs").RoutingRuntime>} */ (runtimes);
  const routing = resolveRuntimes(sizing.plan.nodes, {
    table: [...DEFAULT_ROUTING_TABLE],
    runtimes: routingRuntimes,
    availability: availabilityOf(runtimes),
    runtimeDefaults,
  });
  logStage("routing", { assignments: Object.keys(routing.assignments).length });

  const highestRiskTier = highestOf(sizing.plan.nodes.map((node) => node.riskTier ?? RISK_TIERS[0]));
  const nodes = sizing.plan.nodes.map((node) => toContractNode(/** @type {SizedPlanNode} */ (node), phase, routing.assignments[node.id]));
  const frozen = freezePlan({
    id: `${campaignId}-${phase}`,
    campaignId,
    goal: campaign.goal,
    // `freezePlan` writes contract.json inside `outDir` (`plansDir`), so `cwd`
    // has to point back at the repo root from there, exactly like `runStage`
    // computes it for the nodes it writes under `plansDir/nodes/`.
    cwd: relative(plansDir, cwd) || ".",
    runtimes,
    runtimeDefaults,
    nodes,
  }, {
    outDir: plansDir,
    provenance: {
      targetGitHead: repoFacts.gitHead,
      planner: { runtimeId: runtimeDefaults.worker ?? "", model: modelOf(runtimes, runtimeDefaults.worker) },
      reviewer: { runtimeId: runtimeDefaults.judge ?? "", model: modelOf(runtimes, runtimeDefaults.judge) },
      sizing: sizing.transformations,
      findings,
    },
  });
  logStage("freeze", { contractId: `${campaignId}-${phase}`, highestRiskTier });

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

  return { status: "frozen", plansDir, planPath, contractPath: join(plansDir, "contract.json"), approved, findings };
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
    definitionOfDone: node.definitionOfDone,
    taskPacket: {
      readFiles: node.readFiles,
      writeFiles: node.writeFiles,
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
      symbols: [],
      decisions: [],
      nonGoals: [],
      verification: node.taskPacket.verification,
    },
    definitionOfDone: node.definitionOfDone ?? [],
    gate,
  };
}
