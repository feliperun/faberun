/**
 * `plan` argv: run the planning pipeline as successive ordinary runs (draft,
 * review, revise up to a round budget) and freeze the result, or park it
 * contested. This file only owns the wire — `src/plan/pipeline.mjs` owns the
 * sequencing and every decision the pipeline makes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detachArgv, detachSelf, waitForBootstrap } from "./launch.mjs";
import { classifyRunProgress } from "../campaign/chain.mjs";
import { runProgress } from "../engine/supervise.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../engine/runtime-discovery.mjs";
import { validateRuntime } from "../contract/runtime.mjs";
import { delay } from "../util.mjs";
import { runPlanningPipeline } from "../plan/pipeline.mjs";
import { runDirectory } from "../run/paths.mjs";

/** How often a foreground `plan` polls a launched stage's run directory. */
const DEFAULT_POLL_MS = 1_000;

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
 * @param {string} target
 * @param {{campaign?: string, phase?: string, "review-rounds"?: string, "approve-below"?: string, "runtime-defaults"?: string, runtimes?: string, detach?: boolean, json?: boolean}} values
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

  if (values.detach === true) {
    const argv = ["plan", specPath, "--campaign", campaignId, "--phase", phase, "--review-rounds", String(reviewRounds)];
    if (approveBelow !== undefined) argv.push("--approve-below", approveBelow);
    if (values["runtime-defaults"] !== undefined) argv.push("--runtime-defaults", values["runtime-defaults"]);
    if (typeof values.runtimes === "string" && values.runtimes) argv.push("--runtimes", resolve(values.runtimes));
    const child = detachArgv(argv);
    if (child.pid === undefined) throw new Error("detached plan has no pid");
    process.stdout.write(`[plan] detached · pid ${child.pid} · ${specPath}\n`);
    return;
  }

  const result = await runPlanningPipeline({
    specPath,
    campaignId,
    phase,
    reviewRounds,
    approveBelow,
    runtimeDefaults,
    runtimes,
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

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.status === "contested") {
    process.stdout.write(`[plan] ${campaignId} phase ${phase} contested after ${result.round} round(s) · ${result.findings.length} finding(s) · ${result.planPath}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[plan] ${campaignId} phase ${phase} frozen · approved ${result.approved} · ${result.contractPath}\n`);
}
