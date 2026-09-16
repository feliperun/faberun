// Promote run 1's integrated work (two accepted, fully verified nodes) onto the land branch by hand.
import { readFileSync } from "node:fs";
import { promoteRunInCampaign } from "/Users/frb/.faberun/current/src/campaign/index.mjs";
const repo = "/Users/frb/dev/frb/skills";
const runId = "harden-chain-and-verification-1-coordinator-and-resume";
const run = JSON.parse(readFileSync(`${repo}/.runs/${runId}/run.json`, "utf8"));
const record = promoteRunInCampaign({
  campaignPath: `${repo}/.runs/campaigns/harden-chain-and-verification`,
  repo, runId,
  baseSha: run.sourceIdentity.gitHead,
  finalVerificationPassed: true,
  contractPath: `${repo}/.runs/control/harden-chain-and-verification/contracts/1-coordinator-and-resume.contract.json`,
});
console.log(JSON.stringify(record));
