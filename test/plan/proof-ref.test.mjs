import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlanOutput } from "../../src/plan/template.mjs";

/** @param {unknown} ref @returns {any} a plan with one node whose one DoD item proves by verification ref */
function planWithRef(ref) {
  return {
    nodes: [{
      id: "build",
      objective: "Implement it",
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: ["README.md"],
      writeFiles: ["README.md"],
      definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "verification", ref } }],
      verification: [
        { argv: ["node", "--test", "test/plan/proof-ref.test.mjs"] },
        { argv: ["npm", "run", "typecheck"] },
      ],
    }],
  };
}

test("a plan proof names its verification by text or by index", () => {
  const byIndex = validatePlanOutput(planWithRef(1));
  const byText = validatePlanOutput(planWithRef("npm run typecheck"));
  assert.deepEqual(byIndex.nodes[0].definitionOfDone[0].proof, { kind: "verification", ref: "1" });
  assert.deepEqual(byText.nodes[0].definitionOfDone[0].proof, { kind: "verification", ref: "1" });

  assert.throws(
    () => validatePlanOutput(planWithRef("npm run typecheck --watch")),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /plan\.nodes\[0\]\.definitionOfDone\[0\]\.proof\.ref "npm run typecheck --watch" names no verification command of build/u);
      assert.match(error.message, /0: node --test test\/plan\/proof-ref\.test\.mjs/u);
      assert.match(error.message, /1: npm run typecheck/u);
      return true;
    },
  );
});
