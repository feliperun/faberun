/**
 * Session metering over a provider transcript: what the controller reads from
 * a still-growing stdout log while a turn runs -- provider requests (turns),
 * tool calls, cache reads, completion -- and the bounded incremental parser
 * behind it. Separate from the harness adapters because every adapter owns
 * one stream shape and this module has to know all of them: it is the one
 * place that says what "progress" and "a request" mean for claude, codex,
 * agy and dsh alike. Its readers are the engine (stall detection, the live
 * budget) and the usage ledger; no adapter imports it.
 */
import { canonicalUsage, eventItem, extractJson } from "./protocol.mjs";
import { finite } from "../util.mjs";

/** @typedef {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean, requests: number, contextFirst: number|null, contextMax: number|null, contextLast: number|null, contextSum: number}} SessionTotals */
/**
 * The per-request ledger one transcript proves: provider requests that
 * reported usage, and the context each re-sent -- uncached input (cache
 * writes included) plus cache reads -- for the first, largest and last of
 * them, with their sum. Persisted on the invocation and in usage.jsonl.
 * measured 2026-09-20 over 149 stored claude worker turns: median 49
 * requests, context growing 1.9x within a turn, 3.3M tokens re-sent per
 * turn; the two 600-request turns re-sent 190M and 167M.
 * @typedef {{turns: number, toolCalls: number, requests: number, contextFirst: number|null, contextMax: number|null, contextLast: number|null, contextSum: number|null, completed: boolean}} SessionLedger
 */

/**
 * Best-effort input-token meter over a still-growing transcript. The
 * controller never owns the provider stream (the gate writes stdout straight
 * to the log fd), so budget enforcement polls this instead. Lenient by
 * design: unparsable or partial lines count as zero, and providers that only
 * report usage at completion (exec-jsonl, replay) meter as 0 mid-run.
 *
 * @param {string} harness
 * @param {string} stdout bounded transcript tail
 * @returns {{inputTokens: number|null, cacheReadInputTokens: number|null}}
 */
export function liveUsage(harness, stdout) {
  if (harness === "exec-jsonl" || harness === "replay") {
    // Completion-only harnesses: usage arrives in the terminal envelope, which
    // the close path normalizes, never in a mid-run live observation.
    return { inputTokens: null, cacheReadInputTokens: null };
  }
  const events = parsedEvents(stdout);
  if (harness === "codex") {
    // turn.completed usage is cumulative for the session; the last one wins.
    // Codex counts input_tokens with their cached portion included, so the
    // uncached total is what the ledger calls `inputTokens`.
    const records = events
      .filter((event) => event?.type === "turn.completed" && event.usage && typeof event.usage === "object")
      .map((event) => {
        const rawInput = finite(event.usage.input_tokens ?? event.usage.inputTokens);
        if (rawInput === null) return null;
        const cacheReadInputTokens = finite(
          event.usage.cached_input_tokens ?? event.usage.cacheReadInputTokens ?? event.usage.cache_read_tokens,
        ) ?? 0;
        return { inputTokens: Math.max(0, rawInput - cacheReadInputTokens), cacheReadInputTokens };
      })
      .filter((record) => record !== null);
    if (!records.length) return { inputTokens: null, cacheReadInputTokens: null };
    return records.reduce((best, record) => (
      record.inputTokens + record.cacheReadInputTokens > best.inputTokens + best.cacheReadInputTokens ? record : best
    ));
  }
  if (harness === "claude") {
    // The terminal result event carries the session total; before it lands,
    // sum per-request assistant usage (each request re-reads full context).
    // Claude's input_tokens already exclude cache reads.
    const resultEvent = events.findLast((event) => event?.type === "result");
    const resultUsage = resultEvent?.usage && typeof resultEvent.usage === "object"
      ? finite(resultEvent.usage.input_tokens ?? resultEvent.usage.inputTokens)
      : null;
    if (resultUsage !== null) {
      return {
        inputTokens: resultUsage,
        cacheReadInputTokens: finite(resultEvent.usage.cache_read_input_tokens ?? resultEvent.usage.cacheReadInputTokens) ?? null,
      };
    }
    return {
      inputTokens: events.reduce((sum, event) => {
        if (event?.type !== "assistant") return sum;
        const usage = event.message?.usage;
        const value = usage && typeof usage === "object" ? finite(usage.input_tokens ?? usage.inputTokens) : null;
        return sum + (value ?? 0);
      }, 0) || null,
      cacheReadInputTokens: null,
    };
  }
  if (harness === "dsh") {
    // The terminal event carries the harness's own session total; before it
    // lands, sum the per-message usage the runner forwards.
    const terminal = events.findLast((event) => event?.type === "dsh.completed" || event?.type === "dsh.failed");
    const terminalUsage = terminal ? canonicalUsage(terminal.usage) : null;
    if (terminalUsage && terminalUsage.inputTokens !== null) {
      return { inputTokens: terminalUsage.inputTokens, cacheReadInputTokens: terminalUsage.cacheReadInputTokens };
    }
    return sumRequestUsage(events.filter((event) => event?.type === "dsh.message").map((event) => event.usage));
  }
  if (harness === "agy") {
    const resultRecord = events.map((event) => agyResult(event)).findLast((result) => result !== null);
    const resultUsage = resultRecord ? canonicalUsage(resultRecord.usage) : null;
    if (resultUsage && resultUsage.inputTokens !== null) {
      return { inputTokens: resultUsage.inputTokens, cacheReadInputTokens: resultUsage.cacheReadInputTokens };
    }
    return sumRequestUsage(events.map((event) => agyStep(event))
      .filter((step) => step !== null && step.step_type === "agent_response" && step.state === "DONE")
      .map((step) => step?.usage));
  }
  return { inputTokens: null, cacheReadInputTokens: null };
}

/**
 * Sum per-request usage records into the live meter's shape; no record with
 * a measured input leaves the meter null rather than a plausible zero.
 *
 * @param {unknown[]} usages
 * @returns {{inputTokens: number|null, cacheReadInputTokens: number|null}}
 */
function sumRequestUsage(usages) {
  let inputTokens = null;
  let cacheReadInputTokens = 0;
  for (const raw of usages) {
    const usage = canonicalUsage(raw);
    if (usage.inputTokens === null) continue;
    inputTokens = (inputTokens ?? 0) + usage.inputTokens;
    cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
  }
  return inputTokens === null ? { inputTokens: null, cacheReadInputTokens: null } : { inputTokens, cacheReadInputTokens };
}

/**
 * Budgeted live meter: one number, with cache reads weighted by the campaign
 * policy so it is comparable with the persisted ledger. A provider that only
 * reports usage at completion (exec-jsonl, replay) meters as 0 mid-run.
 *
 * @param {string} harness
 * @param {string} stdout bounded transcript tail
 * @param {number} [cacheReadWeight] cached-to-uncached rate ratio, default 1
 * @returns {number}
 */
export function liveInputTokens(harness, stdout, cacheReadWeight = 1) {
  const usage = liveUsage(harness, stdout);
  if (usage.inputTokens === null) return 0;
  const weighted = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) * cacheReadWeight;
  return Math.round(weighted * 1000) / 1000;
}

/**
 * Parse each JSONL line independently. A bounded transcript tail can start or
 * end mid-line, so unparsable lines are skipped rather than failing the live
 * observation.
 *
 * @param {string} stdout
 */
function parsedEvents(stdout) {
  return String(stdout).split(/\r?\n/u).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Codex item types whose completion proves one tool invocation. */
const CODEX_TOOL_ITEM_TYPES = new Set(["tool_call", "command_execution", "mcp_tool_call", "web_search", "file_change"]);

/**
 * Session evidence from a bounded live transcript: completed turns, cache-read
 * input, tool invocations, and whether the harness's terminal record has been
 * folded. Each harness exposes only what its own events prove, and anything
 * unparsable or unsupported meters as zero — a live observation never throws.
 *
 * @param {string} harness
 * @param {string} stdout bounded transcript tail
 * @returns {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}}
 */
export function liveSessionMetrics(harness, stdout) {
  const parser = new SessionMetricsParser(harness);
  parser.push(String(stdout));
  parser.flush();
  return parser.metrics();
}

/** Retention bound for one streamed record: records at or below it parse whole. */
const SESSION_RECORD_MAX_BYTES = 64 * 1024;

/** Fragment evidence kept for a record that outgrew the retention bound. */
const SESSION_FRAGMENT_BYTES = SESSION_RECORD_MAX_BYTES / 2;

/** Claude-family content-block needle proving one tool invocation. */
const TOOL_USE_NEEDLE = Buffer.from('"type":"tool_use"', "utf8");

/** Cache-read evidence spellings across harness streams. */
const CACHE_READ_PATTERN = /"(?:cache_read_input_tokens|cached_input_tokens|cacheReadInputTokens)":(\d+)/gu;

/**
 * Bounded incremental session-metrics parser: fold fixed-size chunks into
 * running rotation totals without ever holding a buffer that scales with the
 * unread transcript. Records within `SESSION_RECORD_MAX_BYTES` parse whole;
 * a larger record keeps head and tail fragments plus streamed needle counts,
 * so its turn and usage evidence still lands in the totals instead of being
 * silently skipped.
 */
export class SessionMetricsParser {
  /**
   * @param {string} harness
   * @param {{turns?: number, cacheReadInputTokens?: number, toolCalls?: number, completed?: boolean}} [previous]
   */
  constructor(harness, previous = {}) {
    this.harness = harness;
    /** @type {SessionTotals} */
    this.totals = {
      turns: previous.turns ?? 0,
      cacheReadInputTokens: previous.cacheReadInputTokens ?? 0,
      toolCalls: previous.toolCalls ?? 0,
      completed: previous.completed === true,
      requests: 0,
      contextFirst: null,
      contextMax: null,
      contextLast: null,
      contextSum: 0,
    };
    /** @type {string|null} */
    this.continuationId = null;
    /** @type {string|null} Most recent folded item-completed type, for the codex completion rule. */
    this.lastItemType = null;
    /** @type {string|null} Text of the most recent folded agent message, for the codex completion rule. */
    this.lastAgentText = null;
    /** @type {Buffer} */
    this.pending = Buffer.alloc(0);
    /** @type {{head: Buffer, tail: Buffer, streamedToolUse: number, carry: Buffer}|null} */
    this.oversized = null;
  }

  /**
   * Fold every newline-terminated record in one chunk. A trailing partial
   * record stays buffered (bounded) for the next chunk.
   *
   * @param {string|Buffer} chunk
   */
  push(chunk) {
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    while (data.length > 0) {
      const newline = data.indexOf(10);
      if (newline < 0) {
        this.absorb(data);
        return;
      }
      this.absorb(data.subarray(0, newline));
      this.completeRecord();
      data = data.subarray(newline + 1);
    }
  }

  /** Fold the buffered partial record as if a newline had ended it. */
  flush() {
    if (this.pending.length > 0 || this.oversized) this.completeRecord();
  }

  /** @returns {{turns: number, cacheReadInputTokens: number, toolCalls: number, completed: boolean}} */
  metrics() {
    return {
      turns: this.totals.turns,
      cacheReadInputTokens: this.totals.cacheReadInputTokens,
      toolCalls: this.totals.toolCalls,
      completed: this.totals.completed === true,
    };
  }

  /**
   * The per-request ledger folded so far. Codex reports usage cumulatively
   * per turn rather than per request, so its request fields stay null.
   *
   * @returns {SessionLedger}
   */
  session() {
    const totals = this.totals;
    return {
      turns: totals.turns,
      toolCalls: totals.toolCalls,
      requests: totals.requests,
      contextFirst: totals.contextFirst,
      contextMax: totals.contextMax,
      contextLast: totals.contextLast,
      contextSum: totals.requests > 0 ? totals.contextSum : null,
      completed: totals.completed === true,
    };
  }

  /**
   * Retain one piece of a record still under assembly. Once the record
   * outgrows the retention bound, only its head and a rolling tail are kept;
   * the bytes leaving the tail are scanned for tool_use evidence instead of
   * being buffered.
   *
   * @param {Buffer} piece
   */
  absorb(piece) {
    if (this.oversized) {
      const window = Buffer.concat([this.oversized.tail, piece]);
      const keep = window.subarray(Math.max(0, window.length - SESSION_FRAGMENT_BYTES));
      const dropped = window.subarray(0, window.length - keep.length);
      if (this.harness === "claude") {
        const counted = countWithCarry(dropped, this.oversized.carry, TOOL_USE_NEEDLE);
        this.oversized.streamedToolUse += counted.hits;
        this.oversized.carry = counted.carry;
      }
      this.oversized.tail = keep;
      return;
    }
    if (this.pending.length + piece.length <= SESSION_RECORD_MAX_BYTES) {
      // Copy: `piece` may be a view of a scratch buffer the caller reuses for
      // the next read, which would corrupt a record buffered mid-chunk.
      this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, piece]) : Buffer.from(piece);
      return;
    }
    const whole = Buffer.concat([this.pending, piece]);
    this.pending = Buffer.alloc(0);
    const head = whole.subarray(0, Math.min(SESSION_FRAGMENT_BYTES, whole.length));
    const tail = whole.subarray(Math.max(0, whole.length - SESSION_FRAGMENT_BYTES));
    /** @type {{head: Buffer, tail: Buffer, streamedToolUse: number, carry: Buffer}} */
    const oversized = { head, tail, streamedToolUse: 0, carry: Buffer.alloc(0) };
    if (this.harness === "claude") {
      // Count from the record start up to where the rolling tail takes over,
      // so a needle straddling any region boundary is counted exactly once.
      const counted = countWithCarry(whole.subarray(0, Math.max(0, whole.length - tail.length)), oversized.carry, TOOL_USE_NEEDLE);
      oversized.streamedToolUse = counted.hits;
      oversized.carry = counted.carry;
    }
    this.oversized = oversized;
  }

  /** Fold the assembled record into the running totals. */
  completeRecord() {
    const oversized = this.oversized;
    if (oversized) {
      this.oversized = null;
      /** @type {{head: string, tail: string, toolUse: number}} */
      let fragments;
      if (this.harness === "claude") {
        const counted = countWithCarry(oversized.tail, oversized.carry, TOOL_USE_NEEDLE);
        fragments = {
          head: decodeFragment(oversized.head),
          tail: decodeFragment(oversized.tail),
          toolUse: oversized.streamedToolUse + counted.hits,
        };
      } else {
        fragments = { head: decodeFragment(oversized.head), tail: decodeFragment(oversized.tail), toolUse: 0 };
      }
      foldFragmentRecord(this.harness, this.totals, fragments);
      this.continuationId ??= fragmentContinuationId(this.harness, fragments);
      return;
    }
    const line = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const record = /** @type {Record<string, unknown>} */ (event);
    foldRecord(this.harness, this.totals, record);
    this.continuationId ??= recordContinuationId(this.harness, record);
    this.foldCompletionEvidence(record);
  }

  /**
   * Fold the completion evidence one parsed record proves into the sticky
   * totals. A harness is completed when its terminal record was folded; for
   * codex that means a turn.completed that ends the turn with the
   * result-carrying final agent message, so a live observation never treats a
   * still-working or already-answered session ambiguously.
   *
   * @param {Record<string, unknown>} record
   */
  foldCompletionEvidence(record) {
    const totals = this.totals;
    if (this.harness === "codex") {
      if (record.type === "turn.completed" && this.lastItemType === "agent_message"
        && extractJson(this.lastAgentText) !== null) {
        totals.completed = true;
      }
    } else if (this.harness === "claude" && record.type === "result") {
      totals.completed = true;
    } else if (this.harness === "dsh" && (record.type === "dsh.completed" || record.type === "dsh.failed")) {
      totals.completed = true;
    } else if (this.harness === "agy" && record.event === "result") {
      totals.completed = true;
    } else if (this.harness === "exec-jsonl" && record.type === "run.completed") {
      totals.completed = true;
    } else if (this.harness === "replay" && typeof record.status === "string") {
      // The replay envelope is the terminal record: the bin emits exactly one
      // envelope line per invocation, so folding one proves completion.
      totals.completed = true;
    }
    const item = eventItem(record);
    if (record.type === "item.completed" && item) {
      this.lastItemType = String(item.type ?? "");
      this.lastAgentText = this.lastItemType === "agent_message" && typeof item.text === "string"
        ? item.text
        : null;
    } else {
      this.lastItemType = null;
      this.lastAgentText = null;
    }
  }
}

/**
 * Fold one parsed record into the running totals. Turn and tool counts are
 * additive; cache-read is a running max for Codex (each turn.completed
 * counter is already cumulative) and additive for claude-style streams until
 * a terminal result event carries the authoritative session total.
 *
 * @param {string} harness
 * @param {SessionTotals} totals
 * @param {Record<string, unknown>} record
 */
function foldRecord(harness, totals, record) {
  if (harness === "codex") {
    if (record.type === "turn.completed") {
      totals.turns += 1;
      totals.cacheReadInputTokens = Math.max(totals.cacheReadInputTokens, canonicalUsage(record.usage).cacheReadInputTokens ?? 0);
    } else if (record.type === "item.completed" && CODEX_TOOL_ITEM_TYPES.has(String(eventItem(record)?.type))) {
      totals.toolCalls += 1;
    }
    return;
  }
  if (harness === "claude") {
    if (record.type === "assistant") {
      const message = /** @type {Record<string, unknown>} */ (record.message ?? {});
      totals.turns += 1;
      totals.cacheReadInputTokens += canonicalUsage(message.usage).cacheReadInputTokens ?? 0;
      foldRequestUsage(totals, canonicalUsage(message.usage));
      totals.toolCalls += Array.isArray(message.content)
        ? message.content.filter((/** @type {{type?: unknown}} */ block) => block?.type === "tool_use").length
        : 0;
    } else if (record.type === "result") {
      const sessionTotal = canonicalUsage(record.usage).cacheReadInputTokens;
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
    }
    return;
  }
  if (harness === "dsh") {
    // The runner folds the sdk firehose to one `dsh.message` per assistant
    // message (with that message's usage) and one `dsh.tool` per tool call.
    // measured 2026-09-20: before this branch a dsh turn metered zero events,
    // so once progress became event-only (668f6c1) the stall detector cut
    // every dsh worker at the contract's stallTimeoutSec regardless of
    // activity -- three kills on 2026-09-16 at 903s against a 900s limit.
    if (record.type === "dsh.message") {
      totals.turns += 1;
      totals.cacheReadInputTokens += canonicalUsage(record.usage).cacheReadInputTokens ?? 0;
      foldRequestUsage(totals, canonicalUsage(record.usage));
    } else if (record.type === "dsh.tool") {
      totals.toolCalls += 1;
    } else if (record.type === "dsh.completed" || record.type === "dsh.failed") {
      const sessionTotal = canonicalUsage(record.usage).cacheReadInputTokens;
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
    }
    return;
  }
  if (harness === "agy") {
    // agy streams one `step_update` per step: an agent_response reaching DONE
    // is one provider request carrying its own usage, a tool step reaching
    // DONE or ERROR is one tool call, and the terminal `result` carries the
    // session total (measured 2026-09-20 over 6 agy invocations: 140 DONE and
    // 4 ERROR tool steps, 166 DONE agent responses).
    const step = agyStep(record);
    if (step) {
      if (step.step_type === "agent_response" && step.state === "DONE") {
        totals.turns += 1;
        totals.cacheReadInputTokens += canonicalUsage(step.usage).cacheReadInputTokens ?? 0;
        foldRequestUsage(totals, canonicalUsage(step.usage));
      } else if (step.step_type === "tool" && (step.state === "DONE" || step.state === "ERROR")) {
        totals.toolCalls += 1;
      }
    } else if (record.event === "result") {
      const sessionTotal = canonicalUsage(agyResult(record)?.usage).cacheReadInputTokens;
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
    }
    return;
  }
  if (harness === "exec-jsonl" && record.type === "run.completed") {
    // The protocol carries no tool events; only a completed run proves a turn.
    totals.turns += 1;
    totals.cacheReadInputTokens += canonicalUsage(record.usage).cacheReadInputTokens ?? 0;
    foldRequestUsage(totals, canonicalUsage(record.usage));
  }
  if (harness === "replay" && typeof record.status === "string") {
    // A replayed envelope is the whole invocation: one completed turn, no
    // tool events, usage only in the terminal record.
    totals.turns += 1;
    totals.cacheReadInputTokens += canonicalUsage(record.usage).cacheReadInputTokens ?? 0;
    foldRequestUsage(totals, canonicalUsage(record.usage));
  }
}

/**
 * Fold one provider request's usage into the per-request ledger. A request
 * with no measured input is not one the ledger can count.
 *
 * @param {SessionTotals} totals
 * @param {{inputTokens: number|null, cacheReadInputTokens: number|null}} usage
 */
function foldRequestUsage(totals, usage) {
  if (usage.inputTokens === null) return;
  const context = usage.inputTokens + (usage.cacheReadInputTokens ?? 0);
  totals.requests += 1;
  totals.contextFirst ??= context;
  totals.contextMax = Math.max(totals.contextMax ?? 0, context);
  totals.contextLast = context;
  totals.contextSum += context;
}

/** @param {Record<string, unknown>} record @returns {Record<string, any>|null} the agy step_update payload, if this record is one */
function agyStep(record) {
  if (record.event !== "step_update") return null;
  const step = record.step_update;
  return step && typeof step === "object" && !Array.isArray(step) ? /** @type {Record<string, any>} */ (step) : null;
}

/** @param {Record<string, unknown>} record @returns {Record<string, any>|null} the agy terminal result payload, if this record is one */
function agyResult(record) {
  if (record.event !== "result") return null;
  const result = record.result;
  return result && typeof result === "object" && !Array.isArray(result) ? /** @type {Record<string, any>} */ (result) : null;
}

/**
 * Fold the head-plus-tail fragments of one record that outgrew the retention
 * bound: the same evidence foldRecord extracts, read as fragments so an
 * oversized record is never silently skipped.
 *
 * @param {string} harness
 * @param {SessionTotals} totals
 * @param {{head: string, tail: string, toolUse: number}} fragments
 */
function foldFragmentRecord(harness, totals, fragments) {
  const text = `${fragments.head}\n${fragments.tail}`;
  if (harness === "claude") {
    if (text.includes('"type":"assistant"')) {
      totals.turns += 1;
      totals.toolCalls += fragments.toolUse;
      const cacheRead = lastCacheRead(text);
      if (cacheRead !== null) totals.cacheReadInputTokens += cacheRead;
    } else if (text.includes('"type":"result"')) {
      const sessionTotal = lastCacheRead(text);
      if (sessionTotal !== null) totals.cacheReadInputTokens = sessionTotal;
      totals.completed = true;
    }
    return;
  }
  if (harness === "codex") {
    if (text.includes('"type":"turn.completed"')) {
      totals.turns += 1;
      const cacheRead = lastCacheRead(text);
      totals.cacheReadInputTokens = Math.max(totals.cacheReadInputTokens, cacheRead ?? 0);
      // Fragment approximation of the parsed-record completion rule: the
      // turn ends with the final agent message when that message appears
      // before the completed marker in the retained head and tail.
      const agentAt = text.indexOf('"type":"agent_message"');
      if (agentAt >= 0 && agentAt < text.indexOf('"type":"turn.completed"')) totals.completed = true;
    } else if (text.includes('"type":"item.completed"') && [...CODEX_TOOL_ITEM_TYPES].some((type) => text.includes(`"type":"${type}"`))) {
      totals.toolCalls += 1;
    }
    return;
  }
  if (harness === "exec-jsonl" && text.includes('"type":"run.completed"')) {
    totals.turns += 1;
    const cacheRead = lastCacheRead(text);
    if (cacheRead !== null) totals.cacheReadInputTokens += cacheRead;
    totals.completed = true;
  }
}

/**
 * The provider session identity one record proves.
 *
 * @param {string} harness
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function recordContinuationId(harness, record) {
  if (harness === "codex") {
    return record.type === "thread.started" && typeof record.thread_id === "string" ? record.thread_id : null;
  }
  if (harness === "claude") {
    return record.type === "result" && typeof record.session_id === "string" ? record.session_id : null;
  }
  if (harness === "exec-jsonl" && (record.type === "run.started" || record.type === "run.completed")) {
    return typeof record.continuationId === "string" ? record.continuationId : null;
  }
  return null;
}

/**
 * The provider session identity one record's fragments prove.
 *
 * @param {string} harness
 * @param {{head: string, tail: string}} fragments
 * @returns {string|null}
 */
function fragmentContinuationId(harness, fragments) {
  const text = `${fragments.head}\n${fragments.tail}`;
  const pattern = harness === "codex"
    ? /"thread_id":"([^"]+)"/u
    : harness === "claude"
      ? /"session_id":"([^"]+)"/u
      : /"continuationId":"([^"]+)"/u;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

/**
 * Count needle occurrences in one region, keeping the trailing bytes that
 * could complete a needle in the next region so a straddling needle is
 * counted exactly once.
 *
 * @param {Buffer} region
 * @param {Buffer} carry
 * @param {Buffer} needle
 * @returns {{hits: number, carry: Buffer}}
 */
function countWithCarry(region, carry, needle) {
  const stream = carry.length > 0 ? Buffer.concat([carry, region]) : region;
  return { hits: countNeedle(stream, needle), carry: stream.subarray(Math.max(0, stream.length - (needle.length - 1))) };
}

/**
 * @param {Buffer} haystack
 * @param {Buffer} needle
 * @returns {number}
 */
function countNeedle(haystack, needle) {
  let hits = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) hits += 1;
  return hits;
}

/**
 * Decode a retained fragment without splitting a UTF-8 sequence.
 *
 * @param {Buffer} fragment
 * @returns {string}
 */
function decodeFragment(fragment) {
  let start = 0;
  while (start < fragment.length && (fragment[start] & 0xc0) === 0x80) start += 1;
  return fragment.toString("utf8", start);
}

/**
 * The last cache-read number in a fragment text, or null.
 *
 * @param {string} text
 * @returns {number|null}
 */
function lastCacheRead(text) {
  const matches = [...text.matchAll(CACHE_READ_PATTERN)];
  return matches.length > 0 ? Number(matches.at(-1)?.[1]) : null;
}
