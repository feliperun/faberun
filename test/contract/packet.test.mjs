import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateContract,
} from "../../src/contract/index.mjs";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import { validateWorkerResult } from "../../src/contract/worker-result.mjs";
import { judgePrompt } from "../../src/engine/prompts.mjs";
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
