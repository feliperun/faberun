import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../protocol.mjs";
import { normalizeRunnerTranscript, runnerEnvironmentOverlay, withSchema } from "../runner-transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The harness has no one-shot surface that reports what a turn cost, so the
 * adapter's real provider is this client: it speaks the `sdk` JSON-RPC profile
 * and folds the session firehose into the envelope. The `dsh` binary named by
 * `executable()` is the harness the client drives, and probing it is what
 * preflight means by "the provider binary exists".
 */
const RUNNER = join(HERE, "runner.mjs");

/**
 * Every runtime gets the closed-packet profile: the shipped harness advertises
 * twenty-five tools and describes goals, subagents, and skills it was never
 * asked to use. Measured on the same closed packet, that preamble costs
 * 60,994 prompt tokens against 11,959 with this patch — the overhead is
 * re-sent on every step, so it is paid once per model call, not once per node.
 * `agent-instructions` is off for the same reason the packet is closed: the
 * worker's instructions come from its packet, not from whatever `AGENTS.md`
 * sits above the worktree.
 */
const CLOSED_PACKET_PATCH = join(HERE, "closed-packet.patch.yml");

/**
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const dshHarness = {
  capabilities: {
    // The schema rides in the prompt and the verdict is extracted from the
    // final message, exactly as `agy` does; nothing in the wire enforces it.
    structuredOutput: true,
    promptTransport: "stdin",
    // `runtime.sandbox` maps onto DSH_PERMISSION_MODE, which is the harness's
    // own file-effect boundary and its approval policy in one value.
    sandbox: true,
    permissions: false,
    // `sdk` and `headless` are create-only: `session/resume` exists on the ACP
    // profile alone, and reusing a persisted session id is refused outright.
    continuation: false,
    tokenBudget: false,
    costBudget: false,
    usage: true,
    cost: false,
    toolPolicy: false,
    // Measured 2026-09-10: runner.mjs writeSync's each dsh.message as the
    // session emits it, not just at the end. A three-tool-call turn against
    // deepseek-official/deepseek-flash grew the redirected stdout file from
    // 67 to 1,380 to 1,441 to 2,084 bytes across a 14s turn.
    streamsOutput: true,
    // Measured 2026-09-16 in the controller's workspace-write sandbox: a test
    // that starts and terminates a child process cannot signal it or read the
    // process table, so it hangs until the executor's cap. `danger-full-access`
    // was not measured.
    signalsProcesses: false,
  },

  // sandbox maps to DSH_PERMISSION_MODE, which is the harness's file-effect
  // boundary and its approval policy in one value. Both modes execute, so both
  // are declared: measured 2026-09-11, a worker left at the harness default
  // `workspace-write` ran `printf ... > exec-probe.txt` through the shell (the
  // packet forbade the write tool) and the file reached the integrated commit.
  // What that default cannot do is reach outside the worktree -- something a
  // detached run cannot answer an approval prompt for, and the reason
  // `danger-full-access` is the mode for a packet with effects beyond it.
  permissionExecution: { field: "sandbox", executingModes: ["workspace-write", "danger-full-access"], defaultMode: "workspace-write" },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.FABERUN_DSH_BIN ?? runtime.executable ?? "dsh";
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /**
   * @param {import("../index.mjs").HarnessRuntime} runtime
   * @param {string} prompt
   * @param {import("../index.mjs").CommandOptions} options
   * @returns {import("../index.mjs").HarnessCommand}
   */
  command(runtime, prompt, options = {}) {
    const args = [
      RUNNER,
      "--dsh", this.executable(runtime),
      "--provider", /** @type {string} */ (runtime.config?.provider),
      "--model", runtime.model,
    ];
    if (runtime.reasoning) args.push("--reasoning", runtime.reasoning);
    if (runtime.sandbox) args.push("--sandbox", runtime.sandbox);
    args.push("--patch", CLOSED_PACKET_PATCH);
    const extraPatch = runtime.config?.patch;
    if (typeof extraPatch === "string" && extraPatch.length) args.push("--patch", extraPatch);
    return {
      executable: process.execPath,
      args,
      promptTransport: "stdin",
      input: withSchema(prompt, options.schema),
      env: runnerEnvironmentOverlay(process.env),
    };
  },

  /**
   * @param {string} stdout
   * @param {number|null} exitCode
   * @param {string|null} signal
   * @param {import("../index.mjs").NormalizeOptions} [options]
   * @returns {import("../index.mjs").ProviderEnvelope}
   */
  normalize(stdout, exitCode, signal, options = {}) {
    return normalizeRunnerTranscript("dsh", stdout, exitCode, signal, options);
  },
};

export const harness = dshHarness;
export default dshHarness;
