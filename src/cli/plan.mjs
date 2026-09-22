/**
 * `plan` argv: run the planning pipeline as successive ordinary runs (draft,
 * review, revise up to a round budget) and freeze the result, or park it
 * contested. This file only owns the wire — `src/plan/pipeline.mjs` owns the
 * sequencing and every decision the pipeline makes.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detachArgv, detachSelf, waitForBootstrap } from "./launch.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";
import { runProgress } from "../engine/supervise.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../engine/runtime-discovery.mjs";
import { validateRuntime } from "../contract/runtime.mjs";
import { validateFinalVerification, validateSharedVerification } from "../contract/final-verification.mjs";
import { colorLevel, statusToken } from "./brand.mjs";
import { delay } from "../util.mjs";
import { runPlanningPipeline } from "../plan/pipeline.mjs";
import { campaignTree, runDirectory } from "../run/paths.mjs";
import { readCampaign } from "../campaign/record.mjs";

/** How often a foreground `plan` polls a launched stage's run directory. */
const DEFAULT_POLL_MS = 1_000;

/**
 * How long a `--detach` launcher stays to see whether the planning process it
 * started is actually up. Long enough to cover the bootstrap work that fails
 * synchronously -- spec read, strict validation, catalogue load, the runtime
 * ask -- and short enough that a launcher is not a supervisor: past this
 * window, a planning run that dies is a running campaign's problem and leaves
 * its evidence in the run directory, not here.
 */
const PLAN_BOOTSTRAP_WINDOW_MS = 5_000;
const PLAN_BOOTSTRAP_POLL_MS = 100;

/**
 * `--runtime-defaults worker=<id>,judge=<id>`, either key optional, comma
 * separated. Absent entirely, the pipeline falls through to plain
 * availability discovery for every node.
 *
 * @param {string|undefined} value
 * @returns {{worker?: string, judge?: string}}
 */
export function parseRuntimeDefaults(value) {
  /** @type {{worker?: string, judge?: string}} */
  const result = {};
  if (value === undefined) return result;
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new Error(`--runtime-defaults entries must be worker=<id> or judge=<id>: ${pair}`);
    const role = pair.slice(0, eq).trim();
    const id = pair.slice(eq + 1).trim();
    if (role !== "worker" && role !== "judge") throw new Error(`--runtime-defaults role must be worker or judge: ${role}`);
    if (!id) throw new Error(`--runtime-defaults ${role} needs a runtime id`);
    result[role] = id;
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function reviewRoundsOf(value) {
  if (value === undefined) return 2;
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`--review-rounds must be a positive integer: ${String(value)}`);
  return rounds;
}

/**
 * A `--runtimes <path>` catalogue: a JSON object in the same shape a
 * contract's own `runtimes` field takes, validated entry-by-entry with the
 * same validator `validateContract` uses, so a malformed catalogue is
 * rejected before any planning stage launches rather than surfacing as an
 * opaque failure deep inside the pipeline.
 *
 * @param {string} path
 * @returns {Record<string, import("../contract/index.mjs").ValidatedRuntime>}
 */
export function loadRuntimesCatalogue(path) {
  const resolved = resolve(path);
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`--runtimes ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`--runtimes ${path} must be a JSON object`);
  /** @type {Record<string, import("../contract/index.mjs").ValidatedRuntime>} */
  const runtimes = {};
  for (const [id, runtime] of Object.entries(raw)) runtimes[id] = validateRuntime(id, runtime);
  return runtimes;
}

/**
 * A `--verification <path>` catalogue: a JSON object carrying either or both
 * of the contract's own suite keys, `sharedVerification` and
 * `finalVerification`, each validated with the same validator
 * `validateContract` applies. A key that is not a contract suite is refused
 * rather than ignored: a typo'd key would freeze a contract that looks
 * ratcheted and is not, which is the failure mode this flag exists to close.
 *
 * @param {string} path
 * @returns {{sharedVerification?: import("../contract/index.mjs").VerificationCommand[], finalVerification?: import("../contract/index.mjs").VerificationCommand[]}}
 */
export function loadVerificationSuites(path) {
  const resolved = resolve(path);
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`--verification ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`--verification ${path} must be a JSON object`);
  const record = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(record)) {
    if (key !== "sharedVerification" && key !== "finalVerification") throw new Error(`--verification ${path} must carry only sharedVerification and finalVerification: ${key}`);
  }
  return {
    ...(record.sharedVerification === undefined ? {} : { sharedVerification: validateSharedVerification(record.sharedVerification, "contract.sharedVerification") }),
    ...(record.finalVerification === undefined ? {} : { finalVerification: validateFinalVerification(record.finalVerification, "contract.finalVerification") }),
  };
}

/**
 * @param {string} target
 * @param {{campaign?: string, phase?: string, "review-rounds"?: string, "approve-below"?: string, "runtime-defaults"?: string, runtimes?: string, verification?: string, package?: string, "targeted-fix"?: boolean, detach?: boolean, json?: boolean}} values
 * @returns {Promise<void>}
 */
export async function planCli(target, values) {
  const specPath = resolve(target);
  if (typeof values.campaign !== "string" || !values.campaign) throw new Error("plan requires --campaign <id>");
  const campaignId = values.campaign;
  const phase = typeof values.phase === "string" && values.phase ? values.phase : "default";
  const reviewRounds = reviewRoundsOf(values["review-rounds"]);
  const approveBelow = /** @type {"standard"|"high"|"none"|undefined} */ (values["approve-below"]);
  const runtimeDefaults = parseRuntimeDefaults(values["runtime-defaults"]);
  const runtimes = typeof values.runtimes === "string" && values.runtimes
    ? loadRuntimesCatalogue(values.runtimes)
    : DISCOVERY_RUNTIME_DEFINITIONS;
  const verification = typeof values.verification === "string" && values.verification
    ? loadVerificationSuites(values.verification)
    : {};
  const packageMode = packageModeOf(values.package);

  if (values.detach === true) {
    const argv = ["plan", specPath, "--campaign", campaignId, "--phase", phase, "--review-rounds", String(reviewRounds)];
    if (approveBelow !== undefined) argv.push("--approve-below", approveBelow);
    if (values["runtime-defaults"] !== undefined) argv.push("--runtime-defaults", values["runtime-defaults"]);
    if (typeof values.runtimes === "string" && values.runtimes) argv.push("--runtimes", resolve(values.runtimes));
    if (typeof values.verification === "string" && values.verification) argv.push("--verification", resolve(values.verification));
    if (packageMode !== "implementation") argv.push("--package", packageMode);
    if (values["targeted-fix"] === true) argv.push("--targeted-fix");
    const failurePath = planBootstrapFailurePath(process.cwd(), campaignId, phase);
    // Read the campaign before creating anything: the failure record lives
    // inside the campaign tree, so a typo in --campaign would otherwise leave
    // a campaign directory with no record in it for `discoverCampaigns` to
    // find. The child reads it too; this is the launcher refusing what it can
    // see for itself rather than detaching into a certain failure.
    readCampaign(campaignTree(process.cwd(), campaignId));
    mkdirSync(dirname(failurePath), { recursive: true });
    rmSync(failurePath, { force: true });
    const child = detachArgv(argv);
    if (child.pid === undefined) throw new Error("detached plan has no pid");
    // The child's stdio is discarded (detachArgv), so a planning run that dies
    // during bootstrap used to take its own reason with it while the launcher
    // had already printed a pid and exited 0. Measured 2026-09-21 on macOS and
    // Linux the same day: a run died after collecting repo facts and the stderr
    // went with the closed connection. Waiting out a bounded window is the
    // whole check -- a controller still alive past it is up, and one that is
    // not has written why.
    const failure = await watchPlanBootstrap(child, failurePath);
    if (failure) {
      process.stderr.write(`[plan] bootstrap failed · ${failure.error}\n[plan] recorded at ${failurePath}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`[plan] detached · pid ${child.pid} · ${specPath}\n`);
    return;
  }

  // A detached child arrives here with its stdio already discarded, so what
  // it throws reaches nobody unless it is written down first. The record is
  // written on every path, detached or not: a foreground failure that also
  // leaves the file costs nothing and reads the same.
  let result;
  try {
    result = await runPlanningPipeline({
      specPath,
      campaignId,
      phase,
      reviewRounds,
      approveBelow,
      runtimeDefaults,
      runtimes,
      verification,
      targetedFix: values["targeted-fix"] === true,
      packageMode,
      launch: async (contractPath, contract) => {
        const child = detachSelf("run", contractPath);
        if (child.pid === undefined) throw new Error("detached planning run has no pid");
        await waitForBootstrap(runDirectory(contract.cwd, contract.id), child.pid, child);
      },
      wait: async (runDir) => {
        for (;;) {
          const progress = runProgress(runDir);
          const classification = classifyRunProgress(progress);
          if (classification !== "unfinished" && classification !== "waiting") return progress;
          await delay(DEFAULT_POLL_MS);
        }
      },
    });
  } catch (error) {
    writePlanBootstrapFailure(process.cwd(), campaignId, phase, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.status === "contested") {
    process.stdout.write(`[plan] ${campaignId} phase ${phase} contested after ${result.round} round(s) · ${result.findings.length} finding(s) · ${result.planPath}\n`);
    process.exitCode = 1;
    return;
  }
  for (const warning of result.warnings) process.stdout.write(`${statusToken("warn", colorLevel(process.env, process.stdout.isTTY))} ${warning}\n`);
  process.stdout.write(`[plan] ${campaignId} phase ${phase} frozen · approved ${result.approved} · ${result.contractPath}\n`);
}

/**
 * Where a detached planning run records why it never came up. It sits beside
 * the phase's durable plan artifacts rather than in the disposable scratch
 * tree, and it is derived from campaign and phase alone -- the launcher and
 * the child compute the same path without either having to parse the spec.
 *
 * @param {string} cwd
 * @param {string} campaignId
 * @param {string} phase
 * @returns {string}
 */
export function planBootstrapFailurePath(cwd, campaignId, phase) {
  return join(campaignTree(cwd, campaignId), "plans", phase, "bootstrap-failure.json");
}

/**
 * Record a detached planning run's bootstrap failure where its launcher can
 * read it. Best effort: a failure to write this must never replace the
 * failure it was describing.
 *
 * @param {string} cwd
 * @param {string} campaignId
 * @param {string} phase
 * @param {Error} error
 * @returns {void}
 */
export function writePlanBootstrapFailure(cwd, campaignId, phase, error) {
  try {
    const path = planBootstrapFailurePath(cwd, campaignId, phase);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, campaignId, phase, error: error.message }, null, 2)}\n`);
  } catch {
    // Nothing left to do: the caller is already reporting the real failure.
  }
}

/**
 * Watch a freshly detached planning child through its bootstrap window.
 *
 * Returns the recorded failure when the child died inside the window, and
 * null when it is still running at the end of it. A child that exits zero
 * inside the window also reads as no failure: a planning run can legitimately
 * be that fast only by refusing early, and it will have written its own
 * record if it refused.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} failurePath
 * @param {{windowMs?: number, pollMs?: number}} [options]
 * @returns {Promise<{error: string}|null>}
 */
export async function watchPlanBootstrap(child, failurePath, { windowMs = PLAN_BOOTSTRAP_WINDOW_MS, pollMs = PLAN_BOOTSTRAP_POLL_MS } = {}) {
  let exitCode = /** @type {number|null|undefined} */ (undefined);
  let exited = false;
  child.once("exit", (code) => { exited = true; exitCode = code; });
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    // Typed checks, not `!== null`: a child object that never carried the
    // property at all would otherwise read as one that has already exited.
    if (exited || typeof child.exitCode === "number" || typeof child.signalCode === "string") {
      const recorded = readPlanBootstrapFailure(failurePath);
      if (recorded) return recorded;
      const code = typeof exitCode === "number" ? exitCode : child.exitCode;
      if (typeof code === "number" && code !== 0) return { error: `the detached planning process exited ${code} without recording a reason` };
      const signal = child.signalCode;
      if (typeof signal === "string") return { error: `the detached planning process was killed by ${signal} without recording a reason` };
      return null;
    }
    await delay(pollMs);
  }
  return null;
}

/** @param {string} failurePath @returns {{error: string}|null} */
function readPlanBootstrapFailure(failurePath) {
  try {
    const record = JSON.parse(readFileSync(failurePath, "utf8"));
    return typeof record?.error === "string" ? { error: record.error } : null;
  } catch {
    return null;
  }
}

/**
 * `--package implementation|exploratory`. Implementation is the default and
 * the only mode there was: nodes sized by their write set. Exploratory sizes
 * by what a node reads, accepts a one-file write set as the normal shape of a
 * finding, and reports a node whose read surface dwarfs its siblings'.
 *
 * @param {unknown} value
 * @returns {import("../plan/sizing.mjs").PackageMode}
 */
export function packageModeOf(value) {
  if (value === undefined) return "implementation";
  if (value === "implementation" || value === "exploratory") return value;
  throw new Error(`--package must be implementation or exploratory: ${String(value)}`);
}
