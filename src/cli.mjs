#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { modelsCommand } from "./harnesses/catalogue.mjs";
import { bulkReadCommand } from "./engine/bulk-read.mjs";
import { doctorCommand, environmentPreflight, notifyTransportCheck, reachableRuntimes, timeVerificationCommands } from "./host/preflight.mjs";
import { findExecutable } from "./host/platform.mjs";
import { packageName, packageVersion } from "./host/package.mjs";
import { faberunHome } from "./host/home.mjs";
import { reassociateProject } from "./cli/project.mjs";
import { colorLevel, renderBanner, renderUsage, statusToken } from "./cli/brand.mjs";
import { noTransportWarning } from "./notify/index.mjs";
import { renderFindings, renderReport, renderReportJson, renderStatus, renderStatusJson } from "./report/render.mjs";
import { renderNext, renderNextJson } from "./report/next.mjs";

import {
  writeTextAtomic,
} from "./run/store.mjs";
import { runDirectory, runsRoot } from "./run/paths.mjs";
import { migrateRunState } from "./run/migrate.mjs";
import {
  acquire as acquireLock,
  validBootstrapNonce,
} from "./run/lock.mjs";
import { renderRunHandoff } from "./campaign/index.mjs";
import { validateContractForLaunch } from "./campaign/chain.mjs";
import { campaignCli } from "./cli/campaign.mjs";
import { seatCli } from "./cli/seat.mjs";
import { initCommand } from "./cli/init.mjs";
import { setupCommand } from "./cli/setup.mjs";
import { skillsCli } from "./cli/skills.mjs";
import { updateCommand } from "./cli/update.mjs";
import { contractCli, validateContractFile } from "./cli/contract.mjs";
import { specCli } from "./cli/spec.mjs";
import { planCli } from "./cli/plan.mjs";
import { METRICS_OPTIONS, renderCampaignMetrics } from "./campaign/metrics.mjs";
import { runContract } from "./engine/scheduler.mjs";
import { resumeRun } from "./engine/resume.mjs";
import { cancelRun } from "./engine/cancel.mjs";

import { errorMessage } from "./util.mjs";
import { validateContract } from "./contract/index.mjs";
import { setLaunchBaseRef } from "./engine/run-identity.mjs";
import { assertLaunchBaseClean } from "./repo/source-identity.mjs";
import { detachSelf, waitForBootstrap, writeBootstrapFailure } from "./cli/launch.mjs";
import { DEFAULT_SUPERVISE_INTERVAL_SEC, superviseRun } from "./engine/supervise.mjs";
import { preflightContract, reusedDoneWarnings } from "./engine/live-preflight.mjs";

/** @typedef {import("./contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("./contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("./contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("./contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("./contract/index.mjs").RunMetadata} RunMetadata */
/** @typedef {import("./contract/index.mjs").SourceIdentity} SourceIdentity */
/** @typedef {import("./contract/index.mjs").EventRecord} EventRecord */
/** @typedef {import("./contract/index.mjs").Usage} Usage */
/** @typedef {import("./contract/index.mjs").GateResult} GateResult */
/** @typedef {import("./contract/index.mjs").SnapshotError} SnapshotError */
/** @typedef {import("./contract/index.mjs").BoundedScope} BoundedScope */
/** @typedef {import("./run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof acquireLock>} LockHandle */
/** @typedef {import("./harnesses/index.mjs").HarnessRuntime} HarnessRuntime */
/** @typedef {import("./harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("./harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {import("./campaign/index.mjs").Campaign} Campaign */
/** @typedef {{path: string, campaign: Campaign}} CampaignRef */
/** @typedef {import("./engine/lifecycle.mjs").Job} Job */
/** @typedef {import("./engine/lifecycle.mjs").Invocation} Invocation */
/** @typedef {import("./engine/scheduler.mjs").RunOutcome} RunOutcome */
/** @typedef {import("node:child_process").ChildProcess & {bootstrapNonce?: string, bootstrapProcessStartToken?: string|null}} DetachedChild */
/** @typedef {{status?: string, nonce?: string, pid?: number, processStartToken?: string|null, holderId?: string, generation?: number, error?: unknown, runDir?: string}} BootstrapRecord */

/**
 * Whether this process is a detached bootstrap child of the CLI: it carries a
 * launcher-issued nonce *and* this file is what was executed. The second half
 * is why this stays here and not in `engine/detach.mjs` -- `evals/run.mjs` and
 * the tests import `runContract` directly, and an inherited nonce must not make
 * them wait for an acknowledgement nobody will write.
 *
 * @returns {boolean}
 */
export function hasDetachedBootstrapNonce() {
  if (!validBootstrapNonce(process.env.FABERUN_BOOTSTRAP_NONCE)) return false;
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
export const COMMAND_OPTIONS = {
  run: { detach: { type: "boolean" }, "base-ref": { type: "string" } },
  resume: { detach: { type: "boolean" }, node: { type: "string" }, reconcile: { type: "string" }, answer: { type: "string" } },
  supervise: { detach: { type: "boolean" }, interval: { type: "string" } },
  cancel: {},
  preflight: { static: { type: "boolean" }, json: { type: "boolean" }, "time-verification": { type: "boolean" } },
  validate: {},
  status: { json: { type: "boolean" } },
  report: { json: { type: "boolean" } },
  findings: {},
  doctor: { cwd: { type: "string" }, json: { type: "boolean" }, discover: { type: "boolean" } },
  models: { probe: { type: "boolean" }, json: { type: "boolean" } },
  "bulk-read": { question: { type: "string" }, paths: { type: "string", multiple: true }, json: { type: "boolean" } },
  next: { cwd: { type: "string" }, json: { type: "boolean" } },
  update: { check: { type: "boolean" }, json: { type: "boolean" } },
  project: { from: { type: "string" } },
  migrate: { cwd: { type: "string" } },
  setup: { yes: { type: "boolean" }, harnesses: { type: "string" }, worker: { type: "string" }, judge: { type: "string" }, "no-skill": { type: "boolean" }, json: { type: "boolean" } },
  init: { cwd: { type: "string" }, yes: { type: "boolean" }, "no-skill": { type: "boolean" }, agentkit: { type: "boolean" }, greenfield: { type: "boolean" }, stable: { type: "boolean" }, json: { type: "boolean" } },
  metrics: METRICS_OPTIONS,
  plan: {
    campaign: { type: "string" },
    phase: { type: "string" },
    "review-rounds": { type: "string" },
    "approve-below": { type: "string" },
    "runtime-defaults": { type: "string" },
    runtimes: { type: "string" },
    verification: { type: "string" },
    detach: { type: "boolean" },
    json: { type: "boolean" },
  },
};

/**
 * Strict per-command parsing: unknown options, missing positionals, and extra
 * positionals are rejected. Flags are scoped to the commands that declare them.
 *
 * @param {string[]} argv
 * @param {boolean} [quiet]
 * @returns {{command: string, target: string|undefined, values: Record<string, unknown>}|null}
 */
function parseCli(argv, quiet = false) {
  const [command, ...rest] = argv;
  if (!command || !COMMAND_OPTIONS[command]) return null;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: COMMAND_OPTIONS[command], allowPositionals: true, strict: true });
  } catch (error) {
    if (!quiet) process.stderr.write(`${errorMessage(error)}\n`);
    return null;
  }
  if (parsed.positionals.length > 1) return null;
  if (command === "models" && parsed.positionals.length !== 0) return null;
  if (command === "bulk-read" && parsed.positionals.length !== 0) return null;
  if (command === "next" && parsed.positionals.length !== 0) return null;
  if (command === "update" && parsed.positionals.length !== 0) return null;
  if (command === "setup" && parsed.positionals.length !== 0) return null;
  if (command === "init" && parsed.positionals.length !== 0) return null;
  if (command === "migrate" && parsed.positionals.length !== 0) return null;
  if (command !== "doctor" && command !== "models" && command !== "bulk-read" && command !== "next" && command !== "update" && command !== "setup" && command !== "init" && command !== "migrate" && parsed.positionals.length !== 1) return null;
  return {
    command,
    target: parsed.positionals[0],
    values: /** @type {Record<string, unknown>} */ (parsed.values),
  };
}

/**
 * The retry-in-place options of a `resume` invocation, validated before any
 * lock is taken.
 *
 * @param {Record<string, unknown>} values
 * @returns {{node?: string, reconcile?: string, answer?: {node: string, path: string}}}
 */
function resumeOptionsOf(values) {
  const node = typeof values.node === "string" && values.node ? values.node : undefined;
  const reconcile = typeof values.reconcile === "string" && values.reconcile ? values.reconcile : undefined;
  const answer = answerOf(values.answer);
  // `--node` and `--answer` both select the retry closure; two different
  // targets is a contradiction, not a union, so it is refused before anything
  // is spawned or locked.
  if (node && answer && node !== answer.node) {
    throw new Error(`--answer ${answer.node} conflicts with --node ${node}`);
  }
  return { node, reconcile, answer };
}

/**
 * `--answer <node-id>=<path>`, split on the first `=`. A malformed value —
 * no `=`, an empty node id, or an empty path — is refused before anything is
 * spawned.
 *
 * @param {unknown} value
 * @returns {{node: string, path: string}|undefined}
 */
function answerOf(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new Error("--answer must be <node-id>=<path>");
  const eq = value.indexOf("=");
  if (eq < 0) throw new Error("--answer must be <node-id>=<path>");
  const node = value.slice(0, eq);
  const path = value.slice(eq + 1);
  if (!node) throw new Error("--answer node id must not be empty");
  if (!path) throw new Error("--answer path must not be empty");
  return { node, path };
}

/**
 * `supervise --interval`, in seconds. Rejected rather than defaulted when it
 * is not a positive number: a scheduler passing a typo should hear about it,
 * not silently get a different cadence than the one it asked for.
 *
 * @param {unknown} value
 * @returns {number}
 */
function superviseIntervalOf(value) {
  if (value === undefined) return DEFAULT_SUPERVISE_INTERVAL_SEC;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--interval must be a positive number of seconds: ${String(value)}`);
  return seconds;
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv.length === 0 || HELP_FLAGS.has(argv[0])) { help(); return; }
  if (VERSION_FLAGS.has(argv[0])) { process.stdout.write(`${packageName()} ${packageVersion()}\n`); return; }
  if (argv[0] === "campaign") { await campaignCli(argv.slice(1)); return; }
  // `supervise campaign <id>` is the campaign-level watchdog; `campaign
  // supervise <id>` is the same operation reached through the campaign verb.
  if (argv[0] === "supervise" && argv[1] === "campaign") { await campaignCli(["supervise", ...argv.slice(2)]); return; }
  if (argv[0] === "seat") { seatCli(argv.slice(1)); return; }
  if (argv[0] === "skills") { skillsCli(argv.slice(1)); return; }
  if (argv[0] === "contract") { contractCli(argv.slice(1)); return; }
  if (argv[0] === "spec") { specCli(argv.slice(1)); return; }
  const parsed = parseCli(argv);
  if (!parsed) { usage(); return; }
  const { command, values } = parsed;
  const target = parsed.target;
  if (command === "doctor") {
    const ok = await doctorCommand(target, {
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      json: values.json === true,
      discover: values.discover === true,
    });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "models") {
    await modelsCommand({ probe: values.probe === true, json: values.json === true });
    return;
  }
  if (command === "bulk-read") {
    await bulkReadCommand({ question: values.question, paths: values.paths, json: values.json === true });
    return;
  }
  if (command === "next") {
    const cwd = resolve(typeof values.cwd === "string" ? values.cwd : ".");
    const runsDir = runsRoot(cwd);
    process.stdout.write(values.json === true ? renderNextJson(runsDir, cwd) : renderNext(runsDir, cwd));
    return;
  }
  if (command === "update") {
    process.exitCode = await updateCommand({
      check: values.check === true,
      json: values.json === true,
      env: process.env,
      entryPath: process.argv[1],
    });
    return;
  }
  if (command === "setup") {
    process.exitCode = await setupCommand({
      yes: values.yes === true,
      harnesses: typeof values.harnesses === "string" ? values.harnesses : undefined,
      worker: typeof values.worker === "string" ? values.worker : undefined,
      judge: typeof values.judge === "string" ? values.judge : undefined,
      skill: values["no-skill"] !== true,
      json: values.json === true,
      env: process.env,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    return;
  }
  if (command === "init") {
    // The two compatibility rules are alternatives, not a union; a caller that
    // asks for both has not decided and gets the usage error instead.
    if (values.greenfield === true && values.stable === true) { usage(); return; }
    process.exitCode = await initCommand({
      cwd: typeof values.cwd === "string" ? values.cwd : undefined,
      yes: values.yes === true,
      skill: values["no-skill"] !== true,
      agentkit: values.agentkit === true,
      variant: values.stable === true ? "stable" : values.greenfield === true ? "greenfield" : undefined,
      json: values.json === true,
      env: process.env,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    return;
  }
  if (command === "migrate") {
    const result = migrateRunState(resolve(typeof values.cwd === "string" ? values.cwd : "."), { home: faberunHome(process.env) });
    if (!result.moved) {
      process.stdout.write(`[migrate] nothing to move · ${result.legacy} does not exist\n`);
      return;
    }
    const runs = `${result.runs} run${result.runs === 1 ? "" : "s"}`;
    const campaigns = `${result.campaigns} campaign${result.campaigns === 1 ? "" : "s"}`;
    process.stdout.write(`[migrate] ${result.legacy} -> ${result.target} · ${runs}, ${campaigns}\n`);
    return;
  }
  if (!target) { usage(); return; }
  if (command === "project") {
    const record = reassociateProject(faberunHome(process.env), target, {
      from: typeof values.from === "string" && values.from ? values.from : undefined,
    });
    process.stdout.write(`[project] ${record.id} · ${record.path}\n`);
    return;
  }
  if (command === "run") {
    warnIfNoTransport();
    const absolute = resolve(target);
    const baseRef = typeof values["base-ref"] === "string" && values["base-ref"] ? values["base-ref"] : undefined;
    const contract = validateContractForLaunch(JSON.parse(readFileSync(absolute, "utf8")), absolute, { baseRef });
    const runDir = runDirectory(contract.cwd, contract.id);
    setLaunchBaseRef(baseRef);
    // The base is what every worktree is cut from; a dirty tree only blocks
    // when the cwd HEAD *is* that base. A `--base-ref` elsewhere leaves the
    // operator's checkout out of the run entirely. The contract file being
    // launched is this launch's own input, not source the worktrees cut, so it
    // never counts as dirt.
    const contractFromCwd = relative(contract.cwd, absolute);
    const contractIgnore = contractFromCwd && !contractFromCwd.startsWith("..") && !isAbsolute(contractFromCwd) ? [contractFromCwd] : [];
    assertLaunchBaseClean(contract.cwd, baseRef, { ignorePaths: contractIgnore });
    if (values.detach === true) {
      if (existsSync(runDir)) throw new Error(`run already exists: ${runDir}`);
      for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`${advisoryToken()} ${warning}\n`);
      const child = detachSelf("run", target, baseRef ? ["--base-ref", baseRef] : []);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[run] ${contract.id} detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    for (const warning of [...contract.warnings, ...reusedDoneWarnings(contract)]) process.stdout.write(`${advisoryToken()} ${warning}\n`);
    const result = await runContract(target, { detachedBootstrap: hasDetachedBootstrapNonce(), baseRef });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "resume") {
    const resumeOptions = resumeOptionsOf(values);
    if (values.detach === true) {
      const runDir = resolve(target);
      if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
      const extraArgs = [
        ...(resumeOptions.node ? ["--node", resumeOptions.node] : []),
        ...(resumeOptions.reconcile ? ["--reconcile", resumeOptions.reconcile] : []),
        ...(resumeOptions.answer ? ["--answer", `${resumeOptions.answer.node}=${resumeOptions.answer.path}`] : []),
      ];
      const child = detachSelf("resume", target, extraArgs);
      const pid = child.pid;
      if (pid === undefined) throw new Error("detached child has no pid");
      await waitForBootstrap(runDir, pid, child);
      process.stdout.write(`[resume] detached · pid ${pid} · ${runDir}\n`);
      return;
    }
    const result = await resumeRun(target, { ...resumeOptions, detachedBootstrap: hasDetachedBootstrapNonce() });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "supervise") {
    warnIfNoTransport();
    const runDir = resolve(target);
    if (!existsSync(join(runDir, "contract.json"))) throw new Error(`not a run directory: ${runDir}`);
    const intervalSec = superviseIntervalOf(values.interval);
    if (values.detach === true) {
      // The supervisor is not a controller: it takes no lock, so there is no
      // bootstrap handshake to wait on. Spawning and reporting the pid is the
      // whole contract with the host scheduler that started it.
      const child = detachSelf("supervise", target, ["--interval", String(intervalSec)]);
      if (child.pid === undefined) throw new Error("detached child has no pid");
      process.stdout.write(`[supervise] detached · pid ${child.pid} · every ${intervalSec}s · ${runDir}\n`);
      return;
    }
    const outcome = await superviseRun(runDir, {
      intervalSec,
      launch: async (target) => {
        const child = detachSelf("resume", target);
        if (child.pid === undefined) throw new Error("detached child has no pid");
        await waitForBootstrap(target, child.pid, child);
        process.stdout.write(`[supervise] resumed · pid ${child.pid} · ${target}\n`);
      },
    });
    process.stdout.write(`[supervise] ${outcome.state} · ${outcome.launches} resume${outcome.launches === 1 ? "" : "s"} over ${outcome.ticks} checks${outcome.reason ? ` · ${outcome.reason}` : ""}\n`);
    if (outcome.state !== "done") process.exitCode = 1;
    return;
  }
  if (command === "cancel") { await cancelRun(target); return; }
  if (command === "preflight") {
    const absolute = resolve(target);
    const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
    const checks = await preflightContract(absolute, { static: values.static === true });
    const environment = environmentPreflight({
      cwd: contract.cwd,
      runtimes: reachableRuntimes(contract),
      harnessVersions: Object.fromEntries(checks.map((check) => [check.id, check.version])),
    });
    // Opt-in: this actually runs the contract's verification commands, so it
    // costs whatever they cost. It is the only check that can prove a command
    // fits the timeout the contract gives it.
    const timing = values["time-verification"] === true ? timeVerificationCommands(contract) : [];
    const environmentChecks = [...environment.checks, notifyTransportCheck(process.env)];
    const ok = environment.ok && checks.every((check) => check.ok) && timing.every((check) => check.ok || check.advisory);
    if (values.json === true) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        contractId: contract.id,
        ok,
        environment: [...environmentChecks, ...timing],
        checks: checks.map((check) => ({
          id: check.id,
          harness: check.harness,
          executable: check.executable,
          model: check.model,
          version: check.version,
          ok: check.ok,
          live: check.live === true,
          liveStatus: check.liveStatus ?? null,
          usage: check.usage ?? null,
          costUsd: check.costUsd ?? null,
          detail: check.detail,
        })),
      })}\n`);
    } else {
      const level = colorLevel(process.env, process.stdout.isTTY);
      for (const check of [...environmentChecks, ...timing]) process.stdout.write(`${statusToken(check.ok ? "ok" : check.advisory ? "warn" : "fail", level)} ${check.name} · ${check.detail}\n`);
      for (const check of checks) process.stdout.write(`${statusToken(check.ok ? "ok" : "fail", level)} ${check.id} · ${check.detail}\n`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const runDir = resolve(target);
    if (values.json === true) {
      process.stdout.write(renderStatusJson(runDir));
      return;
    }
    const status = renderStatus(runDir);
    writeTextAtomic(join(runDir, "STATUS.md"), status);
    try {
      renderRunHandoff(runDir);
    } catch (error) {
      process.stderr.write(`${statusToken("warn", colorLevel(process.env, process.stderr.isTTY))} campaign handoff render failed: ${errorMessage(error)}\n`);
    }
    process.stdout.write(status);
    return;
  }
  if (command === "report") {
    process.stdout.write(values.json === true ? renderReportJson(resolve(target)) : renderReport(resolve(target)));
    return;
  }
  if (command === "metrics") { process.stdout.write(renderCampaignMetrics(target, values)); return; }
  if (command === "findings") { process.stdout.write(renderFindings(resolve(target))); return; }
  if (command === "plan") {
    await planCli(target, /** @type {Parameters<typeof planCli>[1]} */ (values));
    return;
  }
  if (command === "validate") { validateContractFile(resolve(target)); return; }
  usage();
}

/**
 * The warn token for an advisory written to stdout. DESIGN.md gives every
 * `[warn]` advisory the warn role without distinguishing the stream; only the
 * capability of stdout chooses the escape codes.
 *
 * @returns {string}
 */
function advisoryToken() {
  return statusToken("warn", colorLevel(process.env, process.stdout.isTTY));
}

/**
 * The foreground launch command is the only moment an operator is present, so
 * it is where the no-transport warning belongs. A detached controller's stdio
 * is discarded, so this prints into nothing there by construction — the
 * warning is not suppressed, it is simply not observable.
 */
function warnIfNoTransport() {
  const warning = noTransportWarning();
  if (warning) process.stdout.write(`${advisoryToken()} ${warning}\n`);
}

/** The harness binaries whose presence the banner counts on PATH. */
const HARNESS_BINARIES = ["claude", "codex", "agy", "dsh", "zcode"];

/** Handled before verb dispatch, so they are not options of any command. */
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

/** @returns {number} how many harness binaries are on PATH */
function countHarnesses() {
  return HARNESS_BINARIES.filter((binary) => findExecutable(binary) !== null).length;
}

/**
 * `faberun` with no arguments and `faberun --help`: the identity on stdout
 * with a success exit. The banner belongs to an interactive terminal only; a
 * pipe, a log or `NO_COLOR` receives the usage alone.
 */
function help() {
  if (process.stdout.isTTY && process.env.NO_COLOR === undefined) {
    process.stdout.write(renderBanner({
      version: packageVersion(),
      // DESIGN.md draws `node 26.8.1`; `process.version` is `v26.8.1`.
      nodeVersion: process.version.replace(/^v/u, ""),
      harnessCount: countHarnesses(),
      level: colorLevel(process.env, process.stdout.isTTY),
    }));
  }
  process.stdout.write(renderUsage());
}

/**
 * The usage error: the same text as help, on stderr, no banner, exit code 2.
 * The text lives in `cli/brand.mjs` as `renderUsage()` so help and error
 * cannot drift.
 */
function usage() {
  process.stderr.write(renderUsage());
  process.exitCode = 2;
}

// A closed stdout pipe (orphaned monitor, ended pipeline) must never kill a
// controller through an unhandled EPIPE. Run state lives in the run directory;
// console output is advisory.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/**
 * Dispatch one CLI invocation, recording a bootstrap failure before reporting
 * it so a `--detach` launcher watching the run directory sees why its child
 * died. Exported because `bin/faberun.mjs` is the installed entry point
 * and `import.meta.url` cannot see it.
 *
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
export async function runCli(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    const parsed = parseCli(argv, true);
    writeBootstrapFailure(parsed?.command ?? "", parsed?.target, error instanceof Error ? error : new Error(errorMessage(error)));
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

// `node src/cli.mjs …` still works, and the tests and evals invoke it that way.
// A detached child is always spawned as this file (see spawnDetached), so the
// nonce check below keeps working whichever entry the launcher itself used.
if (process.argv[1] && sameFile(process.argv[1], import.meta.url)) runCli();

/**
 * @param {string|undefined} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFile(left, right) {
  try { return realpathSync(resolve(left ?? "")) === realpathSync(new URL(right)); } catch { return false; }
}
