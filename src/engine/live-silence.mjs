/**
 * What counts as a provider saying nothing at all.
 *
 * This is one rule with three readers -- the dispatch gate
 * (`engine/run-identity.mjs`), planning's pre-stage refusal
 * (`plan/preflight.mjs`) and `doctor` (`host/preflight.mjs`) -- and it is its
 * own module because those three cannot all import each other. `doctor` owns
 * `reachableRuntimes`, which `engine/live-preflight.mjs` imports, so a
 * `doctor` that read the rule out of the engine closed a runtime import
 * cycle. This module imports nothing: it reads a probe's recorded detail and
 * says whether a provider answered, and nothing else.
 *
 * The rule itself is the campaign's claim in one line. Any verdict a provider
 * returned is an answer, a quota refusal included, and the run proceeds onto
 * whatever the contract declares. Only silence blocks.
 */

/**
 * The causes that mean no runtime said anything at all: the provider was
 * asked and did not answer, or could not be started to be asked.
 *
 * `command_invalid` is deliberately not one of them. A command that could not
 * be constructed never reached a provider, so there is no availability
 * verdict either way -- that is a contract defect and validation already owns
 * it. Measured 2026-09-22: three deterministic evals declare a fallback and a
 * judge runtime they never invoke, so those carry no replay recording and the
 * replay adapter throws when asked to build their command. Blocking there
 * refuses a run over a runtime it would never have used, for a fault the
 * provider never had.
 */
const LIVE_SILENCE_CAUSES = new Set(["preflight_timeout", "spawn_error"]);

/**
 * Whether a live probe is pipeline silence rather than a verdict, and which
 * cause. `preflightContract` embeds the provider envelope's error code in the
 * probe detail (`… · live failed · <code>: …`), and the repository-failure
 * wording means no runtime was even asked. Everything else -- a quota
 * refusal, an auth failure, unparsable output -- is a provider that answered,
 * and an answer is hello enough.
 *
 * @param {import("../harnesses/index.mjs").ProbeResult} probe
 * @returns {string|null}
 */
export function liveSilenceCause(probe) {
  if (probe.ok) return null;
  if (/live preflight repository failed/u.test(probe.detail ?? "")) return "spawn_error";
  const match = / · live \S+ · ([a-z_]+):/u.exec(probe.detail ?? "");
  return match !== null && LIVE_SILENCE_CAUSES.has(match[1]) ? match[1] : null;
}
