/**
 * `faberun setup [--yes] [--harnesses a,b] [--worker <id>] [--judge <id>]
 * [--json]`: onboard a fresh machine.
 *
 * It checks the two host prerequisites, discovers the catalogue runtimes
 * through the same `discoverRuntimes` the engine uses, asks which harnesses to
 * enable and which runtime is the default worker and judge, and writes the user
 * config at `$FABERUN_HOME/config.json`. The judge must resolve to a vendor
 * other than the worker's; the prompt refuses a same-vendor answer once and the
 * command fails on the second.
 *
 * Discovery and the question function are injected so tests never touch a real
 * binary or a terminal. `--json` never asks: it reports the same facts as one
 * object and takes the defaults or the flags.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  DISCOVERY_RUNTIME_DEFINITIONS,
  availableCandidates,
  cheapest,
  discoverRuntimes,
  strongest,
} from "../engine/runtime-discovery.mjs";
import { colorLevel, renderBanner, statusToken } from "./brand.mjs";
import { packageVersion } from "../host/package.mjs";
import { configPath, faberunHome } from "../host/home.mjs";
import { writeUserConfig } from "../host/config.mjs";

/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {import("../host/config.mjs").UserConfig} UserConfig */
/** @typedef {(text: string) => void} Writer */
/** @typedef {(question: string) => Promise<string>} Asker */
/** @typedef {{id: string, harness: string, model: string, available: boolean, status: string, missing: string[]}} RuntimeView */
/** @typedef {{ask: Asker, close: () => void}} AskerHandle */
/**
 * @typedef {object} SetupOptions
 * @property {boolean} [yes]
 * @property {string} [harnesses]
 * @property {string} [worker]
 * @property {string} [judge]
 * @property {boolean} [json]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {() => Promise<Record<string, RuntimeAvailability>>} [discover]
 * @property {Asker} [ask]
 * @property {Writer} [stdout]
 * @property {Writer} [stderr]
 * @property {boolean} [isTTY]
 */

/** Node major version the tool requires; `package.json#engines` says the same. */
const MIN_NODE_MAJOR = 22;

/** The harnesses a fresh machine can install, named in the failure hint. */
const INSTALL_HARNESSES = ["claude", "codex", "agy", "dsh", "zcode"];

/**
 * @param {SetupOptions} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function setupCommand(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const json = options.json === true;
  const yes = options.yes === true;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const level = colorLevel(env, isTTY);
  const discover = options.discover ?? (() => discoverRuntimes(DISCOVERY_RUNTIME_DEFINITIONS));

  const availability = await discover();
  const runtimes = runtimeViews(availability, env);
  const availableHarnesses = [...new Set(runtimes.filter((view) => view.available).map((view) => view.harness))];
  const requirements = [nodeRequirement(), gitRequirement()];

  if (isTTY && !json) {
    stdout(renderBanner({
      version: packageVersion(),
      // DESIGN.md draws `node 26.8.1`; `process.version` is `v26.8.1`.
      nodeVersion: process.version.replace(/^v/u, ""),
      harnessCount: availableHarnesses.length,
      level,
      env,
    }));
  }

  if (json) {
    // `--json` never asks and never paints; the object below is the whole
    // report, whether setup succeeds or stops at a check.
  } else {
    for (const requirement of requirements) {
      stdout(`${statusToken(requirement.ok ? "ok" : "fail", level)} ${requirement.name} · ${requirement.detail}\n`);
    }
  }

  if (requirements.some((requirement) => !requirement.ok)) {
    if (json) stdout(`${JSON.stringify({ requirements, runtimes, config: null }, null, 2)}\n`);
    return 1;
  }

  if (!json) {
    for (const view of runtimes) {
      const missing = view.missing.length ? ` · set ${view.missing.join(", ")}` : "";
      stdout(`${statusToken(runtimeToken(view), level)} ${view.id} · ${view.status} · ${view.harness} · ${view.model}${missing}\n`);
    }
  }

  if (availableHarnesses.length === 0) {
    if (json) {
      stdout(`${JSON.stringify({ requirements, runtimes, config: null }, null, 2)}\n`);
    } else {
      stdout(`${statusToken("fail", level)} harnesses · none available · install one of: ${INSTALL_HARNESSES.join(", ")}\n`);
    }
    return 1;
  }

  const candidates = availableCandidates(DISCOVERY_RUNTIME_DEFINITIONS, availability);
  const defaultWorker = cheapest(candidates)?.id ?? "";
  const interactive = isTTY && !json && !yes
    && options.harnesses === undefined && options.worker === undefined && options.judge === undefined;

  /** @type {string[]} */
  let selectedHarnesses;
  let selectedWorker;
  let selectedJudge;
  const asker = makeAsker(options.ask);
  try {
    if (interactive) {
      const harnessAnswer = (await asker.ask(`Enable which harnesses? [${availableHarnesses.join(", ")}] `)).trim();
      selectedHarnesses = splitHarnesses(harnessAnswer).length ? splitHarnesses(harnessAnswer) : availableHarnesses;

      const workerAnswer = (await asker.ask(`Default worker runtime? [${defaultWorker}] `)).trim();
      selectedWorker = workerAnswer || defaultWorker;

      let judgeAnswer = (await asker.ask(`Default judge runtime? [${defaultJudge(selectedWorker, candidates)}] `)).trim();
      let judge = judgeAnswer || defaultJudge(selectedWorker, candidates);
      if (!crossVendor(judge, selectedWorker)) {
        stderr("the judge must come from a different vendor than the worker\n");
        judgeAnswer = (await asker.ask(`Default judge runtime? [${defaultJudge(selectedWorker, candidates)}] `)).trim();
        judge = judgeAnswer || defaultJudge(selectedWorker, candidates);
        if (!crossVendor(judge, selectedWorker)) return 1;
      }
      selectedJudge = judge;
    } else {
      selectedHarnesses = splitHarnesses(options.harnesses ?? "").length ? splitHarnesses(options.harnesses ?? "") : availableHarnesses;
      selectedWorker = options.worker ?? defaultWorker;
      selectedJudge = options.judge ?? defaultJudge(selectedWorker, candidates);
      if (!crossVendor(selectedJudge, selectedWorker)) {
        if (json) stdout(`${JSON.stringify({ requirements, runtimes, config: null }, null, 2)}\n`);
        else stdout(`${statusToken("fail", level)} judge · the judge must come from a different vendor than the worker\n`);
        return 1;
      }
    }
  } finally {
    asker.close();
  }

  const config = {
    schemaVersion: /** @type {1} */ (1),
    harnesses: selectedHarnesses,
    worker: selectedWorker,
    judge: selectedJudge,
    updatedAt: new Date().toISOString(),
  };
  writeUserConfig(env, config);

  if (json) {
    stdout(`${JSON.stringify({ requirements, runtimes, config }, null, 2)}\n`);
    return 0;
  }
  stdout(`${statusToken("ok", level)} config · ${configPath(faberunHome(env))}\n`);
  stdout("next · faberun init in a repository · faberun doctor\n");
  return 0;
}

/**
 * One discovery line's token: an available runtime is a pass, a binary that is
 * absent is a failure, and every other reason (quota, balance, auth, provider
 * error) is a warning.
 *
 * @param {RuntimeView} view
 * @returns {"ok"|"warn"|"fail"}
 */
function runtimeToken(view) {
  if (view.available) return "ok";
  return view.status === "not_found" ? "fail" : "warn";
}

/**
 * @param {Record<string, RuntimeAvailability>} availability
 * @param {NodeJS.ProcessEnv} env
 * @returns {RuntimeView[]}
 */
function runtimeViews(availability, env) {
  return Object.entries(DISCOVERY_RUNTIME_DEFINITIONS).map(([id, definition]) => {
    const state = availability[id];
    const available = state?.available === true;
    return {
      id,
      harness: definition.harness,
      model: definition.model,
      available,
      status: available ? "available" : (state?.reason ?? "provider_unavailable"),
      missing: missingEnvKeys(definition, env),
    };
  });
}

/**
 * The env var names a runtime's own config declares through an `*.env_key` and
 * the process environment does not set. Discovery already reports the
 * authentication reason; naming the variable is what makes it fixable.
 *
 * @param {import("../engine/runtime-discovery.mjs").DiscoveryRuntime} runtime
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function missingEnvKeys(runtime, env) {
  /** @type {string[]} */
  const names = [];
  for (const [key, value] of Object.entries(runtime.config ?? {})) {
    if (!key.endsWith(".env_key")) continue;
    if (typeof value === "string" && value.length > 0 && !env[value]) names.push(value);
  }
  return [...new Set(names)];
}

/**
 * The strongest available runtime whose vendor differs from the worker's. An
 * empty string means no cross-vendor runtime is available, which the caller
 * turns into a refusal.
 *
 * @param {string} workerId
 * @param {import("../engine/runtime-discovery.mjs").RuntimeCandidate[]} candidates
 * @returns {string}
 */
function defaultJudge(workerId, candidates) {
  const vendor = DISCOVERY_RUNTIME_DEFINITIONS[workerId]?.vendor;
  if (vendor === undefined) return "";
  return strongest(candidates, vendor)?.id ?? "";
}

/**
 * Whether `judgeId` is a known runtime whose vendor differs from the known
 * vendor of `workerId`. An unknown id on either side is not cross-vendor.
 *
 * @param {string} judgeId
 * @param {string} workerId
 * @returns {boolean}
 */
function crossVendor(judgeId, workerId) {
  const judgeVendor = DISCOVERY_RUNTIME_DEFINITIONS[judgeId]?.vendor;
  const workerVendor = DISCOVERY_RUNTIME_DEFINITIONS[workerId]?.vendor;
  return Boolean(judgeVendor && workerVendor && judgeVendor !== workerVendor);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitHarnesses(text) {
  return [...new Set(String(text).split(",").map((name) => name.trim()).filter(Boolean))];
}

/** @returns {{name: string, ok: boolean, detail: string}} */
function nodeRequirement() {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    name: "node",
    ok,
    detail: ok ? `${process.version} (${MIN_NODE_MAJOR} or newer required)` : `${process.version} · ${MIN_NODE_MAJOR} or newer required`,
  };
}

/** @returns {{name: string, ok: boolean, detail: string}} */
function gitRequirement() {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { name: "git", ok: false, detail: "not found on PATH" };
  return { name: "git", ok: true, detail: String(probe.stdout ?? "").trim() };
}

/**
 * A question function, real or injected. The real one reads one shared readline
 * interface for the whole command and closes it when setup is done.
 *
 * @param {Asker|undefined} injected
 * @returns {AskerHandle}
 */
function makeAsker(injected) {
  if (injected) return { ask: injected, close: () => {} };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (question) => rl.question(question), close: () => rl.close() };
}
