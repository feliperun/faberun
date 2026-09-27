/**
 * The durable store of live-preflight verdicts: which providers answered the
 * dispatch gate's hello, and when.
 *
 * The gate's verdicts used to live only in a run's own env-preflight.json and
 * died with the run, so every launch paid the ask again -- measured
 * 2026-09-22 at about 18s for four runtimes in parallel. This store is the
 * home that outlives the launch, and it is keyed on the provider -- harness,
 * model and the executable actually resolved -- never on a contract's local
 * runtime id: whether `codex` answers is a fact about this machine and this
 * operator, so two contracts naming the same provider share one answer and
 * one provider reached under two local names stays one record.
 *
 * A record is the catalogue's own RuntimeAvailability shape, so reuse is
 * decided by `isRuntimeAvailable` -- the one home of the freshness rule --
 * and the window a record names (`PREFLIGHT_WINDOW`) is the hello's own
 * clock, declared beside the quota windows it must never be derived from.
 */
import { validateRuntimeAvailability } from "../contract/runtime.mjs";
import { isRuntimeAvailable, PREFLIGHT_WINDOW } from "../engine/runtime-discovery.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { availabilityPath } from "./paths.mjs";
import { writeJsonAtomic } from "./store.mjs";

/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */

/**
 * Answers a provider gives before doing any work that no retry inside their
 * window can change. Measured 2026-09-24: a probe answered
 * `quota_exhausted` was stored as "answered", the next launches reused it
 * without asking, and six processes spent into two exhausted accounts.
 */
const REFUSAL_REASONS = new Set(["quota_exhausted", "insufficient_balance", "model_not_supported"]);
/** How long a refusal that names no reset instant is held. A first guess, not a measurement. */
const REFUSAL_HOLD_MS = 15 * 60 * 1000;

/** The store shape this module reads and writes; a foreign shape reads as empty. */
const STORE_SCHEMA_VERSION = 1;

/**
 * The key one verdict is stored under. The executable is the path the harness
 * adapter itself resolves -- the same string a probe reports -- so a runtime
 * whose model, harness or binary changed is a different question by
 * construction, and no second catalogue-change mechanism is needed. The
 * contract-local runtime id is absent on purpose.
 *
 * @param {{harness: string, model: string, executable: string}} provider
 * @returns {string}
 */
export function availabilityKey(provider) {
  return `${provider.harness}:${provider.model}:${provider.executable}`;
}

/**
 * The fresh verdict stored for one provider, or null whenever nothing may
 * skip the ask: no record, a record that fails its own validator, and an
 * observation outside its window all read as null, because the caller's only
 * fallback is to ask again and asking again is always safe.
 *
 * @param {string} key
 * @param {number} [now] epoch milliseconds; defaults to the current clock
 * @returns {RuntimeAvailability|null}
 */
export function readAvailability(key, now = Date.now()) {
  const record = loadVerdicts()[key];
  return record && isRuntimeAvailable(record, now) ? record : null;
}

/**
 * Record that the named providers answered the live preflight at `now`. The
 * only verdict this store ever holds is "answered": silence
 * (preflight_timeout, spawn_error) and a command that never reached a
 * provider are the gate's to report and are never persisted, so the cache can
 * never turn a pass into a block or the reverse -- it decides only whether
 * the next launch asks.
 *
 * The observation instant is fixed when the verdict is recorded, never
 * refreshed on read: a sliding window would let a continuously launching
 * operator keep a long-dead provider admitted forever.
 *
 * A launch racing another on this store loses at most its own entries, and a
 * lost verdict costs one extra ask -- operator-scale launches are not a hot
 * loop, so the read-modify-write takes no lock.
 *
 * @param {string[]} keys
 * @param {number} [now] epoch milliseconds; the instant the verdicts were observed
 * @returns {void}
 */
export function recordAvailability(keys, now = Date.now()) {
  if (keys.length === 0) return;
  const store = loadStore();
  for (const key of keys) {
    store.verdicts[key] = {
      available: true,
      exhaustedUntil: null,
      // This store's own verdict name: the provider answered the ask. Nothing
      // here claims spend-readiness -- a refusal is an answer too.
      reason: "answered",
      observedAt: new Date(now).toISOString(),
      window: PREFLIGHT_WINDOW,
    };
  }
  const path = availabilityPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, store);
}

/**
 * The refusal a probe or a provider envelope's classified availability
 * carries, or null when it is anything else.
 *
 * @param {{available?: boolean, exhaustedUntil?: string|null, reason?: string}|null|undefined} availability
 * @returns {{reason: string, exhaustedUntil: string|null}|null}
 */
export function refusalOfAvailability(availability) {
  if (!availability || availability.available !== false || !REFUSAL_REASONS.has(String(availability.reason))) return null;
  return { reason: String(availability.reason), exhaustedUntil: availability.exhaustedUntil ?? null };
}

/**
 * Record that a provider refused the work, so every process on this machine
 * knows until the reset: the launch gate asks again instead of reusing an old
 * answer, and a class that spends one call per case stops before its next.
 *
 * @param {string} key
 * @param {{reason: string, exhaustedUntil: string|null}} refusal
 * @param {number} [now]
 * @returns {void}
 */
export function recordRefusal(key, refusal, now = Date.now()) {
  const store = loadStore();
  store.verdicts[key] = {
    available: false,
    exhaustedUntil: refusal.exhaustedUntil ?? new Date(now + REFUSAL_HOLD_MS).toISOString(),
    reason: refusal.reason,
    observedAt: new Date(now).toISOString(),
    window: PREFLIGHT_WINDOW,
  };
  const path = availabilityPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, store);
}

/**
 * The refusal recorded for a provider that has not yet reset, or null.
 *
 * @param {string} key
 * @param {number} [now]
 * @returns {RuntimeAvailability|null}
 */
export function readRefusal(key, now = Date.now()) {
  const record = loadVerdicts()[key];
  if (!record || record.available !== false || !record.exhaustedUntil) return null;
  return Date.parse(record.exhaustedUntil) > now ? record : null;
}

/**
 * Record what a set of live probes learned: an answer as an answer, a refusal
 * as a refusal until its reset.
 *
 * @param {{harness: string, model: string, executable: string, availability?: {available: boolean, exhaustedUntil: string|null, reason: string}}[]} probes
 * @param {number} [now]
 * @returns {void}
 */
export function recordProbeVerdicts(probes, now = Date.now()) {
  const refused = probes.filter((probe) => refusalOfAvailability(probe.availability));
  recordAvailability(probes.filter((probe) => !refused.includes(probe)).map((probe) => availabilityKey(probe)), now);
  for (const probe of refused) recordRefusal(availabilityKey(probe), /** @type {{reason: string, exhaustedUntil: string|null}} */ (refusalOfAvailability(probe.availability)), now);
}

/**
 * @returns {{schemaVersion: number, verdicts: Record<string, RuntimeAvailability>}}
 */
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(availabilityPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.schemaVersion === STORE_SCHEMA_VERSION
      && parsed.verdicts && typeof parsed.verdicts === "object" && !Array.isArray(parsed.verdicts)) {
      return parsed;
    }
  } catch {
    // ENOENT (the first launch on this machine) and a store a truncated write
    // or a future shape left unparseable mean the same thing here: no verdict
    // is known, so every provider is asked. That is the safe direction.
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, verdicts: {} };
}

/**
 * The stored verdicts that pass their own validator. Anything the store
 * cannot vouch for is dropped rather than trusted or repaired: a dropped
 * verdict costs one ask, a trusted one costs a launch gated on bytes nobody
 * can type.
 *
 * @returns {Record<string, RuntimeAvailability>}
 */
function loadVerdicts() {
  /** @type {Record<string, RuntimeAvailability>} */
  const verdicts = {};
  for (const [key, record] of Object.entries(loadStore().verdicts)) {
    try {
      validateRuntimeAvailability(record, `availability verdict ${key}`);
    } catch {
      continue;
    }
    verdicts[key] = /** @type {RuntimeAvailability} */ (record);
  }
  return verdicts;
}
