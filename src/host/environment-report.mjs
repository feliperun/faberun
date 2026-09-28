/**
 * The `doctor --env` report: which controller variables each runtime's child
 * would carry, which it would not, and which excluded names look like
 * credentials. Only names cross this boundary, never values. Separate from
 * `preflight.mjs` because it is a listing built from the worker environment
 * builder, not a readiness check, and it took that module past its 800-line
 * ceiling (measured 2026-09-27: 840 lines).
 */
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../engine/runtime-discovery.mjs";
import { workerEnvironment } from "../engine/worker-env.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./preflight.mjs").ReachableRuntimes} ReachableRuntimes */

/**
 * The name shapes that mark a controller variable as a credential. An excluded
 * name matching one of these is reported as retained: the operator reads that
 * the secret exists on the controller and is kept out of every worker, and
 * never reads its value.
 *
 * `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*` and `GITHUB_*` are the
 * six shapes R3 names; they are a warning about the name, not a claim about the
 * value, so a `GITHUB_ACTIONS` is retained too.
 */
const SECRET_ENV_NAME_PATTERNS = Object.freeze([
  /_KEY$/u,
  /_TOKEN$/u,
  /_SECRET$/u,
  /_PASSWORD$/u,
  /^AWS_/u,
  /^GITHUB_/u,
]);

/** @param {string} name @returns {boolean} */
export function isSecretEnvName(name) {
  return SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * @param {Record<string, string|undefined>} source
 * @returns {string[]}
 */
function presentEnvironmentNames(source) {
  return Object.keys(source).filter((name) => source[name] !== undefined).sort((left, right) => left.localeCompare(right));
}

/**
 * One runtime's side of the `doctor --env` report: the controller variable
 * names it would carry and the names it would not, with every excluded
 * credential-shaped name also listed under `retained`.
 *
 * Values never cross this boundary. The allowlist is computed from the same
 * `workerEnvironment` the dispatch gate spawns with, and only its keys are
 * read; the source is consulted for presence, never copied into the result.
 *
 * @param {{id?: string, harness?: string, config?: Record<string, unknown>, envPassthrough?: string[]}|null|undefined} runtime
 * @param {{envPassthrough?: string[]}|null|undefined} [contract]
 * @param {Record<string, string|undefined>} [source]
 * @returns {{runtime: string, harness: string, passed: string[], excluded: string[], retained: string[]}}
 */
export function runtimeEnvironmentReport(runtime, contract, source = process.env) {
  const allowed = new Set(Object.keys(workerEnvironment(runtime, contract, source)));
  const present = presentEnvironmentNames(source);
  const passed = present.filter((name) => allowed.has(name));
  const excluded = present.filter((name) => !allowed.has(name));
  const retained = excluded.filter((name) => isSecretEnvName(name));
  return { runtime: runtime?.id ?? "", harness: runtime?.harness ?? "", passed, excluded, retained };
}

/**
 * The per-runtime listings behind `doctor --env`. A contract narrows the report
 * to the reachable runtimes the run committed to; without one the report covers
 * the discovery catalogue, because there is no routed runtime to name.
 *
 * @param {ReachableRuntimes} [runtimes]
 * @param {ValidatedContract} [contract]
 * @param {Record<string, string|undefined>} [source]
 * @returns {{runtime: string, harness: string, passed: string[], excluded: string[], retained: string[]}[]}
 */
export function environmentListings(runtimes, contract, source = process.env) {
  const entries = runtimes && runtimes.size
    ? [...runtimes.entries()].map(([id, { runtime }]) => ({ ...runtime, id }))
    : Object.entries(DISCOVERY_RUNTIME_DEFINITIONS).map(([id, runtime]) => ({ ...runtime, id }));
  return entries.map((runtime) => runtimeEnvironmentReport(runtime, contract, source));
}
