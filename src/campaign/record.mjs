/**
 * The `campaign.json` record itself: read it, validate it, and answer what a
 * campaign's id is.
 *
 * `campaignIdOf` falls back to the directory name when the record cannot be
 * read, because a campaign whose file is corrupt still has to be nameable in an
 * error message.
 */
import { CAMPAIGN_FILE, basenameSafe } from "./layout.mjs";
import { errorCode } from "../util.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { assertObject, requireId, requirePacketHash, requireString, requireText, requireTimestamp } from "../contract/assert.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */

/**
 * @param {string} path
 * @returns {Campaign}
 */
export function readCampaign(path) {
  let campaign;
  try {
    campaign = /** @type {unknown} */ (JSON.parse(readFileSync(join(path, CAMPAIGN_FILE), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`campaign not found: ${path}`);
    throw error;
  }
  validateCampaign(campaign);
  // A campaign written before the chain fields existed still reads: the
  // manifest is empty and the landing branch takes the current default. A
  // campaign written by `initializeCampaign` always carries all three.
  const record = /** @type {JsonObject} */ (campaign);
  record.contracts ??= [];
  record.landBranch ??= `campaign/${String(record.id)}`;
  record.promotions ??= [];
  return /** @type {Campaign} */ (campaign);
}
/**
 * @param {string} campaignPath
 * @returns {string}
 */
export function campaignIdOf(campaignPath) {
  try {
    return readCampaign(campaignPath).id;
  } catch {
    return basenameSafe(campaignPath);
  }
}
/**
 * The campaign record's schema, in one home. Exported so the repair verb in
 * `run/migrate.mjs` can prove a record's only defect is the absent `status`
 * field by validating the record with that default applied, instead of the
 * schema being restated beside the repair.
 *
 * @param {unknown} campaign
 */
export function validateCampaign(campaign) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    throw new TypeError("campaign.json must be an object");
  }
  const record = /** @type {JsonObject} */ (campaign);
  requireId(record.id, "campaign.id");
  requireText(record.goal, "campaign.goal");
  if (record.status !== "active" && record.status !== "closed") {
    throw new TypeError("campaign.status must be active or closed");
  }
  if (!Array.isArray(record.linkedRunIds)) throw new TypeError("campaign.linkedRunIds must be an array");
  for (const runId of record.linkedRunIds) requireId(runId, "campaign.linkedRunIds[]");
  // The ordered contract manifest and the landing branch. Each entry carries
  // the digest of the contract's authored bytes, enough to detect tampering
  // between authoring and the launch that validates it. The fields are
  // optional on read so a recorded historical campaign stays readable; a
  // campaign written by `initializeCampaign` always carries them.
  if (record.contracts !== undefined) {
    if (!Array.isArray(record.contracts)) throw new TypeError("campaign.contracts must be an array");
    for (const [index, entry] of record.contracts.entries()) {
      assertObject(entry, `campaign.contracts[${index}]`);
      requireString(/** @type {JsonObject} */ (entry).path, `campaign.contracts[${index}].path`);
      requirePacketHash(/** @type {JsonObject} */ (entry).digest, `campaign.contracts[${index}].digest`);
    }
  }
  if (record.landBranch !== undefined) requireText(record.landBranch, "campaign.landBranch");
  // The chain's durable park: the campaign stays active but carries the reason
  // it stopped, naming the contract, the node and the status when they exist.
  if (record.attention !== undefined && record.attention !== null) {
    assertObject(record.attention, "campaign.attention");
    const attention = /** @type {JsonObject} */ (record.attention);
    requireString(attention.code, "campaign.attention.code");
    requireString(attention.message, "campaign.attention.message");
    requireTimestamp(attention.at, "campaign.attention.at");
  }
  if (record.promotions !== undefined) {
    if (!Array.isArray(record.promotions)) throw new TypeError("campaign.promotions must be an array");
    for (const [index, entry] of record.promotions.entries()) {
      assertObject(entry, `campaign.promotions[${index}]`);
      const promotion = /** @type {JsonObject} */ (entry);
      requireId(promotion.runId, `campaign.promotions[${index}].runId`);
      requireString(promotion.branch, `campaign.promotions[${index}].branch`);
      requireString(promotion.sha, `campaign.promotions[${index}].sha`);
      if (promotion.previousSha !== null) requireString(promotion.previousSha, `campaign.promotions[${index}].previousSha`);
      requireTimestamp(promotion.at, `campaign.promotions[${index}].at`);
      if (promotion.contractPath !== undefined) requireString(promotion.contractPath, `campaign.promotions[${index}].contractPath`);
    }
  }
  // The requirement closure a close records: one entry per requirement id the
  // linked runs' contracts declared, correlated by the identifiers the runs
  // carried, with every uncovered requirement kept as open. Optional on read
  // so a campaign closed before the field existed stays readable.
  if (record.requirements !== undefined) {
    if (!Array.isArray(record.requirements)) throw new TypeError("campaign.requirements must be an array");
    for (const [index, entry] of record.requirements.entries()) {
      assertObject(entry, `campaign.requirements[${index}]`);
      const closure = /** @type {JsonObject} */ (entry);
      requireId(closure.requirementId, `campaign.requirements[${index}].requirementId`);
      if (closure.status !== "covered" && closure.status !== "open") {
        throw new TypeError(`campaign.requirements[${index}].status must be covered or open`);
      }
      if (!Array.isArray(closure.nodes)) throw new TypeError(`campaign.requirements[${index}].nodes must be an array`);
      for (const [position, evidence] of closure.nodes.entries()) {
        assertObject(evidence, `campaign.requirements[${index}].nodes[${position}]`);
        const node = /** @type {JsonObject} */ (evidence);
        requireId(node.runId, `campaign.requirements[${index}].nodes[${position}].runId`);
        requireId(node.node, `campaign.requirements[${index}].nodes[${position}].node`);
        if (node.passed !== null && typeof node.passed !== "boolean") {
          throw new TypeError(`campaign.requirements[${index}].nodes[${position}].passed must be a boolean or null`);
        }
        if (node.verdict !== null && typeof node.verdict !== "string") {
          throw new TypeError(`campaign.requirements[${index}].nodes[${position}].verdict must be a string or null`);
        }
      }
    }
  }
}
