/**
 * `faberun setup [--yes] [--harnesses a,b] [--worker <id>] [--judge <id>]
 * [--json]`: onboard a fresh machine.
 *
 * It checks the two host prerequisites, discovers the catalogue runtimes
 * through the same `discoverRuntimes` the engine uses, asks which harnesses to
 * enable and which runtime is the default worker and judge, and writes the user
 * config at `$FABERUN_HOME/config.json`. When a config already exists, its
 * recorded harnesses, worker and judge seed the defaults instead of the
 * fresh-machine ones, narrowed to whatever discovery still reports available;
 * an explicit `--harnesses`, `--worker` or `--judge` still wins. The judge must
 * resolve to a vendor other than the worker's; the prompt refuses a same-vendor
 * answer once and the command fails on the second. Once the config is written it offers to register
 * the faberun skill into every installed harness's skills directory, reusing
 * `registerSkills` from `./skills.mjs` so discovery has one home.
 *
 * Discovery and the question function are injected so tests never touch a real
 * binary or a terminal. `--json` never asks: it reports the same facts as one
 * object and takes the defaults or the flags.
 */
import { createInterface } from "node:readline/promises";
import {
  DISCOVERY_RUNTIME_DEFINITIONS,
  availableCandidates,
  cheapest,
  discoverRuntimes,
  strongest,
} from "../engine/runtime-discovery.mjs";
import { effectiveProvider } from "../contract/provider.mjs";
import { boundedGitSync } from "../repo/worktree.mjs";
import { colorLevel, renderBanner, statusToken } from "./brand.mjs";
import { packageVersion } from "../host/package.mjs";
import { configPath, faberunHome } from "../host/home.mjs";
import { readUserConfig, writeUserConfig } from "../host/config.mjs";
import { discoverSkillTargets, registerSkills } from "./skills.mjs";

/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {import("../host/config.mjs").UserConfig} UserConfig */
/** @typedef {import("./skills.mjs").SkillRegistration} SkillRegistration */
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
 * @property {string} [judges] comma-separated ordered runtime ids for the machine's R18 judge-list default; unset keeps whatever the existing config already declared
 * @property {boolean} [skill] whether to register the faberun skill (default true)
 * @property {boolean} [json]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {() => Promise<Record<string, RuntimeAvailability>>} [discover]
 * @property {(name: string) => boolean} [isInstalled]
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
    if (json) stdout(`${JSON.stringify({ requirements, runtimes, config: null, skills: [] }, null, 2)}\n`);
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
      stdout(`${JSON.stringify({ requirements, runtimes, config: null, skills: [] }, null, 2)}\n`);
    } else {
      stdout(`${statusToken("fail", level)} harnesses · none available · install one of: ${INSTALL_HARNESSES.join(", ")}\n`);
    }
    return 1;
  }

  const candidates = availableCandidates(DISCOVERY_RUNTIME_DEFINITIONS, availability);
  const kept = mergeExistingConfig(readUserConfig(env), availability);
  const defaultHarnesses = kept.harnesses.length > 0 ? kept.harnesses : availableHarnesses;
  const defaultWorker = kept.worker || (cheapest(candidates)?.id ?? "");
  const interactive = isTTY && !json && !yes
    && options.harnesses === undefined && options.worker === undefined && options.judge === undefined;

  /** @type {string[]} */
  let selectedHarnesses;
  let selectedWorker;
  let selectedJudge;
  const asker = makeAsker(options.ask);
  /** @type {SkillRegistration[]} */
  let skills = [];
  try {
    if (interactive) {
      const harnessAnswer = (await asker.ask(`Enable which harnesses? [${defaultHarnesses.join(", ")}] `)).trim();
      selectedHarnesses = splitHarnesses(harnessAnswer).length ? splitHarnesses(harnessAnswer) : defaultHarnesses;

      const workerAnswer = (await asker.ask(`Default worker runtime? [${defaultWorker}] `)).trim();
      selectedWorker = workerAnswer || defaultWorker;

      const judgeDefault = keptJudgeDefault(kept, selectedWorker, candidates);
      let judgeAnswer = (await asker.ask(`Default judge runtime? [${judgeDefault}] `)).trim();
      let judge = judgeAnswer || judgeDefault;
      if (!crossVendor(judge, selectedWorker)) {
        stderr("the judge must come from a different vendor than the worker\n");
        judgeAnswer = (await asker.ask(`Default judge runtime? [${defaultJudge(selectedWorker, candidates)}] `)).trim();
        judge = judgeAnswer || defaultJudge(selectedWorker, candidates);
        if (!crossVendor(judge, selectedWorker)) return 1;
      }
      selectedJudge = judge;
    } else {
      selectedHarnesses = splitHarnesses(options.harnesses ?? "").length ? splitHarnesses(options.harnesses ?? "") : defaultHarnesses;
      selectedWorker = options.worker ?? defaultWorker;
      selectedJudge = options.judge ?? keptJudgeDefault(kept, selectedWorker, candidates);
      if (!crossVendor(selectedJudge, selectedWorker)) {
        if (json) stdout(`${JSON.stringify({ requirements, runtimes, config: null, skills }, null, 2)}\n`);
        else stdout(`${statusToken("fail", level)} judge · the judge must come from a different vendor than the worker\n`);
        return 1;
      }
    }

    const selectedJudges = splitHarnesses(options.judges ?? "").length ? splitHarnesses(options.judges ?? "") : kept.judges;
    const config = {
      schemaVersion: /** @type {1} */ (1),
      harnesses: selectedHarnesses,
      worker: selectedWorker,
      judge: selectedJudge,
      ...(selectedJudges.length ? { judges: selectedJudges } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeUserConfig(env, config);
    if (!json) stdout(`${statusToken("ok", level)} config · ${configPath(faberunHome(env))}\n`);

    // The offer comes after the config is durable, so a machine that answers
    // no still has a usable setup. Discovery is `skills.mjs`'s table, reused
    // rather than re-probed here.
    const detected = discoverSkillTargets({ env, isInstalled: options.isInstalled })
      .filter((target) => target.dir !== null && target.dirExists && target.installed && !target.unsupported);
    if (options.skill !== false && detected.length > 0) {
      let register = true;
      if (interactive) {
        const answer = (await asker.ask(`Register the faberun skill for ${detected.map((target) => target.harness).join(", ")}? [Y/n] `)).trim();
        register = !answer.toLowerCase().startsWith("n");
      }
      if (register) {
        skills = registerSkills({
          env,
          level,
          isInstalled: options.isInstalled,
          stdout: json ? () => {} : stdout,
        });
      }
    }

    if (json) {
      stdout(`${JSON.stringify({ requirements, runtimes, config, skills }, null, 2)}\n`);
      return 0;
    }
    stdout("next · faberun init in a repository · faberun doctor\n");
    return 0;
  } finally {
    asker.close();
  }
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
 * The recorded harnesses, worker and judge that discovery still reports
 * available, so a re-run of setup keeps an operator's earlier choices instead
 * of resetting them to the fresh-machine defaults. A choice discovery cannot
 * find is dropped, not kept blindly; the caller fills anything empty with
 * today's defaults. A null `existing` (no config yet, or a malformed one)
 * yields nothing kept.
 *
 * @param {UserConfig|null} existing
 * @param {Record<string, RuntimeAvailability>} availability
 * @returns {{harnesses: string[], worker: string, judge: string, judges: string[]}}
 */
export function mergeExistingConfig(existing, availability) {
  if (!existing) return { harnesses: [], worker: "", judge: "", judges: [] };
  const availableHarnesses = new Set(
    Object.entries(DISCOVERY_RUNTIME_DEFINITIONS)
      .filter(([id]) => availability[id]?.available === true)
      .map(([, definition]) => definition.harness),
  );
  const candidateIds = new Set(
    availableCandidates(DISCOVERY_RUNTIME_DEFINITIONS, availability).map((candidate) => candidate.id),
  );
  return {
    harnesses: existing.harnesses.filter((harness) => availableHarnesses.has(harness)),
    worker: existing.worker && candidateIds.has(existing.worker) ? existing.worker : "",
    judge: existing.judge && candidateIds.has(existing.judge) ? existing.judge : "",
    // The judge list is a static, operator-declared ordering (D9): unlike the
    // single worker/judge default, an entry discovery cannot currently reach
    // is not dropped, since R18's own selection already skips a refused or
    // usage-heavy entry at every read.
    judges: Array.isArray(existing.judges) ? existing.judges : [],
  };
}

/**
 * The judge default for the interactive prompt and `--yes`: the recorded judge
 * when it is still available and still a different vendor than `workerId`,
 * otherwise the strongest cross-vendor candidate as today.
 *
 * @param {{judge: string}} kept
 * @param {string} workerId
 * @param {import("../engine/runtime-discovery.mjs").RuntimeCandidate[]} candidates
 * @returns {string}
 */
function keptJudgeDefault(kept, workerId, candidates) {
  if (kept.judge && crossVendor(kept.judge, workerId)) return kept.judge;
  return defaultJudge(workerId, candidates);
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
  const worker = DISCOVERY_RUNTIME_DEFINITIONS[workerId];
  if (worker === undefined) return "";
  const vendor = effectiveProvider(worker);
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
  const judge = DISCOVERY_RUNTIME_DEFINITIONS[judgeId];
  const worker = DISCOVERY_RUNTIME_DEFINITIONS[workerId];
  const judgeVendor = judge && effectiveProvider(judge);
  const workerVendor = worker && effectiveProvider(worker);
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
  const probe = boundedGitSync(["--version"], { encoding: "utf8" });
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
