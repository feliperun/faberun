/**
 * The adapter half of Faberun's own harness clients. `dsh` and `fx` are
 * driven by a runner this repository ships (a JSON-RPC client per harness),
 * and both runners write the same transcript: `<prefix>.started`,
 * `<prefix>.tool`, `<prefix>.message`, then exactly one `<prefix>.completed`
 * or `<prefix>.failed` carrying the session usage. Folding that transcript
 * into an envelope is one job whatever harness sits behind the runner, so it
 * lives here instead of in either adapter.
 */

import { canonicalUsage, extractJson, failed, isQuotaText, isVerdictCandidate, parseJsonLines } from "./protocol.mjs";

/**
 * @param {string} prefix the runner's event namespace, `dsh` or `fx`
 * @param {string} stdout
 * @param {number|null} exitCode
 * @param {string|null} signal
 * @param {import("./index.mjs").NormalizeOptions} [options]
 * @returns {import("./index.mjs").ProviderEnvelope}
 */
export function normalizeRunnerTranscript(prefix, stdout, exitCode, signal, options = {}) {
  if (signal) return failed("canceled", `provider ended after ${signal}`, "canceled");
  let events;
  try {
    events = parseJsonLines(stdout, prefix);
  } catch (error) {
    return failed("invalid_protocol", error instanceof Error ? error.message : String(error));
  }
  const terminal = events.findLast((event) => event.type === `${prefix}.completed` || event.type === `${prefix}.failed`);
  if (!terminal) {
    const detail = options.stderr?.trim();
    return failed(
      "incomplete_stream",
      `${prefix} emitted no terminal event${detail ? `: ${detail.slice(-512)}` : ""}${exitCode === null ? "" : ` (exit ${exitCode})`}`,
    );
  }
  const usage = canonicalUsage(terminal.usage);
  if (terminal.type === `${prefix}.completed`) {
    const text = typeof terminal.result === "string" ? terminal.result : null;
    const result = options.preferStructured ? extractJson(text) ?? text : text;
    const verdicts = options.preferStructured
      ? events.filter((event) => event.type === `${prefix}.message` && isVerdictCandidate(event.text)).length
      : null;
    return {
      status: result?.trim() ? "done" : "no-op",
      result,
      continuationId: null,
      usage,
      costUsd: null,
      error: null,
      ...(verdicts === null ? {} : { judgeCandidates: verdicts }),
    };
  }
  const error = terminal.error && typeof terminal.error === "object" ? /** @type {Record<string, unknown>} */ (terminal.error) : {};
  const kind = typeof terminal.kind === "string" ? terminal.kind : "error";
  const code = typeof error.code === "string" && error.code ? error.code : kind;
  const message = typeof error.message === "string" && error.message ? error.message : code;
  const resetAt = resetTimestamp(error.retryAfterMs);
  return {
    status: statusFor(kind, `${code} ${message}`),
    result: null,
    continuationId: null,
    usage,
    costUsd: null,
    error: { code, message, ...(resetAt ? { resetAt } : {}) },
    ...(resetAt ? { exhaustedUntil: resetAt } : {}),
  };
}

/**
 * Append the output schema the judge prompt refers to. Codex and Claude receive
 * it through a native flag; neither runner-driven harness has one, so it
 * travels in the prompt.
 *
 * @param {string} prompt
 * @param {object|undefined} schema
 * @returns {string}
 */
export function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\nOutput schema (the JSON object must validate against it):\n${JSON.stringify(schema)}`;
}

/**
 * The environment overlay every runner turn spawns with. The Claude Code shell
 * exports `GIT_CONFIG_COUNT` with the VALUE half of each `GIT_CONFIG_{KEY,VALUE}_<n>`
 * pair but not the key half, so `git init` inside the worker fails with status
 * 128; the overlay removes the whole family. `GIT_TERMINAL_PROMPT=0` takes over
 * the prompting that family was for. A null value removes the ambient variable
 * when the gate merges the overlay over the runner environment.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string|null>}
 */
export function runnerEnvironmentOverlay(env) {
  /** @type {Record<string, string|null>} */
  const overlay = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) overlay[key] = null;
  }
  return overlay;
}

/**
 * @param {string} kind
 * @param {string} text
 * @returns {"done"|"no-op"|"blocked"|"failed"|"exhausted"|"stalled"|"canceled"}
 */
function statusFor(kind, text) {
  if (kind === "aborted") return "canceled";
  if (kind === "blocked") return "blocked";
  if (isQuotaText(text) || /insufficient balance/iu.test(text)) return "exhausted";
  if (/permission|approval|sandbox/iu.test(text)) return "blocked";
  return "failed";
}

/**
 * Turn the harness's relative retry hint into the absolute instant the
 * controller needs; without one it takes the failover edge instead of waiting.
 *
 * @param {unknown} retryAfterMs
 * @returns {string|null}
 */
function resetTimestamp(retryAfterMs) {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  return new Date(Date.now() + retryAfterMs).toISOString();
}
