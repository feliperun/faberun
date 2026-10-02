/**
 * The cause a failure that would fire a repair trigger failed for, drawn from
 * a fixed vocabulary.
 *
 * The reauthor widens a refused packet and its round budget bounds only one
 * invocation; what lets a later trigger refuse to repeat a repair that already
 * ran to no effect is the durable record of which cause fired, on which node,
 * at which artifact version -- the same cause on the same node and artifact
 * version must never fire indefinite calls. The classes are read from the
 * refused packet's own grants: a missing entry granted nowhere is a read gap,
 * one readable but not writable is a write gap, and prose is requirement
 * ambiguity, which no widening repairs and which becomes a durable question
 * instead of another discovery round.
 */

/** The cause vocabulary `classifyFailureCause` draws from. */
export const FAILURE_CAUSE_CLASSES = ["missing_read_scope", "missing_write_scope", "ambiguous_requirement", "unclassified"];

/** One classified failure: the key a repair trigger is recorded under. */
/** @typedef {{cause: string, node: string, artifactVersion: string|null}} FailureCause */

/**
 * A missing-context entry naming a path rather than prose: a path separator,
 * or an extension at the end. `src/extra.mjs` and `README.md` are paths;
 * "clearer acceptance criteria" is not.
 */
const PATH_LIKE = /[/\\]|\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Classify the failure of a node a reauthor would fire on -- a packet refused
 * on `context_missing`. Ambiguity dominates, then read gaps: a discovery pass
 * that cannot settle what is being asked cannot spend its budget usefully. A
 * refusal naming nothing classifiable is recorded as `unclassified`, never
 * dropped.
 *
 * @param {import("../contract/index.mjs").ValidatedNode} node
 * @param {import("../contract/index.mjs").NodeSnapshot} state
 * @returns {FailureCause}
 */
export function classifyFailureCause(node, state) {
  const refused = /** @type {{missingContext?: string[]}|null|undefined} */ (state.result);
  const missingContext = Array.isArray(refused?.missingContext) ? refused.missingContext : [];
  const artifactVersion = state.packetHash ?? null;
  if (missingContext.length === 0) return { cause: "unclassified", node: node.id, artifactVersion };
  const read = new Set(node.taskPacket.readFiles ?? []);
  const write = new Set(node.taskPacket.writeFiles ?? []);
  let ambiguous = false;
  let readGap = false;
  let writeGap = false;
  for (const entry of missingContext) {
    if (typeof entry !== "string" || !PATH_LIKE.test(entry)) ambiguous = true;
    else if (!read.has(entry) && !write.has(entry)) readGap = true;
    else if (!write.has(entry)) writeGap = true;
  }
  let cause = "missing_read_scope";
  if (writeGap && !readGap) cause = "missing_write_scope";
  if (ambiguous) cause = "ambiguous_requirement";
  return { cause, node: node.id, artifactVersion };
}
