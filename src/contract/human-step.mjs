/**
 * Validation for a node's `humanStep` field (R16): the operator-only step and
 * its command a requirement's `constraints` declared (`plan/human-step.mjs`
 * detects it; `plan/freeze.mjs` stamps it onto the node that carries the
 * requirement). Split from `contract/index.mjs`, mirroring
 * `judge-independence.mjs`, because the shape that turns a node into a stop
 * belongs with the field that declares it, not the general node-parsing loop.
 */
import { assertObject, boundedString, rejectUnknown } from "./assert.mjs";

/** The fields a node's `humanStep` declaration carries. */
const HUMAN_STEP_FIELDS = new Set(["step", "command"]);

/** Bound on each of `step` and `command`, matching the operator-answer ceiling this stop is paired with (`engine/retry.mjs`'s `Previous attempt` section). */
const HUMAN_STEP_MAX_BYTES = 4096;

/** The error code a `humanStep` node stops with once its dependencies are done, never dispatched to a provider. */
export const HUMAN_STEP_ERROR_CODE = "human_step_pending";

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{step: string, command: string}|undefined}
 */
export function validateHumanStep(value, label) {
  if (value === undefined) return undefined;
  assertObject(value, label);
  const record = /** @type {Record<string, unknown>} */ (value);
  rejectUnknown(record, HUMAN_STEP_FIELDS, label);
  boundedString(record.step, `${label}.step`, HUMAN_STEP_MAX_BYTES);
  boundedString(record.command, `${label}.command`, HUMAN_STEP_MAX_BYTES);
  return { step: /** @type {string} */ (record.step), command: /** @type {string} */ (record.command) };
}

/**
 * The attention message naming the step and its command: `state.error.message`
 * carries this verbatim, so every existing attention surface (the final
 * report, the run's stdout line, a resume's attention print) names both
 * without reading the contract a second time.
 *
 * @param {{step: string, command: string}} humanStep
 * @returns {string}
 */
export function humanStepAttentionMessage(humanStep) {
  return `${humanStep.step} — run \`${humanStep.command}\``;
}

/**
 * @param {{status?: string, error?: {code?: string}|null}} state
 * @returns {boolean}
 */
export function isHumanStepPending(state) {
  return state.status === "blocked" && state.error?.code === HUMAN_STEP_ERROR_CODE;
}
