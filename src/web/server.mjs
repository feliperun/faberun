import { basename, dirname, join } from "node:path";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { discoverCampaigns } from "../campaign/index.mjs";
import { campaignsDir } from "../campaign/layout.mjs";
import { renderCampaignProgress } from "../report/progress.mjs";
import { errorMessage, readJsonTolerant } from "../util.mjs";
import { listNodeSnapshots, nodeSnapshotPath } from "../run/node-store.mjs";
import { runsRoot } from "../run/paths.mjs";
import { assertPrivateBind, loadBearerToken, resolveBindAddress } from "./boundary.mjs";
import { handleApiRequest } from "./api.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM_POLL_MS = 700;
const STREAM_PING_MS = 15_000;
const SNAPSHOT_MAX_BYTES = 200 * 1024;
const LOG_TAIL_MAX_LINES = 200;
const LOG_TAIL_MAX_BYTES = 24 * 1024;
const OUTPUT_TAIL_MAX_BYTES = 4 * 1024;
const PROMPT_MAX_CHARS = 8 * 1024;
const DIFF_PATH_CAP = 400;
const GOAL_MAX_CHARS = 200;
/** The pre-split terminal union (`src/cli/campaign.mjs`'s and `src/web/api.mjs`'s own copies pin the same eight values): whether a node will not move again on its own. Used here only for `buildNodeDetail`'s `closed` flag, which the roll-up's `done`/`settled` split does not carry per selected node. */
const TERMINAL_STATUSES = new Set(["done", "no-op", "failed", "blocked", "exhausted", "stalled", "canceled", "cancelled"]);

/** The three static files behind the same bearer check as every other route. */
const ASSETS = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.mjs": { file: "app.mjs", type: "text/javascript; charset=utf-8" },
};

/** @typedef {{campaignId?: string|null, runId?: string|null, nodeId?: string|null}} Selection */
/** @typedef {{path: string, campaign: import("../campaign/index.mjs").Campaign}} CampaignEntry */

/** Last complete JSONL entries of an append-only file; a torn trailing line is dropped, not fatal. @param {string} path @param {number} maxEntries @param {number} [maxBytes] @returns {Record<string, unknown>[]} */
export function tailJsonl(path, maxEntries, maxBytes = 32 * 1024) {
  const entries = [];
  for (const line of linesInWindow(path, maxBytes)) {
    try {
      entries.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // dropped: torn by a concurrent append
    }
  }
  return entries.slice(-maxEntries);
}

/** Last complete text lines of a file, read from the end without loading the whole file. @param {string} path @param {number} maxLines @param {number} maxBytes @returns {string[]} */
function tailTextLines(path, maxLines, maxBytes) {
  return linesInWindow(path, maxBytes).slice(-maxLines);
}

/** Every complete, non-blank line within the trailing `maxBytes` window of a file. @param {string} path @param {number} maxBytes @returns {string[]} */
function linesInWindow(path, maxBytes) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const readLength = Math.min(stat.size, maxBytes);
  const bytes = readLength > 0 ? readWindow(path, readLength, stat.size - readLength) : Buffer.alloc(0);
  let text = bytes.toString("utf8");
  if (stat.size > maxBytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/** @param {string} path @param {number} length @param {number} position @returns {Buffer} */
function readWindow(path, length, position) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const filled = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** @param {string} value @param {number} maxChars @returns {string} */
function truncateChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join("")}…`;
}

/** @param {string} value @returns {string} */
function oneLine(value) {
  return truncateChars(String(value ?? "").replace(/\s+/gu, " ").trim(), GOAL_MAX_CHARS);
}

/** @param {string[]} paths @returns {string} */
function fileSignature(paths) {
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${path}:-`;
    }
  }).join("|");
}

/** @param {string} runDir @returns {Record<string, any>|null} */
function readRunStatus(runDir) {
  const status = readJsonTolerant(join(runDir, "status.json"));
  return status && typeof status === "object" && Array.isArray(/** @type {any} */ (status).nodes) ? /** @type {any} */ (status) : null;
}

/** @param {Record<string, any>[]} invocations @returns {Record<string, any>|undefined} */
function lastWorkerInvocation(invocations) {
  return [...(Array.isArray(invocations) ? invocations : [])].reverse().find((invocation) => invocation.role === "worker");
}

/** @param {Record<string, any>|null|undefined} verification */
function verificationTab(verification) {
  if (!verification || !Array.isArray(verification.commands)) return null;
  return {
    passed: verification.passed ?? null,
    commands: verification.commands.map((command) => {
      const last = Array.isArray(command.attempts) ? command.attempts.at(-1) : null;
      return {
        command: Array.isArray(command.argv) ? command.argv.join(" ") : "",
        passed: command.passed ?? last?.passed ?? null,
        durationMs: last?.durationMs ?? null,
        outputTail: truncateChars(`${last?.stdout ?? ""}${last?.stderr ? `\n${last.stderr}` : ""}`.trim(), OUTPUT_TAIL_MAX_BYTES),
      };
    }),
  };
}

/** @param {Record<string, any>|null|undefined} scope */
function diffTab(scope) {
  if (!scope) return null;
  const changed = Array.isArray(scope.changedPaths) ? scope.changedPaths : [];
  const unexpected = Array.isArray(scope.unexpectedPaths) ? scope.unexpectedPaths : [];
  const count = scope.changedPathCount ?? changed.length;
  return {
    stat: `${count} file${count === 1 ? "" : "s"} changed${unexpected.length ? ` · ${unexpected.length} unexpected` : ""}`,
    files: changed.slice(0, DIFF_PATH_CAP),
    unexpected: unexpected.slice(0, DIFF_PATH_CAP),
    truncated: changed.length > DIFF_PATH_CAP,
  };
}

/** @param {Record<string, any>|null|undefined} gate */
function findingsTab(gate) {
  if (!gate) return null;
  return {
    verdict: gate.verdict ?? null,
    maxSeverity: gate.maxSeverity ?? null,
    summary: gate.summary ?? null,
    findings: (Array.isArray(gate.findings) ? gate.findings : []).map((finding) => ({
      severity: finding.severity,
      description: finding.description,
      evidence: truncateChars(finding.evidence ?? "", 1024),
    })),
  };
}

/** @param {string} runDir @param {Record<string, any>} node @returns {{lines: string[], path: string|null}} */
function workerLogTab(runDir, node) {
  const worker = lastWorkerInvocation(node.invocations);
  if (!worker?.stdoutPath) return { lines: [], path: null };
  return { lines: tailTextLines(worker.stdoutPath, LOG_TAIL_MAX_LINES, LOG_TAIL_MAX_BYTES), path: basename(worker.stdoutPath) };
}

/** @param {Record<string, any>} node @returns {string|null} */
function promptTab(node) {
  const worker = lastWorkerInvocation(node.invocations);
  if (!worker?.promptPath || !existsSync(worker.promptPath)) return null;
  try {
    return truncateChars(readFileSync(worker.promptPath, "utf8"), PROMPT_MAX_CHARS);
  } catch {
    return null;
  }
}

/**
 * The drill-down's dynamic half: what the old drawer's tabs showed for one
 * node, plus the status.json fields the roll-up itself does not carry
 * (`errorCode`, its note, and the revision count) and a per-role breakdown of
 * the invocations the roll-up only summarizes as a single `runtime` string.
 *
 * @param {string} runsDir @param {string} runId @param {string} nodeId
 * @returns {Record<string, unknown>|null}
 */
function buildNodeDetail(runsDir, runId, nodeId) {
  const runDir = join(runsDir, runId);
  const status = readRunStatus(runDir);
  const statusNode = status?.nodes.find((/** @type {any} */ node) => node.id === nodeId) ?? null;
  const raw = readJsonTolerant(nodeSnapshotPath(runDir, nodeId));
  if (!raw || typeof raw !== "object") return null;
  const record = /** @type {Record<string, any>} */ (raw);
  const invocations = Array.isArray(record.invocations) ? record.invocations : [];
  const worker = lastWorkerInvocation(invocations);
  const judges = invocations.filter((invocation) => invocation?.role === "judge");
  return {
    id: nodeId,
    runId,
    closed: TERMINAL_STATUSES.has(String(statusNode?.status)),
    errorCode: statusNode?.errorCode ?? null,
    errorMessage: statusNode?.note ?? null,
    revisions: typeof statusNode?.revisions === "number" ? statusNode.revisions : null,
    workerRuntime: worker ? { harness: worker.harness ?? null, model: worker.model ?? null, costUsd: typeof worker.costUsd === "number" ? worker.costUsd : null } : null,
    judgeRounds: judges.map((invocation) => ({
      harness: invocation.harness ?? null,
      model: invocation.model ?? null,
      stdoutPath: typeof invocation.stdoutPath === "string" ? invocation.stdoutPath : null,
      status: invocation.status ?? null,
      costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
    })),
    log: workerLogTab(runDir, record),
    verification: verificationTab(record.verification),
    diff: diffTab(record.scope),
    findings: findingsTab(record.gate),
    prompt: promptTab(record),
  };
}

/** Shrink the payload, in order, until it fits the 200 KB ceiling: the open node's log tail, its verification output tails, then its prompt. @param {Record<string, any>} payload @returns {Record<string, unknown>} */
function boundSnapshot(payload) {
  const fits = () => Buffer.byteLength(JSON.stringify(payload), "utf8") <= SNAPSHOT_MAX_BYTES;
  if (fits()) return payload;
  const detail = payload.detail;
  if (detail?.log?.lines) detail.log.lines = detail.log.lines.slice(-20);
  if (fits()) return payload;
  if (detail?.verification?.commands) detail.verification.commands = detail.verification.commands.map((/** @type {any} */ command) => ({ ...command, outputTail: truncateChars(command.outputTail, 200) }));
  if (fits()) return payload;
  if (detail?.prompt) detail.prompt = truncateChars(detail.prompt, 500);
  return payload;
}

/** The declared campaign id when it exists, else the active campaign, else the first one. @param {CampaignEntry[]} campaigns @param {string|null|undefined} campaignId @returns {CampaignEntry|null} */
function resolveCampaign(campaigns, campaignId) {
  if (campaignId) {
    const declared = campaigns.find(({ campaign }) => campaign.id === campaignId);
    if (declared) return declared;
  }
  return campaigns.find(({ campaign }) => campaign.status === "active") ?? campaigns[0] ?? null;
}

/**
 * The full page snapshot: the campaign list (for the selector), the selected
 * campaign's roll-up (`renderCampaignProgress`, the chain and node-graph data
 * the page draws) and, when a node is selected, that node's drill-down
 * detail. Read-only, bounded to ~200 KB.
 *
 * @param {string} runsDir @param {Selection} [selection] @returns {Record<string, unknown>}
 */
export function buildSnapshot(runsDir, selection = {}) {
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  const campaignList = campaigns.map(({ campaign }) => ({ id: campaign.id, goal: oneLine(campaign.goal), status: campaign.status }));
  const entry = resolveCampaign(campaigns, selection.campaignId);
  const selectedId = entry?.campaign.id ?? null;
  const progress = entry ? /** @type {Record<string, unknown>} */ (JSON.parse(renderCampaignProgress(runsDir, entry.campaign.id))) : null;
  const contractPaths = entry ? entry.campaign.contracts.map((contract) => contract.path) : [];
  const validSelection = Boolean(entry && selection.runId && selection.nodeId && entry.campaign.linkedRunIds.includes(selection.runId));
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaigns: campaignList,
    corrupt: corrupt.map((entry_) => entry_.id),
    selectedCampaignId: selectedId,
    progress,
    contractPaths,
    detail: validSelection ? buildNodeDetail(runsDir, /** @type {string} */ (selection.runId), /** @type {string} */ (selection.nodeId)) : null,
  };
  return boundSnapshot(payload);
}

/** Cheap fingerprint of every file a snapshot for this selection depends on, so the stream can skip re-sending an unchanged snapshot. @param {string} runsDir @param {Selection} selection @returns {string} */
export function snapshotSignature(runsDir, selection) {
  const { campaigns } = discoverCampaigns(runsDir);
  const parts = [fileSignature([campaignsDir(runsDir)])];
  for (const { path } of campaigns) parts.push(fileSignature([join(path, "campaign.json")]));
  const entry = resolveCampaign(campaigns, selection.campaignId);
  if (!entry) return parts.join("\n");
  for (const runId of entry.campaign.linkedRunIds) {
    const runDir = join(runsDir, runId);
    const nodeFiles = listNodeSnapshots(runDir).sort().map((name) => nodeSnapshotPath(runDir, name.slice(0, -".json".length)));
    parts.push(fileSignature([join(runDir, "status.json"), join(runDir, "run.json"), join(runDir, "notify.jsonl"), join(runDir, "events.jsonl"), ...nodeFiles]));
  }
  if (selection.runId && selection.nodeId && entry.campaign.linkedRunIds.includes(selection.runId)) {
    const runDir = join(runsDir, selection.runId);
    const node = /** @type {Record<string, any>|null} */ (readJsonTolerant(nodeSnapshotPath(runDir, selection.nodeId)));
    const worker = node ? lastWorkerInvocation(node.invocations) : null;
    parts.push(fileSignature(/** @type {string[]} */ ([worker?.stdoutPath, worker?.promptPath].filter((value) => typeof value === "string"))));
  }
  return parts.join("\n");
}

/** @param {URL} url @param {string} key @returns {string|null} */
function safeParam(url, key) {
  const value = url.searchParams.get(key);
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) ? value : null;
}

/** @param {URL} url @returns {{campaignId: string|null, runId: string|null, nodeId: string|null}} */
function selectionOf(url) {
  return { campaignId: safeParam(url, "campaign"), runId: safeParam(url, "run"), nodeId: safeParam(url, "node") };
}

/** Read-only dashboard server behind its network boundary: the static page, a snapshot endpoint for polling clients, an SSE stream, and the operator's `/api/*` routes — whose writes all shell out to the runner CLI. Every request carries the bearer token in the Authorization header; a token that arrives in the query string is refused unread. The boundary is settled before `listen` — a public or wildcard bind throws and no socket ever opens. @param {{runsDir: string, tokenFile: string, port?: number, host?: string, pollMs?: number, cliEntry?: string}} options @returns {Promise<import("node:http").Server>} */
export async function startServer({ runsDir, tokenFile, port = 4173, host = "127.0.0.1", pollMs = STREAM_POLL_MS, cliEntry }) {
  const address = assertPrivateBind(await resolveBindAddress(host));
  const token = loadBearerToken(tokenFile);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      const refusal = admissionFailure(request, url, token);
      if (refusal) return sendRefusal(response, refusal);
      const asset = ASSETS[/** @type {keyof typeof ASSETS} */ (url.pathname)];
      if (asset) return sendFile(response, join(HERE, asset.file), asset.type);
      if (url.pathname === "/api/snapshot") return sendJson(response, buildSnapshot(runsDir, selectionOf(url)));
      if (url.pathname === "/api/stream") return streamSnapshots(request, response, runsDir, selectionOf(url), pollMs);
      if (url.pathname.startsWith("/api/")) {
        // A phone client that hangs up mid-request must not take the daemon
        // down as an unhandled rejection; the router catches its own errors,
        // this guards the one write that follows a closed socket.
        handleApiRequest(request, response, { runsDir, cliEntry }).catch(() => {
          if (!response.destroyed) response.destroy();
        });
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  /** The `Promise<void>` type is the JSDoc hint that lets `resolve()` take no argument under checkJs. @type {Promise<void>} */
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await listening;
  return server;
}

/** The one admission rule: the token rides the Authorization header and nowhere else. The query string is inspected for its shape — a `token` key, or any parameter equal to the token — and is never echoed back; no refusal or later message repeats what was sent. @param {import("node:http").IncomingMessage} request @param {URL} url @param {string} token @returns {{status: number, reason: string}|null} why the request is refused, or null when it passes */
function admissionFailure(request, url, token) {
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === "token" || secretEquals(value, token)) return { status: 400, reason: "refused: a token in the query string leaks into proxy logs and shell history; send it in the Authorization header" };
  }
  return secretEquals(request.headers.authorization, `Bearer ${token}`)
    ? null
    : { status: 401, reason: "unauthorized: send the dashboard bearer token in the Authorization header" };
}

/**
 * Compare a presented credential against the expected one without letting the
 * comparison's duration say how much of it was right. `===` on strings
 * short-circuits at the first differing byte, which is a byte-at-a-time oracle
 * for anyone who can reach the listener and time it. Lengths are compared
 * first because `timingSafeEqual` throws on a length mismatch; the length of
 * the token is not the secret, its bytes are.
 *
 * @param {unknown} presented
 * @param {string} expected
 * @returns {boolean}
 */
function secretEquals(presented, expected) {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** @param {import("node:http").ServerResponse} response @param {{status: number, reason: string}} refusal */
function sendRefusal(response, refusal) {
  response.writeHead(refusal.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(refusal.reason);
}

/** Pushes a fresh snapshot on connect and whenever the selection's signature changes. @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response @param {string} runsDir @param {Selection} selection @param {number} pollMs */
function streamSnapshots(request, response, runsDir, selection, pollMs) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let lastSignature = "";
  const push = () => {
    const signature = snapshotSignature(runsDir, selection);
    if (signature === lastSignature) return;
    lastSignature = signature;
    response.write(`event: update\ndata: ${JSON.stringify(buildSnapshot(runsDir, selection))}\n\n`);
  };
  push();
  const poll = setInterval(() => {
    try { push(); } catch (error) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
    }
  }, pollMs);
  const ping = setInterval(() => response.write(`: ping ${Date.now()}\n\n`), STREAM_PING_MS);
  const stop = () => { clearInterval(poll); clearInterval(ping); };
  request.on("close", stop);
  response.on("close", stop);
}

/** @param {import("node:http").ServerResponse} response @param {string} path @param {string} type */
function sendFile(response, path, type) {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(readFileSync(path));
}

/** @param {import("node:http").ServerResponse} response @param {unknown} payload */
function sendJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function main() {
  const arguments_ = process.argv.slice(2);
  let port = 4173;
  let host = "127.0.0.1";
  let cwd = process.cwd();
  let tokenFile = "";
  for (let index = 0; index < arguments_.length; index += 2) {
    if (arguments_[index] === "--port") port = Number(arguments_[index + 1]);
    if (arguments_[index] === "--host") host = String(arguments_[index + 1] ?? "");
    if (arguments_[index] === "--cwd") cwd = String(arguments_[index + 1] ?? "");
    if (arguments_[index] === "--token-file") tokenFile = String(arguments_[index + 1] ?? "");
  }
  const runsDir = runsRoot(cwd);
  try {
    const server = await startServer({ runsDir, tokenFile: tokenFile || join(runsDir, "dashboard.token"), port, host });
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    process.stdout.write(`faberun dashboard on http://${address.address}:${address.port} (runs: ${runsDir})\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
