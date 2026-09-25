import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlanProofs } from "../../src/plan/proof-check.mjs";

/**
 * @param {Partial<import("../../src/plan/template.mjs").PlanOutputNode>} overrides
 * @returns {import("../../src/plan/template.mjs").PlanOutputNode}
 */
function node(overrides = {}) {
  return {
    id: "node-a", objective: "Do the thing.", taskKind: "implementation", riskTier: "standard",
    dependsOn: [], readFiles: [], writeFiles: [], scopeAcknowledged: [],
    definitionOfDone: [], verification: [],
    ...overrides,
  };
}

/** @returns {string} an empty temp directory, used only as a read root for existing test files. */
function tempCwd() {
  return mkdtempSync(join(tmpdir(), "proof-check-fixture-"));
}

/**
 * @param {{path: string, covers: string|null}[]} testFiles
 * @returns {import("../../src/plan/repo-facts.mjs").RepoFacts}
 */
function repoFacts(testFiles = []) {
  return { formatVersion: 1, gitHead: null, paths: [], truncated: false, scripts: {}, verificationCandidates: [], testFiles, requirementMeasurements: [] };
}

/**
 * @param {string} cwd
 * @param {string} relativePath
 * @param {string} contents
 */
function writeTestFile(cwd, relativePath, contents) {
  const absolute = join(cwd, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

test("a proof no node can write is found before review", () => {
  const cwd = tempCwd();
  const plan = {
    nodes: [
      node({
        id: "adds-a-flag",
        writeFiles: ["src/cli/flag.mjs"],
        definitionOfDone: [{
          id: "proven",
          text: "The new flag is covered by a test.",
          proof: { kind: "command", ref: 'node --test --test-name-pattern="a test nobody wrote or promised to write"' },
        }],
      }),
    ],
  };
  const findings = checkPlanProofs(plan, repoFacts([]), cwd);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].nodeId, "adds-a-flag");
  assert.equal(findings[0].severity, "critical");
  assert.match(findings[0].text, /a test nobody wrote or promised to write/u);
});

test("a --test-name-pattern that matches a test already in the tree is not flagged", () => {
  const cwd = tempCwd();
  writeTestFile(cwd, "test/cli/flag.test.mjs", 'test("the flag renders correctly", () => {});\n');
  const plan = {
    nodes: [node({
      definitionOfDone: [{
        id: "proven",
        text: "It renders correctly.",
        proof: { kind: "command", ref: 'node --test --test-name-pattern="the flag renders correctly"' },
      }],
    })],
  };
  assert.deepEqual(checkPlanProofs(plan, repoFacts([{ path: "test/cli/flag.test.mjs", covers: null }]), cwd), []);
});

test("a --test-name-pattern absent from the tree is not flagged when some node's writeFiles promises a test file", () => {
  const cwd = tempCwd();
  const plan = {
    nodes: [
      node({
        id: "no-test-here",
        definitionOfDone: [{
          id: "proven",
          text: "It works.",
          proof: { kind: "command", ref: 'node --test --test-name-pattern="a test this node will add"' },
        }],
      }),
      node({ id: "writes-the-test", writeFiles: ["test/cli/flag.test.mjs"] }),
    ],
  };
  assert.deepEqual(checkPlanProofs(plan, repoFacts([]), cwd), []);
});

test("a bare grep proof claiming an absence is flagged, and the negated form is not", () => {
  const cwd = tempCwd();
  const claimsAbsence = node({
    id: "removes-the-import",
    definitionOfDone: [{
      id: "gone",
      text: "src/foo.mjs no longer imports node:fs.",
      proof: { kind: "command", ref: 'grep -c "node:fs" src/foo.mjs' },
    }],
  });
  const [flagged] = checkPlanProofs({ nodes: [claimsAbsence] }, repoFacts([]), cwd);
  assert.equal(flagged.nodeId, "removes-the-import");
  assert.equal(flagged.severity, "critical");
  assert.match(flagged.text, /cannot exit 0/u);

  const guarded = node({
    id: "removes-the-import",
    definitionOfDone: [{
      id: "gone",
      text: "src/foo.mjs no longer imports node:fs.",
      proof: { kind: "command", ref: '! grep -q "node:fs" src/foo.mjs' },
    }],
  });
  assert.deepEqual(checkPlanProofs({ nodes: [guarded] }, repoFacts([]), cwd), []);
});

test("a bare grep proof claiming presence, the ordinary case, is not flagged", () => {
  const cwd = tempCwd();
  const plan = {
    nodes: [node({
      definitionOfDone: [{
        id: "present",
        text: "src/foo.mjs exports processThing.",
        proof: { kind: "command", ref: 'grep -q "export function processThing" src/foo.mjs' },
      }],
    })],
  };
  assert.deepEqual(checkPlanProofs(plan, repoFacts([]), cwd), []);
});
