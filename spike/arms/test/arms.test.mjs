import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPrompt } from "../prompt.mjs";
import { faberunContract } from "../contract.mjs";
import { loadCorpusSet, topologicalOrder } from "../corpus.mjs";
import { medianReport, runIndicators } from "../analyse.mjs";
import { seededShuffle } from "../lib.mjs";
import { offendersIn } from "../checks/centralization.mjs";

test("the simple corpus is the frozen ten, each with a proof, a write scope and a relevant-files list, selectable by id", () => {
  const corpus = loadCorpusSet("simple");
  assert.equal(corpus.requirements.length, 10);
  assert.equal(corpus.acceptance.length, 10, "one acceptance check per requirement: its proof");
  for (const requirement of corpus.requirements) {
    assert.ok(requirement.writeFiles.length > 0, `${requirement.id} has a write scope`);
    assert.ok(requirement.readFiles.some((path) => path.startsWith("spike/corpus/provas/")), `${requirement.id} may read its proof`);
    assert.equal(requirement.dependsOn.length, 0);
  }
  assert.deepEqual(loadCorpusSet("simple", "CONTRACT,REPO").requirements.map((requirement) => requirement.id), ["CONTRACT", "REPO"]);
  assert.throws(() => loadCorpusSet("simple", "NOPE"), /unknown requirement/u);
  assert.equal(corpus.visibleProofs, true);
  assert.equal(corpus.npmCi, false);
});

test("the complex corpus is the recorded 1c phase: four dependent nodes, hidden acceptance, the resolver API stated", () => {
  const corpus = loadCorpusSet("complex");
  assert.equal(corpus.fork, "4913ef2");
  assert.deepEqual(corpus.requirements.map((requirement) => requirement.id), [
    "one-module-owns-the-run-paths",
    "engine-and-campaign-callers-use-the-resolver",
    "cli-repo-and-surface-callers-use-the-resolver",
    "the-centralization-guard-only-falls",
  ]);
  assert.deepEqual(corpus.requirements[3].dependsOn, ["engine-and-campaign-callers-use-the-resolver", "cli-repo-and-surface-callers-use-the-resolver"]);
  assert.ok(corpus.requirements[0].instructions.at(-1)?.includes("candidateWorktreePath(runDir, runId)"), "the resolver node is told the API the acceptance imports");
  assert.deepEqual(corpus.requirements[0].symbols, ["runsRoot", "runDirectory", "RUNS_DIR_NAME"], "the recorded packet's symbols travel unchanged");
  assert.deepEqual(corpus.acceptance.map((check) => check.id), ["resolver-api", "src-centralization", "typecheck", "regression"]);
  assert.equal(corpus.visibleProofs, false, "the acceptance is the driver's, not the arm's");
  assert.equal(corpus.npmCi, true, "typecheck needs the toolchain");
  assert.deepEqual(corpus.restore.map((item) => item.path), ["test/run/paths.test.mjs"]);
  const order = topologicalOrder([corpus.requirements[3], corpus.requirements[1], corpus.requirements[0], corpus.requirements[2]]).map((requirement) => requirement.id);
  assert.equal(order[0], "one-module-owns-the-run-paths");
  assert.equal(order[3], "the-centralization-guard-only-falls");
});

test("arms B and C receive the same prompt except the delegation paragraph, for either corpus", () => {
  for (const corpus of [loadCorpusSet("simple", "CONTRACT,REPO"), loadCorpusSet("complex")]) {
    const b = sessionPrompt({ arm: "B", corpus, sha: "abc123" });
    const c = sessionPrompt({ arm: "C", corpus, sha: "abc123" });
    assert.notEqual(b, c);
    const withoutDelegation = c.replace(/## Delegation\n\n[^\n]+\n\n/u, "");
    assert.equal(withoutDelegation, b, `removing the delegation paragraph from C yields B exactly (${corpus.kind})`);
    assert.match(c, /You have the Agent tool/u);
    assert.doesNotMatch(b, /Agent tool/u);
    for (const requirement of corpus.requirements) {
      assert.ok(b.includes(requirement.objective), `${requirement.id} objective is in the prompt`);
      assert.ok(b.includes(requirement.writeFiles.join(", ")), `${requirement.id} write scope is in the prompt`);
      for (const instruction of requirement.instructions) assert.ok(b.includes(instruction), `${requirement.id} instruction is in the prompt`);
    }
  }
  const complex = sessionPrompt({ arm: "B", corpus: loadCorpusSet("complex"), sha: "abc123" });
  assert.match(complex, /listed in dependency order/u);
  assert.ok(complex.indexOf("## 1. one-module-owns-the-run-paths") < complex.indexOf("## 4. the-centralization-guard-only-falls"), "dependency order");
  assert.match(complex, /Depends on: one-module-owns-the-run-paths\./u);
  assert.match(complex, /node_modules is installed/u);
  assert.match(complex, /the driver runs the following acceptance/u);
});

test("arms A and D carry the same corpus as a contract: dependencies, packet text, verification as proof items, judge only for A", () => {
  const corpus = loadCorpusSet("complex");
  const withJudge = /** @type {any} */ (faberunContract({ id: "arms-test-a-r1", cwd: "/tmp/x", corpus }));
  assert.equal(withJudge.nodes.length, 4);
  assert.deepEqual(withJudge.nodes[3].dependsOn, ["engine-and-campaign-callers-use-the-resolver", "cli-repo-and-surface-callers-use-the-resolver"]);
  for (const [index, node] of withJudge.nodes.entries()) {
    const requirement = corpus.requirements[index];
    assert.deepEqual(node.taskPacket.writeFiles, requirement.writeFiles);
    assert.deepEqual(node.taskPacket.instructions, requirement.instructions, "the same text the session prompt renders");
    assert.deepEqual(node.taskPacket.symbols, requirement.symbols);
    assert.equal(node.gate.review, "blocking");
    assert.ok(node.definitionOfDone.some((item) => item.judgment === true), "a judgment item makes the blocking judge run");
    assert.equal(node.definitionOfDone.filter((item) => item.proof?.kind === "verification").length, requirement.verification.length, "every verification command is a mechanical item");
  }
  const proofOnly = /** @type {any} */ (faberunContract({ id: "arms-test-d-r1", cwd: "/tmp/x", corpus, arm: "D" }));
  for (const node of proofOnly.nodes) {
    assert.equal(node.gate, false, "arm D has no judge");
    assert.equal(node.definitionOfDone.some((item) => item.judgment === true), false);
  }
  assert.notEqual(withJudge.runtimes["claude-sonnet-worker"].vendor, withJudge.runtimes["codex-sol-judge"].vendor, "the judge is another vendor");
  const cheapWriter = /** @type {any} */ (faberunContract({ id: "arms-test-e-r1", cwd: "/tmp/x", corpus, arm: "E" }));
  assert.equal(cheapWriter.runtimeDefaults.worker, "dsh-deepseek-flash-worker");
  assert.equal(cheapWriter.runtimes["dsh-deepseek-flash-worker"].harness, "dsh");
  assert.equal(cheapWriter.runtimes["dsh-deepseek-flash-worker"].model, "deepseek-flash");
  assert.equal(cheapWriter.runtimes["dsh-deepseek-flash-worker"].fallback, undefined, "no fallback: another model would contaminate the arm");
  assert.deepEqual(cheapWriter.nodes.map((node) => node.gate), [false, false, false, false], "arm E is arm D with the writer swapped");
  assert.deepEqual(cheapWriter.nodes.map((node) => node.taskPacket), proofOnly.nodes.map((node) => node.taskPacket), "the packets are identical to arm D's");
  const expected = { F: ["claude", "claude-opus-5"], G: ["codex", "gpt-5.6-sol"], H: ["codex", "gpt-5.6-luna"], I: ["codex", "gpt-6-astra"], J: ["zcode", "glm-5.3-flash"] };
  for (const [arm, [harness, model]] of Object.entries(expected)) {
    const contract = /** @type {any} */ (faberunContract({ id: `arms-test-${arm.toLowerCase()}`, cwd: "/tmp/x", corpus, arm }));
    const writer = contract.runtimes[contract.runtimeDefaults.worker];
    assert.equal(writer.harness, harness, `${arm} harness`);
    assert.equal(writer.model, model, `${arm} model`);
    assert.equal(writer.fallback, undefined, `${arm} has no fallback`);
    assert.equal(writer.maxConcurrent, 3, `${arm} shares the concurrency bound`);
    assert.deepEqual(contract.nodes.map((node) => node.gate), [false, false, false, false], `${arm} is proof-only`);
    assert.deepEqual(contract.nodes.map((node) => node.taskPacket), proofOnly.nodes.map((node) => node.taskPacket), `${arm} packets are arm D's`);
    if (harness === "codex") assert.equal(writer.sandbox, "workspace-write", `${arm} codex writer may write`);
  }
  assert.deepEqual(/** @type {any} */ (faberunContract({ id: "x", cwd: "/tmp/x", corpus, arm: "I" })).runtimes["codex-astra-worker"].pricing, { inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50 }, "astra predates the price seed, so its list price is declared");
  assert.throws(() => faberunContract({ id: "x", cwd: "/tmp/x", corpus, arm: "B" }), /not a faberun arm/u);
  const simple = /** @type {any} */ (faberunContract({ id: "arms-test-s", cwd: "/tmp/x", corpus: loadCorpusSet("simple", "CONTRACT,HOST,REPO") }));
  assert.deepEqual(simple.nodes.map((node) => node.id), ["contract", "host", "repo"], "corpus order, lower-cased ids");
});

test("the centralization check names every src file spelling the double-quoted runs literal except the resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "arms-centralization-"));
  mkdirSync(join(root, "src/run"), { recursive: true });
  mkdirSync(join(root, "src/engine"), { recursive: true });
  writeFileSync(join(root, "src/run/paths.mjs"), 'export const RUNS_DIR_NAME = ".runs";\n');
  writeFileSync(join(root, "src/engine/a.mjs"), 'import { RUNS_DIR_NAME } from "../run/paths.mjs"; // the `.runs` tree, mentioned in a comment\n');
  assert.deepEqual(offendersIn(root), [], "only the resolver spells it; a comment mention is not a spelling");
  writeFileSync(join(root, "src/engine/b.mjs"), 'const dir = join(cwd, ".runs");\n');
  assert.deepEqual(offendersIn(root), ["src/engine/b.mjs"]);
});

test("indicators: cost per delivered requirement is null when nothing was delivered, and medians ignore nulls", () => {
  const delivered = runIndicators({ costUsd: 12, proofsPassed: 4, wallMs: 600_000, requests: 80, contextMax: 120_000, scope: { outOfScope: ["a"] } });
  assert.equal(delivered.costPerDeliveredRequirementUsd.value, 3);
  const nothing = runIndicators({ costUsd: 5, proofsPassed: 0, wallMs: 60_000, requests: 10, contextMax: 1000, scope: { outOfScope: [] } });
  assert.equal(nothing.costPerDeliveredRequirementUsd.value, null, "a cheap run that delivers nothing is not economy, and not a number");
  const median = medianReport([delivered, nothing, runIndicators({ costUsd: 6, proofsPassed: 3, wallMs: 300_000, requests: 40, contextMax: 50_000, scope: { outOfScope: [] } })]);
  assert.equal(median.costPerDeliveredRequirementUsd.value, 2.5);
  assert.equal(median.costPerDeliveredRequirementUsd.count, 2);
});

test("the arm order of a repetition is reproducible from the seed", () => {
  assert.deepEqual(seededShuffle(["A", "B", "C", "D"], 7), seededShuffle(["A", "B", "C", "D"], 7));
  const orders = new Set([1, 2, 3, 4, 5, 6].map((seed) => seededShuffle(["A", "B", "C", "D"], seed).join("")));
  assert.ok(orders.size > 1, "different seeds give different orders");
});
