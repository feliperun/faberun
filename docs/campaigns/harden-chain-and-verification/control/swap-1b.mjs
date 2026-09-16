// Replace contract 1 by 1b in the manifest after run 1 parked on the blocked node.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { authoredContractDigest } from "/Users/frb/.faberun/current/src/campaign/index.mjs";
const campaignPath = "/Users/frb/dev/frb/skills/.runs/campaigns/harden-chain-and-verification/campaign.json";
const from = "/Users/frb/dev/frb/skills/.runs/control/harden-chain-and-verification/contracts/1-coordinator-and-resume.contract.json";
const to = "/Users/frb/dev/frb/skills/.runs/control/harden-chain-and-verification/contracts/1b-resume-base-ref.contract.json";
const campaign = JSON.parse(readFileSync(campaignPath, "utf8"));
const index = campaign.contracts.findIndex((entry) => entry.path === from);
if (index < 0) throw new Error("contract 1 entry not found");
campaign.contracts[index] = { path: to, digest: authoredContractDigest(to) };
campaign.updatedAt = new Date().toISOString();
writeFileSync(`${campaignPath}.tmp`, `${JSON.stringify(campaign, null, 2)}\n`);
renameSync(`${campaignPath}.tmp`, campaignPath);
console.log(campaign.contracts.map((entry) => entry.path.split("/").pop()).join(" -> "));
