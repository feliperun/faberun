// Manual chain step for campaign become-faberun: promote a succeeded run onto the landing branch.
// usage: node promote.mjs <run-id>
import { readFileSync } from "node:fs";
import { promoteRunInCampaign } from "/Users/frb/dev/frb/skills/.runs/control/become-faberun/controller/skills/mine/intent-factory/src/campaign/index.mjs";
const repo = "/Users/frb/dev/frb/skills";
const campaignPath = `${repo}/.runs/campaigns/become-faberun`;
const runId = process.argv[2];
if (!runId) { console.error("usage: node promote.mjs <run-id>"); process.exit(2); }
const runDir = `${repo}/.runs/${runId}`;
const status = JSON.parse(readFileSync(`${runDir}/status.json`, "utf8"));
const notDone = (status.nodes ?? []).filter((n) => n.status !== "done" && n.status !== "no-op");
if (notDone.length) { console.error(`refusing: nodes not done: ${notDone.map((n) => `${n.id}:${n.status}`).join(" ")}`); process.exit(1); }
const metadata = JSON.parse(readFileSync(`${runDir}/run.json`, "utf8"));
const record = promoteRunInCampaign({
  campaignPath, repo, runId,
  baseSha: metadata.sourceIdentity?.gitHead ?? null,
  finalVerificationPassed: true,
  contractPath: `${repo}/.runs/control/become-faberun/contracts/${runId.replace("become-faberun-", "")}.contract.json`,
});
console.log(JSON.stringify(record));
