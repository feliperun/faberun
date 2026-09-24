import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateContract } from "../../src/contract/index.mjs";
import { packet, writeFixture } from "./helpers.mjs";

test("a judgment item without a reason is a finding", () => {
  const missing = writeFixture({
    nodes: [{
      id: "review",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [
        { id: "mechanical", text: "The command passes", proof: { kind: "command", ref: "true" } },
        { id: "judgment", text: "The result is useful", judgment: true },
      ],
      gate: false,
    }],
  });
  const authored = validateContract(JSON.parse(readFileSync(missing.path, "utf8")), missing.path);
  assert.ok(authored.warnings.some((warning) => warning.includes("judgment_without_reason")));
  assert.ok(authored.warnings.some((warning) => warning.includes("judgment_beside_mechanical_proof")));

  const strict = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../../src/cli.mjs", import.meta.url)), "contract", "validate", missing.path, "--strict-traceability"],
    { encoding: "utf8" },
  );
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /^invalid \(\d+ warnings?\)/u);
  assert.match(strict.stdout, /judgment_without_reason/u);
  assert.match(strict.stdout, /judgment_beside_mechanical_proof/u);

  const reasoned = writeFixture({
    nodes: [{
      id: "review",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [
        { id: "mechanical", text: "The command passes", proof: { kind: "command", ref: "true" } },
        { id: "judgment", text: "The result is useful", judgment: true, reason: "Usefulness requires human judgment beyond command output." },
      ],
      gate: false,
    }],
  });
  const persisted = validateContract(
    JSON.parse(readFileSync(reasoned.path, "utf8")),
    reasoned.path,
    { persisted: true },
  );
  assert.equal(persisted.nodes[0].definitionOfDone[1].reason, "Usefulness requires human judgment beyond command output.");
  assert.equal(persisted.warnings.some((warning) => warning.includes("judgment_without_reason")), false);
  assert.equal(persisted.warnings.some((warning) => warning.includes("judgment_beside_mechanical_proof")), false);
});
