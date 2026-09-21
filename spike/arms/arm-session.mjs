/**
 * Arms B and C: the corpus run by one claude session, without (B) or with (C)
 * the harness's own subagents. The command is the product's own claude
 * command for the same model and permission mode arm A's workers get, so the
 * preamble, tool set and flags match; only the prompt (the whole corpus at
 * once) and, for C, the Agent tool differ. Cost is what the CLI reports for
 * the session; the per-request ledger comes from the product's session meter
 * over the same stream.
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLAUDE_TOOLS } from "../../src/harnesses/claude/index.mjs";
import { providerCommand } from "../../src/harnesses/index.mjs";
import { SessionMetricsParser } from "../../src/harnesses/session-metrics.mjs";
import { WORKER_MODEL } from "./contract.mjs";
import { deliveredOf } from "./corpus.mjs";
import { auditScope, keepFinalTree, prepareCheckout, removeCheckout, runAcceptance } from "./fork.mjs";
import { LOGS, providerEnv } from "./lib.mjs";
import { sessionPrompt } from "./prompt.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */

/** A whole corpus in one session is many nodes' worth of requests; the cap only has to catch a runaway. */
const SESSION_MAX_TURNS = 1000;

/**
 * @param {{arm: "B"|"C", label: string, repetition: number, corpus: CorpusSet}} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runSessionArm({ arm, label, repetition, corpus }) {
  const name = `${label}-${arm}-r${repetition}`;
  const { dir, baseSha } = prepareCheckout(name, corpus);
  const prompt = sessionPrompt({ arm, corpus, sha: baseSha });
  const runtime = {
    harness: "claude",
    model: WORKER_MODEL,
    reasoning: "high",
    permissionMode: "bypassPermissions",
    tools: arm === "C" ? [...DEFAULT_CLAUDE_TOOLS, "Agent"] : [...DEFAULT_CLAUDE_TOOLS],
  };
  const command = providerCommand(/** @type {any} */ (runtime), prompt, { maxTurns: SESSION_MAX_TURNS });
  const logPath = join(LOGS, `${name}.stream.jsonl`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const exit = await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, { cwd: dir, env: providerEnv(command.env), stdio: ["pipe", "pipe", "pipe"] });
    const out = createWriteStream(logPath);
    child.stdout.pipe(out);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code, signal) => resolve({ code, signal, stderr: stderr.slice(-4000) }));
    child.stdin.end(command.input ?? "");
  });
  const wallMs = Date.now() - started;

  const stream = readFileSync(logPath, "utf8");
  /** @type {any[]} */
  const events = [];
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a partial trailing line */ }
  }
  const result = events.findLast((event) => event?.type === "result");
  const parser = new SessionMetricsParser("claude");
  parser.push(stream);
  parser.flush();
  const ledger = parser.session();
  let agentCalls = 0;
  for (const event of events) {
    if (event?.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) if (block?.type === "tool_use" && block.name === "Agent") agentCalls += 1;
  }
  const usage = result?.usage ?? {};

  const scope = auditScope({ dir, baseSha, corpus });
  const acceptance = runAcceptance({ dir, corpus });
  const delivery = deliveredOf(acceptance);
  const finalSha = keepFinalTree(dir, `refs/arms/${label}/${arm}-r${repetition}`);
  removeCheckout(dir);

  return {
    arm,
    label,
    repetition,
    exitCode: exit.code,
    signal: exit.signal,
    stderrTail: exit.stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs,
    baseSha,
    finalSha,
    resultSubtype: result?.subtype ?? null,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    tokens: {
      input: usage.input_tokens ?? null,
      cacheCreation: usage.cache_creation_input_tokens ?? null,
      cacheRead: usage.cache_read_input_tokens ?? null,
      output: usage.output_tokens ?? null,
    },
    reportedTurns: result?.num_turns ?? null,
    requests: ledger.requests,
    toolCalls: ledger.toolCalls,
    contextFirst: ledger.contextFirst,
    contextMax: ledger.contextMax,
    contextLast: ledger.contextLast,
    contextSum: ledger.contextSum,
    agentCalls,
    finalMessage: typeof result?.result === "string" ? result.result.slice(0, 4000) : null,
    acceptance,
    acceptanceTotal: delivery.proofs,
    proofsPassed: delivery.delivered,
    guardsPassed: delivery.guardsPassed,
    scope,
    logPath,
  };
}
