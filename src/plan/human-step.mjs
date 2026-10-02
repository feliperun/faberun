/**
 * R16: a requirement's `constraints` bullet can declare a step only the
 * operator can perform (the planner and every worker run inside a sandbox
 * that is never the operator's real environment). Detected here so
 * freeze.mjs can carry it on the frozen plan as an explicit stop, and the
 * Campaign Brief can list it among the human decisions. Pure text matching:
 * no file I/O, no git, no model.
 *
 * The same module owns the other thing only an operator can do, because it
 * is the same boundary at a different source: a packet refusal the failure
 * classifier named `ambiguous_requirement` (R5, campaign-efficiency phase 4)
 * is not repairable by widening the packet — the requirement itself can be
 * read more than one way — so it becomes a durable question
 * (`durableQuestion`) the run carries until `resume --answer <node>` closes
 * it, instead of another widening attempt. The source is the run's failure
 * journal, not the spec's constraints; the discipline is unchanged: pure
 * record shaping, no file I/O, no git, no model.
 */

/** @typedef {{requirementId: string, step: string, command: string}} HumanStep */

/** The word a requirement's constraints must use to name the actor a worker cannot be. */
const OPERATOR_KEYWORD = /\boperator\b/iu;

/** The one command the declared step names, quoted the way the spec format already writes one (spec-format.md). */
const COMMAND_FENCE = /`([^`]+)`/u;

/**
 * @param {import("./spec.mjs").SpecRequirement} requirement
 * @returns {HumanStep|null}
 */
export function detectHumanStep(requirement) {
  const text = requirement.constraints;
  if (!text || !OPERATOR_KEYWORD.test(text)) return null;
  const command = COMMAND_FENCE.exec(text);
  if (!command) return null;
  return { requirementId: requirement.id ?? requirement.title, step: text, command: command[1] };
}

/**
 * @param {import("./spec.mjs").SpecRequirement[]} requirements
 * @returns {HumanStep[]}
 */
export function collectHumanSteps(requirements) {
  return requirements
    .map((requirement) => detectHumanStep(requirement))
    .filter((step) => step !== null);
}

/** @typedef {{node: string, artifactVersion: string, question: string}} DurableQuestion */

/**
 * The durable question an ambiguous-requirement refusal becomes. Null for
 * every other cause: a read or write gap is the packet's own defect and a
 * widening round can repair it, but an ambiguity is a property of the
 * requirement the packet was written from, and no widening of read or write
 * scope can answer it — another attempt would re-read the same prose.
 *
 * The question names the node and the packet version it refuses so the
 * operator's answer is bound to the same key the failure journal uses: a
 * widened packet changes the version, and with it the question.
 *
 * @param {{cause: string, node: string, artifactVersion: string}} record a
 *   failureCause record as the reauthor journal writes it
 * @returns {DurableQuestion|null}
 */
export function durableQuestion(record) {
  if (record.cause !== "ambiguous_requirement") return null;
  return {
    node: record.node,
    artifactVersion: record.artifactVersion,
    question: `Node ${record.node} refused its packet at ${record.artifactVersion} with cause ambiguous_requirement: the requirement can be read more than one way, and no widening of the packet can answer it. Decide what the requirement means, then resume with --answer ${record.node}; no reauthor round and no further attempt runs on this packet version until then.`,
  };
}
