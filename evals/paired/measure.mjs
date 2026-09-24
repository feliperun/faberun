/**
 * The measurement loop: for each repetition, the declared arms run back to
 * back in an order shuffled by the recorded seed, and every run reserves its
 * dollar estimate through the shared budget before it may start. Ported from
 * `spike/arms/measure.mjs`; the ledger is the run list this returns, because
 * the class report is the durable record now. Why separate: the class entry
 * owns what an arm is declared to be, and this owns the order and the spend.
 */
import { seededShuffle } from "./lib.mjs";
import { runFaberunArm } from "./arm-faberun.mjs";
import { runSessionArm } from "./arm-session.mjs";
import { runReplayArm } from "./replay.mjs";

/** @typedef {import("./contract.mjs").PairedArm} PairedArm */
/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */
/** @typedef {import("../budget.mjs").StochasticBudget} StochasticBudget */
/** @typedef {Record<string, unknown>} JsonObject */

/**
 * The dollar estimate one arm's invocation reserves before it may start. A
 * declared `estimateUsd` wins; a replay arm reserves its own worst declared
 * run; a real arm without a declaration reserves a round figure so an
 * unmeasured arm cannot start for free.
 *
 * @param {PairedArm} arm
 * @returns {number}
 */
function estimateOf(arm) {
  if (typeof arm.estimateUsd === "number" && Number.isFinite(arm.estimateUsd)) return arm.estimateUsd;
  const config = /** @type {JsonObject} */ (arm.config ?? {});
  const runs = Array.isArray(config.runs) ? config.runs : [config];
  const declared = /** @type {number[]} */ (runs
    .map((run) => /** @type {JsonObject} */ (run ?? {}).costUsd)
    .filter((value) => typeof value === "number" && Number.isFinite(value)));
  if (declared.length > 0) return Math.max(...declared);
  return 5;
}

/**
 * @param {PairedArm} arm
 * @param {{label: string, repetition: number, corpus: CorpusSet, replayRoot?: string}} context
 * @returns {Promise<JsonObject>}
 */
async function runArm(arm, context) {
  if (arm.runner === "replay") return runReplayArm({ arm, repetition: context.repetition, corpus: context.corpus, root: context.replayRoot });
  if (arm.runner === "faberun") return runFaberunArm({ label: context.label, repetition: context.repetition, corpus: context.corpus, arm });
  if (arm.runner === "session") return runSessionArm({ arm, label: context.label, repetition: context.repetition, corpus: context.corpus });
  throw new Error(`arm ${arm.name} declares unknown runner ${arm.runner}`);
}

/**
 * Run every arm of every repetition under the budget. A run that throws is
 * recorded as an error and its reservation is voided; the arm that cannot fit
 * the remaining allowance stops the loop rather than starting for free.
 *
 * @param {{arms: PairedArm[], corpus: CorpusSet, budget: StochasticBudget, seed: number, repeat: number, label: string, replayRoot?: string, concurrency?: number}} input
 * @returns {Promise<{runs: JsonObject[], skipped: JsonObject[]}>}
 */
export async function measureArms({ arms, corpus, budget, seed, repeat, label, replayRoot, concurrency = 1 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency needs a positive integer");
  /** @type {{order: number, run: JsonObject}[]} */
  const ordered = [];
  /** @type {JsonObject[]} */
  const skipped = [];
  let exhausted = false;
  // Arms are independent runs in their own checkouts, so up to `concurrency`
  // run at once; each is reserved against the budget before it starts. The
  // cost is named, not hidden: parallel arms share the machine and the
  // providers, so a wall-clock band measured this way is not comparable to a
  // serial one, and the provenance says which it was.
  /** @type {{arm: PairedArm, repetition: number}[]} */
  const queue = [];
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    for (const arm of seededShuffle(arms, seed + repetition)) queue.push({ arm, repetition });
  }
  let next = 0;
  const lane = async () => {
    while (!exhausted && next < queue.length) {
      const order = next;
      next += 1;
      const { arm, repetition } = queue[order];
      const reservation = budget.startInvocation(/** @type {any} */ (arm.runtime) ?? arm.name, estimateOf(arm));
      if (reservation === null) {
        skipped.push({ arm: arm.name, repetition, reason: "budget" });
        exhausted = true;
        return;
      }
      try {
        const record = await runArm(arm, { label, repetition, corpus, replayRoot });
        const settlement = /** @type {{usage?: import("../../src/contract/index.mjs").Usage, costUsd?: number|null, costProvenance?: "unknown"|"priced", observedCostUsd?: number|null}} */ (record.costProvenance === "unknown"
          ? {
            costUsd: typeof record.budgetCostUsd === "number" ? record.budgetCostUsd : null,
            costProvenance: "unknown",
            observedCostUsd: typeof record.observedCostUsd === "number" ? record.observedCostUsd : null,
          }
          : (typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}));
        budget.completeInvocation(reservation, settlement);
        ordered.push({ order, run: { ...record, runner: arm.runner, model: arm.model } });
        if (budget.result().overrunUsd > 0) exhausted = true;
      } catch (error) {
        budget.voidInvocation(reservation);
        ordered.push({ order, run: { arm: arm.name, label, runner: arm.runner, model: arm.model, repetition, error: error instanceof Error ? error.message : String(error), scope: { outOfScope: [] } } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, lane));
  const runs = ordered.sort((a, b) => a.order - b.order).map((entry) => entry.run);
  return { runs, skipped };
}
