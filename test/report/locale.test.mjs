import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage, labelsFor } from "../../src/report/locale.mjs";

test("detectLanguage reads the operator's own words: Portuguese goals render Portuguese, English renders English, nothing renders English", () => {
  assert.equal(detectLanguage(["Garantir que o cancelamento não perca trabalho já integrado e que as notas do journal sejam recusadas em vez de cortadas"]), "pt");
  assert.equal(detectLanguage(["The durable state faberun keeps is complete, reachable and repairable: a cancel never orphans integrated work"]), "en");
  assert.equal(detectLanguage([]), "en");
  assert.equal(detectLanguage([null, undefined, ""]), "en");
  assert.equal(detectLanguage(["src/repo/worktree.mjs createPreservedRef refs/faberun"]), "en", "identifiers alone carry no language and fall to English");
});

test("detectLanguage lets the first group with any signal decide: the operator's goal before the planner's objectives", () => {
  const portugueseGoal = "O estado durável que o faberun guarda é completo, alcançável e reparável: um cancelamento nunca deixa órfão o trabalho já integrado";
  const englishObjectives = [
    "Add to src/repo/worktree.mjs the git verb cancel needs: create a durable preserved ref for one integrated commit, inside the run's own namespace",
    "Make cancel create a preserved ref for every non-null integratedHead of the run's nodes before it releases anything, and prove a relaunch of the same contract id still works",
  ];
  assert.equal(detectLanguage([portugueseGoal], [], englishObjectives), "pt", "a Portuguese goal is not outvoted by two English objectives");
  assert.equal(detectLanguage([null], ["nenhuma nota ainda, mas esta é do operador"], englishObjectives), "pt", "with no goal, the journal decides");
  assert.equal(detectLanguage([null], [], englishObjectives), "en", "with neither, the plan's own text decides");
  assert.equal(detectLanguage(["refs/faberun createPreservedRef"], [], ["Garantir que o cancelamento não perca trabalho"]), "pt", "a goal made of identifiers carries no signal and yields to the next group");
  assert.equal(detectLanguage([portugueseGoal, "the plan and the judge"]), "pt", "within one group the count decides");
  assert.equal(detectLanguage(["create a durable preserved ref for one integrated commit"]), "en", "an English article is not a Portuguese one");
});

test("labelsFor answers every key in both languages and falls back to English, then to the key itself", () => {
  const en = labelsFor("en");
  const pt = labelsFor("pt");
  for (const key of ["doneIn", "asked", "did", "proof", "delivered", "why", "do", "nodes", "next", "waitingOnYou", "available", "runUpdate"]) {
    assert.equal(typeof en(key), "string");
    assert.notEqual(pt(key), key, `pt has ${key}`);
    assert.notEqual(pt(key), en(key), `${key} is translated, not copied`);
  }
  assert.equal(pt("doneIn"), "concluído em");
  assert.equal(en("no-such-key"), "no-such-key");
  assert.equal(pt("no-such-key"), "no-such-key");
});
