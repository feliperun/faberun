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
