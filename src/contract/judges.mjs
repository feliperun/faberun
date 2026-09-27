/**
 * Validation for the `judges` contract field (R18): a static, ordered list of
 * runtime ids the engine reads before falling back to the machine default or
 * the single strongest cross-vendor candidate. Split from `contract/index.mjs`,
 * which is already near this repository's 800-line ceiling.
 */
import { requireId } from "./assert.mjs";
import { requireRuntime } from "./runtime.mjs";

/** @typedef {import("./runtime.mjs").ValidatedRuntime} ValidatedRuntime */

/**
 * @param {unknown} value
 * @param {Record<string, ValidatedRuntime>} runtimes
 * @param {string} label
 * @returns {string[]|undefined}
 */
export function validateJudgeList(value, runtimes, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array of runtime ids`);
  value.forEach((id, index) => {
    requireId(id, `${label}[${index}]`);
    requireRuntime(runtimes, id, `${label}[${index}]`);
  });
  if (new Set(value).size !== value.length) throw new TypeError(`${label} must not repeat a runtime id`);
  return /** @type {string[]} */ (value);
}
