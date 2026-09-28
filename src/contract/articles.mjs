/**
 * The reserved constitution articles: the common law this repository writes
 * and no contract may overwrite. Separate from index.mjs because the list is
 * data other layers (tests, future article tooling) read without pulling in
 * the whole validator.
 */
export const RESERVED_ARTICLES = [
  "references/rules.md",
  "references/engineering.md",
  "references/workflow.md",
  "references/handoffs.md",
];

/**
 * The decisions that belong to the repository owner alone, never to a worker
 * or a judge. Both prompts read this one list: the worker refuses an uncovered
 * decision with `blocked_context` instead of choosing it, and the judge fails a
 * diff that takes one. Kept here beside the reserved articles because it is the
 * same kind of data -- a boundary no contract may cross -- and every layer that
 * needs it can read it without pulling in the validator.
 */
export const RESERVED_OWNER_DECISIONS = [
  "license",
  "pricing",
  "branding",
  "publication",
  "third-party data",
];

/**
 * The reserved owner decisions a packet's `decisions` does not cover. Coverage
 * is textual on purpose: a packet covers one by naming it in a decision
 * (`license: MIT`, `pricing lives in the billing service`), and case does not
 * matter.
 *
 * @param {string[]} decisions
 * @returns {string[]}
 */
export function uncoveredReservedOwnerDecisions(decisions) {
  const covered = (decisions ?? []).join("\n").toLowerCase();
  return RESERVED_OWNER_DECISIONS.filter((decision) => !covered.includes(decision));
}
