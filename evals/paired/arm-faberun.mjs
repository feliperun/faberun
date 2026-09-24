/**
 * A faberun arm: the corpus run by the product. A fresh checkout at the base,
 * a contract with one node per requirement, `faberun run` in the foreground
 * under the experiment's own home, and then the same two measurements every
 * arm gets: the acceptance on the tree the run integrated
 * (`refs/faberun/<id>/run`) and the scope audit. Ported from
 * `spike/arms/arm-faberun.mjs`; cost is the run's own `usage.jsonl`, priced by
 * the product, and requests are the per-request session ledgers it persists.
 * Why separate: nothing else knows how to find a faberun run's artefacts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faberunContract } from "./contract.mjs";
import { deliveredOf } from "./corpus.mjs";
import { auditScope, commitAll, git, keepFinalTree, prepareCheckout, removeCheckout, runAcceptance } from "./fork.mjs";
import { FABERUN_CLI, PAIRED_EXPERIMENT_HOME, PAIRED_LOGS, PAIRED_STATE, providerEnv, readJsonl, writeJson } from "./lib.mjs";
import { releaseRunWorktrees } from "../../src/repo/worktree.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */
/** @typedef {import("./contract.mjs").PairedArm} PairedArm */

/** @param {number} count @returns {number|null} null when the stream carried no meter */
const metered = (count) => (count > 0 ? count : null);

/** @param {string} runId @returns {string|null} */
function findRunDir(runId) {
  const projects = join(PAIRED_EXPERIMENT_HOME, "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, "runs", runId);
    if (existsSync(join(candidate, "usage.jsonl")) || existsSync(join(candidate, "nodes"))) return candidate;
  }
  return null;
}

/** Node error codes that mean the provider did not do the work at all. */
const PROVIDER_REFUSALS = new Set(["quota_exhausted", "runtime_tier_exhausted", "runtime_assignment_worker_unavailable", "runtime_assignment_judge_unavailable", "judge_unavailable", "provider_unavailable"]);

/**
 * @param {{label: string, repetition: number, corpus: CorpusSet, arm: PairedArm}} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runFaberunArm({ label, repetition, corpus, arm }) {
  const name = `${label}-${arm.name}-r${repetition}`;
  // A run id is unique per attempt: faberun refuses to reuse one whose
  // directory exists, and a refused launch leaves a stub behind.
  const runId = `arms-${label}-${arm.name.toLowerCase()}-r${repetition}-${Date.now().toString(36)}`;
  const { dir } = prepareCheckout(name, corpus);
  const env = providerEnv(undefined, { FABERUN_HOME: PAIRED_EXPERIMENT_HOME });
  // A run belongs to a campaign of its checkout's project, so each faberun
  // checkout gets the campaign registered under the experiment home. The init
  // writes the managed AGENTS.md block into the checkout; committing it keeps
  // the base the run cuts from clean.
  const init = spawnSync(process.execPath, [FABERUN_CLI, "campaign", "init", "orchestration-arms", "--cwd", dir, "--goal", `Arm ${arm.name} of the orchestration-arms measurement (${label}, repetition ${repetition}): one faberun node per corpus requirement`], { cwd: dir, env, encoding: "utf8" });
  // The checkout path, and so the project, repeats across attempts; a campaign already registered there is the state we want.
  if (init.status !== 0 && !/already exists/u.test(`${init.stdout}${init.stderr}`)) {
    throw new Error(`campaign init failed in the arm ${arm.name} checkout: ${init.stdout}${init.stderr}`);
  }
  const baseSha = commitAll(dir, "chore(arms): campaign signal block written by faberun campaign init");
  const contract = faberunContract({ id: runId, cwd: dir, corpus, arm });
  const contractPath = join(PAIRED_STATE, "contracts", `${runId}.json`);
  writeJson(contractPath, contract);
  // The product's scope closure refuses a packet whose write files have an
  // importer (a test, typically) that is neither declared nor acknowledged. A
  // packet author answers by acknowledging the paths the validator names; the
  // driver does the same, mechanically, and records what it acknowledged so
  // the arm's authoring cost is visible in the ledger.
  /** @type {string[]} */
  const acknowledged = [];
  let validation = spawnSync(process.execPath, [FABERUN_CLI, "validate", contractPath], { cwd: dir, env, encoding: "utf8" });
  /** @type {any[]} */
  const contractNodes = /** @type {any} */ (contract.nodes ?? []);
  for (let round = 0; round < 8 && validation.status !== 0; round += 1) {
    const message = `${validation.stdout}${validation.stderr}`;
    const findings = [...message.matchAll(/nodes\[(\d+)\] \(([^)]+)\): (\S+) \(/gu)];
    if (!findings.length) break;
    for (const [, index, nodeId, path] of findings) {
      const node = contractNodes[Number(index)];
      if (!node || node.id !== nodeId) continue;
      node.taskPacket.scopeAcknowledged = [...new Set([...(node.taskPacket.scopeAcknowledged ?? []), path])];
      acknowledged.push(`${nodeId}: ${path}`);
    }
    writeJson(contractPath, contract);
    validation = spawnSync(process.execPath, [FABERUN_CLI, "validate", contractPath], { cwd: dir, env, encoding: "utf8" });
  }
  if (validation.status !== 0) {
    throw new Error(`arm ${arm.name} contract did not validate: ${validation.stdout}${validation.stderr}`);
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
  // Measured 2026-09-24: on a fresh checkout this write failed after the arm
  // had run to the end, voiding two measured runs of the first R11 reading.
  mkdirSync(PAIRED_LOGS, { recursive: true });
  writeFileSync(join(PAIRED_LOGS, `${name}.stdout.log`), run.stdout ?? "");
  writeFileSync(join(PAIRED_LOGS, `${name}.stderr.log`), run.stderr ?? "");

  const runDir = findRunDir(runId);
  if (runDir === null) throw new Error(`arm ${arm.name} produced no readable run directory for ${runId}; spend is unknown, not zero`);
  const usage = runDir ? readJsonl(join(runDir, "usage.jsonl")) : [];
  const nodes = runDir && existsSync(join(runDir, "nodes"))
    ? readdirSync(join(runDir, "nodes")).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(runDir, "nodes", file), "utf8")))
    : [];
  // A provider that refused the work is not a measurement of the arm.
  // Measured 2026-09-24, R11 repetition 3: with the Codex quota spent, arm H
  // "delivered 0" in 13 s and arm A in 399 s, and both were counted as
  // measured zeros beside the arms that really ran.
  const refused = nodes.filter((node) => PROVIDER_REFUSALS.has(String(node.error?.code ?? "")));
  if (refused.length) {
    throw new Error(`arm ${arm.name}: the provider refused the work (${refused.map((node) => `${node.id}: ${node.error.code}`).join(", ")}); not a measurement`);
  }
  const workerUsage = usage.filter((record) => record.role === "worker");
  const judgeUsage = usage.filter((record) => record.role === "judge");
  const sum = (/** @type {any[]} */ records, /** @type {string} */ key) => records.reduce((total, record) => total + (typeof record[key] === "number" ? record[key] : 0), 0);
  const pricedUsage = usage.filter((record) => typeof record.costUsd === "number" && Number.isFinite(record.costUsd));
  const unpricedUsage = usage.filter((record) => !Number.isFinite(record.costUsd));
  const unknownRecords = usage.length > 0 ? unpricedUsage : [{}];
  /** @type {Map<string, number>} */
  const highestByRuntime = new Map();
  for (const record of pricedUsage) {
    const key = typeof record.runtimeId === "string" ? record.runtimeId : typeof record.model === "string" ? record.model : "unknown-runtime";
    highestByRuntime.set(key, Math.max(highestByRuntime.get(key) ?? 0, record.costUsd));
  }
  const fallbackPerRecord = (/** @type {any} */ record) => {
    const key = typeof record.runtimeId === "string" ? record.runtimeId : typeof record.model === "string" ? record.model : "unknown-runtime";
    return highestByRuntime.get(key) ?? (typeof arm.estimateUsd === "number" && arm.estimateUsd > 0 ? arm.estimateUsd : 1);
  };
  const knownCostUsd = sum(pricedUsage, "costUsd");
  const observedCostUsd = pricedUsage.length > 0 ? Math.max(...pricedUsage.map((record) => record.costUsd)) : null;
  const budgetCostUsd = knownCostUsd + unknownRecords.reduce((total, record) => total + fallbackPerRecord(record), 0);
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
  const delivery = deliveredOf(acceptance);
  const keptSha = keepFinalTree(finalCheckout.dir, `refs/arms/paired/${arm.name}-r${repetition}`);
  removeCheckout(finalCheckout.dir);
  // The arm's run is read and its tree kept; the attempt worktrees it left are
  // released (archived under refs/faberun-archive/ first). Measured 2026-09-24:
  // the R11 round left 28 of them registered in this repository.
  releaseRunWorktrees(dir, runDir, runId);
  if (finalCheckout.dir !== dir) removeCheckout(dir);

  return {
    arm: arm.name,
    label,
    repetition,
    runId,
    workerModel: arm.model,
    scopeAcknowledged: acknowledged,
    exitCode: run.status,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs,
    baseSha,
    finalSha: keptSha,
    // A mixed or empty usage stream is charged through budgetCostUsd, but its
    // provider cost remains null so the report cannot turn unknown spend into
    // a plausible zero. Measured provider records remain fully priced.
    costUsd: unpricedUsage.length === 0 && usage.length > 0 ? knownCostUsd : null,
    budgetCostUsd,
    costProvenance: unpricedUsage.length > 0 || usage.length === 0 ? "unknown" : "priced",
    observedCostUsd,
    workerCostUsd: sum(workerUsage, "costUsd"),
    judgeCostUsd: sum(judgeUsage, "costUsd"),
    unpricedInvocations: unknownRecords.length,
    tokens: { input: sum(usage, "inputTokens"), cacheRead: sum(usage, "cacheReadInputTokens"), output: sum(usage, "outputTokens") },
    // The per-request ledger exists for the claude, dsh and agy streams; a
    // codex or zcode worker leaves no request count and no context size, and a
    // faberun run always has at least one request, so zero means unmetered.
    requests: metered(sessions.reduce((total, session) => total + (session.requests ?? 0), 0)),
    toolCalls: sessions.reduce((total, session) => total + (session.toolCalls ?? 0), 0),
    contextMax: metered(sessions.reduce((best, session) => Math.max(best, session.contextMax ?? 0), 0)),
    invocations: usage.length,
    nodes: nodes.map((node) => ({ id: node.id, status: node.status, attempt: node.attempt, revisions: node.revisions, error: node.error?.code ?? null })),
    acceptance,
    proofsTotal: delivery.proofs,
    proofsPassed: delivery.delivered,
    guardsPassed: delivery.guardsPassed,
    scope,
  };
}
