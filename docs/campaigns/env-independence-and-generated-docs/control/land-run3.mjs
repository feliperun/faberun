import { readFileSync } from "node:fs";
import { promoteRunInCampaign } from "/Users/frb/.faberun/current/src/campaign/index.mjs";
const repo = "/Users/frb/dev/frb/skills";
const runId = "env-independence-and-generated-docs-3-reference-load";
const run = JSON.parse(readFileSync(`${repo}/.runs/${runId}/run.json`, "utf8"));
console.log(JSON.stringify(promoteRunInCampaign({ campaignPath: `${repo}/.runs/campaigns/env-independence-and-generated-docs`, repo, runId, baseSha: run.sourceIdentity.gitHead, finalVerificationPassed: true, contractPath: `${repo}/.runs/control/env-independence-and-generated-docs/contracts/3-reference-load.contract.json` })));
