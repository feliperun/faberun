/**
 * The liveness record of a planning process: where a `faberun plan` says which
 * stage it is in, and how a later reader tells a process that is still working
 * from one that died without a word.
 *
 * It is separate from `pipeline.mjs` because two layers need it and neither
 * owns it: the pipeline writes it as it advances through stages, and
 * `cli/plan.mjs` reads it before starting and clears it when the pipeline
 * returns. `cli/plan.mjs` already owns the sibling record for a plan that dies
 * before the pipeline is reached (`writePlanBootstrapFailure`); this one
 * covers the death that record cannot, the one that happens minutes later.
 *
 * Measured 2026-09-26 (AP4): a detached `plan` (pid 64270) vanished during the
 * repo-facts stage, leaving `plans/phase-1` empty, with no `pipeline.jsonl` and
 * no bootstrap failure. `watchPlanBootstrap` covers a five-second window, so a
 * death after it recorded nothing at all.
 *
 * A record exists because a detached process's stdio is discarded, which is
 * also why `plan --resolve` writes none: it is never detached, so a death
 * there is visible where it happens and a record would only add a second
 * account of something the operator already watched.
 *
 * The module also holds the record of what a dead attempt finished:
 * `writePlanDraftRecord` persists the validated draft plan beside the phase's
 * plan artifacts, and `resumablePlanDraft` reads it back for a resumed
 * attempt, because the liveness record says that the attempt died but not
 * what its death had already paid for. Same boundary, same reader — both
 * halves answer a later launch's one question, what did the last attempt
 * leave behind.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, processStartToken, sameProcessStartToken } from "../run/lock.mjs";
import { campaignTree } from "../run/paths.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { validatePlanOutput } from "./template.mjs";

/** @typedef {{pid?: number, processStartToken?: string|null, at?: string, stage?: string, [key: string]: unknown}} PlanProgressRecord */

/**
 * Beside the phase's durable plan artifacts rather than in the disposable
 * scratch tree, for the same reason `bootstrap-failure.json` is: a record a
 * later launch has to find cannot live where the next `plan` may wipe.
 *
 * @param {string} cwd @param {string} campaignId @param {string} phase
 * @returns {string}
 */
export function planProgressPath(cwd, campaignId, phase) {
  return join(campaignTree(cwd, campaignId), "plans", phase, "progress.json");
}

/**
 * Write the record of the process that is doing the work right now. It carries
 * the pid together with the process start token, so a reader an hour later is
 * not fooled by a pid the operating system handed to somebody else.
 *
 * @param {string} cwd @param {string} campaignId @param {string} phase
 * @param {PlanProgressRecord} record
 * @returns {void}
 */
export function writePlanProgress(cwd, campaignId, phase, record) {
  writeJsonAtomic(planProgressPath(cwd, campaignId, phase), {
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    at: new Date().toISOString(),
    ...record,
  });
}

/**
 * @param {string} cwd @param {string} campaignId @param {string} phase
 * @returns {PlanProgressRecord|null}
 */
export function readPlanProgress(cwd, campaignId, phase) {
  try {
    const record = /** @type {PlanProgressRecord} */ (readJson(planProgressPath(cwd, campaignId, phase)));
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch {
    // An absent record is the ordinary case: a plan that finished clears it.
    // A record that will not parse is one a dying process left half-written,
    // and there is nothing in it a reader could act on either way.
    return null;
  }
}

/**
 * The record of a process that stopped where it stood, or null when no plan is
 * running and nothing died. A live pid with the recorded start token is work
 * in progress, however long it has been in the same stage; anything else means
 * the pipeline never reached its own end.
 *
 * @param {string} cwd @param {string} campaignId @param {string} phase
 * @returns {PlanProgressRecord|null}
 */
export function abandonedPlanProgress(cwd, campaignId, phase) {
  const record = readPlanProgress(cwd, campaignId, phase);
  if (!record) return null;
  const pid = typeof record.pid === "number" ? record.pid : null;
  const token = typeof record.processStartToken === "string" ? record.processStartToken : null;
  if (pid !== null && pidAlive(pid) && sameProcessStartToken(processStartToken(pid), token)) return null;
  return record;
}

/**
 * @param {string} cwd @param {string} campaignId @param {string} phase
 * @returns {void}
 */
export function clearPlanProgress(cwd, campaignId, phase) {
  rmSync(planProgressPath(cwd, campaignId, phase), { force: true });
}

/** The file beside a phase's plan artifacts holding the draft a resumed attempt can adopt. */
const PLAN_DRAFT_FILE = "draft.json";

/**
 * The validated draft a later attempt can adopt without paying for it again.
 *
 * @typedef {{runId: string, at: string, specDigest: string, plan: import("./template.mjs").PlanOutput}} PlanDraftRecord
 */

/**
 * Persist the validated draft plan where a later launch of the same phase
 * finds it: beside the phase's durable plan artifacts, never in the disposable
 * scratch tree, for the same reason the progress record is there — a record a
 * later launch has to find cannot live where the next `plan` may wipe. The
 * record is written once, when the draft validates, and never removed: a
 * frozen or contested phase writes `plan.json` beside it, and the presence of
 * that file is what stops a later attempt from adopting anything.
 *
 * @param {string} plansDir
 * @param {PlanDraftRecord} record
 * @returns {void}
 */
export function writePlanDraftRecord(plansDir, record) {
  writeJsonAtomic(join(plansDir, PLAN_DRAFT_FILE), record);
}

/**
 * The dead attempt's draft, when adopting it costs no paid call, or null when
 * there is nothing to adopt. Two records must agree before anything is
 * adopted: `abandoned` — the progress record above, sampled by the caller
 * before its own first liveness write, which would otherwise overwrite the
 * evidence of the death it is about to resume from — and the draft record
 * `writePlanDraftRecord` wrote when the dead attempt validated its draft. The
 * plan in it is exactly the paid work a resumed attempt would otherwise
 * duplicate. A phase that ever finished, frozen or contested, has a
 * `plan.json` beside the record: that file, not the record's absence, is
 * what makes a later deliberate re-plan draft fresh. A record from a
 * different spec (the operator edited the spec between attempts) or one
 * whose plan no longer validates is refused the same way.
 *
 * @param {{abandoned: PlanProgressRecord|null, plansDir: string, specDigest: string}} options
 * @returns {{runId: string, plan: import("./template.mjs").PlanOutput}|null}
 */
export function resumablePlanDraft({ abandoned, plansDir, specDigest }) {
  if (abandoned === null) return null;
  if (existsSync(join(plansDir, "plan.json"))) return null;
  let record;
  try {
    record = /** @type {PlanDraftRecord|unknown} */ (readJson(join(plansDir, PLAN_DRAFT_FILE)));
  } catch {
    // An absent record is the ordinary case: a draft still running, or a
    // death before the draft validated, leaves nothing to adopt.
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const draft = /** @type {PlanDraftRecord} */ (record);
  if (draft.specDigest !== specDigest || typeof draft.runId !== "string") return null;
  try {
    return { runId: draft.runId, plan: validatePlanOutput(draft.plan) };
  } catch {
    // The record's plan no longer validates: adopting it would spend the
    // round budget repairing an unknown shape, so the caller drafts fresh.
    return null;
  }
}
