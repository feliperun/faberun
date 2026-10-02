/**
 * The patch revise's narrowed context (R4, campaign-efficiency phase 4):
 * what the reviser reads instead of the whole plan, the byte ceiling that
 * context is held to, and the revise's own instruction sentences for it.
 * Separate from `template.mjs` because the planning templates were already
 * at that file's ceiling and this is a second job: `template.mjs` builds the
 * five planning contracts and validates plan output, and this module owns
 * the one stage whose reading narrowed — the findings' nodes, the
 * dependencies those nodes need, and the plan's own declarations, never the
 * whole node list and never the repository facts.
 */
import { stableJson } from "../util.mjs";

/** @typedef {import("./template.mjs").PlanOutputNode} PlanOutputNode */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */

/**
 * The two openings a revise starts from, swapped by `template.mjs`'s
 * `instructionsFor`: the whole plan before the first validated plan (a draft
 * that never validated — the rejected draft is what its findings were raised
 * against), the narrowed context `reviseContextFor` builds once there is a
 * plan to patch (R4).
 */
export const REVISE_OPENING = "Start from the plan JSON in readFiles, the plan the findings were raised against, and return it with only the changes the findings require. Keep every node id, write file, definitionOfDone item and contract-level suite that no finding asks you to change: a revise that redrafts from the findings alone loses what the plan already got right.";
export const REVISE_PATCH_OPENING = "Start from the revise context in readFiles — the nodes your findings name (changedNodes), the dependencies those nodes need (dependencyNodes), and the plan's own declarations — and change only what a finding requires. Keep every node id, write file, definitionOfDone item and contract-level suite that no finding asks you to change: a revise that redrafts from the findings alone loses what the plan already got right.";

/** The patch-mode counterpart of the phase declaration rule: the declarations travel in the context. */
export const REVISE_PATCH_PHASES_INSTRUCTION = "The context carries the plan's phase declarations: when your patch adds or removes a node, carry output.patch.phases with every declaration, updated so the node ids it assigns still cover the plan's nodes exactly once. Every planned node must appear in exactly one phase's nodeIds; a missing, duplicate, or unknown node assignment is refused.";

/** The patch-mode field of the classification rule: the revise returns `output.patch`, not `output.plan`. */
export const REVISE_PATCH_VENDOR_RULE = "Never name a runtime, harness, model, or vendor anywhere in output.patch.";

/**
 * The revise's own selection sentence (R4). The reviser reads no fact set —
 * the plan's readFiles were drawn from it when the plan was drafted — so it
 * keeps the selection instead of selecting again. `FACT_SELECTION_RULE` (in
 * `template.mjs`) stays the drafter's rule; this is the one the revise
 * carries instead, the same narrowing the path-cut rule took.
 */
export const REVISE_FACT_SELECTION_RULE = "Each node's readFiles in the nodes you carry is the selection its drafter already drew from the phase fact set, and the revise context holds no fact set of its own: keep the plan's readFiles unless a finding names the change, and never add a read no node declares and no finding names. The revised plan is held to the same fact set the draft was, so a read the fact set does not hold is refused after the revise that wrote it.";

/**
 * The byte ceiling the patch revise's context is held to: the same 65,536
 * ceiling every planning prompt is measured against (`renderWorkerPrompt`'s
 * guard, and the output ceiling two full-plan revises died at, RM-110),
 * because the context is the revise packet's mandatory fact.
 */
export const REVISE_CONTEXT_BUDGET_BYTES = 65_536;

/**
 * The narrowed context a patch revise reads (R4): the plan's own
 * declarations and the nodes the findings concern with the dependencies
 * those nodes need — never the whole node list. The patch still applies to
 * the full plan the pipeline holds; the reviser only stops reading it,
 * because answering one finding cannot need the phase's other nodes, and
 * reading them is what a revise's context grew to.
 *
 * A finding names its node by id; a finding whose nodeId names no node of
 * the plan (the pipeline's own `nodeId: "plan"` shape) contributes none, so
 * the retry passes the refused attempt's own changed node ids as
 * `extraNodeIds` — a validator message names those by patch index, never by
 * id. Dependencies are the transitive closure of `dependsOn`, in plan order.
 *
 * A context over `REVISE_CONTEXT_BUDGET_BYTES` is refused by name, never
 * truncated to fit and never silently widened back to the whole plan: the
 * same rule `renderWorkerPrompt` applies to a worker packet, applied to the
 * reviser's packet.
 *
 * @param {{nodes: PlanOutputNode[]} & Record<string, unknown>} plan the plan the revise revises
 * @param {PlanFindingOutput[]} findings the findings the revise must resolve
 * @param {string[]} [extraNodeIds] nodes the reviser must see beyond the findings' own
 * @returns {Record<string, unknown>}
 */
export function reviseContextFor(plan, findings, extraNodeIds = []) {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const named = new Set();
  for (const finding of findings) {
    if (byId.has(finding.nodeId)) named.add(finding.nodeId);
  }
  for (const id of extraNodeIds) {
    if (byId.has(id)) named.add(id);
  }
  const dependencies = new Set();
  const queue = [...named];
  for (let index = 0; index < queue.length; index += 1) {
    const node = byId.get(queue[index]);
    for (const id of node?.dependsOn ?? []) {
      if (!byId.has(id) || named.has(id) || dependencies.has(id)) continue;
      dependencies.add(id);
      queue.push(id);
    }
  }
  const context = {
    changedNodes: plan.nodes.filter((node) => named.has(node.id)),
    dependencyNodes: plan.nodes.filter((node) => dependencies.has(node.id)),
    ...(plan.phases === undefined ? {} : { phases: plan.phases }),
    ...(plan.sharedVerification === undefined ? {} : { sharedVerification: plan.sharedVerification }),
    ...(plan.finalVerification === undefined ? {} : { finalVerification: plan.finalVerification }),
    ...(plan.justification === undefined ? {} : { justification: plan.justification }),
  };
  const bytes = Buffer.byteLength(stableJson(context), "utf8");
  if (bytes > REVISE_CONTEXT_BUDGET_BYTES) {
    throw new TypeError(
      `revise_context_over_budget: the revise context is ${bytes - REVISE_CONTEXT_BUDGET_BYTES} bytes over the ${REVISE_CONTEXT_BUDGET_BYTES}-byte budget at ${bytes} total (${context.changedNodes.length} changed node(s), ${context.dependencyNodes.length} dependency node(s)). The context is the revise packet's mandatory fact, so it is refused by name, never truncated to fit and never widened back to the whole plan.`,
    );
  }
  return context;
}
