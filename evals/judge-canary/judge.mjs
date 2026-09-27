/**
 * The single model-backed act of the judge canary: ask the product's own judge
 * question through the runtime's harness and return its raw verdict. Why
 * separate: `class.mjs` owns the corpus, the budget and the score, and must be
 * runnable with a replay judge and no provider; this module is the only place
 * that builds a product judge prompt and spawns a provider, so the class can
 * take a stand-in without touching either.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_SCHEMA, judgePrompt } from "../../src/engine/prompts.mjs";
import { normalizeProviderAvailability, normalizeProviderResult, providerCommand } from "../../src/harnesses/index.mjs";
import { sealedDiffPaths } from "../judge-canary.mjs";
import { providerEnv } from "../paired/lib.mjs";
import { recordInvocationWindows } from "../../src/run/usage-windows.mjs";

/** @typedef {import("../judge-canary.mjs").CanaryArtifact} CanaryArtifact */

/**
 * The node the product's judge prompt reads, built from the sealed case: the
 * task's own node id, its packet and its Definition of Done. None of the three
 * carries the case id, the label or the defect's description, which stay in
 * `case.json` for the score and never reach the judge.
 *
 * @param {CanaryArtifact} artifact
 * @returns {{id: string, definitionOfDone: Record<string, unknown>[], taskPacket: Record<string, unknown>}}
 */
export function canaryJudgeNode(artifact) {
  return {
    id: artifact.nodeId,
    definitionOfDone: artifact.definitionOfDone,
    taskPacket: artifact.taskPacket,
  };
}

/**
 * Ask one runtime to judge one canary case. The prompt is the product's
 * `judgePrompt`; the invocation is the product's `providerCommand` and
 * `normalizeProviderResult`; the workspace is the candidate tree the judge
 * inspects. The output schema is written beside it, not into it, so the tree
 * under review holds nothing the sealed diff did not put there. The raw `envelope.result` string is returned unparsed so the class
 * decides the score and `class.mjs` owns `parseJudge`.
 *
 * @param {{runtime: Record<string, unknown>, artifact: CanaryArtifact, prompt: string, workspace: string}} input
 * @returns {Promise<{result: string, usage?: Record<string, unknown>, costUsd?: number|null}>}
 */
async function askHarnessJudge({ runtime, prompt, workspace }) {
  const schemaDir = mkdtempSync(join(tmpdir(), "faberun-judge-schema-"));
  const schemaPath = join(schemaDir, "judge.schema.json");
  writeFileSync(schemaPath, `${JSON.stringify(JUDGE_SCHEMA, null, 2)}\n`);
  const command = providerCommand(/** @type {any} */ (runtime), prompt, { schema: JUDGE_SCHEMA, schemaPath });
  let collected;
  try {
    collected = await spawnCommand(command, workspace, providerEnv(command.env));
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
  const envelope = normalizeProviderResult(/** @type {any} */ (runtime), collected.stdout, collected.code, collected.signal, { preferStructured: true });
  try {
    recordInvocationWindows(/** @type {any} */ (runtime), envelope.continuationId);
  } catch {
    // Telemetry about the account; a missing session file is no reading, not a failed case.
  }
  if (typeof envelope.result !== "string" || envelope.result.length === 0) {
    const refusal = refusalOf(runtime, envelope, collected.stderr);
    if (refusal) throw refusal;
    throw new Error(envelope.error?.message ?? "judge produced no verdict");
  }
  return {
    result: envelope.result,
    ...(envelope.usage ? { usage: /** @type {Record<string, unknown>} */ (envelope.usage) } : {}),
    costUsd: typeof envelope.costUsd === "number" ? envelope.costUsd : null,
  };
}

/** Provider answers that no further case can change: every later call gets the same refusal. */
const REFUSALS = new Set(["quota_exhausted", "insufficient_balance", "model_not_supported"]);

/** A provider that refused the work before doing any: the class stops on it instead of asking the next case. */
export class ProviderRefusal extends Error {
  /** @param {string} reason @param {string|null} exhaustedUntil @param {string} message */
  constructor(reason, exhaustedUntil, message) {
    super(`provider refused the work (${reason}${exhaustedUntil ? `, back at ${exhaustedUntil}` : ""}): ${message}`);
    this.reason = reason;
    this.exhaustedUntil = exhaustedUntil;
  }
}

/**
 * The refusal a failed judge call carries, classified by the product's own
 * availability rules over the envelope and the provider's stderr. Measured
 * 2026-09-24: zcode printed `[1308] Usage limit reached for 5 hour` on stderr
 * only, the envelope said "ZCode emitted no result object", and the class
 * asked 70 more cases that all failed the same way.
 *
 * @param {Record<string, unknown>} runtime
 * @param {{status?: string, error?: {code?: string, message?: string} | null}} envelope
 * @param {string} stderr
 * @returns {ProviderRefusal|null}
 */
export function refusalOf(runtime, envelope, stderr) {
  // The whole bounded stderr is classified, not its tail. Measured 2026-09-24:
  // zcode printed the [1308] line first and 3 KB of HTTP headers after it, so
  // a 2000-character tail held no quota text and 39 refusals read as errors.
  const text = [envelope.error?.message ?? "", stderr.slice(-65_536)].filter(Boolean).join("\n");
  const availability = normalizeProviderAvailability(/** @type {any} */ (runtime), { ...envelope, status: envelope.status === "done" ? "failed" : envelope.status ?? "failed", error: { ...envelope.error, message: text } });
  const line = text.split("\n").find((entry) => /quota|rate.?limit|usage limit|balance|not supported/iu.test(entry)) ?? text;
  return REFUSALS.has(availability.reason) ? new ProviderRefusal(availability.reason, availability.exhaustedUntil, line.trim().slice(0, 400)) : null;
}

/**
 * The harness judge factory the class uses when no stand-in was injected.
 *
 * @param {Record<string, unknown>} runtime
 * @returns {(input: {runtime: Record<string, unknown>, artifact: CanaryArtifact, prompt: string, workspace: string}) => Promise<{result: string, usage?: Record<string, unknown>, costUsd?: number|null}>}
 */
export function harnessJudge(runtime) {
  return (input) => askHarnessJudge({ ...input, runtime });
}

/**
 * @param {{executable: string, args: string[], promptTransport: "stdin"|"argv", input?: string|null, env?: Record<string, string|null>}} command
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, signal: string|null}>}
 */
function spawnCommand(command, cwd, env) {
  return new Promise((settle, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env,
      stdio: command.promptTransport === "stdin" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => settle({ stdout, stderr, code, signal }));
    if (command.promptTransport === "stdin") child.stdin?.end(command.input ?? "");
  });
}

/**
 * The product prompt one canary case is asked with, built by the product's
 * own `judgePrompt` from what a live gate hands it: the node, the worker's
 * structured result, the paths the sealed diff changes (the product passes
 * the sealed attempt's changed paths, not the packet's writeFiles), and the
 * controller's green verification. Kept here beside the invocation so the
 * class never builds a prompt of its own.
 *
 * @param {CanaryArtifact} artifact
 * @returns {string}
 */
export function canaryJudgePrompt(artifact) {
  return judgePrompt(/** @type {any} */ (canaryJudgeNode(artifact)), artifact.workerResult, {
    diff: sealedDiffPaths(artifact.diff),
    verification: { passed: true, commands: artifact.verification.map((command) => ({ argv: command.argv, passed: true })) },
    deterministic: [{ id: "verification", pass: true, detail: "exit 0" }],
  });
}
