/**
 * Arms A and D: the corpus run by faberun. A fresh checkout at the base, a
 * contract with one node per requirement, `faberun run` in the foreground
 * under the experiment's own home, and then the same two measurements every
 * arm gets: the acceptance, run on the tree the run integrated
 * (`refs/faberun/<id>/run`), and the scope audit. Cost is the run's own
 * usage.jsonl, priced by the product; requests are the per-request session
 * ledgers it persists.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FABERUN_ARMS, faberunContract } from "./contract.mjs";
import { auditScope, commitAll, git, keepFinalTree, prepareCheckout, removeCheckout, runAcceptance } from "./fork.mjs";
import { EXPERIMENT_HOME, FABERUN_CLI, LOGS, RESULTS, providerEnv, readJsonl, writeJson } from "./lib.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

/** @param {string} runId @returns {string|null} */
function findRunDir(runId) {
  const projects = join(EXPERIMENT_HOME, "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, "runs", runId);
    if (existsSync(join(candidate, "usage.jsonl")) || existsSync(join(candidate, "nodes"))) return candidate;
  }
  return null;
}

/**
 * @param {{label: string, repetition: number, corpus: CorpusSet, arm?: "A"|"D"|"E"}} input D is the proof as the only gate; E is D with the DeepSeek Flash writer
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runFaberunArm({ label, repetition, corpus, arm = "A" }) {
  const name = `${label}-${arm}-r${repetition}`;
  // A run id is unique per attempt: faberun refuses to reuse one whose
  // directory exists, and a refused launch leaves a stub behind.
  const runId = `arms-${label}-${arm.toLowerCase()}-r${repetition}-${Date.now().toString(36)}`;
  const { dir } = prepareCheckout(name, corpus);
  const env = providerEnv(undefined, { FABERUN_HOME: EXPERIMENT_HOME });
  // A run belongs to a campaign of its checkout's project, so each faberun
  // checkout gets the campaign registered under the experiment home. The
  // init writes the managed AGENTS.md block into the checkout; committing it
  // keeps the base the run cuts from clean.
  const init = spawnSync(process.execPath, [FABERUN_CLI, "campaign", "init", "orchestration-arms", "--cwd", dir, "--goal", `Arm ${arm} of the orchestration-arms measurement (${label}, repetition ${repetition}): one faberun node per corpus requirement`], { cwd: dir, env, encoding: "utf8" });
  // The checkout path, and so the project, repeats across attempts; a campaign already registered there is the state we want.
  if (init.status !== 0 && !/already exists/u.test(`${init.stdout}${init.stderr}`)) {
    throw new Error(`campaign init failed in the arm ${arm} checkout: ${init.stdout}${init.stderr}`);
  }
  const baseSha = commitAll(dir, "chore(arms): campaign signal block written by faberun campaign init");
  const contract = faberunContract({ id: runId, cwd: dir, corpus, arm });
  const contractPath = join(RESULTS, "contracts", `${runId}.json`);
  writeJson(contractPath, contract);
  // The product's scope closure refuses a packet whose write files have an
  // importer (a test, typically) that is neither declared nor acknowledged.
  // A packet author answers by acknowledging the paths the validator names;
  // the driver does the same, mechanically, and records what it acknowledged
  // so the arm's authoring cost is visible in the ledger.
  /** @type {string[]} */
  const acknowledged = [];
  let validation = spawnSync(process.execPath, [FABERUN_CLI, "validate", contractPath], { cwd: dir, env, encoding: "utf8" });
  for (let round = 0; round < 8 && validation.status !== 0; round += 1) {
    const message = `${validation.stdout}${validation.stderr}`;
    const findings = [...message.matchAll(/nodes\[(\d+)\] \(([^)]+)\): (\S+) \(/gu)];
    if (!findings.length) break;
    for (const [, index, nodeId, path] of findings) {
      const node = /** @type {any} */ (contract.nodes[Number(index)]);
      if (!node || node.id !== nodeId) continue;
      node.taskPacket.scopeAcknowledged = [...new Set([...(node.taskPacket.scopeAcknowledged ?? []), path])];
      acknowledged.push(`${nodeId}: ${path}`);
    }
    writeJson(contractPath, contract);
    validation = spawnSync(process.execPath, [FABERUN_CLI, "validate", contractPath], { cwd: dir, env, encoding: "utf8" });
  }
  if (validation.status !== 0) {
    throw new Error(`arm ${arm} contract did not validate: ${validation.stdout}${validation.stderr}`);
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const run = spawnSync(process.execPath, [FABERUN_CLI, "run", contractPath], {
    cwd: dir,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  writeFileSync(join(LOGS, `${name}.stdout.log`), run.stdout ?? "");
  writeFileSync(join(LOGS, `${name}.stderr.log`), run.stderr ?? "");

  const runDir = findRunDir(runId);
  const usage = runDir ? readJsonl(join(runDir, "usage.jsonl")) : [];
  const nodes = runDir && existsSync(join(runDir, "nodes"))
    ? readdirSync(join(runDir, "nodes")).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(runDir, "nodes", file), "utf8")))
    : [];
  const workerUsage = usage.filter((record) => record.role === "worker");
  const judgeUsage = usage.filter((record) => record.role === "judge");
  const sum = (/** @type {any[]} */ records, /** @type {string} */ key) => records.reduce((total, record) => total + (typeof record[key] === "number" ? record[key] : 0), 0);
  const sessions = usage.map((record) => record.session).filter((session) => session && typeof session === "object");

  let finalSha = null;
  try {
    finalSha = git(["rev-parse", `refs/faberun/${runId}/run`], dir);
  } catch {
    finalSha = null;
  }
  // The integrated tree gets its own checkout, with the toolchain the
  // acceptance needs; the run's own checkout is the fallback when no node
  // integrated anything.
  const finalCheckout = finalSha ? prepareCheckout(`${name}-final`, { ...corpus, visibleProofs: false }, { sha: finalSha }) : { dir, baseSha };
  const scope = auditScope({ dir: finalCheckout.dir, baseSha, corpus });
  const acceptance = runAcceptance({ dir: finalCheckout.dir, corpus });
  const keptSha = keepFinalTree(finalCheckout.dir, `refs/arms/${label}/${arm}-r${repetition}`);
  removeCheckout(finalCheckout.dir);
  if (finalCheckout.dir !== dir) removeCheckout(dir);

  return {
    arm,
    label,
    repetition,
    runId,
    runDir,
    workerModel: FABERUN_ARMS[arm].model,
    scopeAcknowledged: acknowledged,
    exitCode: run.status,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs,
    baseSha,
    finalSha: keptSha,
    costUsd: sum(usage, "costUsd"),
    workerCostUsd: sum(workerUsage, "costUsd"),
    judgeCostUsd: sum(judgeUsage, "costUsd"),
    unpricedInvocations: usage.filter((record) => typeof record.costUsd !== "number").length,
    tokens: { input: sum(usage, "inputTokens"), cacheRead: sum(usage, "cacheReadInputTokens"), output: sum(usage, "outputTokens") },
    requests: sessions.reduce((total, session) => total + (session.requests ?? 0), 0),
    toolCalls: sessions.reduce((total, session) => total + (session.toolCalls ?? 0), 0),
    contextMax: sessions.reduce((best, session) => Math.max(best, session.contextMax ?? 0), 0),
    invocations: usage.length,
    nodes: nodes.map((node) => ({ id: node.id, status: node.status, attempt: node.attempt, revisions: node.revisions, error: node.error?.code ?? null })),
    acceptance,
    acceptanceTotal: acceptance.length,
    proofsPassed: acceptance.filter((check) => check.passed).length,
    scope,
  };
}
