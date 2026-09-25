import { normalizeClaudeResult, parseVersion } from "../protocol.mjs";
import { hookSettings } from "../../host/tool-policy-hook.mjs";

/** Built-in tools a closed-packet worker needs; every other tool is preamble. */
export const DEFAULT_CLAUDE_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

/**
 * Bound the harness preamble of a Claude-compatible CLI: no skills, no MCP
 * servers, no settings files (an explicit `--settings` still applies, so hook
 * enforcement survives) and only the declared built-in tools. Measured on
 * 2026-09-01 against this CLI: 65,170 uncached input tokens per trivial call
 * with the ambient configuration, about 4,300 per turn with these flags.
 * `--bare` would cut further but disables hooks, so it is never used.
 *
 * @param {import("../index.mjs").HarnessRuntime} runtime
 * @returns {string[]}
 */
function claudePreambleArgs(runtime) {
  return [
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    (runtime.tools ?? DEFAULT_CLAUDE_TOOLS).join(","),
  ];
}

/**
 * The environment one runtime's CLI runs under when its contract points it at
 * an Anthropic-compatible endpoint other than Anthropic's own, e.g. GLM on
 * the Z.ai Coding Plan, where Claude Code is one of the supported tools:
 *
 *   "config": { "base_url": "https://api.z.ai/api/anthropic",
 *               "auth_token.env_key": "ZAI_API_KEY" }
 *
 * The overlay travels in the invocation's own command, so it reaches only
 * this runtime's process: a controller that also runs a Claude judge on
 * Anthropic keeps that judge on Anthropic. The token is read from the named
 * variable at invocation time; its value never appears in the contract.
 *
 * A declared endpoint with no resolvable token is refused rather than run:
 * the CLI would fall back to the operator's own Anthropic login and send that
 * credential to the declared host. Measured 2026-09-25 on the tiny-text
 * campaign: two parallel GLM 5.3 judges through this CLI peaked at 599 MB,
 * where the same judges on zcode had peaked at about 1.5 GB together with
 * the test processes.
 *
 * @param {import("../index.mjs").HarnessRuntime} runtime
 * @returns {Record<string, string|null>|undefined}
 */
function endpointEnv(runtime) {
  const baseUrl = declaredBaseUrl(runtime);
  const declared = runtime.config?.["auth_token.env_key"];
  const tokenVar = typeof declared === "string" && declared ? declared : null;
  if (baseUrl === null && tokenVar === null) return undefined;
  const token = tokenVar === null ? undefined : process.env[tokenVar];
  if (typeof token !== "string" || !token) {
    const error = /** @type {Error & {code: string}} */ (new Error(tokenVar === null
      ? `claude runtime declares base_url ${baseUrl} without auth_token.env_key`
      : `claude runtime declares auth_token.env_key ${tokenVar}, which is unset`));
    error.code = "auth_token_unresolved";
    throw error;
  }
  /** @type {Record<string, string|null>} */
  const env = {
    ANTHROPIC_AUTH_TOKEN: token,
    // An ambient Anthropic key outranks the bearer token in the CLI.
    ANTHROPIC_API_KEY: null,
  };
  if (baseUrl !== null) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    // The CLI sends its own background requests (titles, summaries) to the
    // alias models; another endpoint does not serve those names, so every
    // alias resolves to the runtime's model.
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = runtime.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = runtime.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = runtime.model;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  return env;
}

/**
 * @param {{config?: Record<string, unknown>}} runtime
 * @returns {string|null}
 */
function declaredBaseUrl(runtime) {
  const value = runtime.config?.base_url;
  return typeof value === "string" && value ? value : null;
}

/**
 * @type {import("../index.mjs").HarnessAdapter}
 */
export const claudeHarness = {
  capabilities: {
    structuredOutput: true,
    promptTransport: "stdin",
    sandbox: false,
    permissions: true,
    continuation: true,
    tokenBudget: false,
    costBudget: true,
    usage: true,
    cost: true,
    // The Claude-compatible hook surface enforces the tool policy mechanically.
    toolPolicy: true,
    // `--output-format stream-json --verbose` writes one JSON line per event
    // as the turn runs, not one dump at exit.
    streamsOutput: true,
    // Measured 2026-09-16: `bypassPermissions` runs an unsandboxed Bash that
    // signals child processes and reads the process table; headless
    // `acceptEdits` cannot run commands at all, so the flag describes the
    // executing mode.
    signalsProcesses: true,
  },

  // Headless acceptEdits denies Bash; bypassPermissions executes commands.
  permissionExecution: { field: "permissionMode", executingModes: ["bypassPermissions"], defaultMode: "acceptEdits" },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string} */
  executable(runtime) {
    return process.env.FABERUN_CLAUDE_BIN ?? runtime.executable ?? "claude";
  },

  /** @param {import("../index.mjs").HarnessRuntime} runtime @returns {string[]} */
  versionArgs(runtime) {
    return runtime.versionArgs ?? ["--version"];
  },

  parseVersion,

  /** @param {import("../index.mjs").HarnessRuntime} runtime @param {string} prompt @param {import("../index.mjs").CommandOptions} options @returns {import("../index.mjs").HarnessCommand} */
  command(runtime, prompt, options) {
    const continuationId = options.continuationId ?? null;
    const args = [
      "-p",
      ...(continuationId ? ["--resume", continuationId] : []),
      "--model",
      runtime.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      runtime.permissionMode ?? "acceptEdits",
      ...claudePreambleArgs(runtime),
    ];
    if (options.toolPolicy) args.push("--settings", JSON.stringify(hookSettings(options.toolPolicy)));
    if (runtime.reasoning) args.push("--effort", runtime.reasoning);
    // The attempt's request ceiling, enforced by the CLI itself; the
    // controller's monitor enforces the same number for every streaming
    // harness, so this only makes the stop cleaner (a result event instead of
    // a kill) for the one harness that can take it as a flag.
    if (typeof options.maxTurns === "number") args.push("--max-turns", String(options.maxTurns));
    if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
    const env = endpointEnv(runtime);
    return { executable: this.executable(runtime), args, promptTransport: "stdin", input: prompt, ...(env ? { env } : {}) };
  },

  /**
   * The CLI's `total_cost_usd` applies Anthropic's rates to whatever model
   * answered, so on another endpoint it is not what the turn cost: measured
   * 2026-09-25, a GLM 5.3 review on the Z.ai Coding Plan reported $0.13.
   * Such a runtime is priced like any harness that reports no cost.
   *
   * @param {{harness: string, config?: Record<string, unknown>}} runtime
   * @returns {boolean}
   */
  reportsCost(runtime) {
    return declaredBaseUrl(runtime) === null;
  },

  normalize: normalizeClaudeResult,
};

export const harness = claudeHarness;
export default claudeHarness;
