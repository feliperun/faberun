import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../helpers.mjs";
import { bootstrapAttemptPath, bootstrapPath } from "../../src/run/store.mjs";
import { runDirectory } from "../../src/run/paths.mjs";
import { waitForBootstrap, writeBootstrapFailure } from "../../src/cli/launch.mjs";

const NONCE = "11111111-1111-4111-8111-111111111111";
const CONTROLLER_ERROR = "runtime assignment refused: no judge satisfies same-vendor independence";

test("a refused detached launch prints the controller error and leaves no run directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "detach-refusal-"));
  const contractPath = join(directory, "contract.json");
  writeFileSync(contractPath, `${JSON.stringify(fixture({ id: "refused-detach", cwd: directory }), null, 2)}\n`);
  const runDir = runDirectory(directory, "refused-detach");
  // The run directory a launch refused in the runtime-assignment window leaves
  // behind: its frozen contract and an empty nodes folder, never a node.
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), "{}\n");

  const previousNonce = process.env.FABERUN_BOOTSTRAP_NONCE;
  process.env.FABERUN_BOOTSTRAP_NONCE = NONCE;
  try {
    writeBootstrapFailure("run", contractPath, new Error(CONTROLLER_ERROR));
  } finally {
    if (previousNonce === undefined) delete process.env.FABERUN_BOOTSTRAP_NONCE;
    else process.env.FABERUN_BOOTSTRAP_NONCE = previousNonce;
  }

  // The detached child recorded why it died even though contract.json already
  // existed; without that record the launcher can only say readiness failed.
  const attempt = JSON.parse(readFileSync(bootstrapAttemptPath(runDir, NONCE), "utf8"));
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, /runtime assignment refused/u);
  assert.match(JSON.parse(readFileSync(bootstrapPath(runDir), "utf8")).error, /runtime assignment refused/u);

  const child = {
    pid: process.pid,
    bootstrapNonce: NONCE,
    bootstrapProcessStartToken: null,
    exitCode: 1,
    signalCode: null,
    once() {},
  };
  await assert.rejects(
    waitForBootstrap(runDir, process.pid, /** @type {any} */ (child), 1_000),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /detached bootstrap failed/u);
      assert.match(message, /runtime assignment refused/u, "the launcher prints the controller's own error");
      return true;
    },
  );
  assert.equal(existsSync(runDir), false, "a run directory that never held a node is removed");
});
