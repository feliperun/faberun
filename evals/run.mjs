#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resumeRun } from "../src/engine/resume.mjs";
import { runContract } from "../src/engine/scheduler.mjs";
import { preflightContract } from "../src/engine/live-preflight.mjs";
import { acquire as acquireControllerLock, lockPath, processStartToken as computeProcessStartToken } from "../src/run/lock.mjs";
import { writeJsonAtomic } from "../src/run/store.mjs";
import { createAttemptWorktree } from "../src/repo/worktree.mjs";
import { campaignDir } from "../src/campaign/layout.mjs";
import { readJournal } from "../src/campaign/journal.mjs";
import { delay } from "../src/util.mjs";
import { compareEvalReports, mergeEvalRunSources, projectEvalIndicators, readEvalRunSources, renderEvalComparisonReport } from "./metrics.mjs";
import { discoverCaseIds, loadCase, materializeCase, materializePlanCase, safeJoin, withEnvOverlay, withModelBinsUnavailable } from "./case.mjs";
import { applyDiscriminator, compareGc, compareIntegration, compareNode, comparePreflight, normalizedSteps } from "./compare.mjs";
import { runValidateGolden, runVerifyFixtures } from "./golden.mjs";
import { EVALS_ROOT, UsageError, usageError } from "./paths.mjs";
import { plannerArm, qualifyingSessionCampaigns, sessionArm } from "./planner/arm.mjs";

/** The repository root, one level above `evals/`, that the comparative arm reads every campaign record under. */
const REPO_ROOT = resolve(EVALS_ROOT, "..");

/** The CLI entry a command-kind case's `invoke`/`spawnDetached` steps spawn, exactly as `src/cli/launch.mjs`'s own detached children do. */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/** @typedef {Record<string, unknown>} JsonObject */

/** @type {import("node:util").ParseArgsOptionsConfig} */
const CLI_OPTIONS = {
  class: { type: "string" },
  case: { type: "string" },
  json: { type: "boolean" },
  "assert-no-model": { type: "boolean" },
  "verify-discriminating": { type: "boolean" },
};

/**
 * @param {Record<string, unknown>} step
 * @param {{workDir: string, contractPath: string, runDir: string}} context
 * @returns {Promise<void>}
 */
async function executeStep(step, context) {
  const type = step.type;
  const env = /** @type {Record<string, unknown>|undefined} */ (step.env);
  const expectError = typeof step.expectError === "string" ? step.expectError : null;

  if (type === "run" || type === "resume") {
    let rejected = null;
    try {
      await withEnvOverlay(env, () => (
        type === "run"
          ? runContract(context.contractPath)
          : resumeRun(context.runDir, /** @type {Record<string, unknown>} */ (step.options ?? {}))
      ));
    } catch (error) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }
    if (expectError) {
      if (!rejected) throw new Error(`setup step "${type}" was expected to reject matching /${expectError}/, but it resolved`);
      if (!new RegExp(expectError, "iu").test(rejected.message)) {
        throw new Error(`setup step "${type}" rejected with "${rejected.message}", which does not match /${expectError}/`);
      }
      return;
    }
    if (rejected) throw rejected;
    return;
  }
  if (type === "holdControllerLock") {
    acquireControllerLock(context.runDir, { pid: process.pid });
    return;
  }
  if (type === "writeLock") {
    // A raw, unmediated write to controller.lock: the only way to plant a
    // record acquire() itself would refuse to install over a live holder.
    // Writing this process's own pid with a token that does not match its
    // own live token stands in for a controller pid later reused by a
    // different, unrelated live process — the fact the takeover logic keys
    // on rather than pid liveness alone.
    const processStartTokenValue = step.processStartToken === undefined
      ? computeProcessStartToken(process.pid)
      : (typeof step.processStartToken === "string" ? step.processStartToken : null);
    writeJsonAtomic(lockPath(context.runDir), {
      schemaVersion: 1,
      pid: process.pid,
      processStartToken: processStartTokenValue,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
    });
    return;
  }
  if (type === "rewindNodeToRunning") {
    // Simulates a controller that died with this node's provider invocation
    // already finished on disk but never processed: the node's own status is
    // wound back to "running" with no result or gate verdict, exactly as
    // test/helpers.mjs's `orphan()` does, so resume's recovery has to decide
    // what an invocation it never dispatched itself actually produced.
    const nodeId = /** @type {string} */ (step.node);
    const nodePath = join(context.runDir, "nodes", `${nodeId}.json`);
    const state = JSON.parse(readFileSync(nodePath, "utf8"));
    writeJsonAtomic(nodePath, { ...state, status: "running", phase: "worker", result: null, gate: null });
    return;
  }
  if (type === "recreateAttemptWorktree") {
    // A node already integrated has had its attempt worktree removed by the
    // sealing step; recovering it as a still-running orphan needs that
    // worktree back so the recovered result can be re-verified and re-sealed,
    // exactly as test/helpers.mjs's `ensureAttemptWorktree()` does. A no-op
    // when the worktree was never removed.
    const nodeId = /** @type {string} */ (step.node);
    const nodePath = join(context.runDir, "nodes", `${nodeId}.json`);
    const state = JSON.parse(readFileSync(nodePath, "utf8"));
    if (state.worktree?.status === "removed" && state.worktree.branch) {
      const recreated = createAttemptWorktree({
        repo: context.workDir,
        runDir: context.runDir,
        runId: basename(context.runDir),
        nodeId,
        attempt: state.attempt,
        base: state.worktree.baseSha,
      });
      writeJsonAtomic(nodePath, {
        ...state,
        worktree: { ...state.worktree, status: "ready", path: recreated.path, commit: recreated.commit },
      });
    }
    return;
  }
  if (type === "preflight") {
    // The static preflight probe (probeRuntime, never a recording) reports
    // every reachable runtime's own availability and never throws on a bad
    // one — unlike run/resume, which refuse to dispatch at all when any
    // reachable runtime cannot be probed. Written to a fixed path so a case
    // with no run/resume step at all can still assert on it.
    const results = await preflightContract(context.contractPath, { static: true });
    writeFileSync(join(context.workDir, "preflight.json"), JSON.stringify(results, null, 2));
    return;
  }
  if (type === "mkdirp") {
    mkdirSync(safeJoin(context.workDir, /** @type {string} */ (step.path)), { recursive: true });
    return;
  }
  if (type === "writeFile") {
    const target = safeJoin(context.workDir, /** @type {string} */ (step.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, /** @type {string} */ (step.content ?? ""));
    return;
  }
  throw new Error(`unknown setup step type: ${type}`);
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}} loaded
 * @param {{assertNoModel: boolean, stepsOverride?: Record<string, unknown>[], patch?: {contractPatch?: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}}} options
 * @returns {Promise<{id: string, title: string, proves: string, ok: boolean, failures: string[]}>}
 */
async function runCase({ caseDir, spec, expected }, options) {
  const id = /** @type {string} */ (spec.id);
  const title = /** @type {string} */ (spec.title ?? id);
  const proves = /** @type {string} */ (spec.proves ?? "");

  if (options.assertNoModel) {
    const nonReplay = Object.entries(/** @type {Record<string, {harness?: string}>} */ ((/** @type {{runtimes?: unknown}} */ (spec.contract ?? {})).runtimes ?? {}))
      .filter(([, runtime]) => runtime.harness !== "replay")
      .map(([runtimeId, runtime]) => `${runtimeId} (${runtime.harness})`);
    if (nonReplay.length) {
      return { id, title, proves, ok: false, failures: [`--assert-no-model: non-replay runtime(s): ${nonReplay.join(", ")}`] };
    }
  }

  try {
    const { workDir, contractPath, runDir, contract } = materializeCase(caseDir, spec, options.patch);
    const steps = options.stepsOverride ?? normalizedSteps(spec);
    for (const step of steps) await executeStep(/** @type {Record<string, unknown>} */ (step), { workDir, contractPath, runDir });

    const expectedNodes = /** @type {Record<string, Record<string, unknown>>} */ (expected.nodes ?? {});
    const failures = [
      ...Object.entries(expectedNodes).flatMap(([nodeId, expectedNode]) => compareNode(nodeId, expectedNode, runDir)),
      ...(expected.preflight ? comparePreflight(/** @type {Record<string, unknown>} */ (expected.preflight), workDir) : []),
      ...(expected.gc ? compareGc(/** @type {{removed?: string[], kept?: string[], events?: {path: string, reason: string}[]}} */ (expected.gc), workDir) : []),
      ...compareIntegration(/** @type {Record<string, unknown>|undefined} */ (expected.integration), {
        repo: workDir,
        runDir,
        runId: /** @type {string} */ (contract.id),
      }),
    ];
    return { id, title, proves, ok: failures.length === 0, failures };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, title, proves, ok: false, failures: [`case threw: ${message}`] };
  }
}

/**
 * Whether a case's `case.json` is contract-driven (the original deterministic
 * shape) or command-driven (drives `faberun plan` itself through `src/cli.mjs`
 * with no contract of its own).
 *
 * @param {Record<string, unknown>} spec
 * @returns {"contract"|"command"}
 */
function caseKindOf(spec) {
  if (spec.contract !== undefined) return "contract";
  if (spec.command !== undefined) return "command";
  throw new Error(`case ${spec.id} declares neither "contract" nor "command"`);
}

/**
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, unknown>[]}
 */
function normalizedPlanSteps(spec) {
  if (Array.isArray(spec.setup) && spec.setup.length) return spec.setup;
  const command = /** @type {{argv: string[], env?: Record<string, string>}} */ (spec.command);
  return [{ type: "invoke", argv: command.argv, env: command.env }];
}

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {Record<string, string>|undefined} env
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
function runNodeToCompletion(argv, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolvePromise({ exitCode, signal, stdout, stderr }));
  });
}

/**
 * A command-kind case's own setup steps: real child processes, since proving
 * a detached pipeline survives its launcher (D25) needs a launcher that is
 * genuinely a separate, killable OS process rather than an in-process call
 * this same eval runner made.
 *
 * @param {Record<string, unknown>} step
 * @param {{workDir: string, processes: Map<string, import("node:child_process").ChildProcess>}} context
 * @returns {Promise<void>}
 */
async function executePlanStep(step, context) {
  const type = step.type;
  if (type === "invoke") {
    await runNodeToCompletion(/** @type {string[]} */ (step.argv), context.workDir, /** @type {Record<string, string>|undefined} */ (step.env));
    return;
  }
  if (type === "spawnDetached") {
    const name = /** @type {string} */ (step.as);
    const child = spawn(process.execPath, [CLI_ENTRY, ...(/** @type {string[]} */ (step.argv))], {
      cwd: context.workDir,
      env: { ...process.env, ...(/** @type {Record<string, string>|undefined} */ (step.env)) },
      stdio: "ignore",
    });
    context.processes.set(name, child);
    return;
  }
  if (type === "waitForPath") {
    const target = safeJoin(context.workDir, /** @type {string} */ (step.path));
    const timeoutMs = typeof step.timeoutMs === "number" ? step.timeoutMs : 60_000;
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(target)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${step.path} to appear under ${context.workDir}`);
      await delay(50);
    }
    return;
  }
  if (type === "killProcess") {
    const name = /** @type {string} */ (step.as);
    const child = context.processes.get(name);
    if (!child) throw new Error(`plan setup step "killProcess" names an unknown process "${name}"`);
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, /** @type {NodeJS.Signals} */ (step.signal ?? "SIGKILL"));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
      }
    }
    return;
  }
  throw new Error(`unknown plan setup step type: ${type}`);
}

/**
 * Compare a command-kind case's outcome against its `expected.json`:
 * `expectPaths` (files that must or must not exist under the materialized
 * workspace), `plan` (JSON fields of a plan.json at a declared path), and
 * `journal` (campaign journal entries that must be present) — the three
 * facts a `faberun plan` invocation leaves behind that no node snapshot
 * describes, since there is no contract and no run for most of a plan
 * command's own scenarios.
 *
 * @param {Record<string, unknown>} expected
 * @param {{workDir: string, campaignId: string}} context
 * @returns {string[]}
 */
function comparePlanExpectations(expected, context) {
  /** @type {string[]} */
  const failures = [];
  const paths = /** @type {{present?: string[], absent?: string[]}} */ (expected.expectPaths ?? {});
  for (const relativePath of paths.present ?? []) {
    if (!existsSync(join(context.workDir, relativePath))) failures.push(`expected path present: ${relativePath}`);
  }
  for (const relativePath of paths.absent ?? []) {
    if (existsSync(join(context.workDir, relativePath))) failures.push(`expected path absent: ${relativePath}`);
  }
  const plan = /** @type {{path: string, fields?: Record<string, unknown>}|undefined} */ (expected.plan);
  if (plan) {
    const planPath = join(context.workDir, plan.path);
    if (!existsSync(planPath)) {
      failures.push(`plan: ${plan.path} does not exist`);
    } else {
      const actual = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(planPath, "utf8")));
      for (const [key, value] of Object.entries(plan.fields ?? {})) {
        if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
          failures.push(`plan.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
        }
      }
    }
  }
  const journalEntries = /** @type {{type: string, questionId?: string}[]|undefined} */ (expected.journal);
  if (journalEntries) {
    const journal = readJournal(campaignDir(join(context.workDir, ".runs"), context.campaignId));
    for (const entry of journalEntries) {
      const found = journal.some((record) => record.type === entry.type && (entry.questionId === undefined || record.questionId === entry.questionId));
      if (!found) failures.push(`journal: no entry matching ${JSON.stringify(entry)}`);
    }
  }
  return failures;
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}} loaded
 * @param {{assertNoModel: boolean, stepsOverride?: Record<string, unknown>[], patch?: {recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}}} options
 * @returns {Promise<{id: string, title: string, proves: string, ok: boolean, failures: string[]}>}
 */
async function runPlanCase({ caseDir, spec, expected }, options) {
  const id = /** @type {string} */ (spec.id);
  const title = /** @type {string} */ (spec.title ?? id);
  const proves = /** @type {string} */ (spec.proves ?? "");

  if (options.assertNoModel) {
    const nonReplay = Object.entries(/** @type {Record<string, {harness?: string}>} */ (spec.runtimes ?? {}))
      .filter(([, runtime]) => runtime.harness !== "replay")
      .map(([runtimeId, runtime]) => `${runtimeId} (${runtime.harness})`);
    if (nonReplay.length) {
      return { id, title, proves, ok: false, failures: [`--assert-no-model: non-replay runtime(s): ${nonReplay.join(", ")}`] };
    }
  }

  try {
    const { workDir, campaignId } = materializePlanCase(caseDir, spec, options.patch);
    const context = { workDir, campaignId, processes: /** @type {Map<string, import("node:child_process").ChildProcess>} */ (new Map()) };
    const steps = options.stepsOverride ?? normalizedPlanSteps(spec);
    for (const step of steps) await executePlanStep(step, context);
    const failures = comparePlanExpectations(expected, context);
    return { id, title, proves, ok: failures.length === 0, failures };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, title, proves, ok: false, failures: [`case threw: ${message}`] };
  }
}

/**
 * A command-kind case's discriminator: restricted to mutating a recording
 * (`patchRecordingErrorCode`/`patchRecordingEnvelopeField`, the same two
 * types `applyDiscriminator` supports), since there is no contract to patch
 * and no setup-step list a `removeSetupStep` could shrink without also
 * erasing the command invocation itself.
 *
 * @param {Record<string, unknown>} spec
 * @returns {{recordingPatch: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})}}
 */
function applyPlanDiscriminator(spec) {
  const caseId = /** @type {string} */ (spec.id);
  const discriminator = /** @type {Record<string, unknown>|undefined} */ (spec.discriminator);
  if (!discriminator || typeof discriminator !== "object") throw new Error(`case ${caseId} has no discriminator block`);

  if (discriminator.type === "patchRecordingErrorCode") {
    const runtime = discriminator.runtime;
    const code = discriminator.code;
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingErrorCode" needs a "runtime"`);
    if (typeof code !== "string" || !code) throw new Error(`discriminator "patchRecordingErrorCode" needs a "code"`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { recordingPatch: { runtime, index, code } };
  }

  if (discriminator.type === "patchRecordingEnvelopeField") {
    const runtime = discriminator.runtime;
    const path = /** @type {(string|number)[]} */ (discriminator.path);
    if (typeof runtime !== "string" || !runtime) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "runtime"`);
    if (!Array.isArray(path) || path.length === 0) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a non-empty "path" array`);
    const remove = discriminator.remove === true;
    if (!remove && !("value" in discriminator)) throw new Error(`discriminator "patchRecordingEnvelopeField" needs a "value" (or "remove": true)`);
    const index = typeof discriminator.index === "number" ? discriminator.index : 0;
    return { recordingPatch: { runtime, index, path, value: discriminator.value, remove } };
  }

  throw new Error(`unknown discriminator type for a command case: ${discriminator.type}`);
}

/**
 * @param {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}[]} loaded
 * @returns {Promise<{id: string, ok: boolean, failures: string[]}[]>}
 */
async function verifyDiscriminating(loaded) {
  const outcomes = [];
  for (const entry of loaded) {
    const id = /** @type {string} */ (entry.spec.id);

    if (caseKindOf(entry.spec) === "command") {
      let mutation;
      try {
        mutation = applyPlanDiscriminator(entry.spec);
      } catch (error) {
        outcomes.push({ id, ok: false, failures: [error instanceof Error ? error.message : String(error)] });
        continue;
      }
      const result = await runPlanCase(entry, { assertNoModel: false, patch: mutation });
      if (result.ok) {
        outcomes.push({ id, ok: false, failures: [`case still passes with its discriminator mutation (${JSON.stringify(entry.spec.discriminator)}) applied`] });
      } else {
        outcomes.push({ id, ok: true, failures: [] });
      }
      continue;
    }

    let mutation;
    try {
      mutation = applyDiscriminator(entry.spec, /** @type {Record<string, unknown>|undefined} */ (entry.spec.discriminator));
    } catch (error) {
      outcomes.push({ id, ok: false, failures: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    const result = await runCase(entry, {
      assertNoModel: false,
      stepsOverride: mutation.steps,
      patch: { contractPatch: mutation.contractPatch, recordingPatch: mutation.recordingPatch },
    });
    if (result.ok) {
      outcomes.push({ id, ok: false, failures: [`case still passes with its discriminator mutation (${JSON.stringify(entry.spec.discriminator)}) applied`] });
    } else {
      outcomes.push({ id, ok: true, failures: [] });
    }
  }
  return outcomes;
}

/**
 * A report file on disk is either a bare indicator map (the `EvalReport`
 * shape `projectEvalIndicators` returns) or that same map wrapped with a
 * `provenance` block (what `--project` writes and what `evals/baseline.json`
 * and `evals/fixtures/*.json` carry). Either way, `compareEvalReports` only
 * ever wants the indicator map.
 *
 * @param {unknown} parsed
 * @returns {JsonObject}
 */
function evalIndicatorsOf(parsed) {
  const object = /** @type {JsonObject} */ (parsed);
  return object && typeof object.indicators === "object" && object.indicators !== null ? /** @type {JsonObject} */ (object.indicators) : object;
}

/**
 * `evals/run.mjs --compare <before.json> <after.json> [--json]`: compare two
 * already-projected eval reports and print the result.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runCompare(rest) {
  const asJson = rest.includes("--json");
  const positionals = rest.filter((arg) => arg !== "--json");
  if (positionals.length !== 2) {
    usageError("--compare needs exactly two report paths: <before.json> <after.json>");
    return;
  }
  const [beforePath, afterPath] = positionals;
  const before = evalIndicatorsOf(JSON.parse(readFileSync(resolve(beforePath), "utf8")));
  const after = evalIndicatorsOf(JSON.parse(readFileSync(resolve(afterPath), "utf8")));
  const comparison = compareEvalReports(before, after);
  process.stdout.write(asJson ? `${JSON.stringify({ schemaVersion: 1, indicators: comparison }, null, 2)}\n` : renderEvalComparisonReport(comparison));
}

/**
 * `evals/run.mjs --project <runDir>... [--campaign <id>] [--note <text>] [--json]`:
 * project indicators straight from one or more runs' own `events.jsonl`/
 * `usage.jsonl` (concatenated when more than one directory is given — a
 * campaign run across several sequential orchestrator attempts has no
 * single directory holding every record) and print the result together with
 * its provenance, so a report on disk can be regenerated and audited
 * against the run directories it claims to measure instead of trusted as a
 * bare number.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runProject(rest) {
  const asJson = rest.includes("--json");
  /** @type {string|null} */
  let campaign = null;
  /** @type {string|null} */
  let note = null;
  /** @type {string[]} */
  const runDirs = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") continue;
    if (arg === "--campaign") {
      index += 1;
      campaign = rest[index] ?? null;
      continue;
    }
    if (arg === "--note") {
      index += 1;
      note = rest[index] ?? null;
      continue;
    }
    runDirs.push(arg);
  }
  if (runDirs.length === 0) {
    usageError("--project needs at least one run directory");
    return;
  }
  const resolvedRunDirs = runDirs.map((runDir) => resolve(runDir));
  const merged = mergeEvalRunSources(resolvedRunDirs.map((runDir) => readEvalRunSources(runDir)));
  const indicators = projectEvalIndicators(merged);
  const report = {
    schemaVersion: 1,
    provenance: { campaign, runIds: resolvedRunDirs.map((runDir) => basename(runDir)), runDirs: resolvedRunDirs, generatedAt: new Date().toISOString(), note },
    indicators,
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`provenance: ${JSON.stringify(report.provenance)}\n`);
  for (const [name, indicator] of Object.entries(indicators)) {
    process.stdout.write(`${name}: ${JSON.stringify(/** @type {JsonObject} */ (indicator).value)} (n=${/** @type {JsonObject} */ (indicator).count})\n`);
  }
}

/**
 * `evals/run.mjs --arm session|planner [--json]`: project the comparative
 * arm's session side (from each campaign's `docs/campaigns/<id>/ledger`
 * directory) or planner side (from `evals/planner/reports/<id>.json`) and
 * write it to
 * `evals/planner/{session,planner}-arm.json`, in the same
 * `{schemaVersion, provenance, indicators}` shape `--project` writes, so
 * `--compare session-arm.json planner-arm.json` works unmodified.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runArm(rest) {
  const asJson = rest.includes("--json");
  const side = rest.find((arg) => arg !== "--json");
  if (side !== "session" && side !== "planner") {
    usageError('--arm needs "session" or "planner"');
    return;
  }
  if (side === "planner") {
    const report = plannerArm({ repoRoot: REPO_ROOT });
    if (report.campaigns.length === 0) {
      process.stderr.write(
        "no planner reports found under evals/planner/reports/ -- run `faberun plan` against a campaign's REQUIREMENTS.md and save the report there first (see evals/README.md's \"Comparative arm\" section)\n",
      );
      process.exitCode = 1;
      return;
    }
    const outPath = join(EVALS_ROOT, "planner", "planner-arm.json");
    writeJsonAtomic(outPath, report);
    if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`planner arm written to ${outPath} (${report.campaigns.length} report(s))\n`);
    return;
  }
  const report = sessionArm({ repoRoot: REPO_ROOT });
  const outPath = join(EVALS_ROOT, "planner", "session-arm.json");
  writeJsonAtomic(outPath, report);
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`session arm written to ${outPath} (${report.campaigns.length} campaign(s))\n`);
}

/**
 * `evals/run.mjs --validate-planner-arm --min <n> [--json]`: fail unless at
 * least `n` campaigns qualify for the comparative arm (a structured
 * `REQUIREMENTS.md` and a preserved ledger) -- proof there is enough session
 * material for a planner-side comparison to mean anything, independent of
 * whether any planner report has been saved yet.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runValidatePlannerArm(rest) {
  const asJson = rest.includes("--json");
  const minIndex = rest.indexOf("--min");
  if (minIndex === -1 || rest[minIndex + 1] === undefined) {
    usageError("--validate-planner-arm needs --min <n>");
    return;
  }
  const min = Number(rest[minIndex + 1]);
  if (!Number.isInteger(min) || min < 0) {
    usageError(`--min must be a non-negative integer: ${rest[minIndex + 1]}`);
    return;
  }
  const campaignIds = qualifyingSessionCampaigns({ repoRoot: REPO_ROOT });
  const ok = campaignIds.length >= min;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, min, count: campaignIds.length, campaigns: campaignIds }, null, 2)}\n`);
  } else {
    process.stdout.write(`${campaignIds.length}/${min} required campaigns qualify for the comparative arm\n`);
    for (const id of campaignIds) process.stdout.write(`  ${id}\n`);
  }
  if (!ok) process.exitCode = 1;
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] === "--compare") {
    runCompare(argv.slice(1));
    return;
  }
  if (argv[0] === "--project") {
    runProject(argv.slice(1));
    return;
  }
  if (argv[0] === "--validate-golden") {
    runValidateGolden(argv.slice(1));
    return;
  }
  if (argv[0] === "--verify-fixtures") {
    runVerifyFixtures(argv.slice(1));
    return;
  }
  if (argv[0] === "--arm") {
    runArm(argv.slice(1));
    return;
  }
  if (argv[0] === "--validate-planner-arm") {
    runValidatePlannerArm(argv.slice(1));
    return;
  }
  /** @type {{values: Record<string, unknown>}} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: false, strict: true });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
    return;
  }
  const { values } = parsed;
  const assertNoModel = values["assert-no-model"] === true;
  const verifyDiscriminatingFlag = values["verify-discriminating"] === true;
  const asJson = values.json === true;

  if (values.class === undefined && values.case === undefined && !verifyDiscriminatingFlag) {
    usageError("one of --class or --case is required");
    return;
  }
  if (values.class !== undefined && values.class !== "deterministic") {
    usageError(`unknown --class: ${values.class}`);
    return;
  }

  let caseIds = discoverCaseIds();
  if (values.case !== undefined) {
    if (!caseIds.includes(/** @type {string} */ (values.case))) {
      usageError(`unknown --case: ${values.case}`);
      return;
    }
    caseIds = [/** @type {string} */ (values.case)];
  }

  const loaded = caseIds.map((id) => loadCase(id));
  // Cases run one at a time: a step's env overlay and a synthesized
  // controller.lock both mutate process-global state, which parallel cases
  // would otherwise race on and corrupt.
  if (verifyDiscriminatingFlag) {
    const outcomes = await verifyDiscriminating(loaded);
    const ok = outcomes.every((outcome) => outcome.ok);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, cases: outcomes }, null, 2)}\n`);
    } else {
      for (const outcome of outcomes) {
        process.stdout.write(`[${outcome.ok ? "ok" : "fail"}] ${outcome.id}\n`);
        for (const failure of outcome.failures) process.stdout.write(`      ${failure}\n`);
      }
      const passed = outcomes.filter((outcome) => outcome.ok).length;
      process.stdout.write(`${passed}/${outcomes.length} discriminate\n`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }

  const run = async () => {
    const outcomes = [];
    for (const entry of loaded) {
      outcomes.push(caseKindOf(entry.spec) === "command"
        ? await runPlanCase(entry, { assertNoModel })
        : await runCase(entry, { assertNoModel }));
    }
    return outcomes;
  };
  const results = await (assertNoModel ? withModelBinsUnavailable(run) : run());

  const ok = results.every((result) => result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, cases: results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`[${result.ok ? "ok" : "fail"}] ${result.id} · ${result.title}\n`);
      for (const failure of result.failures) process.stdout.write(`      ${failure}\n`);
    }
    const passed = results.filter((result) => result.ok).length;
    process.stdout.write(`${passed}/${results.length} passed\n`);
  }
  if (!ok) process.exitCode = 1;
}

/**
 * Whether this module was launched directly (`node evals/run.mjs ...`)
 * rather than imported — `main()` must run only in the former case, so a
 * test can import the pure projector/comparator functions above without
 * also triggering a CLI run against its own argv.
 *
 * @param {string|undefined} scriptPath
 * @returns {boolean}
 */
function isEvalsRunMain(scriptPath) {
  try {
    return Boolean(scriptPath) && realpathSync(resolve(/** @type {string} */ (scriptPath))) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isEvalsRunMain(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof UsageError) return;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
