/**
 * Campaign Brief Markdown: the portable review surface rendered from the
 * deterministic model in `src/campaign/campaign-brief.mjs`.
 *
 * Rendering is a pure function of the model. It adds no timestamp and reads no
 * live value, so the same spec, plan, contract and recorded-data snapshots
 * produce the same bytes. The opening before the coverage matrix is bounded at
 * 250 words; the coverage matrix, work graph, gaps, estimate and provenance
 * follow it.
 */
/** @typedef {import("../campaign/campaign-brief.mjs").BriefModel} BriefModel */
/** @typedef {import("../campaign/campaign-brief.mjs").BriefCoverageRow} BriefCoverageRow */
/** @typedef {import("../campaign/campaign-brief.mjs").BriefMeasure} BriefMeasure */

const OPENING_WORD_LIMIT = 250;

/**
 * Render the Campaign Brief as Markdown. The result is portable: it links to
 * the spec and frozen plan by path and contains every review fact as text.
 *
 * @param {BriefModel} model
 * @returns {string}
 */
export function renderCampaignBriefMarkdown(model) {
  const opening = fitAtoms(openingAtoms(model), OPENING_WORD_LIMIT);
  const body = [
    renderCoverage(model),
    renderWorkGraph(model),
    renderDecisions(model),
    renderRisksAndEvals(model),
    renderGaps(model),
    renderEstimate(model),
    renderProvenance(model),
  ].join("\n\n");
  return `${opening}\n\n${body}\n`;
}

/**
 * @param {BriefModel} model
 * @returns {{text: string, priority: number}[]}
 */
function openingAtoms(model) {
  return [
    { text: `# Campaign brief — ${model.identity.campaign}`, priority: 0 },
    { text: renderIdentity(model), priority: 0 },
    { text: renderDecision(model), priority: 0 },
    { text: renderIntent(model), priority: 0 },
    { text: renderExpectedOutcome(model), priority: 0 },
    { text: renderSuccessCriteria(model), priority: 1 },
    { text: renderHumanFacts(model), priority: 2 },
    { text: renderCalculatedFacts(model), priority: 3 },
    { text: renderOpenGapSummary(model), priority: 4 },
  ];
}

/**
 * Keep whole atoms while the opening stays within the word limit, dropping the
 * lowest-priority atoms from the end first. Identity, decision, intent and
 * expected outcome are never dropped.
 *
 * @param {{text: string, priority: number}[]} atoms
 * @param {number} limit
 * @returns {string}
 */
function fitAtoms(atoms, limit) {
  const current = atoms.filter((atom) => atom.text.length > 0);
  while (wordCount(current.map((atom) => atom.text).join("\n\n")) > limit) {
    const maxPriority = Math.max(...current.map((atom) => atom.priority));
    if (maxPriority === 0) break;
    const index = current.map((atom) => atom.priority).lastIndexOf(maxPriority);
    if (index < 0) break;
    current.splice(index, 1);
  }
  return current.map((atom) => atom.text).join("\n\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderIdentity(model) {
  const { identity } = model;
  return [
    "## Identity",
    `- Campaign: \`${identity.campaign}\``,
    `- Spec baseline: \`${identity.specBaseline ?? "not recorded"}\``,
    `- Spec digest: \`${identity.specDigest}\``,
    `- Spec: ${link(identity.specPath)}`,
    `- Target git head: \`${identity.targetGitHead ?? "not recorded"}\``,
    `- Frozen plan: ${link(identity.planPath)}`,
    `- Plan digest: \`${identity.planDigest}\``,
    `- Contract digest: \`${identity.contractDigest}\``,
    `- Journal cursor: \`${identity.journalCursor}\``,
    `- Usage sample cutoff: \`${identity.usageSampleCutoff ?? "not recorded"}\``,
  ].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderDecision(model) {
  return [
    "## Decision",
    `- State: **${model.decisionState}**`,
    `- Technical plan: ${link(model.identity.planPath)}`,
    `- Note: ${decisionNote(model)}`,
  ].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function decisionNote(model) {
  const gaps = allGaps(model);
  if (gaps.length === 0) {
    return "No coverage, work-graph or estimate gap is open; this is a review state, not approval to execute.";
  }
  return `${gaps.length} gap${gaps.length === 1 ? "" : "s"} must be resolved before this brief is ready; this is not approval to execute.`;
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderIntent(model) {
  return `## Intent\n${model.opening.intent ?? "not recorded"}`;
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderExpectedOutcome(model) {
  return `## Expected outcome\n${model.opening.expectedOutcome ?? "not recorded"}`;
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderSuccessCriteria(model) {
  const lines = (model.opening.successCriteria.length > 0 ? model.opening.successCriteria : [])
    .map((criterion) => `- ${criterion.measure}: ${criterion.target}${criterion.evidence ? ` (evidence: ${criterion.evidence})` : ""}`);
  return ["## Success criteria", ...(lines.length > 0 ? lines : ["- none recorded"])].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderHumanFacts(model) {
  const facts = model.opening.humanFacts;
  return ["## Human-authored facts", ...(facts.length > 0 ? facts.map((fact) => `- ${fact}`) : ["- none recorded"])].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderCalculatedFacts(model) {
  const facts = model.opening.calculatedFacts;
  return ["## Calculated facts", ...(facts.length > 0 ? facts.map((fact) => `- ${fact}`) : ["- none recorded"])].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderOpenGapSummary(model) {
  const gaps = allGaps(model);
  const line = gaps.length === 0
    ? "- none"
    : `- ${gaps.length} open gap${gaps.length === 1 ? "" : "s"}; the full list follows the coverage matrix.`;
  return ["## Open gaps", line].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderCoverage(model) {
  const { coverage } = model;
  const header = "| Requirement | Frozen nodes | Declared proof or verification | State |";
  const separator = "| --- | --- | --- | --- |";
  const rows = coverage.rows.map((row) => renderCoverageRow(row));
  const unknown = coverage.unknownIds.length > 0
    ? `Unknown requirement ids: ${coverage.unknownIds.map((id) => `\`${id}\``).join(", ")}.`
    : "Unknown requirement ids: none.";
  return [
    "## Coverage matrix",
    `Spec: ${link(coverage.specPath)} · Plan: ${link(coverage.planPath)}`,
    "Each spec requirement is cross-checked against the frozen declarations' nodeIds and each contract node's stamped requirementIds.",
    "",
    header,
    separator,
    ...(rows.length > 0 ? rows : [`| _no spec requirements_ | — | — | outside this plan |`]),
    "",
    unknown,
  ].join("\n");
}

/**
 * @param {BriefCoverageRow} row
 * @returns {string}
 */
function renderCoverageRow(row) {
  const nodeIds = row.nodes.length > 0
    ? row.nodes.map((node) => `\`${node.id}\``).join(", ")
    : row.declaredNodeIds.length > 0 ? `none (declared: ${row.declaredNodeIds.map((id) => `\`${id}\``).join(", ")})` : "—";
  const proofs = row.nodes.length > 0
    ? row.nodes.map((node) => `${node.id}: ${cell(node.proof)}`).join("; ")
    : row.reasons.length > 0 ? cell(row.reasons.join("; ")) : "—";
  return `| \`${row.requirementId}\` | ${nodeIds} | ${proofs} | ${row.state} |`;
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderWorkGraph(model) {
  const { graph } = model;
  const edgeLines = graph.edges.length > 0
    ? graph.edges.map((edge) => `- \`${edge.from}\` → \`${edge.to}\``)
    : ["- Dependency edges: none"];
  const independent = graph.independent.length > 0 ? graph.independent.map((id) => `\`${id}\``).join(", ") : "none";
  const blocking = graph.blocking.length > 0
    ? graph.blocking.map((entry) => `\`${entry.node}\` depends on ${entry.prerequisites.map((id) => `\`${id}\``).join(", ")}`).join("; ")
    : "none";
  const concurrent = Object.entries(graph.maxConcurrent)
    .map(([runtimeId, limit]) => `\`${runtimeId}\` ${limit}`)
    .join(", ");
  return [
    "## Work graph",
    ...edgeLines,
    `- Dependency-independent nodes: ${independent}`,
    `- Blocking prerequisites: ${blocking}`,
    `- maxParallel: ${graph.maxParallel}`,
    `- maxConcurrent: ${concurrent || "none"}`,
    `- Effective concurrency: ${graph.effectiveConcurrency}`,
    `- ${renderDispatchable(graph)}`,
  ].join("\n");
}

/**
 * The capacity reading, kept distinct from the graph reading: a node with no
 * prerequisites is dependency-independent, but that never means it can run at
 * the same time as a sibling. With `maxParallel` 1 the line says plainly that
 * independent nodes are not simultaneously dispatchable.
 *
 * @param {BriefModel["graph"]} graph
 * @returns {string}
 */
function renderDispatchable(graph) {
  if (graph.dispatchableTogether.length >= 2) {
    return `Workers that can run at the same time: ${graph.dispatchableTogether.map((id) => `\`${id}\``).join(", ")}.`;
  }
  return `Workers that can run at the same time: none — ${graph.dispatchNote}.`;
}

/**
 * Human and delegated decisions from this campaign's spec sections and the
 * active campaign journal projection, and nothing else. The section repeats the
 * facts the opening carries so they survive the 250-word opening limit.
 *
 * @param {BriefModel} model
 * @returns {string}
 */
function renderDecisions(model) {
  const { decisions } = model;
  const lines = [
    "## Decisions",
    "(sources: this campaign's spec sections and the active campaign journal projection; nothing inferred from the graph)",
    ...decisions.human.map((text) => `- Human decision (spec): ${text}`),
    ...decisions.delegated.map((text) => `- Delegated decision (spec): ${text}`),
    ...decisions.journal.map((decision) => `- Journal decision [${decision.id}]: ${decision.text}${decision.at ? ` · ${decision.at}` : ""}`),
  ];
  if (lines.length === 2) lines.push("- none recorded");
  return lines.join("\n");
}

/**
 * Risks and planned evals, from this campaign's spec only.
 *
 * @param {BriefModel} model
 * @returns {string}
 */
function renderRisksAndEvals(model) {
  const { decisions } = model;
  const lines = [
    "## Risks and planned evals",
    ...decisions.risks.map((risk) => `- Risk: ${risk.risk} — impact: ${risk.impact}; mitigation: ${risk.mitigation}`),
    ...decisions.evals.map((text) => `- Planned eval: ${text}`),
  ];
  if (lines.length === 1) lines.push("- none recorded");
  return lines.join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderGaps(model) {
  const gaps = allGaps(model);
  const lines = gaps.length > 0 ? gaps.map((gap) => `- ${gap}`) : ["- none"];
  return ["## Gaps", ...lines].join("\n");
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderEstimate(model) {
  const { estimate } = model;
  const method = estimate.method.length > 0 ? estimate.method.join("; ") : "not recorded";
  const assumptions = estimate.assumptions.length > 0 ? estimate.assumptions.join("; ") : "not recorded";
  return [
    "## Estimate",
    `- Nodes: ${estimate.nodeCount}`,
    `- Workers: ${estimate.workerCount}`,
    `- Cost: ${renderMeasure(estimate.cost, "usd")}`,
    `- Cost provenance: ${estimate.cost.provenance ?? "not recorded"}`,
    `- Duration: ${renderMeasure(estimate.duration, "minutes")}`,
    `- Duration provenance: ${estimate.duration.provenance ?? "not recorded"}`,
    `- Runtimes: ${estimate.runtimes.length > 0 ? estimate.runtimes.map((id) => `\`${id}\``).join(", ") : "none"}`,
    `- Models: ${estimate.models.length > 0 ? estimate.models.map((model_) => `\`${model_}\``).join(", ") : "none"}`,
    `- Effective worker concurrency: ${estimate.effectiveConcurrency}`,
    `- Method: ${method}`,
    `- Assumptions: ${assumptions}`,
    `- Sample cutoff: ${estimate.sampleCutoff ?? "not recorded"}`,
    `- Advisory only: ranges are not spend or time ceilings.`,
  ].join("\n");
}

/**
 * @param {BriefMeasure} measure
 * @param {"usd"|"minutes"} unit
 * @returns {string}
 */
function renderMeasure(measure, unit) {
  if (measure.status !== "range" || measure.min === null || measure.max === null) {
    const samples = typeof measure.samples === "number" ? ` (${measure.samples} comparable sample${measure.samples === 1 ? "" : "s"})` : "";
    return `insufficient data — ${measure.reason ?? "no reason recorded"}${samples}`;
  }
  const range = unit === "usd" ? `$${measure.min}–$${measure.max}` : `${measure.min}–${measure.max} minutes`;
  const provenance = measure.sourceRuns.length > 0 ? ` (source runs: ${measure.sourceRuns.join(", ")})` : "";
  return `${range} from ${measure.samples} comparable samples${provenance}`;
}

/**
 * @param {BriefModel} model
 * @returns {string}
 */
function renderProvenance(model) {
  return [
    "## Provenance",
    `- Journal cursor: \`${model.identity.journalCursor}\``,
    `- Usage sample cutoff: \`${model.identity.usageSampleCutoff ?? "not recorded"}\``,
    "- Deterministic: the same spec, plan, contract and recorded-data snapshots produce these bytes.",
  ].join("\n");
}

/**
 * Every gap the decision state considers, in the model's own order: coverage,
 * work graph, decisions, then the estimate measures.
 *
 * @param {BriefModel} model
 * @returns {string[]}
 */
function allGaps(model) {
  return [
    ...model.coverage.gaps,
    ...model.graph.gaps,
    ...model.decisions.gaps,
    ...model.opening.gaps,
    ...model.estimate.gaps,
  ];
}

/**
 * A path rendered as a Markdown link; the link text is the path itself so the
 * brief stays readable without following it.
 *
 * @param {string} path
 * @returns {string}
 */
function link(path) {
  return `[${cell(path)}](${path})`;
}

/**
 * Escape a table cell and collapse it to one line.
 *
 * @param {string} value
 * @returns {string}
 */
function cell(value) {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

/**
 * @param {string} text
 * @returns {number}
 */
function wordCount(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}
