/**
 * R16: a requirement's `constraints` bullet can declare a step only the
 * operator can perform (the planner and every worker run inside a sandbox
 * that is never the operator's real environment). Detected here so
 * freeze.mjs can carry it on the frozen plan as an explicit stop, and the
 * Campaign Brief can list it among the human decisions. Pure text matching:
 * no file I/O, no git, no model.
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
