/**
 * The measurement loop: for each repetition, the arms run back to back in a
 * seeded shuffled order (a provider that drifts over the day drifts across
 * arms, not between them), each run is appended to the ledger with every
 * number the analysis needs, and a (label, arm, repetition) already in the
 * ledger is skipped so an interrupted measurement resumes instead of
 * restarting.
 *
 *   node spike/arms/measure.mjs --label smoke --requirements CONTRACT --arms A,B,C --repetitions 1
 *   node spike/arms/measure.mjs --label pilot --requirements CONTRACT,NOTIFY,REPO,HOST,PLAN --arms A,B,C --repetitions 1
 *   node spike/arms/measure.mjs --label full --requirements all --arms A,B,C --repetitions 3
 */
import { mkdirSync } from "node:fs";
import { runFaberunArm } from "./arm-faberun.mjs";
import { runSessionArm } from "./arm-session.mjs";
import { corpusHash, selectRequirements } from "./corpus.mjs";
import { forkSha } from "./fork.mjs";
import { LEDGER, LOGS, RESULTS, appendJsonl, isMeasuredRun, readJsonl, seededShuffle } from "./lib.mjs";

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback @returns {string} */
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1]);
};
const LABEL = arg("label", "smoke");
const ARMS = arg("arms", "A,B,C").split(",").map((arm) => arm.trim()).filter(Boolean);
const REPETITIONS = Number(arg("repetitions", "1"));
const REQUIREMENTS = selectRequirements(arg("requirements", "CONTRACT"));
const SEED = Number(arg("seed", "20260920"));
/** `--force` reruns keys already in the ledger; the earlier lines stay, the analysis takes every measured one. */
const FORCE = args.includes("--force");

for (const arm of ARMS) if (!["A", "B", "C", "D"].includes(arm)) throw new Error(`unknown arm ${arm}`);
if (!Number.isInteger(REPETITIONS) || REPETITIONS < 1) throw new Error("--repetitions needs a positive integer");
mkdirSync(RESULTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const done = new Set(readJsonl(LEDGER).filter((run) => run.label === LABEL && isMeasuredRun(run)).map((run) => `${run.arm}-r${run.repetition}`));
const fork = forkSha();
const hash = corpusHash();
process.stdout.write(`orchestration-arms · label ${LABEL} · ${REQUIREMENTS.length} requirement(s) · arms ${ARMS.join(",")} · ${REPETITIONS} repetition(s) · fork ${fork.slice(0, 7)}\n`);

for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
  const order = seededShuffle(ARMS, SEED + repetition);
  for (const [position, arm] of order.entries()) {
    const key = `${arm}-r${repetition}`;
    if (done.has(key) && !FORCE) {
      process.stdout.write(`skip ${key}: already in the ledger\n`);
      continue;
    }
    process.stdout.write(`run ${key} (${position + 1}/${order.length} of repetition ${repetition}) · ${new Date().toISOString()}\n`);
    const common = { label: LABEL, repetition, requirements: REQUIREMENTS };
    try {
      const record = arm === "A" || arm === "D"
        ? await runFaberunArm({ ...common, arm })
        : await runSessionArm({ ...common, arm: /** @type {"B"|"C"} */ (arm) });
      appendJsonl(LEDGER, {
        schemaVersion: 1,
        ...record,
        orderInRepetition: position + 1,
        requirementIds: REQUIREMENTS.map((requirement) => requirement.id),
        corpusHash: hash,
        fork,
      });
      process.stdout.write(`  ${key}: ${record.proofsPassed}/${REQUIREMENTS.length} proofs · $${Number(record.costUsd ?? 0).toFixed(2)} · ${Math.round(Number(record.wallMs) / 60000)} min · ${record.requests} requests\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonl(LEDGER, { schemaVersion: 1, label: LABEL, arm, repetition, error: message.slice(0, 2000), at: new Date().toISOString(), corpusHash: hash, fork });
      process.stdout.write(`  ${key}: FAILED · ${message.slice(0, 300)}\n`);
    }
  }
}
