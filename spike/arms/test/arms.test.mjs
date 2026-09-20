import test from "node:test";
import assert from "node:assert/strict";
import { sessionPrompt } from "../prompt.mjs";
import { faberunContract } from "../contract.mjs";
import { loadCorpus, selectRequirements } from "../corpus.mjs";
import { medianReport, runIndicators } from "../analyse.mjs";
import { seededShuffle } from "../lib.mjs";

const corpus = loadCorpus();

test("the corpus is the frozen ten, each with a proof, a write scope and a relevant-files list", () => {
  assert.equal(corpus.length, 10);
  for (const requirement of corpus) {
    assert.match(requirement.prova, /^spike\/corpus\/provas\/[A-Z]+\.test\.mjs$/u);
    assert.ok(requirement.escopoEscrita.length > 0, `${requirement.id} has a write scope`);
    assert.ok(requirement.gabarito.length > 0, `${requirement.id} has relevant files`);
  }
  assert.deepEqual(selectRequirements("CONTRACT,REPO").map((requirement) => requirement.id), ["CONTRACT", "REPO"]);
  assert.throws(() => selectRequirements("NOPE"), /unknown requirement/u);
});

test("arms B and C receive the same prompt except the delegation paragraph", () => {
  const requirements = selectRequirements("CONTRACT,REPO");
  const b = sessionPrompt({ arm: "B", requirements, sha: "abc123" });
  const c = sessionPrompt({ arm: "C", requirements, sha: "abc123" });
  assert.notEqual(b, c);
  const withoutDelegation = c.replace(/## Delegation\n\n[^\n]+\n\n/u, "");
  assert.equal(withoutDelegation, b, "removing the delegation paragraph from C yields B exactly");
  assert.match(c, /You have the Agent tool/u);
  assert.doesNotMatch(b, /Agent tool/u);
  for (const requirement of requirements) {
    assert.ok(b.includes(requirement.objetivo), `${requirement.id} objective is in the prompt`);
    assert.ok(b.includes(requirement.comando), `${requirement.id} proof command is in the prompt`);
    assert.ok(b.includes(requirement.gabarito.join(", ")), `${requirement.id} relevant files are in the prompt`);
  }
  assert.match(b, /never edit or delete anything under spike\/corpus\/provas\//u);
});

test("arm A's contract carries the same corpus, one node per requirement, with the product's bounds", () => {
  const requirements = selectRequirements("CONTRACT,REPO,HOST");
  const contract = /** @type {any} */ (faberunContract({ id: "arms-test-a-r1", cwd: "/tmp/x", requirements }));
  assert.equal(contract.nodes.length, 3);
  assert.deepEqual(contract.nodes.map((node) => node.id), ["contract", "host", "repo"], "corpus order, not the order the ids were asked in");
  for (const [index, node] of contract.nodes.entries()) {
    const requirement = requirements[index];
    assert.deepEqual(node.taskPacket.writeFiles, requirement.escopoEscrita, "the write scope is the requirement's");
    assert.ok(node.taskPacket.readFiles.includes(requirement.prova), "the proof is readable");
    assert.deepEqual(node.taskPacket.verification[0].argv.slice(1), ["--test", requirement.prova], "the proof is the node's verification");
    assert.equal(node.gate.review, "blocking");
    assert.ok(node.definitionOfDone.some((item) => item.judgment === true), "a judgment item makes the blocking judge run");
    assert.ok(node.definitionOfDone.some((item) => item.proof?.kind === "command"), "the proof is a mechanical item too");
    assert.equal(node.taskPacket.instructions[0], requirement.objetivo, "the objective text is identical to the session prompt's");
  }
  assert.equal(contract.runtimes["claude-sonnet-worker"].model, "claude-sonnet-5");
  assert.notEqual(contract.runtimes["claude-sonnet-worker"].vendor, contract.runtimes["codex-sol-judge"].vendor, "the judge is another vendor");
  assert.equal(contract.maxParallel, 3);
  assert.equal(contract.runtimes["claude-sonnet-worker"].maxConcurrent, 3);
});

test("indicators: cost per delivered requirement is null when nothing was delivered, and medians ignore nulls", () => {
  const delivered = runIndicators({ costUsd: 12, proofsPassed: 4, wallMs: 600_000, requests: 80, contextMax: 120_000, scope: { outOfScope: ["a"] } });
  assert.equal(delivered.costPerDeliveredRequirementUsd.value, 3);
  assert.equal(delivered.wallClockMinutes.value, 10);
  assert.equal(delivered.contextMaxKTokens.value, 120);
  assert.equal(delivered.outOfScopeFiles.value, 1);
  const nothing = runIndicators({ costUsd: 5, proofsPassed: 0, wallMs: 60_000, requests: 10, contextMax: 1000, scope: { outOfScope: [] } });
  assert.equal(nothing.costPerDeliveredRequirementUsd.value, null, "a cheap run that delivers nothing is not economy, and not a number");
  assert.equal(nothing.costPerDeliveredRequirementUsd.count, 0);
  const median = medianReport([delivered, nothing, runIndicators({ costUsd: 6, proofsPassed: 3, wallMs: 300_000, requests: 40, contextMax: 50_000, scope: { outOfScope: [] } })]);
  assert.equal(median.costPerDeliveredRequirementUsd.value, 2.5, "the median over the two measured values");
  assert.equal(median.costPerDeliveredRequirementUsd.count, 2);
  assert.equal(median.costUsd.value, 6);
});

test("the arm order of a repetition is reproducible from the seed", () => {
  assert.deepEqual(seededShuffle(["A", "B", "C"], 7), seededShuffle(["A", "B", "C"], 7));
  const orders = new Set([1, 2, 3, 4, 5, 6].map((seed) => seededShuffle(["A", "B", "C"], seed).join("")));
  assert.ok(orders.size > 1, "different seeds give different orders");
});
