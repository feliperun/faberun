/**
 * Untrusted-field marking (rule 14): a field a model wrote is data, never an
 * instruction. findings.json, a run-event summary and a worker summary are all
 * prose a model produced; a privileged reader -- another model, the judge, a
 * notification client -- that receives them unmarked treats them as the
 * controller's own voice and opens an injection path from the model to the
 * reader.
 *
 * This module never inspects, filters or rewrites the text. Sanitizing prose is
 * a race that cannot be won; saying where the text came from is a true and
 * cheap claim. The text arrives whole, carrying its provenance.
 *
 * The marking is explicit in the value, not a convention about field names: a
 * marked field becomes `{untrusted: true, source, text}`, so a reader can tell
 * prose from a fact without knowing `UNTRUSTED_FIELDS` -- a list that grows
 * every time a new generated field lands, and that no client can be expected to
 * track. Fact fields -- counters, ids, timestamps, cost, an enumerated verdict,
 * a severity -- are never marked, because marking everything marks nothing and
 * sends the reader back to guessing.
 */

/**
 * Field names whose values are generated text. This list is the writer's; a
 * reader must not depend on it, which is exactly why the marked value carries
 * its own provenance instead.
 */
export const UNTRUSTED_FIELDS = Object.freeze([
  "summary",
  "description",
  "evidence",
  "text",
  "unexpectedPaths",
]);

/**
 * Return a copy of `payload` with every generated-text field replaced by an
 * explicit `{untrusted: true, source, text}` marker. Arrays and nested objects
 * are walked, so a judge finding's `description` and `evidence` are marked
 * where they sit; fact fields and command lists are copied through untouched.
 * The input is never mutated, and an already-marked value is left alone.
 *
 * @param {unknown} payload
 * @param {string} [source] Where the prose came from ("worker", "judge", ...).
 * @returns {unknown}
 */
export function markUntrusted(payload, source = "model") {
  return markUntrustedValue(payload, source);
}

/**
 * @param {unknown} value
 * @param {string} source
 * @returns {unknown}
 */
function markUntrustedValue(value, source) {
  if (Array.isArray(value)) return value.map((item) => markUntrustedValue(item, source));
  if (value === null || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const marked = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    marked[key] = UNTRUSTED_FIELDS.includes(key) ? markUntrustedField(item, source) : markUntrustedValue(item, source);
  }
  return marked;
}

/**
 * @param {unknown} value
 * @param {string} source
 * @returns {unknown}
 */
function markUntrustedField(value, source) {
  if (typeof value === "string") return { untrusted: true, source, text: value };
  if (Array.isArray(value)) return value.map((item) => markUntrustedField(item, source));
  return value;
}
