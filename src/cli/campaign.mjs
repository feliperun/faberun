import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";
import {
  authoredContractDigest,
  closeCampaign,
  discoverCampaigns,
  initializeCampaign,
  reledgerCampaign,
  renderHandoff,
  resolveCampaign,
} from "../campaign/index.mjs";
import { addContract, replaceContract } from "./campaign-contract.mjs";
import { generateCampaignBrief } from "../campaign/brief-cli.mjs";
import { runsRoot } from "../run/paths.mjs";
import { syncAgentSignal } from "../repo/signal.mjs";
import { acknowledgeJournalEvent, appendJournal, appendSeatAllowanceEvent, readJournal, watchJournal } from "../campaign/journal.mjs";
import { driveCampaignChain } from "../campaign/chain.mjs";
import { unparkCampaign } from "../campaign/unpark.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { projectMetrics } from "../campaign/metrics.mjs";
import { readMetricsSources } from "../campaign/metrics-command.mjs";
import { DEFAULT_WAKE_POLL_MS, watchCampaignWake } from "../campaign/watch.mjs";
import { allowanceEventFields, sampleAllowance } from "../seat/allowance.mjs";
import { detectOperatorHarness } from "../seat/harnesses.mjs";
import { detachArgv, detachSelf, waitForBootstrap } from "./launch.mjs";
import { readJsonTolerant } from "../util.mjs";

const SYNC_OUTPUT_MAX_BYTES = 8000;

const NOTE_KINDS = new Set([
  "intent",
  "decision",
  "supersede",
  "constraint",
  "outcome",
  "next",
  "open-question",
  "retrospective",
]);

/** Flags that only apply to a single note kind; rejected for every other kind. */
const NOTE_KIND_FLAGS = {
  decision: ["decision-id"],
  supersede: ["supersedes"],
  "open-question": ["question-id"],
  outcome: ["run-id"],
};

/** Flags are scoped to the operations that declare them; all other flags are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  list: { cwd: { type: "string" } },
  init: { cwd: { type: "string" }, goal: { type: "string" }, contract: { type: "string", multiple: true }, "land-branch": { type: "string" } },
  watch: { cwd: { type: "string" }, wake: { type: "boolean" }, detach: { type: "boolean" }, interval: { type: "string" }, once: { type: "boolean" } },
  attach: {
    cwd: { type: "string" },
    tool: { type: "string" },
    "session-id": { type: "string" },
    transcript: { type: "string" },
    "no-transcript": { type: "boolean" },
    format: { type: "string" },
    cursor: { type: "string" },
    "event-id": { type: "string" },
  },
  note: {
    cwd: { type: "string" },
    "session-id": { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
    "event-id": { type: "string" },
    "decision-id": { type: "string" },
    supersedes: { type: "string" },
    "question-id": { type: "string" },
    "run-id": { type: "string" },
  },
  resolve: {
    cwd: { type: "string" },
    "session-id": { type: "string" },
    "question-id": { type: "string" },
    text: { type: "string" },
    "event-id": { type: "string" },
  },
  close: { cwd: { type: "string" }, "event-id": { type: "string" } },
  reledger: { cwd: { type: "string" } },
  supervise: { cwd: { type: "string" }, "allow-main": { type: "boolean" } },
  unpark: { cwd: { type: "string" }, force: { type: "boolean" }, "event-id": { type: "string" } },
  "add-contract": { cwd: { type: "string" }, path: { type: "string" } },
  "replace-contract": { cwd: { type: "string" }, path: { type: "string" }, replace: { type: "string" } },
  brief: { cwd: { type: "string" }, phase: { type: "string" } },
  show: { cwd: { type: "string" } },
  sync: { cwd: { type: "string" }, "session-id": { type: "string" } },
  ack: { cwd: { type: "string" }, "session-id": { type: "string" }, "event-id": { type: "string" } },
};

/** @typedef {{cwd?: string, goal?: string, contract?: string[], landBranch?: string, tool?: string, sessionId?: string, transcript?: string, format?: string, cursor?: string, since?: string, kind?: string, text?: string, runId?: string, supersedes?: string, decisionId?: string, questionId?: string, eventId?: string, noTranscript?: boolean, wake?: boolean, detach?: boolean, interval?: string, once?: boolean, allowMain?: boolean, force?: boolean, path?: string, replace?: string, phase?: string}} CliValues */
/** @typedef {import("../campaign/index.mjs").Campaign} Campaign */

/**
 * @param {string[]} args
 * @returns {Promise<number|void>}
 */
export async function campaignCli(args) {
  const operation = args[0];
  if (!operation || !(operation in OPERATION_OPTIONS)) return usage();
  const { positional, values } = parseArgs(args.slice(1), operation);
  if (operation === "brief") {
    const [action, campaignId, ...extra] = positional;
    if (campaignId === undefined || extra.length) return usage();
    if (action === "generate") {
      generateCampaignBrief({ campaignId, phase: values.phase, cwd: values.cwd });
      return;
    }
    // `serve` starts the separate R8 loopback server; the module owns the
    // verification and HTTP behavior, the CLI only parses and dispatches. It is
    // imported on demand so the ordinary CLI startup graph stays free of the
    // HTTP server for every other verb.
    if (action === "serve") {
      const { serveCampaignBrief } = await import("../web/campaign-brief-server.mjs");
      await serveCampaignBrief({ campaignId, phase: values.phase, cwd: values.cwd });
      return;
    }
    return usage();
  }
  const [campaignId, ...extra] = positional;
  if (operation === "list") {
    if (campaignId !== undefined || extra.length) return usage();
    return listCampaigns(values);
  }
  if (!campaignId || extra.length) return usage();
  if (operation === "init") return init(campaignId, values);
  if (operation === "watch") return watch(campaignId, values);
  if (operation === "attach") return attach(campaignId, values);
  if (operation === "note") return note(campaignId, values);
  if (operation === "resolve") return resolveQuestion(campaignId, values);
  if (operation === "close") return close(campaignId, values);
  if (operation === "reledger") return reledger(campaignId, values);
  if (operation === "supervise") return supervise(campaignId, values);
  if (operation === "unpark") return unpark(campaignId, values);
  if (operation === "show") return show(campaignId, values);
  if (operation === "sync") return sync(campaignId, values);
  if (operation === "ack") return ack(campaignId, values);
  if (operation === "add-contract") return addContract(campaignId, values);
  if (operation === "replace-contract") return replaceContract(campaignId, values);
  return usage();
}

/**
 * `campaign watch <id> --wake`: poll the campaign's linked runs' status.json
 * files and print exactly one line per actionable change (TECH-SPEC lean,
 * rule 6 and section 5 row 2b). Replaces the harness-side
 * `watch-campaign.mjs` monitor and the old pull-based outbox watch.
 *
 * `--detach` spawns the same loop as a detached child whose stdio is
 * discarded, so a host scheduler can arm it without a terminal. The loop is
 * protected by a durable `watch.lock` in the campaign directory and the
 * inbox's dedupe key, so two watchers never double-send and a restarted one
 * does not replay what it already delivered.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
async function watch(campaignId, values) {
  if (values.wake !== true) throw new TypeError("watch requires --wake");
  const cwd = resolve(values.cwd ?? ".");
  const { path, runsDir } = selectCampaign(campaignId, values);
  const pollMs = values.interval === undefined ? DEFAULT_WAKE_POLL_MS : positiveIntervalMs(values.interval);
  if (values.detach === true) {
    const argv = ["campaign", "watch", campaignId, "--wake", "--cwd", cwd];
    if (values.interval !== undefined) argv.push("--interval", values.interval);
    if (values.once === true) argv.push("--once");
    const child = detachArgv(argv);
    if (child.pid === undefined) throw new Error("detached campaign watch has no pid");
    process.stdout.write(`[campaign] watch detached · pid ${child.pid} · ${campaignId}\n`);
    return;
  }
  await watchCampaignWake(path, runsDir, { pollMs, once: values.once === true });
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
async function init(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  const goal = textValue(values.goal, "--goal");
  const contracts = contractManifest(values.contract);
  const created = initializeCampaign(runsDir, { campaignId, goal, contracts, landBranch: values.landBranch });
  // The operator's own seat: whichever harness this CLI is running inside
  // (env-marker detection, see seat/harnesses.mjs), the only harness whose
  // allowance is meaningful at a point before any node runtime exists.
  const harness = detectOperatorHarness();
  const allowance = await sampleAllowance({ harness });
  appendSeatAllowanceEvent(created.path, {
    sample: "start",
    harness,
    delta: null,
    ...allowanceEventFields(allowance),
  });
  renderHandoff(created.path, runsDir);
  process.stdout.write(`[campaign] ${campaignId} initialized · ${created.path} · landBranch ${created.campaign.landBranch} · ${created.campaign.contracts.length} contract(s)\n`);
  if (syncAgentSignal(runsDir)) process.stdout.write(`[campaign] AGENTS.md signal updated\n`);
}

/**
 * Read each `--contract` path and record the digest of its authored bytes. The
 * contract is not validated here: a manifest entry may name a file a
 * predecessor will create, so validation happens at launch.
 *
 * @param {string[]|undefined} paths
 * @returns {{path: string, digest: string}[]}
 */
function contractManifest(paths) {
  return (paths ?? []).map((path) => {
    const absolute = resolve(path);
    return { path: absolute, digest: authoredContractDigest(absolute) };
  });
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function attach(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const tool = required(values.tool, "--tool");
  const sessionId = required(values.sessionId, "--session-id");
  const unavailable = Boolean(values.noTranscript);
  const transcript = unavailable ? null : values.transcript;
  if (!unavailable && typeof transcript !== "string") {
    throw new TypeError("attach requires --transcript <absolute-path> or --no-transcript");
  }
  appendJournal(path, {
    type: "session.attached",
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId,
    tool,
    transcript,
    transcriptUnavailable: unavailable,
    format: unavailable ? null : (values.format ?? null),
    cursor: values.cursor ?? null,
  });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] session ${sessionId} attached to ${campaignId}\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function note(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const kind = required(values.kind, "--kind");
  if (!NOTE_KINDS.has(kind)) {
    throw new TypeError(`--kind must be one of ${[...NOTE_KINDS].join(", ")}`);
  }
  for (const [kindName, flags] of Object.entries(NOTE_KIND_FLAGS)) {
    if (kindName === kind) continue;
    for (const flag of flags) {
      const present = /** @type {Record<string, unknown>} */ (values)[camelFlag(`--${flag}`)];
      if (present !== undefined) {
        throw new TypeError(`--${flag} is only valid for --kind ${kindName}`);
      }
    }
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    type: kind,
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId: required(values.sessionId, "--session-id"),
    text: textValue(values.text, "--text"),
  };
  if (kind === "decision") entry.decisionId = required(values.decisionId, "--decision-id");
  if (kind === "supersede") entry.supersedes = required(values.supersedes, "--supersedes");
  if (kind === "open-question") entry.questionId = required(values.questionId, "--question-id");
  if (kind === "outcome" && values.runId !== undefined) entry.runId = required(values.runId, "--run-id");
  appendJournal(path, entry);
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] ${kind} noted\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function resolveQuestion(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  requireActive(campaign);
  const questionId = required(values.questionId, "--question-id");
  appendJournal(path, {
    type: "question.resolved",
    eventId: values.eventId ?? randomUUID(),
    at: new Date().toISOString(),
    sessionId: required(values.sessionId, "--session-id"),
    questionId,
    text: textValue(values.text, "--text"),
  });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] question ${questionId} resolved\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function close(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const closed = closeCampaign(path, { eventId: values.eventId ?? randomUUID() });
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] ${closed.campaign.id} closed\n`);
  process.stdout.write(`[campaign] ledger · docs/campaigns/${closed.campaign.id}/ledger · ${closed.ledgerFiles.length} files\n`);
  reportUnknownCostFraction(path, runsDir);
  for (const skipped of closed.ledgerSkipped) {
    process.stdout.write(`[campaign] ledger skipped · ${skipped.runId}/${skipped.source}\n`);
  }
  reportRequirementClosure(closed.campaign.requirements ?? []);
  if (syncAgentSignal(runsDir)) process.stdout.write(`[campaign] AGENTS.md signal updated\n`);
}

/**
 * Print the unknown-cost fraction beside the close's ledger summary. The
 * denominator is every usage record, so each reason can be recomputed from the
 * copied ledger rather than from the operator's transient run directory.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 */
function reportUnknownCostFraction(campaignPath, runsDir) {
  const metrics = projectMetrics(readMetricsSources(campaignPath, { runsDir }));
  const indicator = metrics.usageCostUsd;
  const total = indicator.count + indicator.unknownCount;
  const reasons = Object.entries(indicator.unknownFractionByReason)
    .map(([reason, fraction]) => `${reason}=${fraction}`)
    .join(", ");
  process.stdout.write(`[campaign] unknown cost · ${indicator.unknownCount}/${total} (${reasons || "none"})\n`);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function reledger(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  const result = reledgerCampaign(path);
  process.stdout.write(`[campaign] ${campaignId} reledger · docs/campaigns/${campaignId}/ledger\n`);
  for (const change of result.copied) process.stdout.write(`[campaign] reledger copied · ${change.runId}/${change.source}\n`);
  for (const change of result.gone) process.stdout.write(`[campaign] reledger gone · ${change.runId}/${change.source}\n`);
}

/**
 * Say out loud what the close just wrote, and what it measured.
 *
 * The record is a correlation between the requirement ids a linked run's
 * contract declared and the node snapshots that reached `done` carrying them.
 * It reads the run directory and never the branch, so a requirement the
 * operator delivered by hand -- because its node blocked, which happens --
 * lands in the record as `open` while the work is on main. Measured
 * 2026-09-22 on `availability-is-verified-not-assumed`: R4 read `open` with
 * an empty `nodes` array and was merged in `a6a5d43`.
 *
 * Nothing printed this before, so the only way to meet the closure was to
 * open the JSON, where `open` reads as "not delivered" instead of "no node of
 * this campaign proved it". Naming the measurement is the whole fix: a close
 * cannot know what it did not run.
 *
 * @param {import("../campaign/index.mjs").RequirementClosure[]} requirements
 */
function reportRequirementClosure(requirements) {
  if (requirements.length === 0) return;
  const open = requirements.filter((entry) => entry.status !== "covered");
  const covered = requirements.length - open.length;
  process.stdout.write(`[campaign] requirements · ${covered}/${requirements.length} carried by a node that reached done\n`);
  if (open.length === 0) return;
  process.stdout.write(`[campaign] no done node carried ${open.map((entry) => entry.requirementId).join(", ")}\n`);
  process.stdout.write("[campaign] closure reads node snapshots, never the branch: a requirement delivered outside a node reads open here\n");
}

/**
 * `campaign supervise <id>` (also spelled `supervise campaign <id>`): the
 * idempotent re-invocation that drives the manifest. It takes the campaign's
 * `coordinator.lock`, writes the campaign heartbeat, and launches each
 * contract's run from the same controller snapshot the previous run recorded.
 * A second invocation against a fresh heartbeat writes nothing and exits 0.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
async function supervise(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  const { path } = resolveCampaign(runsDir, campaignId);
  const outcome = await driveCampaignChain(path, {
    repo: cwd,
    allowMain: values.allowMain === true,
    emit: (line) => process.stdout.write(`${line}\n`),
    launch: async (contractPath, { baseRef, runDir }) => {
      const child = detachSelf("run", contractPath, baseRef ? ["--base-ref", baseRef] : []);
      if (child.pid === undefined) throw new Error("detached run has no pid");
      await waitForBootstrap(runDir, child.pid, child);
      process.stdout.write(`[campaign] launched ${contractPath} · pid ${child.pid}\n`);
    },
  });
  process.stdout.write(`[campaign] ${campaignId} ${outcome.state} · ${outcome.launches} launch${outcome.launches === 1 ? "" : "es"}${outcome.reason ? ` · ${outcome.reason}` : ""}\n`);
  if (outcome.state === "parked" || outcome.state === "stopped") process.exitCode = 1;
}

/**
 * `campaign unpark <id>`: clear the campaign's attention once the run it
 * points at is no longer parked, so `supervise campaign` can drive the chain
 * again. `--force` skips the still-parked check.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
function unpark(campaignId, values) {
  const { path, runsDir, campaign } = selectCampaign(campaignId, values);
  try {
    const result = unparkCampaign(path, {
      runsDir,
      force: values.force === true,
      eventId: values.eventId ?? randomUUID(),
    });
    process.stdout.write(`[campaign] ${result.campaign.id} unparked · ${result.cleared.code} cleared\n`);
  } catch (error) {
    throw explainStillParked(error, campaign.attention);
  }
}

/**
 * `unparkCampaign`'s still-parked refusal names the run and its state but not
 * the node holding the park, and tells the operator to pass `--force` without
 * saying what that flag will and will not do -- an operator told only the
 * flag types the flag. The campaign's own `attention` record already carries
 * the node, its status, and the resume command the chain wrote when it
 * parked (see `chain.mjs`'s `park`), so recompose the message from that
 * instead of changing what the still-parked check itself reports. Any other
 * refusal (closed campaign, not parked) is passed through unchanged.
 *
 * @param {unknown} error
 * @param {Campaign["attention"]} attention
 * @returns {unknown}
 */
function explainStillParked(error, attention) {
  if (!(error instanceof Error) || !attention) return error;
  const match = /^run (\S+) is still (parked|canceled); resume it first or pass --force$/u.exec(error.message);
  if (!match) return error;
  const [, runId, state] = match;
  const node = attention.node ? ` node ${attention.node}${attention.status ? ` (${attention.status})` : ""}` : "";
  return new Error(
    `run ${runId}${node} is still ${state}. --force clears only the campaign's parked attention so \`supervise campaign\` can drive the chain again; it does not resume, cancel, or otherwise change run ${runId}, which stays ${state} until you act on it directly. Resume the run, or pass --force to move on without resuming it.`,
  );
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function show(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  process.stdout.write(renderHandoff(path, runsDir));
}

/**
 * User-pull campaign sync: attach the session once per day when it is not
 * attached yet, then print the campaign status header, the newest linked
 * run's status.json summary, and the unseen journal events after the session
 * cursor. sync never writes the cursor: only `ack` does.
 *
 * @param {string} campaignId
 * @param {CliValues} values
 */
function sync(campaignId, values) {
  const { path, runsDir } = selectCampaign(campaignId, values);
  const sessionId = required(values.sessionId, "--session-id");
  const cursorId = sessionCursorId(sessionId);
  attachSessionOnceDaily(path, runsDir, sessionId);
  const campaign = readCampaign(path);
  const seen = watchJournal(path, { cursor: cursorId, readOnly: true });
  const header = `campaign ${campaign.id} · status ${campaign.status}`;
  const runLine = latestRunStatusLine(runsDir, campaign);
  let output = `${header}\n${runLine}\n`;
  let index = 0;
  for (; index < seen.events.length; index += 1) {
    const event = seen.events[index];
    const line = `${event.at} ${event.type} ${journalEntryText(event)}\n`;
    if (Buffer.byteLength(output + line, "utf8") <= SYNC_OUTPUT_MAX_BYTES - 64) output += line;
    else break;
  }
  if (index < seen.events.length) output += `sync truncated: ${seen.events.length - index} more events\n`;
  process.stdout.write(output);
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 */
function ack(campaignId, values) {
  const { path } = selectCampaign(campaignId, values);
  const sessionId = required(values.sessionId, "--session-id");
  const eventId = required(values.eventId, "--event-id");
  const cursorId = sessionCursorId(sessionId);
  const position = acknowledgeJournalEvent(path, cursorId, eventId);
  process.stdout.write(`[campaign] session ${sessionId} acknowledged up to ${position.eventId}\n`);
}

/**
 * @param {string} runsDir
 * @param {Campaign} campaign
 * @returns {string}
 */
function latestRunStatusLine(runsDir, campaign) {
  const runId = campaign.linkedRunIds.at(-1);
  if (!runId) return "run: none linked yet";
  const status = /** @type {Record<string, any>|null} */ (readJsonTolerant(join(runsDir, runId, "status.json")));
  if (!status) return `run ${runId}: no status.json yet`;
  const controllerState = status.controller?.state ?? "none";
  return `run ${runId} · ${status.summary ?? ""} · controller ${controllerState}`;
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function journalEntryText(entry) {
  if (typeof entry.text === "string" && entry.text) return entry.text;
  if (entry.type === "session.attached") return `session ${entry.sessionId} attached (${entry.tool})`;
  if (entry.type === "run.registered") return `run ${entry.runId} registered`;
  return String(entry.type);
}

/**
 * Append one session.attached journal entry per day when the session has no
 * attach for today yet. The entry reuses the attach journal shape with
 * --no-transcript semantics: no transcript path is known here, so the record
 * is transcriptUnavailable with null transcript and format. The tool is
 * inherited from the session's newest recorded attach (fallback "sync") so
 * the session lineage stays truthful.
 *
 * @param {string} campaignPath
 * @param {string} runsDir
 * @param {string} sessionId
 */
function attachSessionOnceDaily(campaignPath, runsDir, sessionId) {
  const attaches = readJournal(campaignPath).filter(
    (entry) => entry.type === "session.attached" && entry.sessionId === sessionId,
  );
  const newest = attaches.at(-1);
  if (newest !== undefined && localDay(String(newest.at)) === localDay(new Date().toISOString())) return;
  const tool = typeof newest?.tool === "string" && newest.tool.trim() ? newest.tool : "sync";
  appendJournal(campaignPath, {
    type: "session.attached",
    eventId: randomUUID(),
    at: new Date().toISOString(),
    sessionId,
    tool,
    transcript: null,
    transcriptUnavailable: true,
    format: null,
    cursor: null,
  });
  renderHandoff(campaignPath, runsDir);
}

/** @param {string} sessionId @returns {string} */
function sessionCursorId(sessionId) {
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(sessionId)) {
    throw new TypeError("--session-id must be letters, digits, dots, underscores or dashes");
  }
  return `session-${sessionId}`;
}

/**
 * @param {CliValues} values
 */
function listCampaigns(values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  const { campaigns, corrupt } = discoverCampaigns(runsDir);
  if (!campaigns.length && !corrupt.length) {
    process.stdout.write("[campaign] none\n");
    return;
  }
  for (const { campaign, path } of campaigns) {
    const updated = campaign.updatedAt;
    process.stdout.write(
      `[campaign] ${campaign.id} · ${campaign.status} · ${campaign.linkedRunIds.length} linked runs · updated ${updated} · ${path}\n`,
    );
  }
  for (const entry of corrupt) {
    process.stdout.write(`[campaign] ${entry.id} · corrupt · ${entry.error.message} · ${entry.path}\n`);
  }
}

/**
 * @param {string} campaignId
 * @param {CliValues} values
 * @returns {{path: string, runsDir: string, campaign: Campaign}}
 */
function selectCampaign(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  return { ...resolveCampaign(runsDir, campaignId), runsDir };
}

/**
 * @param {Campaign} campaign
 */
function requireActive(campaign) {
  if (campaign.status !== "active") throw new Error(`campaign is closed: ${campaign.id}`);
}

/**
 * @param {string} iso
 * @returns {string}
 */
function localDay(iso) {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Strict per-operation parsing with node:util.parseArgs: unknown options,
 * missing values, and extra positionals are rejected; flags are scoped to the
 * operation that declares them.
 *
 * @param {string[]} args
 * @param {keyof typeof OPERATION_OPTIONS} operation
 * @returns {{positional: string[], values: CliValues}}
 */
function parseArgs(args, operation) {
  const parsed = parseFlags({
    args,
    options: OPERATION_OPTIONS[operation],
    allowPositionals: true,
    strict: true,
  });
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const [key, value] of Object.entries(parsed.values)) values[camelFlag(`--${key}`)] = value;
  return { positional: parsed.positionals, values: /** @type {CliValues} */ (values) };
}

/**
 * @param {string} flag
 * @returns {string}
 */
function camelFlag(flag) {
  return flag.replace(/^--/u, "").replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function textValue(value, label) {
  return required(value === "-" ? readFileSync(0, "utf8").trim() : value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} requires a value`);
  return value;
}

/** @param {string} value @returns {number} */
function positiveIntervalMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError("--interval must be a positive number of seconds");
  return Math.floor(seconds * 1_000);
}

function usage() {
  process.stderr.write(
    "usage: faberun campaign <init|watch|attach|note|resolve|close|reledger|supervise|unpark|show|list|sync|ack|add-contract|replace-contract|brief> <campaign-id> [--cwd <dir>] ...\n",
  );
  process.exitCode = 2;
}

export default OPERATION_OPTIONS;
