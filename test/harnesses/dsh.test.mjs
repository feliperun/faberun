import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateContract } from "../../src/contract/index.mjs";
import { dshHarness } from "../../src/harnesses/dsh/index.mjs";
import { normalizeProviderAvailability, normalizeProviderResult, probeRuntime, providerCommand } from "../../src/harnesses/index.mjs";
import { liveSessionMetrics } from "../../src/harnesses/session-metrics.mjs";
import { closeResult, fakeDsh, fixture, withFakeDsh, writeContract } from "../helpers.mjs";
import { spawnInvocation } from "../../src/host/platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCH = join(HERE, "..", "..", "src", "harnesses", "dsh", "closed-packet.patch.yml");
const RUNNER = join(HERE, "..", "..", "src", "harnesses", "dsh", "runner.mjs");

/** @param {Record<string, unknown>} [patch] */
function runtime(patch = {}) {
  return {
    id: "dsh",
    harness: "dsh",
    model: "deepseek-flash",
    executable: "dsh",
    vendor: "deepseek",
    config: { provider: "deepseek-official" },
    ...patch,
  };
}

/** @param {string} prefix */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("the dsh adapter probes the harness binary the contract names", () => {
  assert.equal(dshHarness.executable(runtime()), "dsh");
  assert.equal(dshHarness.executable(runtime({ executable: "/opt/dsh" })), "/opt/dsh");
  const previous = process.env.FABERUN_DSH_BIN;
  process.env.FABERUN_DSH_BIN = "/env/dsh";
  try {
    assert.equal(dshHarness.executable(runtime()), "/env/dsh");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_DSH_BIN;
    else process.env.FABERUN_DSH_BIN = previous;
  }
  assert.deepEqual(dshHarness.versionArgs(runtime()), ["--version"]);
  assert.equal(dshHarness.parseVersion("dsh 0.1.5-rc.1\n"), "dsh 0.1.5-rc.1");
  assert.equal(dshHarness.parseVersion('{"version":"0.1.5"}'), null);
});

test("the dsh command runs the JSON-RPC client under this node, never the harness directly", () => {
  const command = providerCommand(runtime({ reasoning: "max", sandbox: "danger-full-access" }), "hello", {});
  assert.equal(command.executable, process.execPath);
  assert.equal(command.promptTransport, "stdin");
  assert.equal(command.input, "hello");
  assert.deepEqual(command.args.slice(0, 7), [
    join(HERE, "..", "..", "src", "harnesses", "dsh", "runner.mjs"),
    "--dsh", "dsh",
    "--provider", "deepseek-official",
    "--model", "deepseek-flash",
  ]);
  assert.deepEqual(command.args.slice(7), ["--reasoning", "max", "--sandbox", "danger-full-access", "--patch", PATCH]);
  assert.ok(existsSync(command.args[0]), "the client ships beside the adapter");
  assert.ok(existsSync(PATCH), "the closed-packet profile ships beside the adapter");
});

test("a runtime without a sandbox leaves the harness boundary at its own default", () => {
  const command = providerCommand(runtime(), "hello", {});
  assert.deepEqual(command.args.slice(7), ["--patch", PATCH]);
});

test("an extra patch layer stacks after the closed-packet profile", () => {
  const command = providerCommand(runtime({ config: { provider: "deepseek-official", patch: "/tmp/extra.yml" } }), "hello", {});
  assert.deepEqual(command.args.slice(-4), ["--patch", PATCH, "--patch", "/tmp/extra.yml"]);
});

test("a judge prompt carries the output schema the harness cannot take as a flag", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } } };
  const command = providerCommand(runtime(), "review this", { schema });
  const input = String(command.input);
  assert.ok(input.startsWith("review this\n\nOutput schema"));
  assert.ok(input.includes(JSON.stringify(schema)));
  assert.equal(providerCommand(runtime(), "review this", {}).input, "review this");
});

const GIT_CONFIG_FAMILY = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u;

/**
 * Run `body` with the broken `GIT_CONFIG_*` family and a sentinel set in the
 * ambient environment, restoring both afterward.
 *
 * @template T
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function withBrokenGitEnvironment(body) {
  const broken = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "worker",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "worker@example.test",
  };
  const sentinel = "FABERUN_TEST_DSH_ENV_SENTINEL";
  const previous = new Map();
  for (const [key, value] of Object.entries(broken)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  previous.set(sentinel, process.env[sentinel]);
  process.env[sentinel] = "kept";
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the dsh command removes the broken GIT_CONFIG family and sets GIT_TERMINAL_PROMPT", async () => {
  await withBrokenGitEnvironment(() => {
    const command = providerCommand(runtime(), "hello", {});
    assert.equal(command.env?.GIT_TERMINAL_PROMPT, "0");
    for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
      assert.ok(command.env && Object.hasOwn(command.env, key) && command.env[key] === null, `${key} must be removed`);
    }
    assert.equal(Object.hasOwn(command.env ?? {}, "PATH"), false, "the overlay carries only the variables it changes");
  });
});

test("a fake dsh harness sees the stripped family, GIT_TERMINAL_PROMPT, and every other variable", async () => {
  const directory = scratch("dsh-env-dump-");
  const dump = join(directory, "env.json");
  const fixturePath = join(directory, "fake-dsh-env.mjs");
  writeFileSync(fixturePath, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
`);
  chmodSync(fixturePath, 0o755);
  const previousBin = process.env.FABERUN_DSH_BIN;
  process.env.FABERUN_DSH_BIN = fixturePath;
  try {
    await withBrokenGitEnvironment(async () => {
      const command = providerCommand(runtime(), "hello", {});
      /** @type {Record<string, string|undefined>} */
      const env = { ...process.env };
      for (const [key, value] of Object.entries(command.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      const child = spawn(process.execPath, [fixturePath], { cwd: directory, env, stdio: ["ignore", "ignore", "ignore"] });
      await closeResult(child);
      const dumped = JSON.parse(readFileSync(dump, "utf8"));
      assert.equal(dumped.GIT_CONFIG_COUNT, undefined);
      assert.equal(dumped.GIT_CONFIG_KEY_0, undefined);
      assert.equal(dumped.GIT_CONFIG_VALUE_0, undefined);
      assert.equal(dumped.GIT_TERMINAL_PROMPT, "0");
      for (const [key, value] of Object.entries(process.env)) {
        if (key === "GIT_TERMINAL_PROMPT" || key === "GIT_CONFIG_COUNT" || GIT_CONFIG_FAMILY.test(key)) continue;
        assert.equal(dumped[key], value, `${key} must survive the overlay`);
      }
    });
  } finally {
    if (previousBin === undefined) delete process.env.FABERUN_DSH_BIN;
    else process.env.FABERUN_DSH_BIN = previousBin;
  }
});

test("a completed turn reports the final message and the token split the harness streamed", () => {
  const stdout = [
    JSON.stringify({ type: "dsh.started", sessionId: "s" }),
    JSON.stringify({ type: "dsh.message", text: "thinking" }),
    JSON.stringify({ type: "dsh.message", text: '{"status":"done"}' }),
    JSON.stringify({ type: "dsh.completed", sessionId: "s", result: '{"status":"done"}', usage: { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 800 } }),
  ].join("\n");
  const envelope = normalizeProviderResult(runtime(), stdout, 0, null, {});
  assert.equal(envelope.status, "done");
  assert.equal(envelope.result, '{"status":"done"}');
  assert.equal(envelope.continuationId, null);
  assert.deepEqual(envelope.usage, { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 800 });
  assert.equal(envelope.costUsd, null);
  assert.equal(envelope.error, null);
});

test("dsh assumes harness inputTokens excludes cache reads when canonicalizing usage", () => {
  const stdout = JSON.stringify({
    type: "dsh.completed",
    sessionId: "s",
    result: "done",
    usage: { inputTokens: 1000, outputTokens: 25, cacheReadInputTokens: 800 },
  });
  assert.deepEqual(normalizeProviderResult(runtime(), stdout, 0, null, {}).usage, {
    inputTokens: 1000,
    outputTokens: 25,
    cacheReadInputTokens: 800,
  });
});

test("a judge round counts every verdict-shaped message, not only the last", () => {
  /** @param {string} name */
  const verdict = (name) => JSON.stringify({ verdict: name, maxSeverity: "none", summary: name, findings: [] });
  const stdout = [
    JSON.stringify({ type: "dsh.message", text: verdict("pass") }),
    JSON.stringify({ type: "dsh.message", text: verdict("fail") }),
    JSON.stringify({ type: "dsh.completed", sessionId: "s", result: verdict("fail"), usage: {} }),
  ].join("\n");
  const envelope = normalizeProviderResult(runtime(), stdout, 0, null, { preferStructured: true });
  assert.equal(envelope.judgeCandidates, 2);
  assert.equal(JSON.parse(/** @type {string} */ (envelope.result)).verdict, "fail");
});

test("a verdict wrapped in prose is extracted for a judge and left alone for a worker", () => {
  const prose = 'Here is my review.\n```json\n{"verdict":"pass","maxSeverity":"none","summary":"ok","findings":[]}\n```';
  const stdout = JSON.stringify({ type: "dsh.completed", sessionId: "s", result: prose, usage: {} });
  assert.equal(JSON.parse(/** @type {string} */ (normalizeProviderResult(runtime(), stdout, 0, null, { preferStructured: true }).result)).verdict, "pass");
  assert.equal(normalizeProviderResult(runtime(), stdout, 0, null, {}).result, prose);
});

test("a generic 429 stop is exhaustion with the reset instant the failover wait needs", () => {
  const stdout = JSON.stringify({
    type: "dsh.failed",
    sessionId: "s",
    kind: "error",
    error: { code: "provider_error", message: "429 Too Many Requests", retryAfterMs: 60000 },
    usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 },
  });
  const before = Date.now();
  const envelope = normalizeProviderResult(runtime(), stdout, 1, null, {});
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.error?.code, "provider_error");
  assert.deepEqual(envelope.usage, { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 });
  const resetAt = Date.parse(/** @type {string} */ (envelope.exhaustedUntil));
  assert.ok(resetAt >= before + 59000 && resetAt <= Date.now() + 61000, `unexpected reset instant ${envelope.exhaustedUntil}`);
  assert.equal(envelope.error?.resetAt, envelope.exhaustedUntil);
  assert.equal(normalizeProviderAvailability(runtime(), envelope).exhaustedUntil, envelope.exhaustedUntil);
});

test("a stop with no reset hint still exhausts without inventing an instant", () => {
  const envelope = normalizeProviderResult(runtime(), JSON.stringify({ type: "dsh.failed", kind: "error", error: { code: "RATE_LIMIT", message: "rate limit" }, usage: {} }), 1, null, {});
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.exhaustedUntil, undefined);
  assert.equal(envelope.error?.resetAt, undefined);
});

test("an aborted turn is canceled and a blocked turn is blocked, not failed", () => {
  const aborted = normalizeProviderResult(runtime(), JSON.stringify({ type: "dsh.failed", kind: "aborted", error: { code: "aborted", message: "the turn was aborted" }, usage: {} }), 1, null, {});
  assert.equal(aborted.status, "canceled");
  const blocked = normalizeProviderResult(runtime(), JSON.stringify({ type: "dsh.failed", kind: "blocked", error: { code: "blocked", message: "the sandbox denied the write" }, usage: {} }), 1, null, {});
  assert.equal(blocked.status, "blocked");
});

test("a missing terminal event and a killed provider are reported as such", () => {
  const incomplete = normalizeProviderResult(runtime(), JSON.stringify({ type: "dsh.started", sessionId: "s" }), 1, null, { stderr: "harness exploded" });
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.error?.code, "incomplete_stream");
  assert.ok(incomplete.error?.message.includes("harness exploded"));
  assert.equal(normalizeProviderResult(runtime(), "", null, "SIGKILL", {}).status, "canceled");
  // Transcript purity is the harness contract: prose after a real event is a
  // defect, while a lone unparseable first line is a bounded tail and is
  // skipped, leaving no terminal event to report.
  assert.equal(normalizeProviderResult(runtime(), '{"type":"dsh.started"}\nnot json\n', 0, null, {}).error?.code, "invalid_protocol");
  assert.equal(normalizeProviderResult(runtime(), "not json\n", 0, null, {}).error?.code, "incomplete_stream");
});

test("a dsh runtime without a provider route is rejected before anything runs", () => {
  const directory = scratch("runner-dsh-contract-");
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  runtimes.solo = { harness: "dsh", model: "deepseek-flash", executable: "dsh", vendor: "deepseek", config: {} };
  value.runtimeDefaults = { worker: "solo" };
  const path = writeContract(directory, value);
  assert.throws(() => validateContract(JSON.parse(readFileSync(path, "utf8")), path), /config\.provider must be a non-empty string/u);
});

test("a dsh runtime with a provider route and an explicit vendor validates and routes", () => {
  const directory = scratch("runner-dsh-contract-");
  const value = fixture();
  /** @type {Record<string, Record<string, unknown>>} */
  const runtimes = /** @type {Record<string, Record<string, unknown>>} */ (value.runtimes);
  runtimes.flash = {
    harness: "dsh",
    model: "deepseek-flash",
    reasoning: "high",
    sandbox: "workspace-write",
    executable: "dsh",
    vendor: "deepseek",
    config: { provider: "deepseek-official" },
  };
  const path = writeContract(directory, value);
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.equal(contract.runtimes.flash.harness, "dsh");
  assert.equal(contract.runtimes.flash.vendor, "deepseek");
});

test("the closed-packet profile disables the rows a closed packet cannot use", () => {
  const patch = readFileSync(PATCH, "utf8");
  for (const id of ["tool-subagent", "tool-subagent-fork", "tool-workflow", "tool-goal", "tool-ralph", "tool-web", "tool-jobs", "tool-skill", "plan-mode", "agent-instructions"]) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  disabled: true`, "u"), `${id} must ship disabled`);
  }
});

/**
 * End-to-end through the real client: the adapter's command starts this
 * repository's client, which speaks JSON-RPC to the harness and folds the
 * firehose. The fake harness keeps this deterministic — no harness install,
 * no provider, no network.
 *
 * @param {string} directory
 * @param {"pass"|"no-usage"|"quota"|"two-verdicts"|"silent"|"blocked"} mode
 * @param {import("../../src/harnesses/index.mjs").CommandOptions & {preferStructured?: boolean}} [options]
 */
async function runClient(directory, mode, options = {}) {
  return withFakeDsh(directory, mode, async () => {
    const command = providerCommand(runtime(), "do the thing", options);
    const invocation = spawnInvocation(command.executable, command.args);
    const child = spawn(invocation.command, invocation.args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"], ...invocation.options });
    child.stdin.end(command.input);
    const result = await closeResult(child);
    return {
      ...result,
      envelope: normalizeProviderResult(runtime(), result.stdout, result.code, result.signal, {
        preferStructured: options.schema !== undefined || options.preferStructured === true,
      }),
    };
  });
}

test("the client folds a real harness transcript into a worker result", async () => {
  const { envelope, stdout } = await runClient(scratch("dsh-client-"), "pass");
  assert.equal(envelope.status, "done");
  assert.deepEqual(envelope.usage, { inputTokens: 240, outputTokens: 80, cacheReadInputTokens: 1600 });
  assert.equal(JSON.parse(/** @type {string} */ (envelope.result)).status, "done");
  // Every message is on the transcript, so a judge round can count verdicts.
  assert.equal(stdout.split("\n").filter((line) => line.includes("dsh.message")).length, 2);
});

test("the client reports usage it cannot prove as nulls, never as a fake zero", async () => {
  const { envelope } = await runClient(scratch("dsh-client-"), "no-usage");
  assert.equal(envelope.status, "done");
  assert.deepEqual(envelope.usage, { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
});

test("the client carries a two-verdict judge round out of the harness", async () => {
  const { envelope } = await runClient(scratch("dsh-client-"), "two-verdicts", { preferStructured: true });
  assert.equal(envelope.status, "done");
  assert.equal(envelope.judgeCandidates, 2);
});

test("the client carries a quota verdict and its reset hint out of the harness", async () => {
  const { envelope } = await runClient(scratch("dsh-client-"), "quota");
  assert.equal(envelope.status, "exhausted");
  assert.equal(envelope.error?.code, "QUOTA");
  assert.ok(Date.parse(/** @type {string} */ (envelope.exhaustedUntil)) > Date.now());
});

test("a harness that never answers fails loudly instead of hanging or inventing a result", async () => {
  const { envelope } = await runClient(scratch("dsh-client-"), "silent");
  assert.notEqual(envelope.status, "done");
  assert.equal(envelope.result, null);
  assert.ok(envelope.error, "a silent harness must produce an error, not an empty success");
});

test("a fake harness answers the version probe exactly as a routed runtime expects", async () => {
  const directory = scratch("dsh-client-");
  await withFakeDsh(directory, "pass", async () => {
    const probe = await probeRuntime(runtime(), { cwd: directory });
    assert.equal(probe.ok, true);
    assert.equal(probe.version, "fake-dsh 0.1.5-rc.1");
    assert.equal(probe.capabilities.usage, true);
    assert.equal(probe.capabilities.continuation, false);
  });
});

const probed = spawnSync("dsh", ["--version"], { encoding: "utf8" });
const HARNESS = !probed.error && probed.status === 0 ? "dsh" : null;
const CREDENTIAL = Boolean(process.env.DEEPSEEK_API_KEY);

test("a real harness turns one prompt into a result with real tokens", { skip: HARNESS && CREDENTIAL ? false : "needs the dsh binary on PATH and DEEPSEEK_API_KEY" }, async () => {
  const directory = scratch("dsh-real-");
  const command = providerCommand(runtime({ sandbox: "danger-full-access" }), "Responda apenas OK e nada mais.", {});
  const invocation = spawnInvocation(command.executable, command.args);
  const child = spawn(invocation.command, invocation.args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"], ...invocation.options });
  child.stdin.end(command.input);
  const result = await closeResult(child);
  const envelope = normalizeProviderResult(runtime(), result.stdout, result.code, result.signal, {});
  assert.equal(envelope.status, "done", result.stderr.slice(-400));
  // The property under test is the wire, not the wording: this asserted the
  // answer equalled "OK" and failed twice on 2026-09-11 when the model prefixed
  // its restatement of the prompt. A live model's exact text is its own; what
  // the adapter owes is a done envelope carrying the answer and real tokens.
  assert.match(envelope.result ?? "", /OK/u);
  assert.ok((envelope.usage.inputTokens ?? 0) > 0, "a real turn reports the tokens it actually spent");
});

test("the runner forwards tool calls and per-message usage, so the controller's live meter sees a dsh turn", async () => {
  const directory = scratch("dsh-runner-tool-");
  const fake = fakeDsh(directory, "tool");
  const child = spawn(process.execPath, [RUNNER, "--dsh", fake, "--provider", "deepseek-official", "--model", "deepseek-flash"], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end("do the thing");
  await closeResult(child);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["dsh.started", "dsh.tool", "dsh.message", "dsh.completed"], "a tool call is forwarded, not folded away");
  assert.deepEqual(events[1], { type: "dsh.tool", name: "read", target: "src/a.mjs" });
  assert.deepEqual(events[2].usage, { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 800 }, "each message carries its own usage");
  assert.deepEqual(liveSessionMetrics("dsh", stdout), { turns: 1, cacheReadInputTokens: 800, toolCalls: 1, completed: true });
  assert.equal(normalizeProviderResult(runtime(), stdout, 0, null).status, "done", "the adapter's normalizer tolerates the forwarded record types");
});
