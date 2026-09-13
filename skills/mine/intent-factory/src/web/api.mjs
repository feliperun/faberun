/**
 * The operator's remote API: the phone-shaped surface behind the dashboard
 * server. Reads go straight to the campaign/seat aggregators that already
 * exist; every write shells out to the runner CLI and touches no state file of
 * its own (ADR-0034: a daemon that wrote state would be a second state machine
 * with its own rules, and the CLI is the only writer). That is also why there
 * is no replan, contract, routing or gate route: the contract is frozen with a
 * digest, and the sanctioned middle ground from a phone is `campaign note`.
 * Pause/resume ride the run-level `cancel`/`resume` verbs — the reversible
 * pair this repo already owns (a canceled run is a resumable state) — fired
 * once per linked run that still has work in flight.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { discoverCampaigns } from "../campaign/index.mjs";
import { BRIEF_FILE, JOURNAL_FILE } from "../campaign/layout.mjs";
import { seatStatus } from "../seat/index.mjs";
import { errorMessage, errorCode, fail, readJsonTolerant, truncateChars } from "../util.mjs";

const DEFAULT_CLI_ENTRY = fileURLToPath(new URL("../cli.mjs", import.meta.url));
/** One events page is bounded twice: by the bytes read from the journal and by the entry count returned. */
const EVENTS_WINDOW_BYTES = 32 * 1024;
const EVENTS_WINDOW_ENTRIES = 100;
const REQUEST_BODY_MAX_BYTES = 16 * 1024;
const OUTPUT_TAIL_CHARS = 4 * 1024;
const LIST_GOAL_CHARS = 200;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RUN_DONE_STATUSES = new Set(["done", "no-op"]);
const RUN_TERMINAL_STATUSES = new Set(["done", "no-op", "failed", "blocked", "exhausted", "stalled", "canceled", "cancelled"]);
const RUN_ATTENTION_STATUSES = new Set(["blocked", "failed", "exhausted", "stalled", "canceled", "cancelled"]);
/** The journal's `sessionId` records who spoke; the web daemon is a speaker of its own. */
const WEB_SESSION_ID = "web";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {{runsDir: string, repoRoot: string, cliEntry: string, url: URL, request: IncomingMessage}} ApiContext */
/** @typedef {{type: string, eventId: string, at: string, [key: string]: unknown}} JournalRecord */
/** @typedef {(context: ApiContext, response: ServerResponse, params: string[]) => Promise<void>} ApiHandler */

/** @type {[RegExp, ApiHandler][]} */
const GET_ROUTES = [
  [/^\/api\/campaigns$/u, listCampaigns],
  [/^\/api\/campaigns\/([^/]+)$/u, showCampaign],
  [/^\/api\/campaigns\/([^/]+)\/events$/u, campaignEvents],
  [/^\/api\/campaigns\/([^/]+)\/brief$/u, campaignBrief],
  [/^\/api\/seats$/u, listSeats],
];

/** @type {[RegExp, ApiHandler][]} */
const POST_ROUTES = [
  [/^\/api\/campaigns\/([^/]+)\/note$/u, postNote],
  [/^\/api\/campaigns\/([^/]+)\/decisions\/([^/]+)$/u, postDecision],
  [/^\/api\/campaigns\/([^/]+)\/pause$/u, postPause],
  [/^\/api\/campaigns\/([^/]+)\/resume$/u, postResume],
  [/^\/api\/seats\/([^/]+)\/switch$/u, postSeatSwitch],
];

/**
 * Route one `/api/*` request. Unknown paths answer 404 — deliberately,
 * including the replan-shaped ones — and a path matched with the wrong method
 * answers 405. Never throws: the failure envelope is JSON like the payloads.
 *
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {{runsDir: string, cliEntry?: string}} options
 */
export async function handleApiRequest(request, response, options) {
  const url = new URL(request.url ?? "/", "http://localhost");
  /** @type {ApiContext} */
  const context = {
    runsDir: options.runsDir,
    repoRoot: dirname(options.runsDir),
    cliEntry: options.cliEntry ?? DEFAULT_CLI_ENTRY,
    url,
    request,
  };
  try {
    const table = request.method === "GET" ? GET_ROUTES : request.method === "POST" ? POST_ROUTES : [];
    for (const [pattern, handler] of table) {
      const params = pattern.exec(url.pathname)?.slice(1);
      if (params) return await handler(context, response, params.map(safeSegment));
    }
    if ([...GET_ROUTES, ...POST_ROUTES].some(([pattern]) => pattern.test(url.pathname))) {
      throw fail("method_not_allowed", `use ${request.method === "GET" ? "POST" : "GET"} for ${url.pathname}`);
    }
    throw notFound("no such path");
  } catch (error) {
    const code = errorCode(error);
    const status = code === "bad_request" ? 400 : code === "not_found" ? 404 : code === "method_not_allowed" ? 405 : 500;
    sendJson(response, status, { error: errorMessage(error) });
  }
}

/** @param {string} message @returns {Error & {code: string}} */
function notFound(message) {
  return fail("not_found", message);
}

/** @param {string} message @returns {Error & {code: string}} */
function badRequest(message) {
  return fail("bad_request", message);
}

/** @param {ServerResponse} response @param {number} status @param {unknown} payload */
function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

/** @param {string} value @returns {string} */
function safeSegment(value) {
  if (!SAFE_SEGMENT.test(value)) throw notFound("no such path");
  return value;
}

/** @param {ApiContext} context @param {string} id @returns {{path: string, campaign: import("../campaign/index.mjs").Campaign}} */
function findCampaign(context, id) {
  const found = discoverCampaigns(context.runsDir).campaigns.find(({ campaign }) => campaign.id === id);
  if (!found) throw notFound(`unknown campaign: ${id}`);
  return found;
}

/** The phone-sized run row: three states and two counters, nothing the dashboard snapshot does not already compute better. @param {string} runsDir @param {string} runId @returns {Record<string, unknown>} */
function runRow(runsDir, runId) {
  const status = readJsonTolerant(join(runsDir, runId, "status.json"));
  const nodes = status && typeof status === "object" && Array.isArray(/** @type {any} */ (status).nodes) ? /** @type {any[]} */ (/** @type {any} */ (status).nodes) : [];
  return {
    id: runId,
    state: nodes.some((node) => RUN_ATTENTION_STATUSES.has(String(node.status)))
      ? "attention"
      : nodes.length > 0 && nodes.every((node) => RUN_TERMINAL_STATUSES.has(String(node.status))) ? "done" : "active",
    nodesDone: nodes.filter((node) => RUN_DONE_STATUSES.has(String(node.status))).length,
    nodesTotal: nodes.length,
    costUsd: typeof /** @type {any} */ (status)?.usage?.costUsd === "number" ? /** @type {any} */ (status).usage.costUsd : null,
  };
}

/** Linked runs that still have a node in flight — the only ones pause or resume can change. @param {ApiContext} context @param {import("../campaign/index.mjs").Campaign} campaign @returns {string[]} */
function runsInFlight(context, campaign) {
  return campaign.linkedRunIds.filter((runId) => {
    const status = readJsonTolerant(join(context.runsDir, runId, "status.json"));
    const nodes = status && typeof status === "object" && Array.isArray(/** @type {any} */ (status).nodes) ? /** @type {any[]} */ (/** @type {any} */ (status).nodes) : [];
    return nodes.some((node) => !RUN_TERMINAL_STATUSES.has(String(node.status)));
  });
}

/** @param {ApiContext} context @param {ServerResponse} response */
async function listCampaigns(context, response) {
  const { campaigns, corrupt } = discoverCampaigns(context.runsDir);
  sendJson(response, 200, {
    schemaVersion: 1,
    campaigns: campaigns.map(({ campaign }) => ({
      id: campaign.id,
      goal: truncateChars(String(campaign.goal ?? "").replace(/\s+/gu, " ").trim(), LIST_GOAL_CHARS),
      status: campaign.status,
      updatedAt: campaign.updatedAt,
      runCount: campaign.linkedRunIds.length,
    })),
    corrupt: corrupt.map((entry) => entry.id),
  });
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function showCampaign(context, response, params) {
  const { campaign } = findCampaign(context, params[0]);
  sendJson(response, 200, { campaign, runs: campaign.linkedRunIds.map((runId) => runRow(context.runsDir, runId)) });
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function campaignEvents(context, response, params) {
  const { campaign, path } = findCampaign(context, params[0]);
  const afterRaw = context.url.searchParams.get("after") ?? "0";
  if (!/^\d+$/u.test(afterRaw)) throw badRequest("after must be a non-negative integer cursor");
  const page = readJournalWindow(join(path, JOURNAL_FILE), Number(afterRaw));
  sendJson(response, 200, {
    schemaVersion: 1,
    campaignId: campaign.id,
    after: Number(afterRaw),
    next: page.next,
    size: page.size,
    complete: page.next >= page.size,
    entries: page.entries,
  });
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function campaignBrief(context, response, params) {
  const briefPath = join(findCampaign(context, params[0]).path, BRIEF_FILE);
  if (!existsSync(briefPath)) throw notFound(`operator brief not generated yet: ${BRIEF_FILE}`);
  response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
  response.end(readFileSync(briefPath));
}

/** @param {ApiContext} context @param {ServerResponse} response */
async function listSeats(context, response) {
  sendJson(response, 200, seatStatus());
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function postNote(context, response, params) {
  // The campaign is resolved before the CLI runs, like every other route: an
  // unknown id used to reach `campaign note`, whose own refusal names the
  // absolute path it looked in and handed the caller the server's directory
  // layout.
  findCampaign(context, params[0]);
  const body = await readJsonObject(context.request);
  const argv = ["campaign", "note", params[0], "--session-id", sessionOf(body), "--kind", requiredString(body.kind, "kind"), "--text", requiredString(body.text, "text")];
  for (const [flag, key] of [["--decision-id", "decisionId"], ["--supersedes", "supersedes"], ["--question-id", "questionId"], ["--run-id", "runId"]]) {
    if (typeof body[key] === "string" && /** @type {string} */ (body[key]).trim()) argv.push(flag, /** @type {string} */ (body[key]));
  }
  sendResult(response, await runCli(context, argv));
}

/** A pending operator decision is the journal's open question; resolving it is `campaign resolve`. @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function postDecision(context, response, params) {
  findCampaign(context, params[0]);
  const body = await readJsonObject(context.request);
  const argv = ["campaign", "resolve", params[0], "--session-id", sessionOf(body), "--question-id", params[1], "--text", requiredString(body.text, "text")];
  sendResult(response, await runCli(context, argv));
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function postPause(context, response, params) {
  const targets = runsInFlight(context, findCampaign(context, params[0]).campaign);
  const results = [];
  for (const runId of targets) results.push({ runId, ...await runCli(context, ["cancel", join(context.runsDir, runId)]) });
  sendResult(response, { ok: results.every((result) => result.exitCode === 0), results });
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function postResume(context, response, params) {
  const targets = runsInFlight(context, findCampaign(context, params[0]).campaign);
  const results = [];
  for (const runId of targets) results.push({ runId, ...await runCli(context, ["resume", join(context.runsDir, runId), "--detach"]) });
  sendResult(response, { ok: results.every((result) => result.exitCode === 0), results });
}

/** @param {ApiContext} context @param {ServerResponse} response @param {string[]} params */
async function postSeatSwitch(context, response, params) {
  const body = await readJsonObject(context.request);
  const argv = ["seat", "switch", params[0], "--harness", requiredString(body.harness, "harness")];
  sendResult(response, await runCli(context, argv));
}

/** @param {ServerResponse} response @param {{ok: boolean, [key: string]: unknown}} envelope */
function sendResult(response, envelope) {
  sendJson(response, envelope.ok ? 200 : 500, { schemaVersion: 1, ...envelope });
}

/** @param {Record<string, unknown>} body @returns {string} */
function sessionOf(body) {
  return typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : WEB_SESSION_ID;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${label} is required`);
  return value;
}

/** @param {IncomingMessage} request @returns {Promise<Record<string, unknown>>} */
async function readJsonObject(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > REQUEST_BODY_MAX_BYTES) throw badRequest(`request body exceeds ${REQUEST_BODY_MAX_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("request body must be a JSON object");
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Fire one CLI verb and collect its verdict. The argv is an array handed to
 * spawn, never a shell string, so note text can never become an option or a
 * command.
 *
 * @param {ApiContext} context
 * @param {string[]} argv
 * @returns {Promise<{ok: boolean, command: string, exitCode: number, stdout: string, stderr: string}>}
 */
async function runCli(context, argv) {
  const child = spawn(process.execPath, [context.cliEntry, ...argv], { cwd: context.repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  if (child.stdout) child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  if (child.stderr) child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  /** @type {Promise<number>} */
  const closed = new Promise((resolve) => child.on("close", (code) => resolve(code ?? -1)));
  const exitCode = await closed;
  return {
    ok: exitCode === 0,
    command: argv.join(" "),
    exitCode,
    stdout: truncateChars(stdout.trim(), OUTPUT_TAIL_CHARS),
    stderr: truncateChars(stderr.trim(), OUTPUT_TAIL_CHARS),
  };
}

/**
 * One bounded page of the campaign journal, read forward from the `after` byte
 * cursor. A client that starts at zero gets the first window, never the whole
 * file, however long the campaign has run; `next` is the cursor to send back.
 * Only a line the window has seen ended by its own newline is an entry — a
 * trailing fragment torn by a concurrent append is left for the next page, and
 * legacy `liveness` heartbeats are skipped as narrative-free. A cursor beyond
 * the file is a client bug and answers itself as a bad request.
 *
 * @param {string} path
 * @param {number} after
 * @returns {{entries: JournalRecord[], next: number, size: number}}
 */
function readJournalWindow(path, after) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { entries: [], next: 0, size: 0 };
  }
  if (after > size) throw badRequest(`cursor ${after} is beyond the journal size ${size}`);
  const bytes = windowBytes(path, Math.min(size - after, EVENTS_WINDOW_BYTES), after);
  /** @type {JournalRecord[]} */
  const entries = [];
  let start = 0;
  let consumed = 0;
  while (entries.length < EVENTS_WINDOW_ENTRIES) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline === -1) break;
    consumed = newline + 1;
    const line = bytes.toString("utf8", start, newline).replace(/\r$/u, "");
    if (line.trim()) {
      try {
        const entry = /** @type {JournalRecord} */ (JSON.parse(line));
        if (entry.type !== "liveness") entries.push(entry);
      } catch {
        // dropped: a line torn by a concurrent append; the cursor advances past it
      }
    }
    start = newline + 1;
  }
  return { entries, next: after + consumed, size };
}

/** Positioned read that loops until the window is full, because one readSync may return short. @param {string} path @param {number} length @param {number} position @returns {Buffer} */
function windowBytes(path, length, position) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const readNow = readSync(descriptor, buffer, filled, length - filled, position + filled);
      if (readNow === 0) break;
      filled += readNow;
    }
    return buffer.subarray(0, filled);
  } finally {
    closeSync(descriptor);
  }
}
