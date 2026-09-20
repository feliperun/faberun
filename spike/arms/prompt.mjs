/**
 * The one prompt arms B and C receive, and the single paragraph that tells
 * them apart. Pure and exported so a test can hold the campaign to its own
 * claim: the session arms differ only in whether they may delegate.
 */

/** @typedef {import("./corpus.mjs").Requirement} Requirement */

const DELEGATION = [
  "## Delegation",
  "",
  "You have the Agent tool. Delegate each requirement to its own subagent, giving it the requirement's full text, write scope, relevant files and proof command, and launch independent requirements in parallel (several Agent calls in one message). Integrate what the subagents return, resolve any overlap between them, and run every proof yourself before the final message.",
  "",
].join("\n");

/**
 * @param {{arm: "B"|"C", requirements: Requirement[], sha: string}} input
 * @returns {string}
 */
export function sessionPrompt({ arm, requirements, sha }) {
  const count = requirements.length;
  const head = [
    `# Corpus run: ${count} open requirement${count === 1 ? "" : "s"} in one checkout`,
    "",
    `You are working in a checkout of the faberun repository at commit ${sha}. Implement every requirement below in this checkout. Each one has a write scope, a list of files the requirement's author considered relevant, and an acceptance proof: a test that fails now and must pass when the requirement is met. Run a requirement's proof with the command given once you have implemented it.`,
    "",
    "Rules: never edit or delete anything under spike/corpus/provas/ (the proofs are restored from the corpus and run again by the driver after you finish); do not commit; do not run the whole test suite, only the proofs named here and the tests you write. There is no node_modules directory and none is needed: the proofs use node:test alone.",
    "",
    'When every requirement is done, or you cannot finish one, end with exactly one JSON object as your final message and nothing else: {"status":"done","summary":"<one paragraph>","requirements":{"<ID>":"done"|"partial"|"skipped"}}.',
    "",
  ];
  const body = requirements.map((requirement, index) => [
    `## ${index + 1}. ${requirement.id}: ${requirement.titulo}`,
    "",
    requirement.objetivo,
    "",
    `- write scope: ${requirement.escopoEscrita.join(", ")}`,
    `- relevant files: ${requirement.gabarito.join(", ")}`,
    `- proof: ${requirement.comando}`,
    "",
  ].join("\n"));
  return [...head, ...(arm === "C" ? [DELEGATION] : []), ...body].join("\n");
}
