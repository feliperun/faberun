/**
 * The Campaign Brief core: the deterministic facts behind the pre-execution
 * brief, derived only from the frozen plan, its validated contract and the
 * structured spec that produced them.
 *
 * `buildBriefModel` is the refusal gate. It reads the plan bytes, checks them
 * against the independent `plan.json.sha256` sidecar, then verifies the
 * contract and spec digests, and only then reads facts. A missing input or a
 * mismatch throws a `BriefInputError`; it never degrades into a plausible
 * summary. Nothing here launches a run or writes an artifact: the model is
 * data, and `src/report/campaign-brief.mjs` renders it.
 *
 * The identity section pins the campaign, spec baseline and digest, target git
 * head, frozen plan path and contract digest. The coverage matrix lists every
 * stable spec requirement id, the frozen contract nodes carrying it, each
 * responsible node's declared proof or verification, and whether the
 * requirement is covered, uncovered, outside this plan, or traceability
 * missing. `decideBriefState` turns any coverage, work-graph or estimate gap
 * into `gaps to resolve`; otherwise the brief is `ready for human review`,
 * which is still not approval to execute.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { contractDigest } from "../contract/index.mjs";
import { contentDigest, fileDigest } from "../plan/freeze.mjs";
import { parseSpec } from "../plan/spec.mjs";
import { errorCode } from "../util.mjs";

/** @typedef {import("../plan/spec.mjs").ParsedSpec} ParsedSpec */
/** @typedef {import("../plan/spec.mjs").SpecRequirement} SpecRequirement */
/** @typedef {Record<string, any>} AnyRecord */

/** @typedef {"missing_input"|"invalid_input"|"plan_digest_mismatch"|"missing_identity"|"contract_digest_mismatch"|"spec_digest_mismatch"} BriefInputErrorCode */
/** @typedef {'covered'|'uncovered'|'outside this plan'|'traceability missing'} CoverageState */
/** @typedef {'ready for human review'|'gaps to resolve'} BriefDecisionState */
/** @typedef {{id: string, requirementIds: string[], nodeIds?: string[], deliverable: string}} BriefDeclaration */
/** @typedef {{id: string, proof: string}} BriefProofNode */
/** @typedef {{requirementId: string, title: string, declaredNodeIds: string[], nodes: BriefProofNode[], state: CoverageState, reasons: string[]}} BriefCoverageRow */
/** @typedef {{rows: BriefCoverageRow[], unknownIds: string[], unknownDeclared: string[], unknownStamped: string[], gaps: string[], specPath: string, planPath: string, covered: number, uncovered: number, outside: number, traceabilityMissing: number, total: number}} BriefCoverage */
/** @typedef {{id: string, runtimeId: string|null, model: string|null, dependsOn: string[], requirementIds: string[]}} BriefGraphNode */
/** @typedef {{from: string, to: string}} BriefGraphEdge */
/** @typedef {{node: string, prerequisites: string[]}} BriefBlockingNode */
/** @typedef {{nodes: BriefGraphNode[], edges: BriefGraphEdge[], independent: string[], blocking: BriefBlockingNode[], maxParallel: number, maxConcurrent: Record<string, number>, effectiveConcurrency: number, gaps: string[]}} BriefGraph */
/** @typedef {{status: "range"|"insufficient data", min: number|null, max: number|null, samples: number|null, reason: string|null, sourceRuns: string[], method: string|null}} BriefMeasure */
/** @typedef {{status?: "range"|"insufficient data", min?: number, max?: number, samples?: number, reason?: string, sourceRuns?: string[], method?: string}} BriefMeasureInput */
/** @typedef {{cost?: BriefMeasureInput, duration?: BriefMeasureInput, runtimes?: string[], models?: string[], effectiveConcurrency?: number, sampleCutoff?: string|null, method?: string[]}} BriefEstimateInput */
/** @typedef {{cost: BriefMeasure, duration: BriefMeasure, runtimes: string[], models: string[], effectiveConcurrency: number, sampleCutoff: string|null, method: string[], gaps: string[]}} BriefEstimate */
/** @typedef {{measure: string, target: string, evidence: string}} BriefSuccessCriterion */
/** @typedef {{risk: string, impact: string, mitigation: string}} BriefRisk */
/** @typedef {{intent: string|null, expectedOutcome: string|null, successCriteria: BriefSuccessCriterion[], humanFacts: string[], calculatedFacts: string[], gaps: string[]}} BriefOpening */
/** @typedef {{human: string[], delegated: string[], risks: BriefRisk[], evals: string[], gaps: string[]}} BriefDecisions */
/** @typedef {{campaign: string, specBaseline: string|null, specDigest: string, specPath: string, targetGitHead: string|null, planPath: string, planDigest: string, contractDigest: string, journalCursor: number, usageSampleCutoff: string|null}} BriefIdentity */
/** @typedef {{identity: BriefIdentity, opening: BriefOpening, coverage: BriefCoverage, graph: BriefGraph, decisions: BriefDecisions, estimate: BriefEstimate, decisionState: BriefDecisionState}} BriefModel */

/**
 * Options for `buildBriefModel`. `planPath` points at the frozen `plan.json`;
 * `specPath` overrides the path recorded in `plan.spec.path`, which is resolved
 * against `cwd` when relative. The journal cursor and usage sample cutoff are
 * recorded verbatim so the same snapshots produce the same bytes.
 *
 * @typedef {object} BriefBuildOptions
 * @property {string} campaignId
 * @property {string} planPath
 * @property {string} [contractPath]
 * @property {string} [sidecarPath]
 * @property {string} [specPath]
 * @property {string} [cwd]
 * @property {number} [journalCursor]
 * @property {string|null} [usageSampleCutoff]
 * @property {BriefEstimateInput} [estimate]
 */

const SAMPLE_FLOOR = 5;

/**
 * A refusal to build a brief from missing or mismatched inputs. The `code` names
 * the exact refusal so a caller can distinguish "refreeze this plan" from "the
 * sidecar does not cover these bytes".
 */
export class BriefInputError extends Error {
  /**
   * @param {BriefInputErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "BriefInputError";
    /** @type {BriefInputErrorCode} */
    this.code = code;
  }
}

/**
 * Verify the frozen inputs and derive the deterministic brief model. Reads the
 * plan, its sidecar, the contract and the spec; throws `BriefInputError` on a
 * missing file, a malformed document, absent identity fields, or any digest
 * mismatch, before reading a single fact out of the spec.
 *
 * @param {BriefBuildOptions} options
 * @returns {BriefModel}
 */
export function buildBriefModel(options) {
  const campaignId = requireInputString(options.campaignId, "campaignId");
  const planPath = requireInputString(options.planPath, "planPath");
  const planText = readText(planPath, "frozen plan");
  const planDigest = fileDigest(planPath);
  const sidecarPath = options.sidecarPath ?? `${planPath}.sha256`;
  const sidecarText = readText(sidecarPath, "plan digest sidecar");
  if (planDigest !== sidecarText.trim()) {
    throw new BriefInputError(
      "plan_digest_mismatch",
      `frozen plan ${planPath} does not match its sidecar: the file is ${planDigest}, the sidecar records ${sidecarText.trim() || "(empty)"}`,
    );
  }
  const plan = parseJson(planText, "frozen plan");
  if (plan.formatVersion !== 1) {
    throw new BriefInputError("missing_identity", `frozen plan ${planPath} has no formatVersion 1; refreeze it before generating a brief`);
  }
  const expectedContractDigest = typeof plan.contractDigest === "string" ? plan.contractDigest : "";
  if (!expectedContractDigest) {
    throw new BriefInputError("missing_identity", `frozen plan ${planPath} records no contractDigest; refreeze it before generating a brief`);
  }
  if (!plan.spec || typeof plan.spec.path !== "string" || typeof plan.spec.digest !== "string") {
    throw new BriefInputError("missing_identity", `frozen plan ${planPath} records no spec path and digest; refreeze it before generating a brief`);
  }

  const planDir = dirname(planPath);
  const contractPath = options.contractPath ?? join(planDir, "contract.json");
  const contractText = readText(contractPath, "contract");
  const contract = parseJson(contractText, "contract");
  const rawContractDigest = contractDigest(contract);
  if (rawContractDigest !== expectedContractDigest) {
    throw new BriefInputError(
      "contract_digest_mismatch",
      `contract ${contractPath} does not match plan.contractDigest: computed ${rawContractDigest}, plan records ${expectedContractDigest}`,
    );
  }

  const specPath = resolveSpecPath(plan, options);
  const specText = readText(specPath, "structured spec");
  if (contentDigest(specText) !== plan.spec.digest) {
    throw new BriefInputError(
      "spec_digest_mismatch",
      `structured spec ${specPath} does not match plan.spec.digest: the bytes changed since the plan froze`,
    );
  }

  const parsedSpec = parseSpec(specText);
  const contractNodes = asArray(contract.nodes);
  const declarations = normalizeDeclarations(plan.phases);
  const coverage = buildCoverage(parsedSpec, declarations, contractNodes, specPath, planPath);
  const graph = buildGraph(contract, contractNodes);
  const decisions = buildDecisions(parsedSpec);
  const estimate = buildEstimate(options.estimate, graph, options.usageSampleCutoff ?? null);
  const opening = buildOpening(parsedSpec, coverage, graph, estimate, decisions);
  const identity = buildIdentity({
    campaign: campaignId,
    plan,
    planPath,
    planDigest,
    contractDigest: expectedContractDigest,
    specPath,
    specBaseline: typeof parsedSpec.frontMatter?.baseline === "string" ? parsedSpec.frontMatter.baseline : null,
    journalCursor: options.journalCursor ?? 0,
    usageSampleCutoff: options.usageSampleCutoff ?? null,
  });
  const decisionState = decideBriefState({ opening, coverage, graph, decisions, estimate });
  return { identity, opening, coverage, graph, decisions, estimate, decisionState };
}

/**
 * `gaps to resolve` when the coverage matrix, the work graph or the opening's
 * source facts report a gap, or when either estimate measure lacks its required
 * evidence; otherwise `ready for human review`. Neither state approves
 * execution.
 *
 * @param {{opening: BriefOpening, coverage: BriefCoverage, graph: BriefGraph, decisions: BriefDecisions, estimate: BriefEstimate}} model
 * @returns {BriefDecisionState}
 */
export function decideBriefState(model) {
  if (model.coverage.gaps.length > 0) return "gaps to resolve";
  if (model.graph.gaps.length > 0) return "gaps to resolve";
  if (model.decisions.gaps.length > 0) return "gaps to resolve";
  if (model.opening.gaps.length > 0) return "gaps to resolve";
  if (model.estimate.cost.status !== "range" || model.estimate.duration.status !== "range") return "gaps to resolve";
  return "ready for human review";
}

/**
 * @param {string|undefined} value
 * @param {string} label
 * @returns {string}
 */
function requireInputString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BriefInputError("missing_input", `brief ${label} is required`);
  }
  return value;
}

/**
 * @param {string} path
 * @param {string} label
 * @returns {string}
 */
function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new BriefInputError("missing_input", `brief ${label} is missing: ${path}`);
    }
    throw error;
  }
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {AnyRecord}
 */
function parseJson(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BriefInputError("invalid_input", `brief ${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefInputError("invalid_input", `brief ${label} must be a JSON object`);
  }
  return /** @type {AnyRecord} */ (value);
}

/**
 * The spec path to verify: an explicit override wins, otherwise the recorded
 * path, resolved against `cwd` when relative.
 *
 * @param {AnyRecord} plan
 * @param {BriefBuildOptions} options
 * @returns {string}
 */
function resolveSpecPath(plan, options) {
  if (typeof options.specPath === "string" && options.specPath.trim()) return options.specPath;
  const recorded = plan.spec && typeof plan.spec.path === "string" ? plan.spec.path : "";
  if (!recorded) throw new BriefInputError("missing_identity", "frozen plan records no spec path");
  if (isAbsolute(recorded)) return recorded;
  return resolve(options.cwd ?? process.cwd(), recorded);
}

/**
 * @param {unknown} phases
 * @returns {BriefDeclaration[]}
 */
function normalizeDeclarations(phases) {
  return asArray(phases).map((phase) => {
    const record = /** @type {AnyRecord} */ (phase ?? {});
    /** @type {BriefDeclaration} */
    const declaration = {
      id: String(record.id ?? ""),
      requirementIds: asArray(record.requirementIds).map(String),
      deliverable: String(record.deliverable ?? ""),
    };
    if (Array.isArray(record.nodeIds)) declaration.nodeIds = record.nodeIds.map(String);
    return declaration;
  });
}

/**
 * The frozen nodes a declaration assigns: its explicit `nodeIds`, or — for a
 * legacy declaration that predates node assignment — the contract nodes whose
 * execution `phase` matches, exactly as freeze stamps them.
 *
 * @param {BriefDeclaration} declaration
 * @param {AnyRecord[]} nodes
 * @returns {string[]}
 */
function declaredNodeIdsFor(declaration, nodes) {
  if (declaration.nodeIds !== undefined) return declaration.nodeIds;
  return nodes.filter((node) => node.phase === declaration.id).map((node) => String(node.id ?? ""));
}

/**
 * Build the coverage matrix by cross-checking the spec's requirement ids
 * against the frozen declarations' node ids and each node's stamped
 * `requirementIds`. Unknown ids on either side are named, never dropped.
 *
 * @param {ParsedSpec} parsedSpec
 * @param {BriefDeclaration[]} declarations
 * @param {AnyRecord[]} nodes
 * @param {string} specPath
 * @param {string} planPath
 * @returns {BriefCoverage}
 */
function buildCoverage(parsedSpec, declarations, nodes, specPath, planPath) {
  const nodeById = new Map(nodes.map((node) => [String(node.id ?? ""), node]));
  const requirements = parsedSpec.requirements.filter((requirement) => requirement.id !== null);
  const known = new Set(requirements.map((requirement) => String(requirement.id)));
  const declarationsPresent = declarations.length > 0;
  /** @type {BriefCoverageRow[]} */
  const rows = [];
  /** @type {string[]} */
  const gaps = [];

  for (const requirement of requirements) {
    const requirementId = String(requirement.id);
    const claiming = declarations.filter((declaration) => declaration.requirementIds.includes(requirementId));
    const declaredNodeIds = unique(claiming.flatMap((declaration) => declaredNodeIdsFor(declaration, nodes)));
    /** @type {BriefProofNode[]} */
    const proofNodes = [];
    /** @type {string[]} */
    const reasons = [];
    /** @type {CoverageState} */
    let state;
    if (!declarationsPresent) {
      state = "traceability missing";
      reasons.push("plan.json carries no requirement declarations");
    } else if (claiming.length === 0) {
      state = "outside this plan";
    } else if (declaredNodeIds.length === 0) {
      state = "uncovered";
      reasons.push("declared but no frozen node is assigned");
    } else {
      /** @type {string[]} */
      const traceability = [];
      for (const nodeId of declaredNodeIds) {
        const node = nodeById.get(nodeId);
        if (node === undefined) {
          traceability.push(`declared node ${nodeId} is not a frozen contract node`);
          continue;
        }
        const stamped = asArray(node.requirementIds).map(String);
        if (!stamped.includes(requirementId)) {
          traceability.push(`node ${nodeId} is declared for ${requirementId} but its stamped requirementIds do not include it`);
          continue;
        }
        proofNodes.push({ id: nodeId, proof: nodeProof(node) });
      }
      if (traceability.length > 0) {
        state = "traceability missing";
        reasons.push(...traceability);
      } else {
        state = "covered";
      }
    }
    if (state === "uncovered" || state === "traceability missing") {
      gaps.push(`${requirementId}: ${state} (${reasons.join("; ") || "no reason recorded"})`);
    }
    rows.push({ requirementId, title: requirement.title, declaredNodeIds, nodes: proofNodes, state, reasons });
  }

  const declaredRequirementIds = unique(declarations.flatMap((declaration) => declaration.requirementIds));
  const stampedRequirementIds = unique(nodes.flatMap((node) => asArray(node.requirementIds).map(String)));
  const unknownDeclared = declaredRequirementIds.filter((id) => !known.has(id));
  const unknownStamped = stampedRequirementIds.filter((id) => !known.has(id));
  const unknownIds = unique([...unknownDeclared, ...unknownStamped]);
  for (const id of unknownIds) {
    const where = [
      unknownDeclared.includes(id) ? "declared" : null,
      unknownStamped.includes(id) ? "stamped on a node" : null,
    ].filter((value) => value !== null).join(" and ");
    gaps.push(`unknown requirement id ${id} (${where})`);
  }
  for (const declaration of declarations) {
    if (declaration.requirementIds.length === 0) {
      gaps.push(`declaration ${declaration.id} names no requirement id`);
    }
  }

  /** @param {CoverageState} state @returns {number} */
  const counted = (state) => rows.filter((row) => row.state === state).length;
  return {
    rows,
    unknownIds,
    unknownDeclared,
    unknownStamped,
    gaps,
    specPath,
    planPath,
    covered: counted("covered"),
    uncovered: counted("uncovered"),
    outside: counted("outside this plan"),
    traceabilityMissing: counted("traceability missing"),
    total: rows.length,
  };
}

/**
 * The actual `dependsOn` graph plus the contract's capacity limits. The
 * dependency-independent set is distinct from the workers capacity actually
 * lets dispatch together.
 *
 * @param {AnyRecord} contract
 * @param {AnyRecord[]} nodes
 * @returns {BriefGraph}
 */
function buildGraph(contract, nodes) {
  const runtimes = contract.runtimes && typeof contract.runtimes === "object" && !Array.isArray(contract.runtimes)
    ? /** @type {Record<string, AnyRecord>} */ (contract.runtimes)
    : {};
  const ids = new Set(nodes.map((node) => String(node.id ?? "")));
  /** @type {string[]} */
  const gaps = [];
  /** @type {BriefGraphEdge[]} */
  const edges = [];
  /** @type {BriefGraphNode[]} */
  const graphNodes = nodes.map((node) => {
    const id = String(node.id ?? "");
    const dependsOn = asArray(node.dependsOn).map(String);
    for (const dependency of dependsOn) {
      if (dependency === id) {
        gaps.push(`node ${id} depends on itself`);
      } else if (!ids.has(dependency)) {
        gaps.push(`node ${id} depends on unknown node ${dependency}`);
      } else {
        edges.push({ from: dependency, to: id });
      }
    }
    const runtimeId = typeof node.runtime === "string"
      ? node.runtime
      : typeof contract.runtimeDefaults?.worker === "string" ? contract.runtimeDefaults.worker : null;
    const runtime = runtimeId !== null && typeof runtimes[runtimeId] === "object" ? runtimes[runtimeId] : null;
    return {
      id,
      runtimeId,
      model: runtime && typeof runtime.model === "string" ? runtime.model : null,
      dependsOn,
      requirementIds: asArray(node.requirementIds).map(String),
    };
  });
  const independent = graphNodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
  const blocking = graphNodes.filter((node) => node.dependsOn.length > 0).map((node) => ({ node: node.id, prerequisites: node.dependsOn }));
  /** @type {Record<string, number>} */
  const maxConcurrent = {};
  for (const node of graphNodes) {
    if (node.runtimeId === null) continue;
    const runtime = runtimes[node.runtimeId];
    const limit = runtime && Number.isInteger(runtime.maxConcurrent) && runtime.maxConcurrent > 0 ? runtime.maxConcurrent : 1;
    maxConcurrent[node.runtimeId] = maxConcurrent[node.runtimeId] === undefined ? limit : Math.min(maxConcurrent[node.runtimeId], limit);
  }
  const maxParallel = Number.isInteger(contract.maxParallel) && contract.maxParallel > 0 ? contract.maxParallel : 1;
  const independentCapacity = independent.reduce((total, id) => {
    const node = graphNodes.find((candidate) => candidate.id === id);
    const limit = node && node.runtimeId !== null ? maxConcurrent[node.runtimeId] ?? 1 : 1;
    return total + limit;
  }, 0);
  const effectiveConcurrency = Math.max(1, Math.min(maxParallel, independent.length || 1, independentCapacity || 1));
  return { nodes: graphNodes, edges, independent, blocking, maxParallel, maxConcurrent, effectiveConcurrency, gaps };
}

/**
 * Human decisions and delegated decisions from the explicit spec sections;
 * risks and planned evals only from this campaign's spec. A missing section is
 * a gap, never inferred from the graph.
 *
 * @param {ParsedSpec} parsedSpec
 * @returns {BriefDecisions}
 */
function buildDecisions(parsedSpec) {
  /** @param {string} name @returns {string} */
  const section = (name) => parsedSpec.sections.get(name)?.body ?? "";
  const human = [...bulletLines(section("human decisions")), ...bulletLines(section("settled owner decisions"))];
  const delegated = bulletLines(section("delegable decisions"));
  const evals = bulletLines(section("planned evals"));
  const risks = riskRows(section("risks"));
  /** @type {string[]} */
  const gaps = [];
  /** @type {[string, boolean][]} */
  const sectionPresence = [
    ["intent", parsedSpec.sections.has("intent")],
    ["success criteria", parsedSpec.sections.has("success criteria")],
    ["human decisions", parsedSpec.sections.has("human decisions")],
    ["delegable decisions", parsedSpec.sections.has("delegable decisions")],
    ["risks", parsedSpec.sections.has("risks")],
    ["planned evals", parsedSpec.sections.has("planned evals")],
  ];
  for (const [name, present] of sectionPresence) {
    if (!present) gaps.push(`spec has no ${name} section`);
  }
  if (human.length === 0) gaps.push("spec records no human decision");
  return { human, delegated, risks, evals, gaps };
}

/**
 * Normalize an estimate input. A `range` needs finite bounds and at least five
 * comparable samples; anything less is `insufficient data` with the reason,
 * never a zero or a point estimate.
 *
 * @param {BriefEstimateInput|undefined} input
 * @param {BriefGraph} graph
 * @param {string|null} sampleCutoff
 * @returns {BriefEstimate}
 */
function buildEstimate(input, graph, sampleCutoff) {
  const cost = normalizeMeasure(input?.cost, "cost");
  const duration = normalizeMeasure(input?.duration, "duration");
  /** @type {string[]} */
  const gaps = [];
  if (cost.status !== "range") gaps.push(`cost estimate reports insufficient data: ${cost.reason ?? "no reason recorded"}`);
  if (duration.status !== "range") gaps.push(`duration estimate reports insufficient data: ${duration.reason ?? "no reason recorded"}`);
  if (typeof sampleCutoff !== "string" || !sampleCutoff.trim()) {
    gaps.push("usage sample cutoff is not recorded");
  }
  return {
    cost,
    duration,
    runtimes: unique(input?.runtimes ?? graph.nodes.map((node) => node.runtimeId).filter((id) => id !== null).map(String)),
    models: unique(input?.models ?? graph.nodes.map((node) => node.model).filter((model) => model !== null).map(String)),
    effectiveConcurrency: typeof input?.effectiveConcurrency === "number" ? input.effectiveConcurrency : graph.effectiveConcurrency,
    sampleCutoff: typeof sampleCutoff === "string" && sampleCutoff.trim() ? sampleCutoff : null,
    method: input?.method ?? [],
    gaps,
  };
}

/**
 * @param {BriefMeasureInput|undefined} input
 * @param {string} label
 * @returns {BriefMeasure}
 */
function normalizeMeasure(input, label) {
  /** @param {string} reason @returns {BriefMeasure} */
  const insufficient = (reason) => ({
    status: /** @type {const} */ ("insufficient data"),
    min: null,
    max: null,
    samples: typeof input?.samples === "number" ? input.samples : null,
    reason,
    sourceRuns: input?.sourceRuns ?? [],
    method: input?.method ?? null,
  });
  if (!input || input.status !== "range") return insufficient(input?.reason ?? `${label} range was not provided`);
  if (typeof input.samples !== "number" || input.samples < SAMPLE_FLOOR) {
    return insufficient(`${label} range has fewer than ${SAMPLE_FLOOR} comparable completed nodes`);
  }
  if (typeof input.min !== "number" || typeof input.max !== "number") {
    return insufficient(`${label} range bounds are missing`);
  }
  return {
    status: "range",
    min: input.min,
    max: input.max,
    samples: input.samples,
    reason: null,
    sourceRuns: input.sourceRuns ?? [],
    method: input.method ?? null,
  };
}

/**
 * The R2 opening: one sentence of intent, expected outcome, measurable success
 * criteria, and separated human-authored and calculated facts. Missing source
 * facts are named as gaps rather than invented.
 *
 * @param {ParsedSpec} parsedSpec
 * @param {BriefCoverage} coverage
 * @param {BriefGraph} graph
 * @param {BriefEstimate} estimate
 * @param {BriefDecisions} decisions
 * @returns {BriefOpening}
 */
function buildOpening(parsedSpec, coverage, graph, estimate, decisions) {
  const intent = firstSentence(parsedSpec.sections.get("intent")?.body ?? "");
  const successCriteria = successCriteriaRows(parsedSpec.sections.get("success criteria")?.body ?? "");
  const expectedOutcome = successCriteria.length > 0 ? successCriteria[0].target : null;
  /** @type {string[]} */
  const gaps = [];
  if (intent === null) gaps.push("spec Intent section has no sentence to quote");
  if (expectedOutcome === null) gaps.push("spec Success criteria section has no measurable target");

  /** @type {string[]} */
  const humanFacts = [
    ...decisions.human.map((text) => `Human decision: ${text}`),
    ...decisions.delegated.map((text) => `Delegated decision: ${text}`),
    ...decisions.risks.map((risk) => `Risk: ${risk.risk} — mitigation: ${risk.mitigation}`),
    ...decisions.evals.map((text) => `Planned eval: ${text}`),
  ];
  /** @type {string[]} */
  const calculatedFacts = [
    `Coverage: ${coverage.covered} covered, ${coverage.uncovered} uncovered, ${coverage.outside} outside this plan, ${coverage.traceabilityMissing} traceability missing of ${coverage.total} spec requirements.`,
    `Work graph: ${graph.nodes.length} nodes, ${graph.edges.length} dependency edges, ${graph.independent.length} dependency-independent, effective concurrency ${graph.effectiveConcurrency} under maxParallel ${graph.maxParallel}.`,
    `Estimate: cost ${estimate.cost.status}, duration ${estimate.duration.status}; sample cutoff ${estimate.sampleCutoff ?? "not recorded"}.`,
  ];
  return { intent, expectedOutcome, successCriteria, humanFacts, calculatedFacts, gaps };
}

/**
 * @param {{campaign: string, plan: AnyRecord, planPath: string, planDigest: string, contractDigest: string, specPath: string, specBaseline: string|null, journalCursor: number, usageSampleCutoff: string|null}} input
 * @returns {BriefIdentity}
 */
function buildIdentity(input) {
  const provenance = input.plan.provenance && typeof input.plan.provenance === "object" ? input.plan.provenance : {};
  return {
    campaign: input.campaign,
    specBaseline: input.specBaseline,
    specDigest: typeof input.plan.spec?.digest === "string" ? input.plan.spec.digest : "",
    specPath: input.specPath,
    targetGitHead: typeof provenance.targetGitHead === "string" ? provenance.targetGitHead : null,
    planPath: input.planPath,
    planDigest: input.planDigest,
    contractDigest: input.contractDigest,
    journalCursor: input.journalCursor,
    usageSampleCutoff: input.usageSampleCutoff,
  };
}

/**
 * @param {AnyRecord} node
 * @returns {string}
 */
function nodeProof(node) {
  /** @type {string[]} */
  const proofs = [];
  for (const item of asArray(node.definitionOfDone)) {
    const record = /** @type {AnyRecord} */ (item ?? {});
    const proof = record.proof && typeof record.proof === "object" ? /** @type {AnyRecord} */ (record.proof) : null;
    if (proof === null) continue;
    const id = typeof record.id === "string" ? `${record.id} ` : "";
    const kind = typeof proof.kind === "string" ? proof.kind : "proof";
    const ref = typeof proof.ref === "string" && proof.ref ? `: ${proof.ref}` : "";
    proofs.push(`${id}${kind}${ref}`);
  }
  const packet = node.taskPacket && typeof node.taskPacket === "object" ? /** @type {AnyRecord} */ (node.taskPacket) : {};
  for (const command of asArray(packet.verification)) {
    const argv = command && typeof command === "object" ? /** @type {AnyRecord} */ (command).argv : undefined;
    if (Array.isArray(argv)) proofs.push(argv.map(String).join(" "));
  }
  return proofs.length > 0 ? proofs.join("; ") : "no declared proof";
}

/**
 * @param {string} body
 * @returns {string[]}
 */
function bulletLines(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

/**
 * @param {string} body
 * @returns {BriefSuccessCriterion[]}
 */
function successCriteriaRows(body) {
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return [];
  const header = tableCells(rows[0]).map((cell) => cell.toLowerCase());
  const measureIndex = header.findIndex((cell) => cell.includes("measure"));
  const targetIndex = header.findIndex((cell) => cell.includes("target"));
  const evidenceIndex = header.findIndex((cell) => cell.includes("evidence"));
  return rows.slice(2).map((row) => {
    const cells = tableCells(row);
    return {
      measure: measureIndex >= 0 ? cells[measureIndex] ?? "" : "",
      target: targetIndex >= 0 ? cells[targetIndex] ?? "" : "",
      evidence: evidenceIndex >= 0 ? cells[evidenceIndex] ?? "" : "",
    };
  }).filter((criterion) => criterion.measure.length > 0 || criterion.target.length > 0);
}

/**
 * @param {string} body
 * @returns {BriefRisk[]}
 */
function riskRows(body) {
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return [];
  const header = tableCells(rows[0]).map((cell) => cell.toLowerCase());
  const riskIndex = header.findIndex((cell) => cell.includes("risk"));
  const impactIndex = header.findIndex((cell) => cell.includes("impact"));
  const mitigationIndex = header.findIndex((cell) => cell.includes("mitigation"));
  return rows.slice(2).map((row) => {
    const cells = tableCells(row);
    return {
      risk: riskIndex >= 0 ? cells[riskIndex] ?? "" : "",
      impact: impactIndex >= 0 ? cells[impactIndex] ?? "" : "",
      mitigation: mitigationIndex >= 0 ? cells[mitigationIndex] ?? "" : "",
    };
  }).filter((risk) => risk.risk.length > 0);
}

/**
 * @param {string} row
 * @returns {string[]}
 */
function tableCells(row) {
  const trimmed = row.trim();
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith("|") ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutTrailing.split("|").map((value) => value.trim());
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function firstSentence(text) {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  const match = /^(.*?[.!?])(?:\s|$)/u.exec(collapsed);
  return (match ? match[1] : collapsed).trim();
}

/**
 * @param {unknown} value
 * @returns {any[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @template T
 * @param {T[]} values
 * @returns {T[]}
 */
function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
