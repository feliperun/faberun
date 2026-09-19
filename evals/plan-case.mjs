/**
 * Running a command-kind deterministic case: one whose `case.json` drives
 * `faberun plan` itself through `src/cli.mjs`, rather than declaring a
 * contract for the engine to execute directly. Separate from `run.mjs`
 * because a command-kind case has no contract, no node snapshot and no
 * worktree to compare against — its own three facts (paths under the run
 * root, a plan.json's fields, campaign journal entries) need their own
 * comparison and their own setup-step vocabulary (`invoke`, `spawnDetached`,
 * `waitForPath`, `killProcess`), which `run.mjs` only ever calls into.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal } from "../src/campaign/journal.mjs";
import { campaignTree, runsRoot } from "../src/run/paths.mjs";
import { delay } from "../src/util.mjs";
import { materializePlanCase, safeJoin, withScopedFaberunHome } from "./case.mjs";

/**
 * The file a command-kind case's child processes are spawned as: the real
 * CLI entry, so `invoke`/`spawnDetached` exercise exactly what an operator
 * runs.
 */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/**
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, unknown>[]}
 */
export function normalizedPlanSteps(spec) {
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
    // Relative to runsRoot(workDir), not workDir itself, for the same reason
    // comparePlanExpectations resolves there: since R2 that root lives under
    // the operator's home, keyed by a project id the case file cannot predict.
    const target = safeJoin(runsRoot(context.workDir), /** @type {string} */ (step.path));
    const timeoutMs = typeof step.timeoutMs === "number" ? step.timeoutMs : 60_000;
    // A field makes the wait a state condition rather than a file-existence one: a
    // pipeline that writes a file and then rewrites it with its outcome would
    // otherwise be read between the two (measured 2026-09-17 on a CI runner).
    const field = typeof step.field === "string" ? step.field : null;
    const ready = () => {
      if (!existsSync(target)) return false;
      if (!field) return true;
      try {
        return JSON.parse(readFileSync(target, "utf8"))[field] !== undefined;
      } catch {
        // A torn or unparsable file is simply not ready yet.
        return false;
      }
    };
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${step.path}${field ? ` to carry ${field}` : ""} under ${context.workDir}`);
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
 * `expectPaths` (files that must or must not exist under the case's run
 * root), `plan` (JSON fields of a plan.json at a declared path), and
 * `journal` (campaign journal entries that must be present) — the three
 * facts a `faberun plan` invocation leaves behind that no node snapshot
 * describes, since there is no contract and no run for most of a plan
 * command's own scenarios.
 *
 * Every declared path is relative to `runsRoot(context.workDir)`, not
 * `context.workDir` itself: since R2 that root lives under the operator's
 * home, keyed by a project id `expected.json` cannot predict, so resolving
 * through the same function the pipeline itself calls is the only way a
 * fixture stays correct regardless of where state actually lives.
 *
 * @param {Record<string, unknown>} expected
 * @param {{workDir: string, campaignId: string}} context
 * @returns {string[]}
 */
function comparePlanExpectations(expected, context) {
  /** @type {string[]} */
  const failures = [];
  const runRoot = runsRoot(context.workDir);
  const paths = /** @type {{present?: string[], absent?: string[]}} */ (expected.expectPaths ?? {});
  for (const relativePath of paths.present ?? []) {
    if (!existsSync(join(runRoot, relativePath))) failures.push(`expected path present: ${relativePath}`);
  }
  for (const relativePath of paths.absent ?? []) {
    if (existsSync(join(runRoot, relativePath))) failures.push(`expected path absent: ${relativePath}`);
  }
  const plan = /** @type {{path: string, fields?: Record<string, unknown>}|undefined} */ (expected.plan);
  if (plan) {
    const planPath = join(runRoot, plan.path);
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
    const journal = readJournal(campaignTree(context.workDir, context.campaignId));
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
export async function runPlanCase({ caseDir, spec, expected }, options) {
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
    return await withScopedFaberunHome(async () => {
      const { workDir, campaignId } = materializePlanCase(caseDir, spec, options.patch);
      const context = { workDir, campaignId, processes: /** @type {Map<string, import("node:child_process").ChildProcess>} */ (new Map()) };
      const steps = options.stepsOverride ?? normalizedPlanSteps(spec);
      for (const step of steps) await executePlanStep(step, context);
      const failures = comparePlanExpectations(expected, context);
      return { id, title, proves, ok: failures.length === 0, failures };
    });
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
export function applyPlanDiscriminator(spec) {
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
