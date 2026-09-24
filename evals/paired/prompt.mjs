/**
 * The one prompt the session arms receive, and the single paragraph that
 * tells B and C apart. Every requirement is rendered from the same packet a
 * faberun node gets -- objective, instructions, symbols, decisions,
 * non-goals, read and write files, verification -- in dependency order. Ported
 * from `spike/arms/prompt.mjs` and exported so a test can hold the campaign to
 * its own claim: the session arms differ only in whether they may delegate.
 */
import { topologicalOrder } from "./corpus.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

const DELEGATION = [
  "## Delegation",
  "",
  "You have the Agent tool. Delegate each requirement to its own subagent, giving it the requirement's full text, write scope, relevant files and verification commands. Respect the dependencies: launch a requirement only after every requirement it depends on is done and integrated, and launch independent requirements in parallel (several Agent calls in one message). Integrate what the subagents return, resolve any overlap between them, and run every verification yourself before the final message.",
  "",
].join("\n");

/**
 * @param {{arm: "B"|"C", corpus: CorpusSet, sha: string}} input
 * @returns {string}
 */
export function sessionPrompt({ arm, corpus, sha }) {
  const ordered = topologicalOrder(corpus.requirements);
  const count = ordered.length;
  const dependent = ordered.some((requirement) => requirement.dependsOn.length > 0);
  const visibleProofs = corpus.restore.map((item) => item.path).filter(Boolean);
  const head = [
    `# Corpus run: ${count} requirement${count === 1 ? "" : "s"} in one checkout`,
    "",
    `You are working in a checkout of the faberun repository at commit ${sha}. Implement every requirement below in this checkout. Each one is a closed packet: an objective, instructions, the symbols it introduces, decisions already made, non-goals, the files its author considered relevant, its write scope, and the verification commands that prove it. Run a requirement's verification once you have implemented it.`,
    "",
    dependent
      ? "The requirements depend on one another and are listed in dependency order: a requirement that depends on another must be done on top of the other's result, not in parallel with it. Independent requirements may be done in any order."
      : "The requirements are independent of one another and may be done in any order.",
    "",
    corpus.npmCi
      ? "node_modules is installed in this checkout (npm ci), so the typecheck and test commands below run as written."
      : "There is no node_modules directory and none is needed: the proofs use node:test alone.",
    "",
    corpus.visibleProofs && visibleProofs.length
      ? `Rules: never edit or delete anything under a corpus acceptance file (${visibleProofs.join(", ")}); the driver restores it from the corpus and runs it again after you finish. Do not commit; do not run the whole test suite, only the proofs named here and the tests you write.`
      : `Rules: do not commit; do not run the whole test suite, only the verification named here and the tests you write. After you finish, the driver runs its own acceptance on your tree, with its own copy of any test file it owns.`,
    "",
    'When every requirement is done, or you cannot finish one, end with exactly one JSON object as your final message and nothing else: {"status":"done","summary":"<one paragraph>","requirements":{"<ID>":"done"|"partial"|"skipped"}}.',
    "",
  ];
  const body = ordered.map((requirement, index) => [
    `## ${index + 1}. ${requirement.id}: ${requirement.title}`,
    "",
    requirement.objective,
    "",
    ...(requirement.dependsOn.length ? [`Depends on: ${requirement.dependsOn.join(", ")}.`, ""] : []),
    "### Instructions",
    "",
    ...requirement.instructions.map((instruction, position) => `${position + 1}. ${instruction}`),
    "",
    ...(requirement.symbols.length ? [`- symbols this requirement introduces: ${requirement.symbols.join(", ")}`] : []),
    ...(requirement.decisions.length ? ["- decisions already made:", ...requirement.decisions.map((decision) => `  - ${decision}`)] : []),
    ...(requirement.nonGoals.length ? ["- non-goals:", ...requirement.nonGoals.map((nonGoal) => `  - ${nonGoal}`)] : []),
    `- relevant files: ${requirement.readFiles.join(", ")}`,
    `- write scope: ${requirement.writeFiles.join(", ")}`,
    `- verification: ${requirement.verification.map((command) => command.argv.map((part, position) => (position === 0 ? "node" : part)).join(" ")).join("; ")}`,
    "",
  ].join("\n"));
  return [...head, ...(arm === "C" ? [DELEGATION] : []), ...body].join("\n");
}
