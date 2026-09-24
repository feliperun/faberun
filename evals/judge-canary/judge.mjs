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
import { normalizeProviderResult, providerCommand } from "../../src/harnesses/index.mjs";
import { sealedDiffPaths } from "../judge-canary.mjs";
import { providerEnv } from "../paired/lib.mjs";

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
  if (typeof envelope.result !== "string" || envelope.result.length === 0) {
    throw new Error(envelope.error?.message ?? "judge produced no verdict");
  }
  return {
    result: envelope.result,
    ...(envelope.usage ? { usage: /** @type {Record<string, unknown>} */ (envelope.usage) } : {}),
    costUsd: typeof envelope.costUsd === "number" ? envelope.costUsd : null,
  };
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
