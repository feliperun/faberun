/**
 * A deterministic stage between the draft and the first review round (R15):
 * finds a Definition of Done proof no node can satisfy, without invoking a
 * model. Two shapes of unsatisfiable proof are checked: a
 * `--test-name-pattern` naming no test the tree has and no test file any
 * node's `writeFiles` promises to add, and a bare `grep`/`grep -c` proof whose
 * own DoD text claims the absence of what it greps for — grep exits 1 when
 * nothing matches, so a proof shaped that way cannot exit 0 in the very state
 * the node promises. Lives apart from `rounds.mjs` because both the pipeline
 * (before any round) and every later round's own findings feed off the same
 * plan-wide scan; this module owns none of the round bookkeeping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellWords } from "../util.mjs";
import { NAME_PATTERN_FLAG } from "./proof-run.mjs";

/** @typedef {import("./template.mjs").PlanOutput} PlanOutput */
/** @typedef {import("./template.mjs").PlanOutputNode} PlanOutputNode */
/** @typedef {import("./template.mjs").PlanFindingOutput} PlanFindingOutput */
/** @typedef {import("../contract/definition-of-done.mjs").DefinitionOfDoneItem} DefinitionOfDoneItem */
/** @typedef {import("./repo-facts.mjs").RepoFacts} RepoFacts */

/**
 * A test title inside a `test(...)`/`test.only(...)`/`test.skip(...)` call,
 * quoted with any of the three ordinary JS quote characters.
 */
const TEST_TITLE = /\btest(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gu;

/**
 * Words an English Definition of Done uses to promise that something is
 * gone, not present — the direction in which a bare `grep` cannot exit 0.
 * Text-based and therefore inexact, but the same restraint the rest of this
 * pipeline already accepts for a deterministic check: a plain `grep` proving
 * presence (the ordinary case) is left alone, because flagging every `grep`
 * regardless of direction would drown the one finding this stage exists for.
 */
const ABSENCE_CLAIM = /\b(?:no longer|not |never |removed|absent|without |must not|should not|does ?n[o']t|isn['’]t|no more|zero (?:occurrences|matches|instances)|nowhere)\b/iu;

/**
 * The command text a DoD proof actually runs: `kind: "command"` carries it
 * verbatim, `kind: "verification"` carries the (already index-normalized,
 * see `contract/definition-of-done.mjs`) position of one of the node's own
 * `verification` entries. `kind: "path"` has no command at all.
 *
 * @param {PlanOutputNode} node
 * @param {DefinitionOfDoneItem["proof"]} proof
 * @returns {string|null}
 */
function proofCommandText(node, proof) {
  if (!proof) return null;
  if (proof.kind === "command") return proof.ref;
  if (proof.kind === "verification") {
    const command = node.verification[Number(proof.ref)];
    return command ? command.argv.join(" ") : null;
  }
  return null;
}

/**
 * Whether `pattern` (a `--test-name-pattern` value, a regular expression) is
 * satisfied by a test title already declared in one of `repoFacts.testFiles`
 * — read straight off disk, since repo facts records only the path, never
 * the titles inside it.
 *
 * @param {string} cwd
 * @param {RepoFacts} repoFacts
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesAnExistingTest(cwd, repoFacts, pattern) {
  /** @type {RegExp} */
  let regex;
  try {
    regex = new RegExp(pattern, "u");
  } catch {
    return false;
  }
  for (const entry of repoFacts.testFiles) {
    /** @type {string} */
    let source;
    try {
      source = readFileSync(join(cwd, entry.path), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(TEST_TITLE)) {
      if (regex.test(match[2])) return true;
    }
  }
  return false;
}

/** @param {PlanOutput} plan @returns {boolean} */
function someNodeWritesATestFile(plan) {
  return plan.nodes.some((node) => node.writeFiles.some((path) => /^test\/.*\.test\.mjs$/u.test(path)));
}

/**
 * Whether `commandText` is a `grep` proof no revise can protect against
 * failing in the state it promises: the base command is `grep` (optionally
 * `-c`), and it carries neither of the two shapes that make its exit code
 * mean what a proof needs (`! grep -q …`, or a trailing `|| true`, which
 * always exits 0 whatever grep found).
 *
 * @param {string} commandText
 * @returns {boolean}
 */
function isUnguardedGrep(commandText) {
  const tokens = shellWords(commandText);
  if (tokens.length === 0) return false;
  const negated = tokens[0] === "!";
  const base = negated ? tokens[1] : tokens[0];
  if (base !== "grep") return false;
  if (negated && tokens.includes("-q")) return false;
  if (tokens.length >= 2 && tokens[tokens.length - 2] === "||" && tokens[tokens.length - 1] === "true") return false;
  return true;
}

/**
 * Every DoD proof in `plan` no node can satisfy, checked without a model:
 * see the module header for the two shapes this looks for. Returns one
 * finding per unsatisfiable proof, in plan order, ready to merge into the
 * findings the first review round already carries.
 *
 * @param {PlanOutput} plan
 * @param {RepoFacts} repoFacts
 * @param {string} cwd
 * @returns {PlanFindingOutput[]}
 */
export function checkPlanProofs(plan, repoFacts, cwd) {
  /** @type {PlanFindingOutput[]} */
  const findings = [];
  for (const node of plan.nodes) {
    for (const item of node.definitionOfDone) {
      const commandText = proofCommandText(node, item.proof);
      if (commandText === null) continue;
      const nameFlag = NAME_PATTERN_FLAG.exec(commandText);
      if (nameFlag) {
        const pattern = nameFlag[1] ?? nameFlag[2] ?? nameFlag[3];
        if (matchesAnExistingTest(cwd, repoFacts, pattern) || someNodeWritesATestFile(plan)) continue;
        findings.push({
          id: `proof-unmet-${node.id}-${item.id}`,
          severity: "critical",
          nodeId: node.id,
          text: `Node ${node.id}'s Definition of Done item "${item.id}" proves itself with --test-name-pattern="${pattern}", which matches no test already in the tree and no test file any node's writeFiles declares. Either name a test that already exists, or have some node's writeFiles add the test file this pattern will match.`,
        });
        continue;
      }
      if (isUnguardedGrep(commandText) && ABSENCE_CLAIM.test(item.text)) {
        findings.push({
          id: `proof-unmet-${node.id}-${item.id}`,
          severity: "critical",
          nodeId: node.id,
          text: `Node ${node.id}'s Definition of Done item "${item.id}" claims an absence ("${item.text}") but proves it with a bare grep ("${commandText}"): grep exits 1 when nothing matches, so this proof cannot exit 0 in the state the node promises. Write it as "! grep -q …" instead.`,
        });
      }
    }
  }
  return findings;
}
