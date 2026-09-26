/**
 * The environment a worker, a judge, or an availability probe may receive.
 *
 * A controller variable reaches a child only when something named it. The
 * names a child may see are the union of:
 *
 *   - the base operating-system names below,
 *   - the names the selected adapter declares in its `declaredEnvironment`,
 *   - the runtime's `*.env_key` names, and
 *   - the explicit `envPassthrough` names on the runtime or the contract.
 *
 * Everything else the controller holds -- an `AWS_*`, a `GITHUB_TOKEN`, a
 * `DATABASE_URL` exported in a shell profile -- is dropped. Verification
 * commands are not workers and keep the full controller environment
 * (`judge-gate.mjs`); only worker, judge, and availability-probe spawns route
 * through here.
 *
 * The adapter lists are imported from each adapter directly instead of through
 * `harnesses/catalogue.mjs`: the registry imports this module for its probe, so
 * reaching the catalogue from here would close a runtime import cycle the repo
 * forbids. The catalogue keeps its own copy of the same names for R2, and both
 * read the same adapter exports.
 */
import { declaredEnvironment as claudeEnvironment } from "../harnesses/claude/index.mjs";
import { declaredEnvironment as codexEnvironment } from "../harnesses/codex/index.mjs";
import { declaredEnvironment as agyEnvironment } from "../harnesses/agy/index.mjs";
import { declaredEnvironment as dshEnvironment } from "../harnesses/dsh/index.mjs";
import { declaredEnvironment as zcodeEnvironment } from "../harnesses/zcode/index.mjs";
import { declaredEnvironment as execJsonlEnvironment } from "../harnesses/exec-jsonl/index.mjs";
import { declaredEnvironment as replayEnvironment } from "../harnesses/replay/index.mjs";
import { NOTIFY_ENV_NAMES } from "../notify/index.mjs";

/**
 * The base operating-system names every child needs to resolve a binary, find
 * its home, and speak the locale. `LC_*` is a family, matched by prefix; the
 * Windows entries are listed on every platform because the machine that reads
 * them is the machine that has them.
 *
 * @type {readonly string[]}
 */
export const BASE_ENV_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "COMSPEC",
  "PATHEXT",
]);

/** @type {ReadonlySet<string>} */
const BASE_NAME_SET = new Set(BASE_ENV_NAMES);

/**
 * The adapter-declared names, keyed by harness. Values never travel here.
 *
 * A `Map` rather than the catalogue's frozen object on purpose: the repo
 * forbids the same top-level body defined twice, and the registry owns the
 * catalogue copy.
 *
 * @type {Map<string, readonly string[]>}
 */
const ADAPTER_ENVIRONMENTS = new Map([
  ["claude", claudeEnvironment],
  ["codex", codexEnvironment],
  ["agy", agyEnvironment],
  ["dsh", dshEnvironment],
  ["zcode", zcodeEnvironment],
  ["exec-jsonl", execJsonlEnvironment],
  ["replay", replayEnvironment],
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isBaseName(name) {
  return BASE_NAME_SET.has(name) || name.startsWith("LC_");
}

/**
 * The `*.env_key` names a runtime's config declares. A config value there is
 * the environment-variable name, never the value, so this reads names alone.
 *
 * @param {{config?: Record<string, unknown>}|null|undefined} runtime
 * @returns {string[]}
 */
function envKeyNames(runtime) {
  /** @type {string[]} */
  const names = [];
  for (const [key, value] of Object.entries(runtime?.config ?? {})) {
    if (key.endsWith(".env_key") && typeof value === "string" && value.length > 0) names.push(value);
  }
  return names;
}

/**
 * The non-base names one runtime may carry: what its adapter declares, what
 * its `*.env_key` config entries name, and what the runtime or the contract
 * explicitly passes through. The notification transport is never one of them,
 * whatever an author writes.
 *
 * @param {{harness?: string, config?: Record<string, unknown>, envPassthrough?: string[]}|null|undefined} runtime
 * @param {{envPassthrough?: string[]}|null|undefined} [contract]
 * @returns {string[]}
 */
export function declaredEnvironmentNames(runtime, contract) {
  const names = new Set(ADAPTER_ENVIRONMENTS.get(runtime?.harness ?? "") ?? []);
  for (const name of envKeyNames(runtime)) names.add(name);
  for (const name of Array.isArray(runtime?.envPassthrough) ? runtime.envPassthrough : []) names.add(name);
  for (const name of Array.isArray(contract?.envPassthrough) ? contract.envPassthrough : []) names.add(name);
  for (const name of NOTIFY_ENV_NAMES) names.delete(name);
  return [...names];
}

/**
 * The base names present in `source`, including every `LC_*` member.
 *
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>}
 */
export function baseEnvironment(source = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  // Look the base names up rather than filtering source keys: Windows exposes
  // `Path`, not `PATH`, and `source[name]` is the case-insensitive read there.
  for (const name of BASE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && name.startsWith("LC_")) env[name] = value;
  }
  return env;
}

/**
 * The non-base allowlisted names present in `source`, with their controller
 * values. This is the overlay a caller hands the gate: the gate already holds
 * the base set in its own environment, so it only needs what the runtime adds
 * on top.
 *
 * @param {{harness?: string, config?: Record<string, unknown>, envPassthrough?: string[]}|null|undefined} runtime
 * @param {{envPassthrough?: string[]}|null|undefined} [contract]
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>}
 */
export function passthroughEnvironment(runtime, contract, source = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of declaredEnvironmentNames(runtime, contract)) {
    if (isBaseName(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The complete environment a worker, judge, or availability probe receives.
 *
 * @param {{harness?: string, config?: Record<string, unknown>, envPassthrough?: string[]}|null|undefined} runtime
 * @param {{envPassthrough?: string[]}|null|undefined} [contract]
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>}
 */
export function workerEnvironment(runtime, contract, source = process.env) {
  return { ...baseEnvironment(source), ...passthroughEnvironment(runtime, contract, source) };
}
