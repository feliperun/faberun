/**
 * The operator's remote API: the phone-shaped surface behind the dashboard
 * server. Reads go straight to the campaign/seat aggregators that already
 * exist — the campaign response embeds `src/report/progress.mjs`'s shared
 * projection verbatim, so every label a client derives (wait reason, next
 * action, decision owner) comes from the same roll-up the dashboard draws
 * and none is recomputed here — and every write shells out to the runner CLI
 * and touches no state file of its own (ADR-0034: a daemon that wrote state
 * would be a second state machine with its own rules, and the CLI is the
 * only writer). That is also why there
 * is no replan, contract, routing or gate route: the contract is frozen with a
 * digest, and the sanctioned middle ground from a phone is `campaign note`.
 *
 * Pause and resume are the one pair that spans both layers. The durable pause
 * belongs to the campaign — `campaign/unpark.mjs` writes and clears the
 * attention the chain already consults before it dispatches, recovers or
 * advances — and every run it stops carries the engine's own pause request:
 * `cancel` writes `cancel.request.json` and `resume` consumes it, the same
 * reversible pair fired once per linked run. Resume clears the campaign pause
 * only once no resumed run still carries its request, and arms each resumed
 * run's watchdog, so the answer never claims an action nothing took.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { discoverCampaigns } from "../campaign/index.mjs";
import { BRIEF_FILE, JOURNAL_FILE } from "../campaign/layout.mjs";
import { PAUSE_ATTENTION_CODE, pauseCampaign, unparkCampaign } from "../campaign/unpark.mjs";
import { buildCampaignProgress } from "../report/progress.mjs";
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
/** The engine's durable pause request: written by `cancel`, consumed by `resume`, honoured by the chain before it recovers a run. */
const CANCEL_REQUEST_FILE = "cancel.request.json";
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
/** @typedef {{command: string, ok: boolean, exitCode: number|null, output: string}} OperationStep */

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

/** The node rows a run's `status.json` value carries; a missing or torn file has none. @param {unknown} status @returns {any[]} */
function nodesOf(status) {
  return status && typeof status === "object" && Array.isArray(/** @type {any} */ (status).nodes) ? /** @type {any[]} */ (/** @type {any} */ (status).nodes) : [];
}

/** The phone-sized run row: three states and two counters, nothing the dashboard snapshot does not already compute better. @param {string} runsDir @param {string} runId @returns {Record<string, unknown>} */
function runRow(runsDir, runId) {
  const status = readJsonTolerant(join(runsDir, runId, "status.json"));
  const nodes = nodesOf(status);
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

/** Whether the run carries the engine's durable pause request. @param {string} runsDir @param {string} runId @returns {boolean} */
function pauseRequested(runsDir, runId) {
  return existsSync(join(runsDir, runId, CANCEL_REQUEST_FILE));
}

/** Linked runs a pause can stop: a node still outside the terminal set and no pause requested yet. @param {ApiContext} context @param {import("../campaign/index.mjs").Campaign} campaign @returns {string[]} */
function runsInFlight(context, campaign) {
  return campaign.linkedRunIds.filter((runId) => !pauseRequested(context.runsDir, runId)
    && nodesOf(readJsonTolerant(join(context.runsDir, runId, "status.json"))).some((node) => !RUN_TERMINAL_STATUSES.has(String(node.status))));
}

/** Linked runs a resume can reach: exactly those carrying the durable pause request. @param {ApiContext} context @param {import("../campaign/index.mjs").Campaign} campaign @returns {string[]} */
function runsPaused(context, campaign) {
  return campaign.linkedRunIds.filter((runId) => pauseRequested(context.runsDir, runId));
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
  sendJson(response, 200, {
    campaign,
    runs: campaign.linkedRunIds.map((runId) => runRow(context.runsDir, runId)),
    // The shared projection (src/report/progress.mjs), verbatim: the same
    // roll-up the dashboard draws, so every label a phone client shows —
    // current phase, wait reason, next action and its decision owner — is
    // derived once at the source, never recomputed per surface.
    progress: projectionOf(context.runsDir, campaign.id),
  });
}

/** The campaign's shared projection, or null when the state on disk cannot produce one. @param {string} runsDir @param {string} campaignId @returns {Record<string, unknown>|null} */
function projectionOf(runsDir, campaignId) {
  try {
    return buildCampaignProgress(runsDir, campaignId, Date.now());
  } catch {
    // the projection is additive: an unbuildable one degrades this one field
    // to null, and the campaign and runs above still answer
    return null;
  }
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

/** A closed campaign is not pausable or resumable, and the refusal comes before the CLI so nothing is spawned for it. @param {import("../campaign/index.mjs").Campaign} campaign */
function requireActive(campaign) {
  if (campaign.status !== "active") throw badRequest(`campaign is closed: ${campaign.id}`);
}

/** One CLI verdict as a recorded step. @param {string} command @param {{ok: boolean, exitCode: number, stdout: string, stderr: string}} verdict @returns {OperationStep} */
function cliStep(command, verdict) {
  return { command, ok: verdict.ok, exitCode: verdict.exitCode, output: verdict.stdout || verdict.stderr };
}

/**
 * The one answer shape a pause or a resume gives. `action` is the recorded
 * outcome: `applied` when the panel changed state, `pending` when a step could
 * not be taken (and the reason names what blocks it), and `none` when nothing
 * was needed (and the reason names why). A paused campaign with no run in
 * flight still records its pause, so `none` never hides a lost intent; a
 * pending operation answers 409 because the request will not complete until
 * the blocker does.
 *
 * @param {ServerResponse} response
 * @param {{action: "applied"|"pending"|"none", reason?: string|null, steps?: OperationStep[]}} result
 */
function operation(response, { action, reason = null, steps = [] }) {
  sendJson(response, action === "pending" ? 409 : 200, { schemaVersion: 1, ok: action !== "pending", action, reason, steps });
}

/**
 * Pause the campaign: record the durable campaign pause first, so the chain
 * stops dispatching, and then stop the work a pause has to stop by firing the
 * engine's `cancel` once per linked run still in flight. A campaign parked on
 * the chain's own reason is refused instead of overwritten — the operator has
 * to act on that failure, and hiding it under a pause would be the panel lying
 * about the campaign's state.
 *
 * @param {ApiContext} context @param {ServerResponse} response @param {string[]} params
 */
async function postPause(context, response, params) {
  const { campaign, path } = findCampaign(context, params[0]);
  requireActive(campaign);
  const park = campaign.attention;
  if (park && park.code !== PAUSE_ATTENTION_CODE) {
    return operation(response, { action: "pending", reason: `campaign is parked on ${park.code}: ${park.message}` });
  }
  const targets = runsInFlight(context, campaign);
  /** @type {OperationStep[]} */
  const steps = [];
  let paused;
  try {
    paused = pauseCampaign(path, { runIds: targets, sessionId: WEB_SESSION_ID });
  } catch (error) {
    // The chain can park the campaign between the check above and this write;
    // its reason wins, and the answer says so instead of overwriting it.
    return operation(response, { action: "pending", reason: errorMessage(error), steps });
  }
  if (paused.recorded) steps.push({ command: "campaign pause", ok: true, exitCode: null, output: `${paused.attention.code} · ${targets.length} run(s) in flight` });
  /** @type {string[]} */
  const failed = [];
  for (const runId of targets) {
    const verdict = await runCli(context, ["cancel", join(context.runsDir, runId)]);
    steps.push(cliStep(`cancel ${runId}`, verdict));
    if (!verdict.ok) failed.push(runId);
  }
  if (failed.length > 0) return operation(response, { action: "pending", reason: `the campaign is paused but cancel failed for ${failed.join(", ")}`, steps });
  const applied = paused.recorded || targets.length > 0;
  return operation(response, { action: applied ? "applied" : "none", reason: applied ? null : "campaign is already paused", steps });
}

/**
 * Resume the campaign: continue every linked run whose durable pause request
 * `cancel` wrote, clear the campaign pause, and arm each resumed run's
 * watchdog. The pause is cleared only after no resumed run still carries its
 * request, because the engine's `resume` consumes that request inside the
 * controller it starts and clearing first would let the chain park the
 * campaign again on the same run. A campaign parked on the chain's own
 * reason, with no run paused, is refused: that park is not the pause a
 * resume lifts, and clearing it would announce a resume with no operation
 * behind it while steamrolling the decision the park is waiting on.
 *
 * @param {ApiContext} context @param {ServerResponse} response @param {string[]} params
 */
async function postResume(context, response, params) {
  const { campaign, path } = findCampaign(context, params[0]);
  requireActive(campaign);
  const targets = runsPaused(context, campaign);
  const park = campaign.attention;
  if (park && park.code !== PAUSE_ATTENTION_CODE && targets.length === 0) {
    return operation(response, { action: "pending", reason: `campaign is parked on ${park.code}: ${park.message}` });
  }
  if (!park && targets.length === 0) {
    return operation(response, { action: "none", reason: "no requested pause: no linked run is paused and the campaign is not parked" });
  }
  /** @type {OperationStep[]} */
  const steps = [];
  /** @type {string[]} */
  const failed = [];
  for (const runId of targets) {
    const verdict = await runCli(context, ["resume", join(context.runsDir, runId), "--detach"]);
    steps.push(cliStep(`resume ${runId} --detach`, verdict));
    if (!verdict.ok) failed.push(runId);
  }
  if (failed.length > 0) return operation(response, { action: "pending", reason: `resume failed for ${failed.join(", ")}`, steps });
  const unconsumed = targets.filter((runId) => pauseRequested(context.runsDir, runId));
  if (unconsumed.length > 0) {
    return operation(response, { action: "pending", reason: `run ${unconsumed.join(", ")} has not consumed its requested pause yet`, steps });
  }
  if (park && park.code === PAUSE_ATTENTION_CODE) {
    let cleared;
    try {
      cleared = unparkCampaign(path, { runsDir: context.runsDir });
    } catch (error) {
      return operation(response, { action: "pending", reason: errorMessage(error), steps });
    }
    steps.push({ command: "campaign unpark", ok: true, exitCode: null, output: `${cleared.cleared.code} cleared` });
  }
  /** @type {string[]} */
  const unarmed = [];
  for (const runId of targets) {
    const verdict = await runCli(context, ["supervise", join(context.runsDir, runId), "--detach"]);
    steps.push(cliStep(`supervise ${runId} --detach`, verdict));
    if (!verdict.ok) unarmed.push(runId);
  }
  if (unarmed.length > 0) return operation(response, { action: "pending", reason: `supervise failed for ${unarmed.join(", ")}`, steps });
  return operation(response, { action: "applied", steps });
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
