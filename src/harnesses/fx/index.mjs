/**
 * The fx harness adapter: capabilities, the command that starts Faberun's own
 * fx client (`runner.mjs`), and the envelope folded from its transcript. The
 * client, not the `fx` binary, is what the gate spawns.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../protocol.mjs";
import { normalizeRunnerTranscript, runnerEnvironmentOverlay, withSchema } from "../runner-transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * fx has no one-shot surface that streams a turn or reports its cache split,
 * so the adapter's real provider is this client: it speaks `fx acp`, answers
 * fx's permission requests, and relays the provider traffic through a
 * loopback meter. The `fx` binary named by `executable()` is the harness the
 * client drives, and probing it is what preflight means by "the provider
 * binary exists".
 */
const RUNNER = join(HERE, "runner.mjs");

/**
 * The same client in Zig (`native/`), built by `zig build` in that directory.
 * Measured 2026-09-24 over three parseDuration turns: 15-16 MB resident
 * against 83 MB for `runner.mjs`, with the same transcript. Until a release
 * ships the binary, a checkout that has not built it runs `runner.mjs`.
 */
const NATIVE_RUNNER = join(HERE, "native", "zig-out", "bin", process.platform === "win32" ? "faberun-fx-runner.exe" : "faberun-fx-runner");

/**
 * Measured 2026-09-24 on the parseDuration fixture on one macOS machine: this
 * runner peaked at 83 MB resident and `fx acp` at 9 MB, against 310-370 MB for
 * `dsh --profile headless` alone, with the same model and a passing suite. The
 * harness exists for parallel campaigns on DeepSeek, where that difference is
 * the worker count a machine can hold.
 *
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const fxHarness = {
  capabilities: {
    // The schema rides in the prompt and the verdict is extracted from the
    // final message, as dsh does; nothing in the wire enforces it.
    structuredOutput: true,
    promptTransport: "stdin",
    // `runtime.sandbox` is decided per ACP permission request by
    // `permissions.mjs`: file mutations by path, shell commands allowed.
    sandbox: true,
    permissions: false,
    // `fx acp` can resume a session, but the runner builds a throwaway HOME
    // per turn and fx stores sessions there; no id outlives the turn.
    continuation: false,
    tokenBudget: false,
    costBudget: false,
    usage: true,
    cost: false,
    toolPolicy: false,
    // Measured 2026-09-24: one parseDuration turn streamed 7 `tool_call`
    // updates as they happened; the runner forwards each as `fx.tool`.
    streamsOutput: true,
    // Not measured for fx.
    signalsProcesses: null,
  },

  permissionExecution: {
    field: "sandbox",
    executingModes: ["read-only", "workspace-write", "danger-full-access"],
    defaultMode: "workspace-write",
    readOnlyModes: ["read-only"],
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.FABERUN_FX_BIN ?? runtime.executable ?? "fx";
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
    const args = ["--fx", this.executable(runtime), "--model", runtime.model];
    if (runtime.sandbox) args.push("--sandbox", runtime.sandbox);
    const config = runtime.config ?? {};
    if (config.provider === "codex") args.push("--provider", "codex");
    if (typeof config.base_url === "string" && config.base_url) args.push("--base-url", config.base_url);
    if (typeof config["api_key.env_key"] === "string" && config["api_key.env_key"]) args.push("--key-env", config["api_key.env_key"]);
    if (typeof config.context_window === "number") args.push("--context-window", String(config.context_window));
    if (typeof config.max_output_tokens === "number") args.push("--max-output-tokens", String(config.max_output_tokens));
    const native = existsSync(NATIVE_RUNNER);
    return {
      executable: native ? NATIVE_RUNNER : process.execPath,
      args: native ? args : [RUNNER, ...args],
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
    return normalizeRunnerTranscript("fx", stdout, exitCode, signal, options);
  },
};

export const harness = fxHarness;
export default fxHarness;
