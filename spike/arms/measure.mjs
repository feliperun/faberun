/**
 * The measurement loop: for each repetition, the arms run back to back in a
 * seeded shuffled order (a provider that drifts over the day drifts across
 * arms, not between them), each run is appended to the ledger with every
 * number the analysis needs, and a (label, arm, repetition) already measured
 * is skipped so an interrupted measurement resumes instead of restarting.
 *
 *   node spike/arms/measure.mjs --corpus simple --label pilot --requirements CONTRACT,HOST,NOTIFY,REPO,RUN --arms A,B,C,D --repetitions 3
 *   node spike/arms/measure.mjs --corpus complex --label complex --arms A,B,C,D --repetitions 2
 */
import { mkdirSync } from "node:fs";
import { runFaberunArm } from "./arm-faberun.mjs";
import { runSessionArm } from "./arm-session.mjs";
import { FABERUN_ARMS } from "./contract.mjs";
import { loadCorpusSet } from "./corpus.mjs";
import { forkSha } from "./fork.mjs";
import { LEDGER, LOGS, RESULTS, appendJsonl, isMeasuredRun, readJsonl, seededShuffle } from "./lib.mjs";

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback @returns {string} */
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1]);
};
const LABEL = arg("label", "smoke");
const ARMS = arg("arms", `B,C,${Object.keys(FABERUN_ARMS).join(",")}`).split(",").map((arm) => arm.trim()).filter(Boolean);
const REPETITIONS = Number(arg("repetitions", "1"));
const KIND = /** @type {"simple"|"complex"} */ (arg("corpus", "simple"));
const CORPUS = loadCorpusSet(KIND, arg("requirements", "all"));
const SEED = Number(arg("seed", "20260920"));
/** `--force` reruns keys already in the ledger; the earlier lines stay, the analysis takes every measured one. */
const FORCE = args.includes("--force");

for (const arm of ARMS) if (!["B", "C"].includes(arm) && !(arm in FABERUN_ARMS)) throw new Error(`unknown arm ${arm}`);
if (!Number.isInteger(REPETITIONS) || REPETITIONS < 1) throw new Error("--repetitions needs a positive integer");
mkdirSync(RESULTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const done = new Set(readJsonl(LEDGER).filter((run) => run.label === LABEL && isMeasuredRun(run)).map((run) => `${run.arm}-r${run.repetition}`));
const fork = forkSha(CORPUS.fork);
process.stdout.write(`orchestration-arms · corpus ${KIND} · label ${LABEL} · ${CORPUS.requirements.length} requirement(s) · ${CORPUS.acceptance.length} acceptance check(s) · arms ${ARMS.join(",")} · ${REPETITIONS} repetition(s) · fork ${fork.slice(0, 7)}\n`);

for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
  const order = seededShuffle(ARMS, SEED + repetition);
  for (const [position, arm] of order.entries()) {
    const key = `${arm}-r${repetition}`;
    if (done.has(key) && !FORCE) {
      process.stdout.write(`skip ${key}: already in the ledger\n`);
      continue;
    }
    process.stdout.write(`run ${key} (${position + 1}/${order.length} of repetition ${repetition}) · ${new Date().toISOString()}\n`);
    const common = { label: LABEL, repetition, corpus: CORPUS };
    try {
      const record = arm in FABERUN_ARMS
        ? await runFaberunArm({ ...common, arm })
        : await runSessionArm({ ...common, arm: /** @type {"B"|"C"} */ (arm) });
      appendJsonl(LEDGER, {
        schemaVersion: 1,
        ...record,
        corpus: KIND,
        orderInRepetition: position + 1,
        requirementIds: CORPUS.requirements.map((requirement) => requirement.id),
        acceptanceIds: CORPUS.acceptance.map((check) => check.id),
        corpusHash: CORPUS.hash,
        fork,
      });
      process.stdout.write(`  ${key}: ${record.proofsPassed}/${CORPUS.acceptance.length} acceptance · $${Number(record.costUsd ?? 0).toFixed(2)} · ${Math.round(Number(record.wallMs) / 60000)} min · ${record.requests} requests\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonl(LEDGER, { schemaVersion: 1, label: LABEL, arm, repetition, corpus: KIND, error: message.slice(0, 2000), at: new Date().toISOString(), corpusHash: CORPUS.hash, fork });
      process.stdout.write(`  ${key}: FAILED · ${message.slice(0, 300)}\n`);
    }
  }
}
