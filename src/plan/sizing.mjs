/**
 * Graph sizing: deterministic post-processing of a drafted plan, with no
 * model call. A plan classifies nodes (taskKind, riskTier) and estimates
 * their shape, but only a fixed set of mechanical rules decides how many
 * nodes a run actually gets — merging what has no mechanical proof of its
 * own, merging what another node's write set already covers, splitting a
 * verification too long for one node's budget, marking what is safely
 * parallel, and refusing a graph shaped wrong. Separate from repo-facts.mjs
 * (which only measures) and routing.mjs (which only assigns runtimes): this
 * module only reshapes the node list itself.
 */

import { dirname } from "node:path";

/** @typedef {import("../contract/definition-of-done.mjs").DefinitionOfDoneItem} DefinitionOfDoneItem */

/** @typedef {{argv: string[], cwd?: string, timeoutSec?: number, repeat?: number, env?: string[], measuredMs?: number, flaggedOverBudget?: true}} SizingVerificationCommand */
/** @typedef {{writeFiles?: string[], writeRoots?: string[], verification: SizingVerificationCommand[], [key: string]: unknown}} SizingTaskPacket */
/** @typedef {{id: string, dependsOn?: string[], taskKind?: string, riskTier?: string, taskPacket: SizingTaskPacket, definitionOfDone?: DefinitionOfDoneItem[], parallel?: boolean, [key: string]: unknown}} PlanNode */
/** @typedef {{nodes: PlanNode[], justification?: string, [key: string]: unknown}} Plan */
/** @typedef {{path: string, covers: string|null}} SizingTestFileEntry */
/** @typedef {{testFiles?: SizingTestFileEntry[]}} SizingFacts */
/** @typedef {{nodeBudgetMs: number, targetedFix?: boolean, facts?: SizingFacts, minWriteFiles?: number, maxMergedWriteFiles?: number, turnCeiling?: number}} SizingOptions */
/** @typedef {{rule: string, nodes: string[], detail: string}} SizingTransformation */
/** @typedef {{plan: Plan, transformations: SizingTransformation[], estimate: {nodes: number, overheadMinutes: number}}} SizingResult */

/** The dependency-chain depth past which a plan needs `plan.justification`. */
const DEPTH_CEILING = 8;

/**
 * Floor for a node's write set, applied when the caller asks (the pipeline
 * does). measured 2026-09-20 over 100 stored claude worker nodes: cost per
 * turn barely moves with the write set (rank correlation 0.05; a median of
 * 44 requests at 2-3 files against 56 at 7 or more), each node pays about
 * 14.5 minutes of verification, judge and integration outside its worker
 * turn, and cost per delivered write file was lowest at 4-6 files (0.10M
 * input-equivalent tokens per file, against 0.22M at 2-3).
 */
export const MIN_WRITE_FILES = 4;
/** Ceiling for a merged write set: above it cost per delivered node doubled (1.52M-eq at 7+ files against 0.65M-eq at 4-6). */
const MAX_MERGED_WRITE_FILES = 6;
/** Non-worker wall clock one node costs the run, in minutes: verification and candidate 6.3, judge 1.8, integration 6.4 (medians, 2026-09-20). */
const NODE_OVERHEAD_MINUTES = 14.5;

/**
 * @param {Plan} plan
 * @param {SizingOptions} options
 * @returns {SizingResult}
 */
export function applySizingRules(plan, options) {
  const nodeBudgetMs = options.nodeBudgetMs;
  const targetedFix = options.targetedFix === true;
  const facts = options.facts ?? {};
  /** @type {SizingTransformation[]} */
  const transformations = [];

  let nodes = structuredClone(plan.nodes);

  nodes = mergeNoMechanicalProof(nodes, transformations);
  nodes = mergeContainedWriteSet(nodes, transformations);
  nodes = mergeUnderfilledSiblings(nodes, options.minWriteFiles ?? null, options.maxMergedWriteFiles ?? MAX_MERGED_WRITE_FILES, transformations);
  nodes = splitOverBudgetVerification(nodes, nodeBudgetMs, facts, transformations);
  nodes = markParallelisable(nodes, transformations);
  nodes = flagOverTurnCeiling(nodes, options.turnCeiling ?? null, transformations);

  if (nodes.length === 1 && !targetedFix) {
    throw new Error(`sizing_single_node_plan: node ${nodes[0].id} is the plan's only node; pass options.targetedFix to allow a single-node plan`);
  }

  const depth = longestChainDepth(nodes);
  if (depth > DEPTH_CEILING && !plan.justification) {
    throw new Error(`sizing_depth_exceeds_ceiling: dependency chain depth ${depth} exceeds ${DEPTH_CEILING} and plan.justification is required`);
  }

  return {
    plan: { ...plan, nodes },
    transformations,
    // What the node count costs the run before any worker turn: the number a
    // plan reader needs to weigh one more split against.
    estimate: { nodes: nodes.length, overheadMinutes: nodes.length * NODE_OVERHEAD_MINUTES },
  };
}

/**
 * Whether a node's Definition of Done carries at least one mechanical proof
 * (`command`, `path`, or `verification`). A `judgment: true` item, or no
 * items at all, is not one.
 *
 * @param {PlanNode} node
 * @returns {boolean}
 */
function hasMechanicalProof(node) {
  return (node.definitionOfDone ?? []).some((item) => item.proof !== undefined);
}

/**
 * @param {PlanNode} node
 * @returns {string[]}
 */
function writeFilesOf(node) {
  return node.taskPacket.writeFiles ?? [];
}

/**
 * Whether every path in `subset` is also in `superset`, and `subset` is
 * non-empty (an empty write set contains nothing worth merging on).
 *
 * @param {string[]} subset
 * @param {string[]} superset
 * @returns {boolean}
 */
function isNonEmptySubsetOf(subset, superset) {
  return subset.length > 0 && subset.every((path) => superset.includes(path));
}

/**
 * The first node, by declaration order, whose writeFiles is a non-empty
 * superset of `node`'s.
 *
 * @param {PlanNode} node
 * @param {PlanNode[]} nodes
 * @returns {PlanNode|undefined}
 */
function findContainingNode(node, nodes) {
  return nodes.find((candidate) => candidate.id !== node.id && isNonEmptySubsetOf(writeFilesOf(node), writeFilesOf(candidate)));
}

/**
 * Fold `child` into `parent` in place: writeFiles, readFiles, verification and
 * definitionOfDone are unioned (deduplicated), the child's objective is
 * appended to the parent's, and every other node's
 * dependsOn is rewritten to point at `parent` instead of `child`, with the
 * self-reference this can create dropped. `parent`'s own dependsOn is unioned
 * with `child`'s too, and both a self-reference and a reference to the
 * now-deleted `child` are dropped from it (the child is a plain member of
 * that list, not rewritten, whenever `parent` was the one depending on it).
 *
 * @param {PlanNode[]} nodes
 * @param {PlanNode} child
 * @param {PlanNode} parent
 * @returns {PlanNode[]}
 */
function foldNodeInto(nodes, child, parent) {
  parent.taskPacket.writeFiles = dedupe([...(parent.taskPacket.writeFiles ?? []), ...(child.taskPacket.writeFiles ?? [])]);
  const parentReads = Array.isArray(parent.taskPacket.readFiles) ? /** @type {string[]} */ (parent.taskPacket.readFiles) : null;
  const childReads = Array.isArray(child.taskPacket.readFiles) ? /** @type {string[]} */ (child.taskPacket.readFiles) : [];
  if (parentReads !== null || childReads.length > 0) parent.taskPacket.readFiles = dedupe([...(parentReads ?? []), ...childReads]);
  // The merged node inherits the importers either node had acknowledged and
  // the turns both expected. Found 2026-09-21 in review with the
  // state-location session: a fold that kept only the parent's
  // acknowledgements sent the merged node to scope closure without the
  // child's, so it failed for the fold rather than for the work, and the
  // over-cap flag read one node's expectation for two nodes' worth of work.
  const parentAcks = Array.isArray(parent.taskPacket.scopeAcknowledged) ? /** @type {string[]} */ (parent.taskPacket.scopeAcknowledged) : [];
  const childAcks = Array.isArray(child.taskPacket.scopeAcknowledged) ? /** @type {string[]} */ (child.taskPacket.scopeAcknowledged) : [];
  if (parentAcks.length > 0 || childAcks.length > 0) parent.taskPacket.scopeAcknowledged = dedupe([...parentAcks, ...childAcks]);
  const parentTurns = typeof parent.expectedTurns === "number" ? parent.expectedTurns : null;
  const childTurns = typeof child.expectedTurns === "number" ? child.expectedTurns : null;
  if (parentTurns !== null || childTurns !== null) parent.expectedTurns = (parentTurns ?? 0) + (childTurns ?? 0);
  if (typeof parent.objective === "string" && typeof child.objective === "string" && child.objective !== parent.objective) {
    parent.objective = `${parent.objective} Also: ${child.objective}`;
  }
  parent.taskPacket.verification = dedupeVerification([...parent.taskPacket.verification, ...child.taskPacket.verification]);
  parent.definitionOfDone = dedupeById([...(parent.definitionOfDone ?? []), ...(child.definitionOfDone ?? [])]);
  parent.dependsOn = dedupe([...(parent.dependsOn ?? []), ...(child.dependsOn ?? [])]).filter((id) => id !== parent.id && id !== child.id);
  return nodes
    .filter((node) => node.id !== child.id)
    .map((node) => (node.id === parent.id ? parent : {
      ...node,
      dependsOn: (node.dependsOn ?? []).map((id) => (id === child.id ? parent.id : id)).filter((id, index, array) => array.indexOf(id) === index && id !== node.id),
    }));
}

/** @param {string[]} values @returns {string[]} */
function dedupe(values) {
  return [...new Set(values)];
}

/** @param {DefinitionOfDoneItem[]} items @returns {DefinitionOfDoneItem[]} */
function dedupeById(items) {
  const byId = new Map();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

/** @param {SizingVerificationCommand[]} commands @returns {SizingVerificationCommand[]} */
function dedupeVerification(commands) {
  const seen = new Map();
  for (const command of commands) {
    const key = command.argv.join("\u0000");
    if (!seen.has(key)) seen.set(key, command);
  }
  return [...seen.values()];
}

/**
 * A node whose Definition of Done has no mechanical proof merges into the
 * dependency it names first, or — when it names none — into the first node
 * whose writeFiles already contains its own. Runs to a fixpoint since one
 * merge can enlarge a parent's writeFiles enough to contain a further node.
 *
 * @param {PlanNode[]} nodes
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function mergeNoMechanicalProof(nodes, transformations) {
  let current = nodes;
  // A node with no reachable parent (no resolvable dependsOn and no
  // containing node) is skipped rather than aborting the whole rule, so a
  // later, mergeable node is still folded.
  const skip = new Set();
  for (;;) {
    const child = current.find((node) => !skip.has(node.id) && !hasMechanicalProof(node));
    if (!child) break;
    const byId = new Map(current.map((node) => [node.id, node]));
    const parent = (child.dependsOn ?? []).map((id) => byId.get(id)).find((node) => node !== undefined)
      ?? findContainingNode(child, current);
    if (!parent) {
      skip.add(child.id);
      continue;
    }
    transformations.push({
      rule: "no-mechanical-proof-merge",
      nodes: [child.id, parent.id],
      detail: `${child.id} has no mechanical Definition of Done proof; merged into ${parent.id}`,
    });
    current = foldNodeInto(current, child, parent);
  }
  return current;
}

/**
 * A node whose writeFiles is a non-empty subset of another node's, and which
 * declares no verification of its own, merges into that other node.
 *
 * @param {PlanNode[]} nodes
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function mergeContainedWriteSet(nodes, transformations) {
  let current = nodes;
  for (;;) {
    const child = current.find((node) => node.taskPacket.verification.length === 0 && findContainingNode(node, current));
    if (!child) break;
    const parent = /** @type {PlanNode} */ (findContainingNode(child, current));
    transformations.push({
      rule: "contained-write-set-merge",
      nodes: [child.id, parent.id],
      detail: `${child.id}'s writeFiles is contained in ${parent.id}'s and it declares no verification; merged into ${parent.id}`,
    });
    current = foldNodeInto(current, child, parent);
  }
  return current;
}

/**
 * Two siblings under the write-set floor, in the same directory, alike in
 * taskKind and riskTier, with no dependency path between them and a union
 * under the merged ceiling, become one node: the later folds into the
 * earlier. Inactive unless the caller sets `minWriteFiles`. Runs to a
 * fixpoint, so a merged node still under the floor may take a third.
 *
 * @param {PlanNode[]} nodes
 * @param {number|null} minWriteFiles
 * @param {number} ceiling
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function mergeUnderfilledSiblings(nodes, minWriteFiles, ceiling, transformations) {
  if (minWriteFiles === null) return nodes;
  let current = nodes;
  for (;;) {
    let folded = false;
    for (const child of current) {
      if (!isUnderfilled(child, minWriteFiles)) continue;
      const parent = current.slice(0, current.indexOf(child)).find((candidate) => isUnderfilled(candidate, minWriteFiles)
        && candidate.taskKind === child.taskKind && candidate.riskTier === child.riskTier
        && sharesDirectory(candidate, child)
        && dedupe([...writeFilesOf(candidate), ...writeFilesOf(child)]).length <= ceiling
        && !dependencyRelated(candidate, child, current));
      if (!parent) continue;
      transformations.push({
        rule: "underfilled-sibling-merge",
        nodes: [child.id, parent.id],
        detail: `${child.id} (${writeFilesOf(child).length} write file(s)) and ${parent.id} (${writeFilesOf(parent).length}) are both under the ${minWriteFiles}-file floor, in the same directory, with no dependency between them; merged into ${parent.id}`,
      });
      current = foldNodeInto(current, child, parent);
      folded = true;
      break;
    }
    if (!folded) break;
  }
  return current;
}

/** @param {PlanNode} node @param {number} minWriteFiles @returns {boolean} */
function isUnderfilled(node, minWriteFiles) {
  const count = writeFilesOf(node).length;
  return count > 0 && count < minWriteFiles;
}

/** @param {PlanNode} left @param {PlanNode} right @returns {boolean} whether a write file of each sits in the same directory */
function sharesDirectory(left, right) {
  const directories = new Set(writeFilesOf(left).map((path) => dirname(path)));
  return writeFilesOf(right).some((path) => directories.has(dirname(path)));
}

/**
 * Whether one node reaches the other through dependsOn, in either direction.
 *
 * @param {PlanNode} left
 * @param {PlanNode} right
 * @param {PlanNode[]} nodes
 * @returns {boolean}
 */
function dependencyRelated(left, right, nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  /** @param {string} from @param {string} to @returns {boolean} */
  const reaches = (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
      const id = /** @type {string} */ (stack.pop());
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  return reaches(left.id, right.id) || reaches(right.id, left.id);
}

/**
 * A node the drafter expects to need more provider requests than one attempt
 * is allowed is flagged, once, for the operator to split: the run would cut
 * it at the cap and retry it, and a plan that knows this before launch is
 * cheaper than a run that learns it.
 *
 * @param {PlanNode[]} nodes
 * @param {number|null} ceiling
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function flagOverTurnCeiling(nodes, ceiling, transformations) {
  if (ceiling === null) return nodes;
  return nodes.map((node) => {
    const expected = node.expectedTurns;
    if (typeof expected !== "number" || expected <= ceiling || node.flaggedOverTurnCeiling === true) return node;
    transformations.push({
      rule: "over-turn-ceiling",
      nodes: [node.id],
      detail: `${node.id} expects ${expected} provider requests, above the ${ceiling}-request attempt cap; split it before launch or the run will cut it at the cap and retry it once`,
    });
    return { ...node, flaggedOverTurnCeiling: true };
  });
}

/**
 * A verification command whose measured duration exceeds the node budget is
 * replaced by the per-test-file candidates the repo facts say cover this
 * node's writeFiles; with no covering test file, the command is flagged in
 * place instead (a repeat pass never re-flags an already-flagged command, nor
 * re-splits a command that no longer carries a measured duration).
 *
 * @param {PlanNode[]} nodes
 * @param {number} nodeBudgetMs
 * @param {SizingFacts} facts
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function splitOverBudgetVerification(nodes, nodeBudgetMs, facts, transformations) {
  const testFiles = facts.testFiles ?? [];
  return nodes.map((node) => {
    const writeFiles = writeFilesOf(node);
    /** @type {SizingVerificationCommand[]} */
    const verification = [];
    let changed = false;
    for (const command of node.taskPacket.verification) {
      const overBudget = command.measuredMs !== undefined && command.measuredMs > nodeBudgetMs && command.flaggedOverBudget !== true;
      if (!overBudget) {
        verification.push(command);
        continue;
      }
      const candidates = dedupe(testFiles.filter((file) => file.covers !== null && writeFiles.includes(file.covers)).map((file) => file.path));
      if (candidates.length > 0) {
        transformations.push({
          rule: "over-budget-verification-split",
          nodes: [node.id],
          detail: `${command.argv.join(" ")} measured ${command.measuredMs}ms over the ${nodeBudgetMs}ms budget; replaced with ${candidates.join(", ")}`,
        });
        changed = true;
        for (const path of candidates) verification.push({ argv: ["node", "--test", path] });
      } else {
        transformations.push({
          rule: "over-budget-verification-flagged",
          nodes: [node.id],
          detail: `${command.argv.join(" ")} measured ${command.measuredMs}ms over the ${nodeBudgetMs}ms budget; no repo-facts test file covers this node's writeFiles`,
        });
        changed = true;
        verification.push({ ...command, flaggedOverBudget: true });
      }
    }
    return changed ? { ...node, taskPacket: { ...node.taskPacket, verification } } : node;
  });
}

/**
 * A node with no dependsOn, that no other node depends on, and whose
 * writeFiles shares nothing with any other node's, may run in parallel with
 * the rest of the plan.
 *
 * @param {PlanNode[]} nodes
 * @param {SizingTransformation[]} transformations
 * @returns {PlanNode[]}
 */
function markParallelisable(nodes, transformations) {
  const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn ?? []));
  return nodes.map((node) => {
    if (node.parallel === true) return node;
    const isDependencyFree = (node.dependsOn ?? []).length === 0 && !dependedOn.has(node.id);
    if (!isDependencyFree) return node;
    const writeFiles = writeFilesOf(node);
    const isDisjoint = nodes.every((other) => other.id === node.id || !writeFilesOf(other).some((path) => writeFiles.includes(path)));
    if (!isDisjoint) return node;
    transformations.push({
      rule: "parallelisable",
      nodes: [node.id],
      detail: `${node.id} has no dependency relation and disjoint writeFiles; marked parallel`,
    });
    return { ...node, parallel: true };
  });
}

/**
 * Ceiling on the concurrency a frozen plan may declare. Not a measurement: no
 * one has measured how many concurrent workers this or any host survives, and
 * the only evidence on hand is the wrong direction — three OOM kills on the
 * planning host on 2026-09-21. So the ceiling is the largest value a contract
 * in this repository's own record has ever run with: of the 58 stored
 * contracts, 44 ran at 1 and 14 at 2, none higher. Raise it when someone
 * measures a host surviving more, not before.
 */
const MAX_PROVEN_PARALLELISM = 2;

/**
 * How many nodes a sized plan may have in flight at once: the nodes
 * `markParallelisable` marked, floored at 1 and capped at
 * `MAX_PROVEN_PARALLELISM`. The mark is transitive by construction — a marked
 * node depends on nothing, nothing depends on it, and its writeFiles is
 * disjoint from *every* other node's, so any two marked nodes are independent
 * of each other too and can all run together. The count is therefore the
 * concurrency sizing proved the plan has work for: above it a slot only ever
 * idles, and a plan with one marked node, or none, is 1 — the serial number a
 * contract carries when it says nothing.
 *
 * `parallel` is a node-level mark and no contract node accepts it, so this
 * number is the only way sizing's conclusion survives into a frozen contract
 * (as `maxParallel`).
 *
 * @param {Plan} plan
 * @returns {number}
 */
export function provenParallelism(plan) {
  return Math.min(MAX_PROVEN_PARALLELISM, Math.max(1, plan.nodes.filter((node) => node.parallel === true).length));
}

/**
 * The longest dependsOn chain in the graph, counted in nodes. Sizing runs on
 * a model-drafted, not-yet-validated plan, so a dependsOn cycle is possible
 * here; it is refused by name rather than left to overflow the stack.
 *
 * @param {PlanNode[]} nodes
 * @returns {number}
 */
function longestChainDepth(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  /** @type {Map<string, number>} */
  const memo = new Map();
  /** @type {Set<string>} */
  const inProgress = new Set();
  /** @param {string} id @returns {number} */
  const depthOf = (id) => {
    if (memo.has(id)) return /** @type {number} */ (memo.get(id));
    if (inProgress.has(id)) {
      throw new Error(`sizing_dependency_cycle: node ${id} depends on itself through a dependsOn cycle`);
    }
    inProgress.add(id);
    const node = byId.get(id);
    const deps = node?.dependsOn ?? [];
    const depth = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(depthOf));
    inProgress.delete(id);
    memo.set(id, depth);
    return depth;
  };
  return nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => depthOf(node.id)));
}
