/**
 * The R8 loopback browser surface: a separate, minimal HTTP server for one
 * frozen phase plan's already-generated Campaign Brief HTML. It is not the
 * dashboard (`src/web/server.mjs`): it has no bearer token, no API, no write
 * route and no run state. The CLI parses argv and calls `serveCampaignBrief`;
 * this module owns every bit of verification and HTTP behavior.
 *
 * Startup is the refusal gate. Before a socket exists, `verifyPinnedBrief`
 * reads and holds the phase plan's exact `plan.json` and pinned `spec.md`
 * bytes, checking the plan against its independent `plan.json.sha256` sidecar,
 * the contract against `plan.contractDigest`, and the spec against
 * `plan.spec.digest`. A missing or changed source file, or a missing
 * `campaign-brief.md.html` copy, throws a named `CampaignBriefServeError` and
 * no URL is ever printed. The verified bytes are the bytes the read-only
 * `/plan.json` and `/spec.md` drill-downs serve, so the brief's review facts do
 * not depend on the live files after startup.
 *
 * The bound address is always loopback. The HTML copy itself is a
 * self-contained file that stays readable from disk without this server.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { resolveCampaign } from "../campaign/index.mjs";
import { contractDigest } from "../contract/index.mjs";
import { runsRoot } from "../run/paths.mjs";
import { errorCode } from "../util.mjs";

/** @typedef {Record<string, any>} AnyRecord */

/**
 * @typedef {object} CampaignBriefServeOptions
 * @property {string} campaignId
 * @property {unknown} phase
 * @property {string} [cwd] repository whose runs root holds the campaign.
 * @property {string} [runsDir] explicit runs root; defaults to `runsRoot(cwd)`.
 * @property {string} [host] loopback bind host; defaults to `127.0.0.1`.
 * @property {number} [port] port to bind; defaults to `0` (an ephemeral port).
 * @property {(line: string) => void} [stdout] where the one success URL line goes.
 * @property {boolean} [shutdownSignals] install SIGINT/SIGTERM close handlers; default true.
 */

/**
 * @typedef {object} CampaignBriefServeHandle
 * @property {import("node:http").Server} server the listening server.
 * @property {string} url the browser URL, printed once on success.
 * @property {number} port the bound port.
 * @property {string} host the bound loopback address.
 * @property {string} campaignId
 * @property {string} phase
 * @property {string} planPath absolute path of the verified frozen plan.
 * @property {string} specPath absolute path of the verified structured spec.
 * @property {string} htmlPath absolute path of the served HTML copy.
 * @property {() => Promise<void>} close stop listening and release the port.
 */

/** The exact read-only drill-down routes and the one HTML entry route. */
const HTML_ROUTES = new Set(["/", "/campaign-brief.md.html"]);
const PLAN_ROUTE = "/plan.json";
const SPEC_ROUTE = "/spec.md";

/**
 * A named refusal to serve. `code` distinguishes the exact startup failure so
 * a caller can tell a stale sidecar from a changed spec or a missing HTML copy.
 */
export class CampaignBriefServeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "CampaignBriefServeError";
    this.code = code;
  }
}

/**
 * Verify one frozen phase plan and start its loopback server. Reads and holds
 * the pinned plan and spec bytes, checks the contract digest and the HTML
 * copy, then binds `host:port` (loopback only). On success one line naming the
 * URL is written to `stdout`; on any verification failure a
 * `CampaignBriefServeError` is thrown before a socket opens and nothing is
 * printed.
 *
 * @param {CampaignBriefServeOptions} options
 * @returns {Promise<CampaignBriefServeHandle>}
 */
export async function serveCampaignBrief(options) {
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const verified = verifyPinnedBrief(options);
  const host = requireLoopbackHost(options.host ?? "127.0.0.1");
  const requestedPort = options.port ?? 0;
  const server = http.createServer((request, response) => {
    handleRequest(request, response, verified);
  });
  await listen(server, host, requestedPort);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : requestedPort;
  const url = `http://${hostForUrl(host)}:${port}/`;
  if (options.shutdownSignals !== false) installShutdown(server);
  stdout(`[brief] serving ${verified.campaignId} · ${verified.phase} · ${url}`);
  return {
    server,
    url,
    port,
    host,
    campaignId: verified.campaignId,
    phase: verified.phase,
    planPath: verified.planPath,
    specPath: verified.specPath,
    htmlPath: verified.htmlPath,
    close: () => closeServer(server),
  };
}

/**
 * The refusal gate. The plan is checked against its independent sidecar first,
 * then parsed for its spec and contract identity, then the contract and spec
 * digests are verified, then the HTML copy must exist. The exact bytes read
 * here are returned and served, never re-read.
 *
 * @param {CampaignBriefServeOptions} options
 * @returns {{campaignId: string, phase: string, planPath: string, specPath: string, htmlPath: string, planBytes: Buffer, specBytes: Buffer, htmlBytes: Buffer}}
 */
function verifyPinnedBrief(options) {
  const campaignId = requireString(options.campaignId, "campaignId");
  const phase = requirePhase(options.phase);
  const cwd = resolvePath(options.cwd ?? ".");
  const runsDir = options.runsDir ?? runsRoot(cwd);
  const { path: campaignPath } = resolveCampaign(runsDir, campaignId);
  const planDir = join(campaignPath, "plans", phase);
  const planPath = join(planDir, "plan.json");
  const contractPath = join(planDir, "contract.json");
  const htmlPath = join(planDir, "campaign-brief.md.html");

  const planBytes = readBytes(planPath, "brief_plan_missing", `frozen plan ${planPath}`);
  const planDigest = sha256Hex(planBytes);
  const sidecarText = readText(`${planPath}.sha256`, "brief_plan_missing", `plan digest sidecar for ${planPath}`);
  if (planDigest !== sidecarText.trim()) {
    throw new CampaignBriefServeError(
      "brief_plan_changed",
      `frozen plan ${planPath} does not match its sidecar: the file is ${planDigest}, the sidecar records ${sidecarText.trim() || "(empty)"}`,
    );
  }

  const plan = parseJson(planBytes.toString("utf8"), "brief_plan_invalid", `frozen plan ${planPath}`);
  if (plan.formatVersion !== 1) {
    throw new CampaignBriefServeError("brief_plan_invalid", `frozen plan ${planPath} has no formatVersion 1; refreeze it before serving a brief`);
  }
  const specIdentity = plan.spec;
  if (!specIdentity || typeof specIdentity.path !== "string" || typeof specIdentity.digest !== "string") {
    throw new CampaignBriefServeError("brief_plan_invalid", `frozen plan ${planPath} records no spec path and digest; refreeze it before serving a brief`);
  }
  const expectedContractDigest = typeof plan.contractDigest === "string" ? plan.contractDigest : "";
  if (!expectedContractDigest) {
    throw new CampaignBriefServeError("brief_plan_invalid", `frozen plan ${planPath} records no contractDigest; refreeze it before serving a brief`);
  }

  const contractBytes = readBytes(contractPath, "brief_contract_missing", `contract ${contractPath}`);
  const contract = parseJson(contractBytes.toString("utf8"), "brief_contract_invalid", `contract ${contractPath}`);
  const rawContractDigest = contractDigest(contract);
  if (rawContractDigest !== expectedContractDigest) {
    throw new CampaignBriefServeError(
      "brief_contract_changed",
      `contract ${contractPath} does not match plan.contractDigest: computed ${rawContractDigest}, plan records ${expectedContractDigest}`,
    );
  }

  const specPath = isAbsolute(specIdentity.path) ? specIdentity.path : resolvePath(cwd, specIdentity.path);
  const specBytes = readBytes(specPath, "brief_spec_missing", `structured spec ${specPath}`);
  if (sha256Hex(specBytes) !== specIdentity.digest) {
    throw new CampaignBriefServeError(
      "brief_spec_changed",
      `structured spec ${specPath} does not match plan.spec.digest: the bytes changed since the plan froze`,
    );
  }

  const htmlBytes = readBytes(htmlPath, "brief_html_missing", `rendered brief ${htmlPath}`);

  return { campaignId, phase, planPath, specPath, htmlPath, planBytes, specBytes, htmlBytes };
}

/**
 * The whole HTTP surface: GET (and HEAD) only, three exact routes, everything
 * else 404. No path is ever joined to a filesystem path, so no directory
 * listing or arbitrary file can be requested, and any other method is refused
 * as a write attempt.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {{campaignId: string, phase: string, planPath: string, specPath: string, htmlPath: string, planBytes: Buffer, specBytes: Buffer, htmlBytes: Buffer}} context
 */
function handleRequest(request, response, context) {
  try {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return sendText(response, 405, "method not allowed\n", { allow: "GET, HEAD" }, false);
    const headOnly = method === "HEAD";
    const url = new URL(request.url ?? "/", "http://localhost");
    if (HTML_ROUTES.has(url.pathname)) return sendBytes(response, "text/html; charset=utf-8", context.htmlBytes, headOnly);
    if (url.pathname === PLAN_ROUTE) return sendBytes(response, "application/json; charset=utf-8", context.planBytes, headOnly);
    if (url.pathname === SPEC_ROUTE) return sendBytes(response, "text/markdown; charset=utf-8", context.specBytes, headOnly);
    return sendText(response, 404, "not found\n", {}, headOnly);
  } catch {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendText(response, 500, "server error\n", {}, false);
  }
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} type
 * @param {Buffer} bytes
 * @param {boolean} headOnly
 */
function sendBytes(response, type, bytes, headOnly) {
  response.writeHead(200, {
    "content-type": type,
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : bytes);
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} body
 * @param {import("node:http").OutgoingHttpHeaders} [extra]
 * @param {boolean} [headOnly]
 */
function sendText(response, status, body, extra = {}, headOnly = false) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  response.end(headOnly ? undefined : body);
}

/**
 * `localhost` resolves to the IPv4 loopback; an IPv4-mapped IPv6 literal is
 * judged by the IPv4 address it carries. Everything else, including the
 * wildcard and every RFC1918 address, is refused before a socket exists.
 *
 * @param {string} host
 * @returns {string}
 */
function requireLoopbackHost(host) {
  const normalized = host === "localhost" ? "127.0.0.1" : host;
  const plain = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(normalized)?.[1] ?? normalized;
  const isLoopback = (net.isIPv4(plain) && plain.startsWith("127.")) || (net.isIPv6(plain) && plain === "::1");
  if (!isLoopback) {
    throw new CampaignBriefServeError(
      "brief_bind_not_loopback",
      `refusing to bind ${host}: the brief server binds only to loopback (127.0.0.1 or ::1)`,
    );
  }
  return normalized;
}

/** @param {string} host @returns {string} */
function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * @param {import("node:http").Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
function listen(server, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (/** @type {Error} */ error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolveListen();
    });
  });
}

/**
 * Stop accepting connections and release the port. Idle keep-alive sockets are
 * destroyed so the close settles promptly.
 *
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

/**
 * The CLI's server runs until the operator stops it. The handlers close the
 * socket and exit; the `close` listener removes them so a stop that already
 * happened does not leave a live signal listener behind.
 *
 * @param {import("node:http").Server} server
 */
function installShutdown(server) {
  const shutdown = () => {
    closeServer(server).then(() => process.exit(0));
  };
  const remove = () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", remove);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CampaignBriefServeError("brief_invalid_request", `campaign brief serve requires ${label}`);
  }
  return value;
}

/**
 * `--phase` names one directory under `<campaignDir>/plans/`; anything with a
 * path separator or a dot segment would escape it.
 *
 * @param {unknown} value
 * @returns {string}
 */
function requirePhase(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CampaignBriefServeError("brief_phase_required", "campaign brief serve requires --phase <phase>");
  }
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new CampaignBriefServeError("brief_phase_invalid", "--phase must be a single path segment");
  }
  return value;
}

/**
 * @param {string} path
 * @param {string} missingCode
 * @param {string} label
 * @returns {Buffer}
 */
function readBytes(path, missingCode, label) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new CampaignBriefServeError(missingCode, `${label} is missing`);
    throw error;
  }
}

/**
 * @param {string} path
 * @param {string} missingCode
 * @param {string} label
 * @returns {string}
 */
function readText(path, missingCode, label) {
  return readBytes(path, missingCode, label).toString("utf8");
}

/**
 * @param {string} text
 * @param {string} invalidCode
 * @param {string} label
 * @returns {AnyRecord}
 */
function parseJson(text, invalidCode, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CampaignBriefServeError(invalidCode, `${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CampaignBriefServeError(invalidCode, `${label} must be a JSON object`);
  }
  return /** @type {AnyRecord} */ (value);
}

/** @param {Buffer} bytes @returns {string} */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
