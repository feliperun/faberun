import { validateWorkerResult } from "../contract/worker-result.mjs";
import { scopeFindingsPromptSection } from "../contract/scope-findings.mjs";
import { JUDGE_ENVELOPE_REASON, JUDGE_FINDING_ENVELOPE_REASON, JUDGE_LIMITS } from "../contract/judge-envelope.mjs";
import { RESERVED_OWNER_DECISIONS, uncoveredReservedOwnerDecisions } from "../contract/articles.mjs";
import { harnessCapabilities } from "../harnesses/index.mjs";

/** @typedef {{id: string, definitionOfDone: import("../contract/definition-of-done.mjs").DefinitionOfDoneItem[], taskPacket: {mode?: "execution"|"discovery"|"autonomous", objective: string, instructions: string[], decisions?: string[], writeFiles?: string[], writeRoots?: string[], verification: {argv: string[]}[]}}} JudgeNode */
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

/** Heading `renderPreviousAttemptSection` (engine/retry.mjs) writes an operator answer under. */
const OPERATOR_ANSWER_HEADING = "Operator answer:";

/**
 * The latest operator answer carried by a `Previous attempt` section, or null.
 * `renderPreviousAttemptSection` writes it verbatim under the heading, so the
 * judge reads the same newest answer the worker read without a second copy on
 * the node snapshot. A second `--answer` appends an override and the section is
 * rebuilt from the newest record on the next resume.
 *
 * @param {unknown} previousAttempt
 * @returns {string|null}
 */
export function previousAttemptOperatorAnswer(previousAttempt) {
  if (typeof previousAttempt !== "string") return null;
  const start = previousAttempt.indexOf(OPERATOR_ANSWER_HEADING);
  if (start < 0) return null;
  const rest = previousAttempt.slice(start + OPERATOR_ANSWER_HEADING.length);
  const stop = rest.search(/^(?:Attempt \d+ failed|Error:|Judge findings|Scope findings|Failing verification:)/mu);
  const answer = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  return answer || null;
}

/**
 * The heading the variable previous-attempt state travels under, byte-equal
 * to the line `renderPreviousAttemptSection` (engine/retry.mjs) writes: two
 * hashes, one space, `Previous attempt`, end of line. Every tolerance this
 * match ever carried cost a node: a tolerant suffix read the task's own
 * `## Previous attempt notes:` heading as retry state (this node's attempt
 * 2), and a tolerant `#{1,6}` hash run read a task instruction headed
 * `# Previous attempt` the same way (attempt 3's revision_cap) — with a
 * state section supplied, the lifted block was replaced and the stable
 * instructions after that heading were dropped from the worker and judge
 * prompts. Only the writer's exact spelling may open the variable block.
 */
const PREVIOUS_ATTEMPT_HEADING = /^## Previous attempt$/gm;

/**
 * The line every rendered record opens with — `Attempt N failed; this is
 * attempt M.`, the `Attempt N failed` opening `previousAttemptOperatorAnswer`'s
 * stop regex reads as a section start, and the first body line under the
 * heading in every record the retry writer lays down (this node's own retry
 * records included). Requiring it behind the heading keeps the split on real
 * trailing record blocks: an instruction block that borrows even the exact
 * heading opens its body with other words — measured on attempt 3's
 * revision_cap, where `Attempt 2 failed in staging` under a borrowed heading
 * was classified as a record and split out of the stable prefix.
 */
const PREVIOUS_ATTEMPT_RECORD_LINE = /^Attempt \d+ failed; this is attempt \d+\./u;

/**
 * Split a prompt that already carries the variable `Previous attempt` section
 * into the stable instructions and that section, so assembly can re-append it
 * after the stable sandbox notice and result-file protocol — cacheable prefix
 * first, variable state last. The section is the block from its heading to
 * the end of the prompt: every writer lays it down as the trailing block of
 * whatever it was built on. `section` is null when the base carries none.
 *
 * @param {string} basePrompt
 * @returns {{stable: string, section: string|null}}
 */
export function splitPreviousAttemptSection(basePrompt) {
  for (const match of basePrompt.matchAll(PREVIOUS_ATTEMPT_HEADING)) {
    const rest = basePrompt.slice(match.index + match[0].length);
    const bodyStart = rest.split("\n").find((line) => line.trim() !== "");
    if (bodyStart !== undefined && PREVIOUS_ATTEMPT_RECORD_LINE.test(bodyStart)) {
      return {
        stable: basePrompt.slice(0, match.index).replace(/\n+$/u, ""),
        section: basePrompt.slice(match.index).replace(/\n+$/u, ""),
      };
    }
  }
  return { stable: basePrompt, section: null };
}

/**
 * @param {JudgeNode} node
 * @param {unknown} workerResult
 * @param {{diff?: unknown[], verification?: unknown, deterministic?: unknown, scopeFindings?: {unexpectedPaths: string[]}|null, previousAttempt?: string, operatorAnswer?: string}} context
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
  const decisions = node.taskPacket.decisions ?? [];
  const uncoveredReserved = uncoveredReservedOwnerDecisions(decisions);
  const operatorAnswer = typeof context.operatorAnswer === "string" && context.operatorAnswer.trim()
    ? context.operatorAnswer.trim()
    : previousAttemptOperatorAnswer(context.previousAttempt);
  const decisionsSection =
    `Decisions already made by the operator:\n${decisions.length ? decisions.map((decision) => `- ${decision}`).join("\n") : "- (none)"}\n\n` +
    `Reserved owner decisions (the repository owner alone decides these):\n${RESERVED_OWNER_DECISIONS.map((decision) => `- ${decision}`).join("\n")}\n\n` +
    `Reserved owner decisions with no coverage in the decisions above:\n${uncoveredReserved.length ? uncoveredReserved.map((decision) => `- ${decision}`).join("\n") : "- (none)"}\n\n` +
    "A diff that takes an owner decision with no coverage is a blocking finding: fail and name the decision. Referencing an existing owner decision does not take it.";
  const operatorSection = operatorAnswer
    ? `Operator answer:\n${operatorAnswer}\n\nThat operator answer is a blocking judgment item: an unmet answer is a blocking finding, so fail with a finding that cites the Definition of Done judgment item the answer bears on, and do not pass work that ignores it.`
    : "";
  return `Review node ${node.id} independently. The review context is closed: inspect only the ${node.taskPacket.mode === "autonomous" ? "write roots" : "write files"} below and do not perform repository-wide discovery. Do not re-run the verification commands — the controller already executed them and attached the results; re-running suites duplicates cost without adding evidence.\n\n` +
    `${writeBoundaryLabel}:\n${writeFiles}\n\nVerification commands (already executed by the controller):\n${verification}\n\n` +
    `Task brief:\n${node.taskPacket.objective}\n\nInstructions:\n${taskInstructions}\n\n${decisionsSection}\n\nDefinition of Done:\n${criteria}\n\n` +
    (operatorSection ? `${operatorSection}\n\n` : "") +
    `Worker result (structured):\n${structured ? JSON.stringify(structured) : "(invalid worker result withheld)"}\n\n` +
    `Controller diff paths:\n${diff.length ? diff.map((path) => `- ${path}`).join("\n") : "- (none)"}\n\n` +
    `Controller verification:\n${JSON.stringify(verificationResult)}\n\n` +
    (scopeSection ? `${scopeSection}\n\n` : "") +
    "Return only the JSON object required by the output schema, with every field present: a verdict with nothing to report still carries `findings: []`, never an omitted key. The verdict is a record, not a report: keep `summary` within " + JUDGE_LIMITS.summaryBytes + " bytes, use at most " + JUDGE_LIMITS.findings + " findings, and keep each finding's `description` within " + JUDGE_LIMITS.descriptionBytes + " bytes and its `evidence` within " + JUDGE_LIMITS.evidenceBytes + " bytes. A verdict that overshoots this envelope is rejected unread, however sound the arbitration. Evidence must be concrete. " +
    "Use verdict pass only when findings is empty and maxSeverity is none. " +
    "Use verdict fail whenever findings is non-empty, including advisory findings below failOn. " +
    (node.definitionOfDone.length
      ? "Arbitrate only the judgment items; deterministic items are already proven by the controller and must not be re-arbitrated. " +
        "Use pass only when every judgment item is satisfied. Every finding must cite the id of the judgment item it addresses; a fail verdict whose findings cite no id is a protocol failure."
      : "Use pass only when every Definition of Done item is satisfied. " +
        "Assess every Definition of Done item by its id and cite the id you are addressing in each finding.") +
    // The variable state trails every stable instruction, including the
    // output-schema rules, so the cacheable prefix ends at the section's
    // heading and dispatch's assembly keeps it last when it re-appends.
    (context.previousAttempt ? `\n\n${context.previousAttempt}` : "");
}

/**
 * The one rule the judge has never been given, added after N5 of the
 * `open-source-readiness` campaign (AP20). A requirement that reads "the
 * guard refuses these paths, except the declared ones" enumerates its cases,
 * and a delivery that holds the general shape without covering one of them
 * passes a judge that only checks whether the shape holds. Measured
 * 2026-09-27: the `guards-core` node shipped the guard without the default
 * exclusions its requirement declared, the judge approved, and the operator
 * had to intervene twice on the integration ref for the phase to close.
 *
 * The rule sits with the list it governs, so it is stated exactly when there
 * are judgment items to arbitrate and never when there are none.
 */
const JUDGE_ENUMERATED_ITEM_RULE =
  "When an item enumerates cases, classes or exclusions (\"A, B and C\", \"every X except Y\"), it is satisfied only when the delivery covers every one of them, checked one by one against the diff: the general shape holding is not coverage. A finding that names such an item must say which of them is missing, and an approval that checked none of them is a protocol failure.";

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
    ? `Judgment items — arbitrate only these:\n${judgmentItems.map((item) => `- [${item.id}] ${item.text} (judgment)`).join("\n")}\n${JUDGE_ENUMERATED_ITEM_RULE}`
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
 * Append the `## Sandbox` warning a resolved worker runtime earns. Only a
 * harness whose adapter declares `signalsProcesses === false` gets it: that
 * sandbox cannot signal child processes or read the process table, so a test
 * that starts and terminates a child hangs until the executor's cap. An
 * unmeasured harness (`null`) is left alone — no measurement justifies the
 * warning.
 *
 * @param {string} prompt
 * @param {{harness: string}} runtime
 * @returns {string}
 */
export function appendSandboxNotice(prompt, runtime) {
  if (harnessCapabilities(runtime).signalsProcesses !== false) return prompt;
  return `${prompt}\n\n## Sandbox\nYour harness runs you in a sandbox that cannot signal other processes or read the process table. A test that starts and terminates a child process hangs here until the executor's cap and is then killed as a stall. Do not run such tests; the controller runs them after you report.`;
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

