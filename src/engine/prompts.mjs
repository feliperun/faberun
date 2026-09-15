import { validateWorkerResult } from "../contract/worker-result.mjs";
import { scopeFindingsPromptSection } from "../contract/scope-findings.mjs";
import { JUDGE_ENVELOPE_REASON, JUDGE_FINDING_ENVELOPE_REASON, JUDGE_LIMITS } from "../contract/judge-envelope.mjs";

/** @typedef {{id: string, definitionOfDone: import("../contract/definition-of-done.mjs").DefinitionOfDoneItem[], taskPacket: {mode?: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], writeFiles?: string[], writeRoots?: string[], verification: {argv: string[]}[]}}} JudgeNode */
/** @typedef {{verdict: "pass"|"fail"|"invalid_judge_output", maxSeverity: "none"|"minor"|"major"|"critical", summary: string, findings: {severity: "minor"|"major"|"critical", description: string, evidence: string}[]}} JudgeVerdict */

/**
 * A node whose work is over and whose outcome needs nothing more from the
 * controller: success or an explicit cancellation.
 */
export const TERMINAL = new Set([
  "done",
  "no-op",
  "canceled",
]);

/**
 * A node that stopped without succeeding and cannot proceed by itself. Parking
 * is not finishing: the run needs attention, not a "done" report. Kept apart
 * from `TERMINAL` so the watchdog can tell the two apart instead of returning
 * the moment every node has stopped.
 */
export const PARKED = new Set([
  "blocked",
  "failed",
  "exhausted",
  "stalled",
]);

/** Every status a node never leaves on its own: terminal plus parked. */
export const SETTLED = new Set([...TERMINAL, ...PARKED]);

/** The statuses that count as a node's success. */
export const SUCCESS = new Set(["done", "no-op"]);

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    maxSeverity: { type: "string", enum: ["none", "minor", "major", "critical"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["minor", "major", "critical"] },
          description: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["severity", "description", "evidence"],
      },
    },
  },
  // Every property, and it has to be every property: OpenAI's structured
  // output rejects the schema itself -- `invalid_json_schema`, 400, before the
  // model runs -- unless `required` lists every key in `properties`. Dropping
  // `findings` from here to spare Claude an occasional omission took the codex
  // judge down completely, which is the worse trade: Claude's failure was
  // intermittent and recoverable, this one was every invocation.
  //
  // The tolerance lives in `parseJudge`, which reads an absent `findings` as
  // `[]`, and in the prompt below, which says out loud that a clean pass still
  // sends the empty array.
  required: ["verdict", "maxSeverity", "summary", "findings"],
};

/**
 * @param {string} result
 * @returns {JudgeVerdict}
 */
export function parseJudge(result) {
  let parsed;
  try {
    parsed = /** @type {unknown} */ (JSON.parse(result));
  } catch (error) {
    throw new Error(`judge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verdict = /** @type {Record<string, unknown>} */ (parsed);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("judge result must be an object");
  // Judge output is an external LLM boundary: models add fields beyond the
  // schema (toolAction, confidence, …). Unknown keys are dropped here; every
  // canonical field keeps strict value validation below.
  const judgeVerdict = verdict.verdict;
  const maxSeverity = verdict.maxSeverity;
  if (typeof judgeVerdict !== "string" || !JUDGE_SCHEMA.properties.verdict.enum.includes(judgeVerdict)) throw new Error("judge verdict must be pass or fail");
  if (typeof maxSeverity !== "string" || !JUDGE_SCHEMA.properties.maxSeverity.enum.includes(maxSeverity)) throw new Error("judge maxSeverity is invalid");
  if (typeof verdict.summary !== "string") throw new Error("judge result is missing summary");
  if (verdict.findings !== undefined && !Array.isArray(verdict.findings)) throw new Error("judge findings must be an array");
  const rawFindings = /** @type {unknown[]} */ (verdict.findings ?? []);
  if (Buffer.byteLength(verdict.summary, "utf8") > JUDGE_LIMITS.summaryBytes || rawFindings.length > JUDGE_LIMITS.findings) throw new Error(JUDGE_ENVELOPE_REASON);
  const severityRank = { none: 0, minor: 1, major: 2, critical: 3 };
  const findings = rawFindings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error("judge finding is invalid");
    const record = /** @type {Record<string, unknown>} */ (finding);
    const severity = record.severity;
    if (typeof severity !== "string" || !["minor", "major", "critical"].includes(severity) || typeof record.description !== "string" || typeof record.evidence !== "string") {
      throw new Error("judge finding is invalid");
    }
    if (Buffer.byteLength(record.description, "utf8") > JUDGE_LIMITS.descriptionBytes || Buffer.byteLength(record.evidence, "utf8") > JUDGE_LIMITS.evidenceBytes) throw new Error(JUDGE_FINDING_ENVELOPE_REASON);
    return {
      severity: /** @type {"minor"|"major"|"critical"} */ (severity),
      description: record.description,
      evidence: record.evidence,
    };
  });
  const findingSeverities = findings.map((finding) => finding.severity);
  const actualMax = findingSeverities.reduce(
    (highest, severity) => severityRank[severity] > severityRank[highest] ? severity : highest,
    /** @type {"none"|"minor"|"major"|"critical"} */ ("none"),
  );
  if (actualMax !== maxSeverity) throw new Error("judge maxSeverity does not match findings");
  if ((judgeVerdict === "pass") !== (maxSeverity === "none")) throw new Error("judge verdict and maxSeverity are inconsistent");
  return {
    verdict: /** @type {"pass"|"fail"} */ (judgeVerdict),
    maxSeverity: /** @type {"none"|"minor"|"major"|"critical"} */ (maxSeverity),
    summary: verdict.summary,
    findings,
  };
}

/**
 * How much of a red command's captured output the judge prompt carries, per
 * stream, and the total budget across all red commands. Green commands send no
 * output at all: the controller already ran them and their result is the
 * `passed` bit, so echoing 2 KiB stdout plus 2 KiB stderr per green command per
 * attempt is pure spend. This campaign already lost a node to that: a packet
 * with seven verification commands serialized the whole `state.verification`
 * and crossed the 64 KiB judge-prompt guard.
 */
const JUDGE_RED_STREAM_BYTES = 2 * 1024;
const JUDGE_RED_TOTAL_BYTES = 16 * 1024;

/**
 * The judge's view of controller verification: `{argv, passed}` for every green
 * command and output tails only for red ones. The state carries up to 2 KiB per
 * stream per attempt for every command, green or red; the judge only needs the
 * red evidence, and bounding the red evidence in aggregate keeps the whole
 * prompt inside the dispatch guard.
 *
 * @param {unknown} verification
 * @returns {{passed: boolean, error?: string, commands: Array<Record<string, unknown>>}}
 */
function judgeVerificationEvidence(verification) {
  const record = verification && typeof verification === "object" && !Array.isArray(verification)
    ? /** @type {{passed?: unknown, error?: unknown, commands?: unknown}} */ (verification)
    : {};
  const commands = Array.isArray(record.commands) ? record.commands : [];
  let budget = JUDGE_RED_TOTAL_BYTES;
  const compact = commands.map((command) => {
    const entry = command && typeof command === "object" && !Array.isArray(command)
      ? /** @type {Record<string, unknown>} */ (command)
      : {};
    if (entry.passed === true) return { argv: entry.argv, passed: true };
    /** @type {Record<string, unknown>} */
    const red = { argv: entry.argv, passed: false };
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    const last = attempts.length ? /** @type {Record<string, unknown>} */ (attempts[attempts.length - 1]) : null;
    if (typeof last?.exitCode === "number") red.exitCode = last.exitCode;
    if (last?.timedOut === true) red.timedOut = true;
    for (const stream of /** @type {const} */ (["stdout", "stderr"])) {
      const text = typeof last?.[stream] === "string" ? last[stream] : "";
      if (!text.trim() || budget <= 0) continue;
      const bounded = boundedPromptText(text, Math.min(JUDGE_RED_STREAM_BYTES, budget));
      budget -= Buffer.byteLength(bounded, "utf8");
      red[stream] = bounded;
    }
    return red;
  });
  return {
    passed: record.passed === true,
    ...(typeof record.error === "string" && record.error ? { error: record.error } : {}),
    commands: compact,
  };
}

/**
 * @param {JudgeNode} node
 * @param {unknown} workerResult
 * @param {{diff?: unknown[], verification?: unknown, deterministic?: unknown, scopeFindings?: {unexpectedPaths: string[]}|null, previousAttempt?: string}} context
 * @returns {string}
 */
export function judgePrompt(node, workerResult, context = {}) {
  const criteria = node.definitionOfDone.length
    ? judgeDoDChecklist(node.definitionOfDone, context.deterministic)
    : "- The requested work is complete, correct, tested, and limited to scope.";
  const taskInstructions = node.taskPacket.instructions.length
    ? node.taskPacket.instructions.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "(none)";
  const writeBoundary = node.taskPacket.mode === "autonomous"
    ? node.taskPacket.writeRoots ?? []
    : node.taskPacket.writeFiles ?? [];
  const writeBoundaryLabel = node.taskPacket.mode === "autonomous" ? "Write roots" : "Write files";
  const writeFiles = writeBoundary.length
    ? writeBoundary.map((path) => `- ${path}`).join("\n")
    : "- (none)";
  const verification = node.taskPacket.verification.length
    ? node.taskPacket.verification.map((command) => `- ${command.argv.join(" ")}`).join("\n")
    : "- (none)";
  let structured = null;
  try { structured = typeof workerResult === "string" ? JSON.parse(workerResult) : workerResult; } catch {
    // Non-JSON worker result: leave it withheld from the judge prompt.
  }
  if (structured) {
    try { structured = validateWorkerResult(structured); } catch { structured = null; }
  }
  const diff = Array.isArray(context.diff) ? /** @type {unknown[]} */ (context.diff).slice(0, 64) : [];
  const verificationResult = judgeVerificationEvidence(context.verification);
  const scopeSection = scopeFindingsPromptSection(context.scopeFindings);
  return `Review node ${node.id} independently. The review context is closed: inspect only the ${node.taskPacket.mode === "autonomous" ? "write roots" : "write files"} below and do not perform repository-wide discovery. Do not re-run the verification commands — the controller already executed them and attached the results; re-running suites duplicates cost without adding evidence.\n\n` +
    `${writeBoundaryLabel}:\n${writeFiles}\n\nVerification commands (already executed by the controller):\n${verification}\n\n` +
    `Task brief:\n${node.taskPacket.objective}\n\nInstructions:\n${taskInstructions}\n\nDefinition of Done:\n${criteria}\n\n` +
    `Worker result (structured):\n${structured ? JSON.stringify(structured) : "(invalid worker result withheld)"}\n\n` +
    `Controller diff paths:\n${diff.length ? diff.map((path) => `- ${path}`).join("\n") : "- (none)"}\n\n` +
    `Controller verification:\n${JSON.stringify(verificationResult)}\n\n` +
    (scopeSection ? `${scopeSection}\n\n` : "") +
    (context.previousAttempt ? `${context.previousAttempt}\n\n` : "") +
    "Return only the JSON object required by the output schema, with every field present: a verdict with nothing to report still carries `findings: []`, never an omitted key. The verdict is a record, not a report: keep `summary` within " + JUDGE_LIMITS.summaryBytes + " bytes, use at most " + JUDGE_LIMITS.findings + " findings, and keep each finding's `description` within " + JUDGE_LIMITS.descriptionBytes + " bytes and its `evidence` within " + JUDGE_LIMITS.evidenceBytes + " bytes. A verdict that overshoots this envelope is rejected unread, however sound the arbitration. Evidence must be concrete. " +
    "Use verdict pass only when findings is empty and maxSeverity is none. " +
    "Use verdict fail whenever findings is non-empty, including advisory findings below failOn. " +
    (node.definitionOfDone.length
      ? "Arbitrate only the judgment items; deterministic items are already proven by the controller and must not be re-arbitrated. " +
        "Use pass only when every judgment item is satisfied. Every finding must cite the id of the judgment item it addresses; a fail verdict whose findings cite no id is a protocol failure."
      : "Use pass only when every Definition of Done item is satisfied. " +
        "Assess every Definition of Done item by its id and cite the id you are addressing in each finding.");
}

/**
 * The Definition of Done checklist for the judge prompt: judgment items the
 * judge must arbitrate, plus each deterministic item with the controller-run
 * proof result when one is attached.
 *
 * @param {import("../contract/definition-of-done.mjs").DefinitionOfDoneItem[]} items
 * @param {unknown} deterministic
 * @returns {string}
 */
function judgeDoDChecklist(items, deterministic) {
  const results = Array.isArray(deterministic)
    ? /** @type {Array<{id: string, pass: boolean, detail: string}>} */ (deterministic)
    : null;
  const parts = [];
  const judgmentItems = items.filter((item) => item.judgment === true);
  parts.push(judgmentItems.length
    ? `Judgment items — arbitrate only these:\n${judgmentItems.map((item) => `- [${item.id}] ${item.text} (judgment)`).join("\n")}`
    : "No judgment items require arbitration.");
  const proofItems = items.filter((item) => item.proof !== undefined);
  if (proofItems.length) {
    parts.push(`Deterministic items — already proven by the controller; do not re-arbitrate them:\n${proofItems.map((item) => {
      const proof = /** @type {import("../contract/definition-of-done.mjs").DefinitionOfDoneProof} */ (item.proof);
      const result = results?.find((entry) => entry.id === item.id);
      const outcome = result === undefined
        ? "controller proof recorded"
        : result.pass ? "PASS" : `FAIL — ${result.detail}`;
      return `- [${item.id}] ${outcome} — ${item.text} (proof: ${proof.kind} ${proof.ref})`;
    }).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * @param {{prompt: string}} node
 * @param {{summary: string, findings: {severity: "minor"|"major"|"critical", description: string, evidence: string}[]}} verdict
 * @returns {string}
 */
export function retryPrompt(node, verdict) {
  const findings = verdict.findings
    .map((finding) => `- [${finding.severity}] ${boundedPromptText(finding.description, 2 * 1024)} Evidence: ${boundedPromptText(finding.evidence, 4 * 1024)}`)
    .join("\n");
  const prompt = `${node.prompt}\n\nA quality gate rejected the previous attempt. Fix the current working tree in place inside the closed context above.\n` +
    `Gate summary: ${boundedPromptText(verdict.summary, 4 * 1024)}\n${findings}`;
  return Buffer.byteLength(prompt, "utf8") > 64 * 1024
    ? `${node.prompt}\n\nA quality gate rejected the previous attempt. Review the bounded structured findings in the state snapshot and fix the working tree inside the closed context.`
    : prompt;
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedPromptText(value, maxBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : `${bytes.subarray(0, maxBytes - 1).toString("utf8")}…`;
}

