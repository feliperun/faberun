/**
 * The hard allowance shared by model-backed eval classes, kept separate from
 * the runner so every stochastic class reserves and settles spend identically.
 */
import { priceUsage } from "../src/run/usage.mjs";

/** @typedef {{inputTokens?: number|null, cacheReadInputTokens?: number|null, outputTokens?: number|null}} UsageRecord */
/** @typedef {{id?: string, model?: string, pricing?: {inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number}}} Runtime */
/** @typedef {{runtime: Runtime|string, estimateUsd: number, startedAt: string}} Reservation */

/**
 * A missing budget is a startup error rather than an unlimited allowance.
 * Estimates are reserved before launch, so concurrent invocations cannot
 * collectively cross the declared cap.
 */
export class StochasticBudget {
  /**
   * @param {{argv?: string[], budgetUsd?: number, highestObservedUsd?: Record<string, number>|Map<string, number>}|string[]} [options]
   */
  constructor(options = {}) {
    const settings = Array.isArray(options) ? {} : options;
    const argv = Array.isArray(options) ? options : (settings.argv ?? process.argv.slice(2));
    const flagBudget = budgetFromArgs(argv);
    const budgetUsd = settings.budgetUsd ?? flagBudget;
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
      throw new Error("stochastic evals require --budget-usd <non-negative number>");
    }
    this.budgetUsd = budgetUsd;
    this.spendUsd = 0;
    this.pricedSpendUsd = 0;
    this.unknownSpendUsd = 0;
    this.voidedSpendUsd = 0;
    this.voidedInvocations = 0;
    /** @type {Map<string, number>} */
    this.highestObservedUsd = new Map(
      settings.highestObservedUsd instanceof Map
        ? settings.highestObservedUsd
        : Object.entries(settings.highestObservedUsd ?? {}).filter(([, value]) => finiteNonNegative(value)),
    );
    /** @type {Set<Reservation>} */
    this.inFlight = new Set();
  }

  /** @returns {number} */
  get reservedUsd() {
    let total = 0;
    for (const reservation of this.inFlight.keys()) total += reservation.estimateUsd;
    return total;
  }

  /**
   * Reserve an invocation before launching it. `null` is the stop signal when
   * priced spend plus all existing reservations reaches the allowance.
   *
   * @param {Runtime|string} runtime
   * @param {number|{usage?: UsageRecord, estimateUsd?: number}} estimate
   * @returns {Reservation|null}
   */
  startInvocation(runtime, estimate) {
    const estimateUsd = estimateFor(runtime, estimate, this.highestObservedUsd);
    if (estimateUsd === null) throw new Error("each invocation needs a finite dollar estimate");
    // Voided work has already consumed provider capacity and therefore still
    // consumes the hard allowance, even though it is reported separately.
    if (this.spendUsd + this.voidedSpendUsd + this.reservedUsd + estimateUsd >= this.budgetUsd) return null;
    const reservation = { runtime, estimateUsd, startedAt: new Date().toISOString() };
    this.inFlight.add(reservation);
    return reservation;
  }

  /**
   * Settle a completed invocation from a fabricated or provider usage record.
   * Unknown usage uses the greatest observed cost for this runtime, falling
   * back to its reservation so an unknown invocation is never treated as free.
   *
   * @param {Reservation} reservation
   * @param {{usage?: UsageRecord, costUsd?: number|null, costProvenance?: "unknown"|"priced", observedCostUsd?: number|null}} [record]
   * @returns {{costUsd: number, costProvenance: "priced"|"observed-fallback"}}
   */
  completeInvocation(reservation, record = {}) {
    const key = runtimeKey(reservation.runtime);
    if (typeof record.observedCostUsd === "number" && finiteNonNegative(record.observedCostUsd)) {
      this.highestObservedUsd.set(key, Math.max(this.highestObservedUsd.get(key) ?? 0, record.observedCostUsd));
    }
    const observed = this.highestObservedUsd.get(key);
    const explicitlyUnknown = record.costProvenance === "unknown";
    const priced = explicitlyUnknown ? null : pricedCost(reservation.runtime, record.usage, record.costUsd);
    const costUsd = explicitlyUnknown && typeof record.costUsd === "number"
      ? record.costUsd
      : priced === null
        ? (observed && observed > 0 ? observed : reservation.estimateUsd)
        : priced;
    if (!Number.isFinite(costUsd) || (priced === null && costUsd <= 0)) throw new Error("unknown invocation cost cannot be recorded as zero");
    this.removeReservation(reservation);
    this.spendUsd += costUsd;
    if (priced === null || explicitlyUnknown) this.unknownSpendUsd += costUsd;
    else {
      this.pricedSpendUsd += costUsd;
      this.highestObservedUsd.set(key, Math.max(this.highestObservedUsd.get(key) ?? 0, costUsd));
    }
    return { costUsd, costProvenance: priced === null || explicitlyUnknown ? "observed-fallback" : "priced" };
  }

  /**
   * Record an invocation discarded or killed after reservation. Its reserved
   * amount is voided and remains visible in the result instead of vanishing.
   *
   * @param {Reservation} reservation
   * @param {{usage?: UsageRecord, costUsd?: number|null, observedCostUsd?: number|null}} [record]
   * @returns {number}
   */
  voidInvocation(reservation, record = {}) {
    const key = runtimeKey(reservation.runtime);
    const priced = pricedCost(reservation.runtime, record.usage, record.costUsd);
    const observed = this.highestObservedUsd.get(key);
    const voidedUsd = priced ?? (observed && observed > 0 ? observed : reservation.estimateUsd);
    if (!Number.isFinite(voidedUsd) || (priced === null && voidedUsd <= 0)) throw new Error("unknown invocation cost cannot be voided as zero");
    this.removeReservation(reservation);
    this.voidedSpendUsd += voidedUsd;
    this.voidedInvocations += 1;
    if (priced !== null) this.highestObservedUsd.set(key, Math.max(observed ?? 0, priced));
    return voidedUsd;
  }

  /** @returns {{budgetUsd: number, spendUsd: number, pricedSpendUsd: number, unknownSpendUsd: number, reservedUsd: number, voidedSpendUsd: number, voidedInvocations: number, overrunUsd: number, highestObservedUsd: Record<string, number>}} */
  result() {
    return {
      budgetUsd: this.budgetUsd,
      spendUsd: this.spendUsd,
      pricedSpendUsd: this.pricedSpendUsd,
      unknownSpendUsd: this.unknownSpendUsd,
      reservedUsd: this.reservedUsd,
      voidedSpendUsd: this.voidedSpendUsd,
      voidedInvocations: this.voidedInvocations,
      overrunUsd: Math.max(0, this.spendUsd + this.voidedSpendUsd - this.budgetUsd),
      highestObservedUsd: Object.fromEntries(this.highestObservedUsd),
    };
  }

  /** @param {Reservation} reservation */
  removeReservation(reservation) {
    if (!this.inFlight.delete(reservation)) throw new Error("invocation reservation is not active");
  }
}

/** @param {string[]} argv @returns {number|undefined} */
function budgetFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argument === "--budget-usd" ? argv[index + 1] : argument.startsWith("--budget-usd=") ? argument.slice("--budget-usd=".length) : undefined;
    if (value !== undefined) {
      if (value === "") throw new Error("--budget-usd needs a value");
      const budgetUsd = Number(value);
      if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("--budget-usd must be a non-negative number");
      return budgetUsd;
    }
  }
  return undefined;
}

/** @param {Runtime|string} runtime @returns {string} */
function runtimeKey(runtime) {
  if (typeof runtime === "string") return runtime;
  return runtime.id ?? runtime.model ?? "unknown-runtime";
}

/**
 * @param {Runtime|string} runtime
 * @param {number|{usage?: UsageRecord, estimateUsd?: number}} estimate
 * @param {Map<string, number>} highestObservedUsd
 * @returns {number|null}
 */
function estimateFor(runtime, estimate, highestObservedUsd) {
  if (typeof estimate === "number") return finiteNonNegative(estimate) ? estimate : null;
  if (typeof estimate.estimateUsd === "number") return finiteNonNegative(estimate.estimateUsd) ? estimate.estimateUsd : null;
  const priced = pricedCost(runtime, estimate.usage, undefined);
  const observed = highestObservedUsd.get(runtimeKey(runtime));
  return priced ?? (observed && observed > 0 ? observed : null);
}

/**
 * @param {Runtime|string} runtime
 * @param {UsageRecord|undefined} usage
 * @param {number|null|undefined} reportedCostUsd
 * @returns {number|null}
 */
function pricedCost(runtime, usage, reportedCostUsd) {
  const canonicalUsage = /** @type {import("../src/contract/index.mjs").Usage|undefined} */ (/** @type {unknown} */ (usage));
  const priced = priceUsage(typeof runtime === "string" ? { model: runtime } : runtime, canonicalUsage, reportedCostUsd);
  return typeof priced.costUsd === "number" && Number.isFinite(priced.costUsd) && priced.costUsd >= 0
    ? priced.costUsd
    : null;
}

/** @param {number} value @returns {boolean} */
function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}
