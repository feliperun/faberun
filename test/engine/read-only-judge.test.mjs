import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { readWorkerResultFile } from "../../src/engine/result-file.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

/**
 * A codex stand-in whose sandbox refuses every write, exactly as the
 * Campaign Brief reviewer's did (`patch rejected: writing is blocked by
 * read-only sandbox`). It recognises three prompts by their text alone: the
 * liveness hello, a judge's `Review node`, and a worker told its final
 * message is the result. The reviewer, named by its objective, gets the
 * refusal and no result when told to write the file, which is what stalled
 * that reviewer for 300s; the writable worker follows the file protocol.
 *
 * @param {string} directory
 * @returns {string}
 */
function readOnlyCodex(directory) {
  const path = join(directory, "read-only-codex.mjs");
  writeFileSync(path, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("read-only-codex 1.0.0"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = input || process.argv.at(-1) || "";
  const say = (text) => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "read-only-thread" }));
  if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
    say(JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] }));
  } else if (prompt.startsWith("Review node")) {
    say(JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "read-only review", findings: [] }));
  } else if (prompt.includes("your final response is the result")) {
    say(JSON.stringify({ status: "done", summary: "reviewed", verification: [], artifacts: [], missingContext: [], output: { findings: [] } }));
  } else if (prompt.includes("sol-ro-reviewer")) {
    say("patch rejected: writing is blocked by read-only sandbox");
  } else {
    const result = JSON.stringify({ status: "done", summary: "built", verification: [], artifacts: [], missingContext: [] });
    const canonical = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1];
    if (canonical) writeFileSync(canonical, result);
    say(result);
  }
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 0 } }));
});
`);
  chmodSync(path, 0o755);
  return path;
}

// RM-058, measured on the Campaign Brief run: the codex-sol reviewer under
// `sandbox: read-only` had its result-file write rejected and stalled, and
// the campaign granted it workspace-write to get a verdict at all.
test("a read-only judge's verdict reaches the gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "read-only-judge-"));
  const runtimes = {
    luna: { harness: "codex", model: "gpt-5.6-luna" },
    sol: { harness: "codex", model: "gpt-5.6-sol", vendor: "openai-sol", sandbox: "read-only" },
  };
  const path = writeContract(directory, fixture({
    id: "read-only-judge-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes,
    nodes: [
      { id: "review", type: "backend", runtime: "sol", taskPacket: packet({ mode: "discovery", objective: "sol-ro-reviewer: review the plan", readFiles: ["README.md"], writeFiles: [] }), gate: false },
      {
        id: "build",
        type: "backend",
        taskPacket: packet(),
        definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
        gate: { review: "blocking", failOn: ["major", "critical"] },
      },
    ],
  }));
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = readOnlyCodex(directory);
  try {
    const result = await runContract(path);
    const review = nodeState(result, "review");
    assert.equal(review.status, "done", `a read-only reviewer delivers its result: ${review.error?.message ?? ""}`);
    assert.deepEqual(readWorkerResultFile(result.runDir, "review")?.output, { findings: [] }, "the controller persisted what the final message carried");
    const build = nodeState(result, "build");
    assert.equal(build.status, "done", build.error?.message);
    assert.equal(build.gate?.verdict, "pass", "the read-only judge's verdict reached the gate");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }

  const writing = fixture({ id: "writing-judge", runtimeDefaults: { worker: "luna", judge: "sol" }, runtimes: { ...runtimes, sol: { ...runtimes.sol, sandbox: "workspace-write" } } });
  const writingPath = writeContract(mkdtempSync(join(tmpdir(), "writing-judge-")), writing);
  const warnings = validateContract(JSON.parse(readFileSync(writingPath, "utf8")), writingPath).warnings;
  assert.ok(warnings.some((warning) => /judge runtime sol declares sandbox workspace-write/u.test(warning)), warnings.join("\n"));
});
