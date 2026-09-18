/**
 * `campaign add-contract` and `campaign replace-contract`: give an active
 * campaign's contract manifest a command, instead of the hand edit of
 * `campaign.json` an operator otherwise repeats every time a phase is
 * re-authored. `campaign.mjs` dispatches into this module; its
 * `OPERATION_OPTIONS` entries live there so the command surface stays one
 * table (`cli/campaign.mjs`'s own header explains why).
 */
import { resolve } from "node:path";
import { addContractToCampaign, renderHandoff, replaceContractInCampaign, resolveCampaign } from "../campaign/index.mjs";
import { runsRoot } from "../run/paths.mjs";

/** @typedef {{cwd?: string, path?: string, replace?: string, eventId?: string}} CampaignContractValues */

/**
 * @param {string} campaignId
 * @param {CampaignContractValues} values
 */
export function addContract(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  const { path } = resolveCampaign(runsDir, campaignId);
  const contractPath = requiredPath(values.path, "--path");
  const { campaign, added } = addContractToCampaign(path, contractPath);
  renderHandoff(path, runsDir);
  process.stdout.write(added
    ? `[campaign] contract added · ${contractPath} · ${campaign.contracts.length} contract(s)\n`
    : `[campaign] contract already recorded · ${contractPath}\n`);
}

/**
 * @param {string} campaignId
 * @param {CampaignContractValues} values
 */
export function replaceContract(campaignId, values) {
  const cwd = resolve(values.cwd ?? ".");
  const runsDir = runsRoot(cwd);
  const { path } = resolveCampaign(runsDir, campaignId);
  const contractPath = requiredPath(values.path, "--path");
  const oldPath = requiredPath(values.replace, "--replace");
  const { clearedAttention } = replaceContractInCampaign(path, oldPath, contractPath);
  renderHandoff(path, runsDir);
  process.stdout.write(`[campaign] contract replaced · ${oldPath} -> ${contractPath}\n`);
  if (clearedAttention) process.stdout.write(`[campaign] attention cleared · ${clearedAttention.code}\n`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} requires a value`);
  return resolve(value);
}
