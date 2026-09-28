/**
 * A loopback relay between one fx worker and its OpenAI-compatible provider.
 * fx 0.0.11 keeps only prompt and completion totals from a Chat Completions
 * response, so the cache counters the provider returns never reach its JSON
 * or its ACP usage. The relay forwards every byte unchanged and reads the
 * `usage` object on the way back: measured 2026-09-24 over 24 fx requests to
 * api.deepseek.com, 268,288 of 283,372 input tokens (94.7%) were cache hits
 * that fx reported as ordinary input. It also sees the HTTP status fx turns
 * into prose, which is the only reliable quota and rate-limit signal.
 *
 * One relay per runner, bound to 127.0.0.1 on an ephemeral port, so parallel
 * workers never share a meter.
 */

import { createServer } from "node:http";

/** Bytes of an error body kept for classification; the rest is the provider's prose. */
const ERROR_BODY_LIMIT = 2048;

/**
 * @typedef {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} RequestUsage
 * @typedef {{status: number, usage: RequestUsage|null, error: string|null, retryAfterMs: number|null}} RelayedRequest
 */

/**
 * @param {{upstream: string, onRequest: (request: RelayedRequest) => void}} options
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startUsageProxy({ upstream, onRequest }) {
  const base = upstream.replace(/\/+$/u, "");
  const server = createServer((req, res) => {
    relay(base, req, res).then(onRequest, (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("faberun usage proxy: upstream unreachable");
      onRequest({ status: 502, usage: null, error: error instanceof Error ? error.message : String(error), retryAfterMs: null });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

/**
 * @param {string} base
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<RelayedRequest>}
 */
async function relay(base, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || ["host", "connection", "content-length", "accept-encoding"].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const response = await fetch(`${base}${req.url ?? ""}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    redirect: "manual",
  });
  /** @type {Record<string, string>} */
  const outgoing = {};
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) outgoing[name] = value;
  }
  res.writeHead(response.status, outgoing);
  const decoder = new TextDecoder();
  let text = "";
  let pending = "";
  /** @type {unknown} */
  let usage = null;
  const contentType = response.headers.get("content-type");
  // Measured 2026-09-26: the Codex endpoint streams SSE with no content-type
  // at all, so a missing header is decided by the first bytes.
  let streaming = (contentType ?? "").includes("text/event-stream");
  let sniffed = contentType !== null;
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
      const decoded = decoder.decode(chunk, { stream: true });
      if (!sniffed) {
        sniffed = true;
        streaming = /^\s*(data:|event:|:)/u.test(decoded);
      }
      if (!streaming) {
        text += decoded;
        continue;
      }
      pending += decoded;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) usage = streamedUsage(line) ?? usage;
    }
  }
  usage = streamedUsage(pending) ?? usage;
  res.end();
  if (!streaming && response.ok) usage = parsedUsage(text);
  return {
    status: response.status,
    usage: canonicalRequestUsage(usage),
    error: response.ok ? null : text.slice(0, ERROR_BODY_LIMIT) || response.statusText,
    retryAfterMs: retryAfter(response.headers.get("retry-after")),
  };
}

/** @param {string} line @returns {unknown} */
function streamedUsage(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return null;
  return parsedUsage(payload);
}

/** @param {string} text @returns {unknown} */
function parsedUsage(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    // A Responses stream reports usage once, on `response.completed`, inside
    // the response object.
    return value.usage ?? value.response?.usage ?? null;
  } catch {
    // A partial or non-JSON frame carries no usage; the next frame might.
    return null;
  }
}

/**
 * Reduce the provider's usage object to the ledger's shape, where
 * `inputTokens` excludes the cached prefix. DeepSeek reports the split
 * directly (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`); OpenAI,
 * vLLM and Z.ai report `prompt_tokens_details.cached_tokens` inside
 * `prompt_tokens`; the Responses API (fx's Codex provider) reports
 * `input_tokens_details.cached_tokens` inside `input_tokens`.
 *
 * @param {unknown} usage
 * @returns {RequestUsage|null}
 */
export function canonicalRequestUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const record = /** @type {Record<string, any>} */ (usage);
  const number = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const input = number(record.input_tokens);
  if (input !== null) {
    const cached = number(record.input_tokens_details?.cached_tokens) ?? 0;
    return { inputTokens: Math.max(0, input - cached), outputTokens: number(record.output_tokens) ?? 0, cacheReadInputTokens: cached };
  }
  const prompt = number(record.prompt_tokens);
  const output = number(record.completion_tokens) ?? 0;
  const hit = number(record.prompt_cache_hit_tokens) ?? number(record.prompt_tokens_details?.cached_tokens) ?? 0;
  const miss = number(record.prompt_cache_miss_tokens);
  if (prompt === null && miss === null) return null;
  return { inputTokens: miss ?? Math.max(0, (prompt ?? 0) - hit), outputTokens: output, cacheReadInputTokens: hit };
}

/** @param {string|null} header @returns {number|null} */
function retryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : null;
}
