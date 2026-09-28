import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateContract,
} from "../../src/contract/index.mjs";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import { validateWorkerResult } from "../../src/contract/worker-result.mjs";
import { RESERVED_OWNER_DECISIONS } from "../../src/contract/articles.mjs";
import { judgePrompt } from "../../src/engine/prompts.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { nodeState, notifications } from "../runner-helpers.mjs";
import { runDirectory, runsRoot } from "../../src/run/paths.mjs";
import { JUDGE_LIMITS } from "../../src/contract/judge-envelope.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import * as helpers from "../helpers.mjs";
import { initializeGit, packet, writeFixture } from "./helpers.mjs";

// The other half of contract.test.mjs: task packets, the prompts rendered from
// them, and the write boundaries they declare.

// Task packets and the prompts rendered from them.
// Runtime declaration, fallback edges and vendor rules are in runtime.test.mjs.

test("every worker prompt states the controller's verification is the proof", () => {
  const prompts = [
    renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()), "build"),
    renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "discovery", readFiles: [], writeFiles: [] })), "discover"),
    renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "autonomous", writeRoots: ["src"] })), "build"),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /## Verification\nThe controller runs every command below after you report; its recorded results are the proof of this node\./u);
    assert.match(prompt, /Running a command yourself is optional and only for one that finishes in seconds and spawns no long-lived process\./u);
    assert.match(prompt, /never run tests that start and terminate other processes\./u);
    assert.match(prompt, /Prefer a targeted edit over rewriting a whole file, and read with an offset and limit rather than whole files/u);
    assert.match(prompt, /## Required output/u, "the Required output section is untouched");
  }
});

test("every mode's Required output names the whole shape validateWorkerResult requires", () => {
  // Derived from the validator itself, not restated as a literal the two
  // sides could drift apart from: the envelope's own keys are the keys a
  // worker result must carry.
  const requiredFields = Object.keys(validateWorkerResult({
    status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [],
  }));
  const prompts = {
    execution: renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()), "build"),
    discovery: renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "discovery", readFiles: [], writeFiles: [] })), "discover"),
    autonomous: renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "autonomous", writeRoots: ["src"] })), "build"),
  };
  for (const [mode, prompt] of Object.entries(prompts)) {
    const requiredOutput = prompt.slice(prompt.indexOf("## Required output"));
    for (const field of requiredFields) {
      assert.match(requiredOutput, new RegExp(`"${field}"`, "u"), `${mode}'s Required output must name ${field}`);
    }
  }
  // The artifacts content contract belongs to the packet's own instructions,
  // not to this schema statement, so discovery's copy states the shape only.
  const discoveryRequiredOutput = prompts.discovery.slice(prompts.discovery.indexOf("## Required output"));
  assert.doesNotMatch(discoveryRequiredOutput, /execution task packet/u);
});

test("validate loads taskPacketFile and renders a closed execution prompt", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-file-"));
  writeFileSync(join(directory, "packet.json"), `${JSON.stringify(helpers.packet())}\n`);
  const value = helpers.fixture();
  /** @type {Array<Record<string, unknown>>} */
  const packetFileNodes = /** @type {Array<Record<string, unknown>>} */ (value.nodes);
  packetFileNodes[0] = { id: "build", type: "backend", phase: "fixture-phase-0", taskPacketFile: "packet.json", gate: false };
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.nodes[0].taskPacket.mode, "execution");
  assert.match(contract.nodes[0].prompt, /Closed context/u);
  assert.match(contract.nodes[0].prompt, /exactly one JSON object/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /BLOCKED_CONTEXT/u);
});

test("validate rejects malformed, escaping, and missing-read-file task packets", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-invalid-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(directory, "outside-link"));
  const cases = [
    [helpers.packet({ readFiles: ["../outside"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["../outside"] }), /escapes cwd/u],
    [helpers.packet({ readFiles: ["outside-link"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["outside-link"] }), /escapes cwd/u],
    [helpers.packet({ writeFiles: ["."] }), /must name a file/u],
    [helpers.packet({ readFiles: ["missing.txt"] }), /does not exist/u],
    [helpers.packet({ mode: "discovery", writeFiles: ["README.md"] }), /must be empty for a discovery packet/u],
    [helpers.packet({ mode: "execution", readFiles: [] }), /readFiles must not be empty/u],
    [helpers.packet({ mode: "execution", writeFiles: [] }), /writeFiles must not be empty/u],
  ];
  for (const [taskPacket, expected] of cases) {
    const value = helpers.fixture({ nodes: [{ id: "build", type: "backend", taskPacket, gate: false }] });
    const path = helpers.writeContract(directory, value);
    assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), expected);
  }
});

test("validate rejects new write paths beneath an outward symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-target-"));
  symlinkSync(outside, join(directory, "outside-dir"));
  const value = helpers.fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: helpers.packet({ writeFiles: ["outside-dir/new.txt"] }), gate: false }],
  });
  const path = helpers.writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /escapes cwd/u,
  );
});

test("validate rejects a symlink followed by dotdot escaping cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-dotdot-"));
  const outside = mkdtempSync(join(tmpdir(), "runner-task-packet-symlink-dotdot-target-"));
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(directory, "secret.txt"), "inside secret");
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(join(outside, "sub"), join(directory, "link"));
  const value = helpers.fixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: helpers.packet({ readFiles: ["link/../secret.txt"] }),
      gate: false,
    }],
  });
  const path = helpers.writeContract(directory, value);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /escapes cwd/u,
  );
});

test("judge prompt exposes only the write-file evidence boundary", () => {
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  assert.match(prompt, /Write files:\n- README\.md/u);
  assert.match(prompt, /\[works\] It works/u);
  assert.doesNotMatch(prompt, /Read files/u);
  assert.doesNotMatch(prompt, /contract\.json/u);
});

test("judge prompt advertises the envelope the parser enforces", () => {
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  // A verdict that overshoots is discarded unread, so the numbers the parser
  // enforces have to be the numbers the prompt states: a judge told nothing
  // about the limit can only be destroyed by it, and the re-ask repeats it.
  assert.match(prompt, new RegExp(`keep \`summary\` within ${JUDGE_LIMITS.summaryBytes} bytes`, "u"));
  assert.match(prompt, new RegExp(`at most ${JUDGE_LIMITS.findings} findings`, "u"));
  assert.match(prompt, new RegExp(`\`description\` within ${JUDGE_LIMITS.descriptionBytes} bytes`, "u"));
  assert.match(prompt, new RegExp(`\`evidence\` within ${JUDGE_LIMITS.evidenceBytes} bytes`, "u"));
  assert.match(prompt, /rejected unread/u);
});

test("the judge is told an enumerating item is covered class by class (AP20)", () => {
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "guard", text: "The guard refuses .runs, except the legacy layout block a doc labels", judgment: true }],
  });
  const prompt = judgePrompt(node, "worker complete");
  // The requirement matters only because it enumerates: a judge that checks
  // the shape and not the exclusions approves a half delivery, which is what
  // `guards-core` did before the operator intervened twice on the ref.
  assert.match(prompt, /\[guard\] The guard refuses/u);
  assert.match(prompt, /checked one by one against the diff/u);
  assert.match(prompt, /the general shape holding is not coverage/u);

  // The rule governs arbitration, so a node with nothing to arbitrate is not
  // told about it: the checklist says there are no judgment items instead.
  const proven = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
  });
  const provenPrompt = judgePrompt(proven, "worker complete");
  assert.match(provenPrompt, /No judgment items require arbitration\./u);
  assert.doesNotMatch(provenPrompt, /checked one by one against the diff/u);
});

test("judge prompt lists scope findings only when the node carries an advisory finding", () => {
  const node = /** @type {import("../../src/engine/prompts.mjs").JudgeNode} */ ({
    id: "build",
    type: "backend",
    taskPacket: /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet()),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  });
  const clean = judgePrompt(node, "worker complete");
  assert.doesNotMatch(clean, /Scope findings/u);

  const flagged = judgePrompt(node, "worker complete", { scopeFindings: { unexpectedPaths: ["outside.txt"] } });
  assert.match(flagged, /Scope findings/u);
  assert.match(flagged, /- outside\.txt/u);
});

test("discovery packets render as read-only discovery work", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-discovery-packet-"));
  const value = helpers.fixture({
    nodes: [{
      id: "discover",
      type: "backend",
      taskPacket: helpers.packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
      gate: false,
    }],
  });
  const path = helpers.writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.match(contract.nodes[0].prompt, /read-only/u);
  assert.match(contract.nodes[0].prompt, /worker-result JSON object/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /BLOCKED_CONTEXT/u);
});

test("stored contract inlines the task packet and drops the generated prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-stored-packet-"));
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
  const path = helpers.writeContract(directory, helpers.fixture({ id: "stored-packet-run", pollIntervalMs: 10 }));
  initializeGit(directory);
  const result = await helpers.withFakeCodex(directory, "pass", () => runContract(path));
  const stored = JSON.parse(readFileSync(join(result.runDir, "contract.json"), "utf8"));
  assert.equal(stored.nodes[0].taskPacket.mode, "execution");
  assert.equal(stored.nodes[0].prompt, undefined);
  assert.equal(stored.nodes[0].taskPacketFile, undefined);
  const revalidated = validateContract(stored, join(result.runDir, "contract.json"));
  assert.match(revalidated.nodes[0].prompt, /Closed context/u);
});

test("autonomous packets use bounded write roots and render a read-only inspection boundary", () => {
  const { directory, path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["src"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(directory, "src"));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["src"]);
  assert.match(contract.nodes[0].prompt, /write roots/u);
  assert.match(contract.nodes[0].prompt, /read-only/u);
  assert.doesNotMatch(contract.nodes[0].prompt, /Write files/u);

  for (const invalid of [
    { writeFiles: [] },
    { writeRoots: ["."] },
    { writeRoots: ["../outside"] },
  ]) {
    const invalidPath = writeFixture({
      nodes: [{
        id: "build",
        type: "backend",
        taskPacket: {
          mode: "autonomous",
          objective: "Implement it",
          instructions: ["Inspect as needed and make the change"],
          readFiles: [],
          writeRoots: ["src"],
          symbols: [],
          decisions: [],
          nonGoals: [],
          verification: [],
          ...invalid,
        },
        gate: false,
      }],
    });
    mkdirSync(join(invalidPath.directory, "src"));
    assert.throws(() => validateContract(JSON.parse(readFileSync(invalidPath.path, "utf8")), invalidPath.path), /autonomous|writeRoots|escapes cwd/u);
  }
});

test("autonomous write roots reject symlinks resolving to cwd but allow nested symlinks", () => {
  const root = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["alias"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  symlinkSync(".", join(root.directory, "alias"));
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(root.path, "utf8")), root.path),
    /escapes cwd/u,
  );

  const nested = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["alias"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(nested.directory, "src"));
  symlinkSync("src", join(nested.directory, "alias"));
  const contract = validateContract(JSON.parse(readFileSync(nested.path, "utf8")), nested.path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["alias"]);
});

test("an autonomous write root may name an existing regular file", () => {
  const { directory, path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: {
        mode: "autonomous",
        objective: "Implement it",
        instructions: ["Inspect as needed and make the change"],
        readFiles: [],
        writeRoots: ["docs/NOTES.md"],
        symbols: [],
        decisions: [],
        nonGoals: [],
        verification: [],
      },
      gate: false,
    }],
  });
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs", "NOTES.md"), "notes\n");
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(contract.nodes[0].taskPacket.writeRoots, ["docs/NOTES.md"]);
});

test("an autonomous prompt states that scope is advisory", () => {
  const prompt = renderWorkerPrompt(
    /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "autonomous", writeRoots: ["src"] })),
    "build",
  );
  // The write roots are the expected boundary, not a wall: the engine records
  // a write outside them and shows it to the judge rather than treating the
  // worker as failed for stepping past a declaration.
  assert.match(prompt, /The write roots below are the expected boundary, not a hard wall/u);
  assert.match(prompt, /a write outside them is allowed when the task requires it/u);
  assert.match(prompt, /the result must name the path and the reason/u);
  // blocked_context is reserved for context that is genuinely missing, not for
  // a write that crossed a declared root.
  assert.match(prompt, /blocked_context worker-result object below only for context that is genuinely missing/u);
  assert.doesNotMatch(prompt, /do not write outside those directory boundaries/u);
  assert.match(prompt, /## Write roots\n- src/u);
});

test("a reserved owner decision without coverage is refused with blocked_context", () => {
  const uncovered = renderWorkerPrompt(
    /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ decisions: [] })),
    "build",
  );
  assert.match(uncovered, /## Reserved owner decisions/u);
  assert.match(uncovered, /return the blocked_context worker-result object naming the decision/u);
  const uncoveredList = uncovered.slice(
    uncovered.indexOf("Reserved decisions with no coverage"),
    uncovered.indexOf("If the task requires taking an uncovered decision"),
  );
  for (const decision of RESERVED_OWNER_DECISIONS) {
    assert.ok(uncoveredList.includes(decision), `the worker must be told ${decision} is uncovered`);
  }

  // A decision the packet already made is not refused.
  const covered = renderWorkerPrompt(
    /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ decisions: ["license: MIT"] })),
    "build",
  );
  const coveredList = covered.slice(
    covered.indexOf("Reserved decisions with no coverage"),
    covered.indexOf("If the task requires taking an uncovered decision"),
  );
  assert.doesNotMatch(coveredList, /license/u, "a covered decision is not refused");
  assert.match(coveredList, /pricing/u, "an uncovered decision is still named");

  // The autonomous prompt reads the same list and refuses the same way.
  const autonomous = renderWorkerPrompt(
    /** @type {import("../../src/contract/index.mjs").TaskPacket} */ (helpers.packet({ mode: "autonomous", writeRoots: ["src"], decisions: [] })),
    "build",
  );
  assert.match(autonomous, /## Reserved owner decisions/u);
  assert.match(autonomous, /return the blocked_context worker-result object naming the decision/u);
});

test("replayPolicy defaults to safe and accepts only its enumerated values", () => {
  const defaulted = writeFixture();
  const contract = validateContract(JSON.parse(readFileSync(defaulted.path, "utf8")), defaulted.path);
  assert.equal(contract.nodes[0].replayPolicy, "safe");

  for (const policy of ["safe", "reconcile", "never"]) {
    const accepted = writeFixture({
      nodes: [{ id: "build", type: "backend", replayPolicy: policy, taskPacket: packet(), gate: false }],
    });
    const validated = validateContract(JSON.parse(readFileSync(accepted.path, "utf8")), accepted.path);
    assert.equal(validated.nodes[0].replayPolicy, policy);
  }

  for (const invalid of [true, "retry", "SAFE", 1]) {
    const rejected = writeFixture({
      nodes: [{ id: "build", type: "backend", replayPolicy: invalid, taskPacket: packet(), gate: false }],
    });
    assert.throws(
      () => validateContract(JSON.parse(readFileSync(rejected.path, "utf8")), rejected.path),
      /replayPolicy must be one of safe, reconcile, never/u,
    );
  }
});

// The 800-line ceiling is a rule about source modules: source-shape enforces
// it over .mjs alone. Measured 2026-09-22: a packet declaring the generated
// docs/COMMANDS.md was warned that 1141 lines left "-341 from the 800-line
// ceiling", which is not a budget, is not true of that file, and trains the
// reader to skim past the warnings that are.
test("the write-file line ceiling warns about modules, not about every declared path", () => {
  const { directory, path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: { ...packet(), writeFiles: ["long.md", "long.mjs", "short.mjs"] },
    }],
  });
  initializeGit(directory);
  writeFileSync(join(directory, "long.md"), `${"x\n".repeat(1200)}`);
  writeFileSync(join(directory, "long.mjs"), `${"// x\n".repeat(780)}`);
  writeFileSync(join(directory, "short.mjs"), "// x\n");

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  const ceiling = warnings.filter((line) => line.includes("800-line ceiling"));
  assert.equal(ceiling.length, 1, `exactly the module near the ceiling warns: ${JSON.stringify(ceiling)}`);
  assert.match(ceiling[0], /long\.mjs is already 78[01] lines/u);
  assert.ok(!ceiling.some((line) => line.includes("long.md")), "a markdown file has no module ceiling");
});

// A `kind: "command"` proof's ref runs through a shell, while
// taskPacket.verification's argv does not: the same unquoted filter value
// that argv would keep as one argument, a shell splits into words. Measured
// 2026-09-22: six DoD refs on a real campaign wrote this shape and the gate
// rejected work whose identical argv had just passed as verification.
test("an unquoted test-name-pattern value on a command proof is warned, not silently split", () => {
  const { path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      gate: false,
      taskPacket: packet(),
      definitionOfDone: [
        { id: "unit", text: "the suite passes", proof: { kind: "command", ref: "node --test --test-name-pattern=a b c" } },
      ],
    }],
  });

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  const quoting = warnings.filter((line) => line.includes("--test-name-pattern"));
  assert.equal(quoting.length, 1, `exactly the unquoted proof warns: ${JSON.stringify(warnings)}`);
  assert.match(quoting[0], /value "a b c" is unquoted/u);
  assert.match(quoting[0], /--test-name-pattern="a b c"/u);
});

test("a quoted test-name-pattern value on a command proof warns nothing", () => {
  const { path } = writeFixture({
    nodes: [{
      id: "build",
      type: "backend",
      gate: false,
      taskPacket: packet(),
      definitionOfDone: [
        { id: "unit", text: "the suite passes", proof: { kind: "command", ref: 'node --test --test-name-pattern="a b c"' } },
      ],
    }],
  });

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  assert.ok(!warnings.some((line) => line.includes("--test-name-pattern")), `no warning expected: ${JSON.stringify(warnings)}`);
});

// One proof, one source. Measured 2026-09-22: a broken command lived in a
// spec's R3, in its R4 and in seven nodes' verification, and the repair
// reached one copy. Nothing recorded that the others were copies of the same
// claim, so nothing could say they had stopped agreeing.
test("verification commands proving one requirement are warned when they stop agreeing", () => {
  const { path } = writeFixture({
    nodes: [
      {
        id: "alpha",
        type: "backend",
        requirementIds: ["R3"],
        taskPacket: { ...packet(), verification: [{ argv: ["node", "--test", "test/a.test.mjs"], requirementId: "R3" }] },
      },
      {
        id: "beta",
        type: "backend",
        requirementIds: ["R3"],
        taskPacket: { ...packet(), verification: [{ argv: ["node", "--test", "test/repaired.test.mjs"], requirementId: "R3" }] },
      },
    ],
  });

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  const divergence = warnings.filter((line) => line.includes("no longer agree"));
  assert.equal(divergence.length, 1, JSON.stringify(warnings));
  assert.match(divergence[0], /requirementId "R3"/u);
  assert.match(divergence[0], /test\/a\.test\.mjs/u);
  assert.match(divergence[0], /test\/repaired\.test\.mjs/u);
});

test("the same command claimed by two nodes for one requirement warns nothing", () => {
  const command = { argv: ["node", "--test", "test/a.test.mjs"], requirementId: "R3" };
  const { path } = writeFixture({
    nodes: [
      { id: "alpha", type: "backend", requirementIds: ["R3"], taskPacket: { ...packet(), verification: [command] } },
      { id: "beta", type: "backend", requirementIds: ["R3"], taskPacket: { ...packet(), verification: [command] } },
    ],
  });

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  assert.ok(!warnings.some((line) => line.includes("no longer agree")), JSON.stringify(warnings));
});

test("a verification command claiming a requirement its node does not carry is warned", () => {
  const { path } = writeFixture({
    nodes: [{
      id: "alpha",
      type: "backend",
      requirementIds: ["R1"],
      taskPacket: { ...packet(), verification: [{ argv: ["node", "--test", "test/a.test.mjs"], requirementId: "R9" }] },
    }],
  });

  const warnings = validateContract(JSON.parse(readFileSync(path, "utf8")), path).warnings;
  const mislabel = warnings.filter((line) => line.includes("does not carry in requirementIds"));
  assert.equal(mislabel.length, 1, JSON.stringify(warnings));
  assert.match(mislabel[0], /declares requirementId "R9"/u);
});

test("requirementId is rejected when it is not a bounded id", () => {
  const { path } = writeFixture({
    nodes: [{
      id: "alpha",
      type: "backend",
      taskPacket: { ...packet(), verification: [{ argv: ["node", "--test", "test/a.test.mjs"], requirementId: 7 }] },
    }],
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(path, "utf8")), path),
    /requirementId must be a requirement id/u,
  );
});

test("a closed discovery prompt asks for output and an empty artifacts list; an open one still asks for the packet", () => {
  const closed = renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (packet({ mode: "discovery", readFiles: ["contract.json"], writeFiles: [], verification: [] })), "plan");
  assert.match(closed, /deliver your result in `output` and send `artifacts` as \[\]/);
  assert.ok(!closed.includes("artifacts[0]"), "a closed discovery prompt never asks for an artifact");
  const open = renderWorkerPrompt(/** @type {import("../../src/contract/index.mjs").TaskPacket} */ (packet({ mode: "discovery", readFiles: [], writeFiles: [], verification: [] })), "discover");
  assert.match(open, /put exactly one execution task packet JSON string in artifacts\[0\]/);
});

// This crash-recovery test moved here from test/engine/judge.test.mjs when that
// file reached the repository's 800-line ceiling; the same verification command
// runs both files, so the judge re-ask coverage is unchanged.
test("the judge re-ask bound survives a controller crash in either gap because it is persisted with the node", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-"));
  const outDir = mkdtempSync(join(tmpdir(), "runner-judge-reask-durable-out-"));
  const counter = join(outDir, "judge-calls.txt");
  const promptTwo = join(outDir, "judge-prompt-2.txt");
  const runDir = runDirectory(directory, "judge-reask-durable-run");
  // Crash images the controller itself persisted, taken at the two instants a
  // standalone marker left open: the write that dispatches the bounded re-ask,
  // and the moment its verdict is durable while the blocked transition is not.
  // Each excludes what no successor controller inherits: the dead controller's
  // lock, its in-flight atomic temporaries and its file locks.
  const dispatchGap = join(runsRoot(directory), "judge-reask-dispatch-gap");
  const verdictGap = join(runsRoot(directory), "judge-reask-verdict-gap");
  /** @param {string} source @returns {boolean} */
  const inherited = (source) => !source.endsWith(".tmp") && !source.endsWith(".lock") && !source.endsWith("controller.lock");
  const uncited = JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the work is not acceptable", evidence: "inspected the delivered diff" }] });
  const fake = join(directory, "durable-provider.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("durable-provider 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.prompt.startsWith("Review node")) {
    let count = 0;
    try { count = readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
    appendFileSync(${JSON.stringify(counter)}, "x\\n");
    writeFileSync(count === 0 ? ${JSON.stringify(join(outDir, "judge-prompt-1.txt"))} : ${JSON.stringify(promptTwo)}, request.prompt);
    // The re-ask is in flight and its verdict is not written yet: this is the
    // image a controller loss leaves behind between dispatch and verdict.
    if (count === 1) cpSync(${JSON.stringify(runDir)}, ${JSON.stringify(dispatchGap)}, { recursive: true, filter: ${inherited.toString()} });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "judge" }));
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result: ${JSON.stringify(uncited)}, continuationId: "judge", usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0 } }));
    return;
  }
  const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.started", continuationId: "worker" }));
  console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "worker", usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 } }));
});
`);
  chmodSync(fake, 0o755);
  const path = helpers.writeContract(directory, helpers.fixture({
    id: "judge-reask-durable-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl-judge" },
    runtimes: {
      jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: fake },
      "jsonl-judge": { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-judge", executable: fake },
    },
    nodes: [{
      id: "build",
      type: "backend",
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      taskPacket: helpers.packet(),
      gate: { review: "blocking", failOn: ["major", "critical"] },
    }],
  }));
  // Crash the controller between the two writes: the verdict and the spent
  // bound land in the node snapshot first, then the interrupt throws and the
  // blocked transition never runs. The image is the code's own write, so no
  // sampler has to win a race against the transition.
  const previousInterrupt = process.env.FABERUN_JUDGE_REASK_INTERRUPT;
  process.env.FABERUN_JUDGE_REASK_INTERRUPT = "after-verdict";
  try {
    await assert.rejects(() => runContract(path), /judge re-ask interrupted after verdict persistence/u);
  } finally {
    if (previousInterrupt === undefined) delete process.env.FABERUN_JUDGE_REASK_INTERRUPT;
    else process.env.FABERUN_JUDGE_REASK_INTERRUPT = previousInterrupt;
  }
  cpSync(runDir, verdictGap, { recursive: true, filter: inherited });
  assert.equal(existsSync(join(runDir, "judge-reask")), false, "the bound is node state, not a standalone marker beside it");
  assert.match(readFileSync(promptTwo, "utf8"), /Your previous fail verdict cited no Definition of Done item id/u);

  // Gap one: the write that spends the bound is the write that dispatches the
  // re-ask, so no crash image can hold one without the other.
  const dispatched = JSON.parse(readFileSync(join(dispatchGap, "nodes", "build.json"), "utf8"));
  assert.ok(
    /** @type {Record<string, unknown>[]} */ (dispatched.executionOverrides).some((item) => item.kind === "judge-reask"),
    "the crash image carries the bound in the node snapshot",
  );
  assert.equal(
    /** @type {Record<string, unknown>[]} */ (dispatched.invocations).filter((item) => item.phase === "judge").length,
    2,
    "the same atomic write carries the re-ask that bound permits",
  );
  const afterDispatch = nodeState(await resumeRun(dispatchGap));
  assert.equal(afterDispatch.status, "blocked", afterDispatch.error?.message);
  assert.equal(afterDispatch.phase, "judge");
  assert.equal(afterDispatch.error?.code, "judge_protocol", "the replayed re-ask blocks instead of asking a second one");
  assert.equal(afterDispatch.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal(afterDispatch.attempt, 1, "the recovered re-ask does not burn a worker attempt");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "worker").length, 1, "the worker is never re-run");
  assert.equal((afterDispatch.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 3, "recovery replays the interrupted re-ask exactly once");

  // Gap two: the re-ask verdict and the spent bound are durable and the blocked
  // transition is not, so recovery reads them from the node and blocks rather
  // than treating the second uncited verdict as a first failure.
  const persistedVerdict = JSON.parse(readFileSync(join(verdictGap, "nodes", "build.json"), "utf8"));
  assert.equal(persistedVerdict.status, "running", "the crash image halted before the blocked transition");
  assert.ok(
    /** @type {Record<string, unknown>[]} */ (persistedVerdict.executionOverrides).some((item) => item.kind === "judge-reask"),
    "the durable record carries the spent bound",
  );
  const persistedJudges = /** @type {Record<string, unknown>[]} */ (persistedVerdict.invocations).filter((item) => item.phase === "judge");
  assert.equal(persistedJudges.length, 2, "the durable record carries the completed re-ask whose bound permits no third ask");
  assert.equal(persistedJudges.at(-1)?.status, "closed");
  const afterVerdict = nodeState(await resumeRun(verdictGap));
  assert.equal(afterVerdict.status, "blocked", afterVerdict.error?.message);
  assert.equal(afterVerdict.phase, "judge");
  assert.equal(afterVerdict.error?.code, "judge_protocol", "the recovered second uncited verdict is not a first failure");
  assert.equal(afterVerdict.revisions, 0, "an uncited rejection never consumes a revision");
  assert.equal((afterVerdict.invocations ?? []).filter((invocation) => invocation.phase === "judge").length, 2, "the recovered verdict settles the node without another judge invocation");
  assert.ok(notifications(verdictGap).some((event) => event.type === "attention" && event.errorCode === "judge_protocol"));
});
