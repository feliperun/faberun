#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { resumeRun } from "../src/engine/resume.mjs";
import { runContract } from "../src/engine/scheduler.mjs";
import { preflightContract } from "../src/engine/live-preflight.mjs";
import { acquire as acquireControllerLock, lockPath, processStartToken as computeProcessStartToken } from "../src/run/lock.mjs";
import { writeJsonAtomic } from "../src/run/store.mjs";
import { createAttemptWorktree } from "../src/repo/worktree.mjs";
import { RUNS_DIR_NAME, runsRoot } from "../src/run/paths.mjs";
import { compareEvalReports, mergeEvalRunSources, noiseBandOf, projectEvalIndicators, readEvalRunSources, renderEvalComparisonReport } from "./metrics.mjs";
import { discoverCaseIds, loadCase, materializeCase, safeJoin, withEnvOverlay, withModelBinsUnavailable, withScopedFaberunHome } from "./case.mjs";
import { applyDiscriminator, compareGc, compareIntegration, compareNode, comparePreflight, normalizedSteps } from "./compare.mjs";
import { runValidateGolden, runVerifyFixtures } from "./golden.mjs";
import { EVALS_ROOT, UsageError, usageError } from "./paths.mjs";
import { applyPlanDiscriminator, runPlanCase } from "./plan-case.mjs";
import { plannerArm, qualifyingSessionCampaigns, sessionArm } from "./planner/arm.mjs";
import { resilienceCases } from "./resilience.mjs";

/** The repository root, one level above `evals/`, that the comparative arm reads every campaign record under. */
const REPO_ROOT = resolve(EVALS_ROOT, "..");

/** @typedef {Record<string, unknown>} JsonObject */

/** @typedef {{id: string, title: string, proves: string, ok: boolean, failures: string[]}} CaseOutcome */

/** @type {import("node:util").ParseArgsOptionsConfig} */
const CLI_OPTIONS = {
  class: { type: "string" },
  case: { type: "string" },
  repeat: { type: "string" },
  json: { type: "boolean" },
  "assert-no-model": { type: "boolean" },
  "verify-discriminating": { type: "boolean" },
};

/**
 * The eval classes and the case kind each one names, matched against
 * `caseKindOf`. A class is a case *kind*, not a per-case field — the kind is
 * already on every spec, so scoping needs no case-file change. `deterministic`
 * keeps meaning the contract-driven cases it always named; `planner` names the
 * command-driven ones, the expensive class this runner used to execute
 * unfiltered under `--class deterministic` on every pull request.
 *
 * `resilience` is deliberately absent: its cases are generated from the
 * engine's failure-policy declarations (`evals/resilience.mjs`) rather than
 * discovered from disk, so it has no case kind to match here.
 *
 * @type {Record<string, "contract" | "command">}
 */
const CLASS_KINDS = {
  deterministic: "contract",
  planner: "command",
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
    const { root, relative } = stepFsRoot(context.workDir, /** @type {string} */ (step.path));
    mkdirSync(safeJoin(root, relative), { recursive: true });
    return;
  }
  if (type === "writeFile") {
    const { root, relative } = stepFsRoot(context.workDir, /** @type {string} */ (step.path));
    const target = safeJoin(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, /** @type {string} */ (step.content ?? ""));
    return;
  }
  throw new Error(`unknown setup step type: ${type}`);
}

/**
 * A `mkdirp`/`writeFile` step's path, split from the root it is relative to.
 * A case that stages fixture *run state* (an old run directory GC should
 * find) spells that intent as a leading `.runs/`, the same literal every
 * case file used before R2 moved the runs root out of the repository; this
 * keeps that spelling meaningful by resolving it against `runsRoot(workDir)`
 * instead of `workDir` itself, while every other step (repository content,
 * such as a fixture `node_modules/`) is unaffected.
 *
 * @param {string} workDir
 * @param {string} path
 * @returns {{root: string, relative: string}}
 */
function stepFsRoot(workDir, path) {
  const prefix = `${RUNS_DIR_NAME}/`;
  if (path === RUNS_DIR_NAME) return { root: runsRoot(workDir), relative: "." };
  if (path.startsWith(prefix)) return { root: runsRoot(workDir), relative: path.slice(prefix.length) };
  return { root: workDir, relative: path };
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
    return await withScopedFaberunHome(async () => {
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
    });
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
  const bandIndex = rest.indexOf("--band");
  const bandPath = bandIndex >= 0 ? rest[bandIndex + 1] : undefined;
  if (bandIndex >= 0 && (bandPath === undefined || bandPath.startsWith("--"))) {
    usageError("--band needs the path of a report written by `--band <report.json>...`");
    return;
  }
  const positionals = rest.filter((arg, index) => arg !== "--json" && index !== bandIndex && index !== bandIndex + 1);
  if (positionals.length !== 2) {
    usageError("--compare needs exactly two report paths: <before.json> <after.json>");
    return;
  }
  const [beforePath, afterPath] = positionals;
  const before = evalIndicatorsOf(JSON.parse(readFileSync(resolve(beforePath), "utf8")));
  const after = evalIndicatorsOf(JSON.parse(readFileSync(resolve(afterPath), "utf8")));
  const bands = bandPath === undefined ? undefined : evalIndicatorsOf(JSON.parse(readFileSync(resolve(bandPath), "utf8")));
  const comparison = compareEvalReports(before, after, bands);
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
  if (argv[0] === "--band") {
    runBand(argv.slice(1));
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
  const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) {
    usageError("--repeat needs a positive integer");
    return;
  }

  const className = /** @type {string|undefined} */ (values.class);
  if (className === undefined && values.case === undefined && !verifyDiscriminatingFlag) {
    usageError("one of --class or --case is required");
    return;
  }
  if (className !== undefined && values.case !== undefined) {
    usageError("use --class or --case, not both");
    return;
  }
  if (className !== undefined && className !== "resilience" && CLASS_KINDS[className] === undefined) {
    usageError(`unknown --class: ${className} (known: ${Object.keys(CLASS_KINDS).join(", ")}, resilience)`);
    return;
  }

  // The resilience class is generated, not discovered: evals/resilience.mjs
  // enumerates one case per failure class the engine's own policy tables
  // declare, so the class tracks those declarations instead of a checked-in
  // copy of them. There is no case.json on disk for discoverCaseIds to find.
  /** @type {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}[]} */
  let loaded;
  if (className === "resilience") {
    loaded = resilienceCases();
  } else {
    let caseIds = discoverCaseIds();
    if (values.case !== undefined) {
      if (!caseIds.includes(/** @type {string} */ (values.case))) {
        usageError(`unknown --case: ${values.case}`);
        return;
      }
      caseIds = [/** @type {string} */ (values.case)];
    }
    loaded = caseIds.map((id) => loadCase(id));
    // `--class` scopes everything a run selects: the pass run and
    // `--verify-discriminating` alike, so the nightly workflow can carry the
    // planner class without it leaking back into an unscoped call.
    if (className !== undefined) loaded = casesOfClass(loaded, className);
  }
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
      const once = () => (caseKindOf(entry.spec) === "command"
        ? runPlanCase(entry, { assertNoModel })
        : runCase(entry, { assertNoModel }));
      outcomes.push(await repeatCase(once, repeat));
    }
    return outcomes;
  };
  const results = await (assertNoModel ? withModelBinsUnavailable(run) : run());

  const ok = results.every((result) => result.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok, cases: results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const repeats = result.repeats > 1 ? ` (${result.passes}/${result.repeats} runs)` : "";
      process.stdout.write(`[${result.ok ? "ok" : "fail"}] ${result.id} · ${result.title}${repeats}\n`);
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

/**
 * The cases of one eval class: the entries whose `caseKindOf` kind is the one
 * `CLASS_KINDS` names for the class. A class that selects zero cases throws:
 * a scheduled job that ran nothing and exited green is exactly the silent
 * failure class scoping exists to keep off the nightly schedule.
 *
 * @template {{spec: Record<string, unknown>}} T
 * @param {T[]} loaded
 * @param {string} className
 * @returns {T[]}
 */
export function casesOfClass(loaded, className) {
  const kind = CLASS_KINDS[className];
  const selected = kind === undefined ? [] : loaded.filter((entry) => caseKindOf(entry.spec) === kind);
  if (selected.length === 0) {
    throw new Error(`--class ${className} selected no cases (from ${loaded.length} discovered)`);
  }
  return selected;
}

/**
 * Run one case `n` times, sequentially (cases share process-global state),
 * and fold the outcomes: ok only when every run is, each failing run's
 * failures prefixed with its ordinal, and `repeats` and `passes` recorded so
 * a flaky case reads as "3 of 5", never as one lucky green.
 *
 * @param {() => Promise<CaseOutcome>} once
 * @param {number} n
 * @returns {Promise<CaseOutcome & {repeats: number, passes: number}>}
 */
export async function repeatCase(once, n) {
  /** @type {CaseOutcome[]} */
  const runs = [];
  for (let index = 0; index < n; index += 1) runs.push(await once());
  const passes = runs.filter((run) => run.ok).length;
  return {
    ...runs[0],
    ok: passes === n,
    failures: runs.flatMap((run, index) => run.failures.map((failure) => (n > 1 ? `[run ${index + 1}/${n}] ${failure}` : failure))),
    repeats: n,
    passes,
  };
}

/**
 * `evals/run.mjs --band <report.json> <report.json>... [--json]`: the noise
 * band per indicator across repeated reports of the same setup (see
 * `noiseBandOf`), to hand to `--compare ... --band <band.json>` so a delta
 * inside it prints as not measured instead of as a number.
 *
 * @param {string[]} rest
 * @returns {void}
 */
function runBand(rest) {
  const asJson = rest.includes("--json");
  const paths = rest.filter((arg) => arg !== "--json");
  if (paths.length < 2) {
    usageError("--band needs at least two report paths from repeated runs of the same setup");
    return;
  }
  const indicators = noiseBandOf(paths.map((path) => JSON.parse(readFileSync(resolve(path), "utf8"))));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, repetitions: paths.length, indicators }, null, 2)}\n`);
    return;
  }
  for (const [name, entry] of Object.entries(indicators)) {
    process.stdout.write(`${name}\n`);
    process.stdout.write(`  band:   ${entry.band === null ? "not measured (fewer than two readings)" : `±${entry.band}`}\n`);
    process.stdout.write(`  median: ${entry.median ?? "no data"} (n=${entry.n})\n`);
  }
}
