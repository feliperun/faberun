import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { initializeCampaign } from "../src/campaign/index.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../src/contract/index.mjs";
import { createAttemptWorktree } from "../src/repo/worktree.mjs";
import { RUNS_DIR_NAME, campaignTree, runsRoot } from "../src/run/paths.mjs";
import { writeExecutable } from "./write-executable.mjs";
import { gitArguments } from "../src/host/platform.mjs";

// The suite must never notify a person or wake a session; `./setup.mjs` is
// the one place that neutralises every notify variable, and `npm test`
// preloads it into every test process. Importing it here covers a file run
// on its own. Tests that need a failing or absent transport set the variable
// explicitly inside the test and restore it afterward.
import "./setup.mjs";

// The git every fixture repository is created and read through; the runner
// preloads it too, so this covers a file executed on its own.
import "./git-env.mjs";

// runsRoot registers every path it resolves as a project under $FABERUN_HOME.
// Every fixture this suite builds resolves through it, so an unset variable
// would write real project entries into the operator's own ~/.faberun as a
// side effect of running the tests. Always a throwaway home, never the
// operator's, even when one is configured: no suite run should depend on it.
// The runner owns the scope now — package.json preloads test/scoped-home.mjs
// into every test process — so this only fills in for a file executed
// without it, and an already-set home wins.
if (!process.env.FABERUN_HOME) {
  process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * How much longer a wait has to be on this host before it means the same
 * thing. Every deadline here is waiting on a spawned process to reach some
 * state, and a spawn on Windows is not one exec: a fixture binary is a `.cmd`
 * shim, so the command interpreter starts first and node after it. Measured
 * 2026-09-21 on Windows 11 with the suite at its default parallelism, a
 * provider took 0.3-0.6s to reach its first line against ~60ms on Linux, and
 * five deadlines that hold anywhere else expired. The factor is the honest
 * translation of "long enough that only a real hang trips this".
 *
 * Raised from 3 to 6, measured 2026-09-22 over six Windows CI jobs on this
 * repository: `run --detach leaves a controller that outlives the invoker`
 * completed in 11.3s, 15.2s and 16.2s and then blew a 60s deadline, and
 * `done-when 7` did the same at 66.3s. The median was never the problem --
 * the runner's tail is over 4x its median, so a bound inside that tail turns
 * contention into a red build. At 120s both detach tests passed on a rerun of
 * the same commit.
 *
 * What this factor does not fix, and must not be read as fixing: `a gate
 * exits once the directory holding its release file is gone`
 * (`test/run/process.test.mjs`) is bimodal on Windows -- it completes in
 * 345-430ms or it never completes, and its 60s deadline is its own, not this
 * factor's. It has failed on node 24 three times and node 22 twice across
 * unrelated commits, so it is neither node-version-specific nor slowness.
 * Raising a deadline separates flake-by-slowness from flake-by-hang; it
 * cannot cure the second.
 */
export const SPAWN_WAIT_FACTOR = process.platform === "win32" ? 6 : 1;

/**
 * Poll `read` until it returns a non-null value or the deadline passes.
 *
 * @param {() => unknown} read
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<unknown>}
 */
export async function waitForValue(read, timeoutMs = 5_000 * SPAWN_WAIT_FACTOR, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await delay(intervalMs);
  }
  throw new Error(`condition was not reached within ${timeoutMs}ms`);
}

/**
 * A genuinely orphaned node crashed mid-attempt: its isolated worktree is
 * still on disk, not yet sealed and removed. Simulating that means
 * recreating the worktree once it was already removed by a prior full
 * completion, so recovery's re-integration path has a real workspace to
 * seal and verify, exactly as an interrupted run would.
 *
 * @param {string} runDir
 * @param {{id: string, attempt: number, worktree?: import("../src/contract/index.mjs").WorktreeState|null}} state
 * @returns {import("../src/contract/index.mjs").WorktreeState|null|undefined} the worktree to persist on the node
 */
export function ensureAttemptWorktree(runDir, state) {
  if (state.worktree?.status !== "removed" || !state.worktree.branch) return state.worktree;
  const contract = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  const recreated = createAttemptWorktree({
    repo: contract.cwd,
    runDir,
    runId: contract.id,
    nodeId: state.id,
    attempt: state.attempt,
  });
  return { ...state.worktree, status: "ready", path: recreated.path, commit: recreated.commit };
}

/**
 * @param {string} runDir
 * @param {string} nodeId
 * @param {Record<string, unknown>} [patch]
 * @returns {void}
 */
export function orphan(runDir, nodeId, patch = {}) {
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(path, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    result: null,
    gate: null,
    ...patch,
  }, null, 2));
}

/**
 * @template T
 * @param {string} directory
 * @param {string} mode
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withFakeCodex(directory, mode, body) {
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = fakeCodex(directory, mode);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
  }
}

/**
 * @template T
 * @param {string} directory
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withFakeAgy(directory, body) {
  const previous = process.env.FABERUN_AGY_BIN;
  process.env.FABERUN_AGY_BIN = fakeAgy(directory);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FABERUN_AGY_BIN;
    else process.env.FABERUN_AGY_BIN = previous;
  }
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function fixture(overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "test-run",
    campaignId: "test-campaign",
    goal: "Prove the runner works",
    cwd: ".",
    runtimeDefaults: { worker: "luna", judge: "sol" },
    runtimes: {
      // sol routes to deepseek through config.model_provider, whose canonical
      // provider (derived from the route, not a free-text label) is genuinely
      // distinct from luna's harness-default "openai": every fixture node's
      // default worker (luna) and judge (sol) pairing must clear the
      // worker/judge cross-vendor gate untouched.
      luna: { harness: "codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
      sol: { harness: "codex", model: "gpt-5.6-sol", reasoning: "xhigh", config: { model_provider: "deepseek" } },
      opus: { harness: "claude", model: "opus", reasoning: "high" },
      agy: { harness: "agy", model: "gemini-3.7-flash-low" },
      flash: {
        harness: "codex",
        model: "deepseek-v4-flash",
        config: { model_provider: "deepseek", "model_providers.deepseek.env_key": "DEEPSEEK_API_KEY" },
      },
    },
    ...overrides,
    nodes: /** @type {Record<string, unknown>[]} */ (overrides.nodes ?? [{ id: "build", type: "backend", taskPacket: packet(), gate: false }]).map((node, index) => ({
      phase: `fixture-phase-${index}`,
      ...node,
    })),
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function packet(overrides = {}) {
  return {
    mode: "execution",
    objective: "Implement it",
    instructions: ["Implement the requested behavior"],
    readFiles: ["contract.json"],
    writeFiles: ["README.md"],
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [{ argv: process.platform === "win32" ? [process.execPath, "-e", "process.exit(0)"] : ["true"] }],
    ...overrides,
  };
}

/**
 * @param {string} directory
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
export function writeContract(directory, value) {
  const path = join(directory, "contract.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const cwd = join(directory, typeof value.cwd === "string" ? value.cwd : ".");
  const runsDir = runsRoot(cwd);
  const campaignId = value.campaignId;
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new TypeError("contract.campaignId must be a non-empty string");
  }
  const defaultWriteFile = join(cwd, "README.md");
  if (!existsSync(defaultWriteFile)) writeFileSync(defaultWriteFile, "");
  const pathForCampaign = campaignTree(cwd, campaignId);
  if (!existsSync(join(cwd, ".git"))) initializeGit(cwd);
  if (!existsSync(pathForCampaign)) {
    initializeCampaign(runsDir, { campaignId, goal: value.goal });
  }
  return path;
}

/**
 * @param {string} directory
 * @returns {void}
 */
export function initializeGit(directory) {
  // Without this, a machine with the file system monitor enabled starts a
  // detached `git fsmonitor--daemon` for every fixture repository the suite
  // creates, and each one outlives the directory it watched: measured
  // 2026-09-20, an afternoon of runs left 4810 of them holding 39 GB.
  execFileSync("git", gitArguments(["init", "-q", directory]));
  execFileSync("git", gitArguments(["-C", directory, "add", ".", `:!${RUNS_DIR_NAME}`]));
  execFileSync("git", gitArguments(["-C", directory, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]));
}

/**
 * @param {string} directory
 * @param {string} [mode]
 * @returns {string}
 */
export function fakeCodex(directory, mode = "pass") {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-codex-")), `fake-codex-${mode}.mjs`);
  const source = `import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) {
  if (mode === "version-fail") {
    console.error("deliberate failure");
    process.exitCode = 1;
  } else {
    console.log("fake-codex 1.0.0");
  }
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const prompt = input || process.argv.at(-1) || "";
    const judge = prompt.startsWith("Review node");
    // The dispatch gate's live preflight says hello with one trivial prompt
    // before any dispatch. A real provider answers a liveness prompt even
    // when it is out of quota, so every mode answers it here, in the shape a
    // completed turn emits, and only then falls through to its own behavior.
    if (prompt.includes("FABERUN_PREFLIGHT_OK")) {
      console.log(JSON.stringify({type:"thread.started",thread_id:"preflight-hello"}));
      const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:hello}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));
      return;
    }
    const canonicalResultPath = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1] ?? null;
    // A protocol-compliant worker writes the canonical result file its prompt
    // designates: the scope gate reads only that file to decide whether the
    // attempt is completed work. Modes listed here are compliant; a mode left
    // out delivers its result in the final message alone.
    const protocolResult = (text) => {
      if (canonicalResultPath) writeFileSync(canonicalResultPath, text);
      return text;
    };
    const protocolModes = new Set(["write-result", "write-unexpected", "write-unexpected-judge-prompt", "write-unexpected-long-review", "new-symlink-escape", "retargeted-symlink-escape", "write-outside-file-root", "write-under-file-root"]);
    if (mode !== "exhausted") console.log(JSON.stringify({type:"thread.started",thread_id:"fake-thread"}));
    if (mode === "write-allowed" && !judge) writeFileSync("README.md", "worker output\\n");
    if (mode === "continuation-carries-file" && !judge && !existsSync("carried.txt")) writeFileSync("carried.txt", "attempt-1\\n");
    if (mode === "write-unexpected" && !judge) writeFileSync("unexpected.txt", "out of scope\\n");
    if (mode === "new-symlink-escape" && !judge) {
      symlinkSync("outside.txt", "alias.txt");
      writeFileSync("alias.txt", "unauthorized target\\n");
    }
    if (mode === "retargeted-symlink-escape" && !judge) {
      unlinkSync("alias.txt");
      symlinkSync("outside.txt", "alias.txt");
      writeFileSync("alias.txt", "unauthorized target\\n");
    }
    if (mode === "contained-alias" && !judge) writeFileSync("alias.txt", "authorized target\\n");
    if (mode === "write-file-root" && !judge) writeFileSync("notes.md", "in the file root\\n");
    if (mode === "write-outside-file-root" && !judge) writeFileSync("sibling.md", "outside the file root\\n");
    if (mode === "write-under-file-root" && !judge) {
      unlinkSync("notes.md");
      mkdirSync("notes.md");
      writeFileSync("notes.md/nested.txt", "under the file root\\n");
    }
    if (mode === "write-unexpected-judge-prompt" && !judge) writeFileSync("unexpected.txt", "out of scope\\n");
    if (mode === "write-unexpected-long-review" && !judge) writeFileSync("unexpected.txt", "out of scope\\n");
    if (mode === "write-unexpected-judge-prompt" && judge) appendFileSync(${JSON.stringify(join(runsRoot(directory), "judge-prompt.txt"))}, prompt);
    if (mode === "write-unexpected-long-review" && judge) {
      // A summary far longer than any status cell can hold: the note that
      // carries it has to be bounded the same way on every surface.
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({verdict:"fail",maxSeverity:"minor",summary:"the review could not verify the declared behavior from the recorded evidence alone, so it flags the checklist item for a human pass",findings:[{severity:"minor",description:"style [works]",evidence:"line 1"}]})}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      return;
    }
    if (mode === "write-unexpected-failed" && !judge) {
      writeFileSync("unexpected.txt", "out of scope\\n");
      console.log(JSON.stringify({type:"turn.failed",error:{message:"deliberate failure"},usage:{input_tokens:7,output_tokens:3}}));
      return;
    }
    if (mode === "write-unexpected-message-only" && !judge) {
      // A done result that never reached the canonical file: the final message
      // alone is not accepted work, so the scope gate must not defer to it.
      writeFileSync("unexpected.txt", "out of scope\\n");
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] })}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      return;
    }
    if (mode === "write-unexpected-blocked-context" && !judge) {
      writeFileSync("unexpected.txt", "out of scope\\n");
      const text = protocolResult(JSON.stringify({ status: "blocked_context", summary: "missing context", verification: [], artifacts: [], missingContext: ["missing.txt"] }));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      return;
    }
    if (mode === "write-unexpected-invalid-result" && !judge) {
      writeFileSync("unexpected.txt", "out of scope\\n");
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"I could not finish: the task packet is ambiguous."}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      return;
    }
    if (mode === "write-unexpected-revision" && !judge) {
      const counterPath = ${JSON.stringify(join(runsRoot(directory), "scope-revision-workers"))};
      appendFileSync(counterPath, "x\\n");
      const run = readFileSync(counterPath, "utf8").trim().split("\\n").length;
      writeFileSync(\`unexpected-\${run}.txt\`, "out of scope\\n");
      if (prompt.includes("quality gate rejected")) appendFileSync(${JSON.stringify(join(runsRoot(directory), "scope-retry-prompt.txt"))}, prompt);
      const text = protocolResult(JSON.stringify({ status: "done", summary: \`worker attempt \${run}\`, verification: [], artifacts: [], missingContext: [] }));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      return;
    }
    if (mode === "large-output") {
      for (let index = 0; index < 7000; index += 1) console.log(JSON.stringify({ type: "progress", text: "A".repeat(100) }));
      for (let index = 0; index < 7000; index += 1) console.error("E".repeat(100));
    }
    if (mode === "thread-large-timeout") {
      // Attempt isolation (phase 1) makes a resumed invocation a fresh attempt
      // in a fresh worktree, never a continuation of the timed-out one: only
      // the first invocation hangs past its wall-clock deadline, and every
      // invocation after it completes normally.
      const counterPath = ${JSON.stringify(join(runsRoot(directory), "thread-large-timeout-invocations"))};
      appendFileSync(counterPath, "x\\n");
      const call = readFileSync(counterPath, "utf8").trim().split("\\n").length;
      if (call > 1) {
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({ status: "done", summary: "fresh attempt after the capped timeout", verification: [], artifacts: [], missingContext: [] })}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
        return;
      }
      // A small progress burst, not the 7000-line flood "large-output" uses:
      // this scenario only needs the turn.failed usage line written well
      // before the wall-clock cap fires, even on a loaded host.
      for (let index = 0; index < 50; index += 1) console.log(JSON.stringify({ type: "progress", text: "A".repeat(100) }));
      console.log(JSON.stringify({type:"turn.failed",error:{message:"still running after partial accounting",usage:{input_tokens:5,output_tokens:2,cached_input_tokens:1}}}));
      setInterval(() => {}, 60_000);
      return;
    }
    if (mode === "wait-for-release") {
      const started = ${JSON.stringify(join(runsRoot(directory), "provider-started"))};
      const release = ${JSON.stringify(join(runsRoot(directory), "provider-release"))};
      writeFileSync(started, "started");
      const timer = setInterval(() => {
        if (!existsSync(release)) return;
        clearInterval(timer);
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] })}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
      }, 5);
      return;
    }
    if (mode === "slow") {
      const wait = prompt.startsWith("Review node") ? 2000 : 3500;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
    if (mode === "prose-retry" && !prompt.startsWith("Review node")) {
      if (!prompt.includes("quality gate rejected")) {
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"All requirements are already in place; nothing to do."}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
        return;
      }
    }
    if (mode === "prose-json" && !prompt.startsWith("Review node")) {
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"All checks pass, my only modification is the declared write file.\\n\\n" + JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] })}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      return;
    }
    if (mode === "complete-exit-1" && !prompt.startsWith("Review node")) {
      // A finished worker turn whose harness then exits non-zero: the run
      // owns a durable canonical result and a final agent message carrying
      // the same JSON, plus the two benign error items from the incident.
      writeFileSync("README.md", "worker output\\n");
      const resultPath = /canonical result file: (\\S+\\.json)/.exec(prompt)?.[1];
      const payload = { status: "done", summary: "completed despite non-zero exit", verification: [], artifacts: [], missingContext: [] };
      const text = JSON.stringify(payload);
      if (resultPath) writeFileSync(resultPath, text);
      console.log(JSON.stringify({type:"item.completed",item:{id:"item_0",type:"error",message:"Under-development features enabled: rollout_budget. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set \`suppress_unstable_features_warning = true\` in /Users/frb/.codex/config.toml."}}));
      console.log(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"error",message:"Model metadata for \`deepseek-v4-flash\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2000000,cached_input_tokens:1900000,output_tokens:100}}));
      process.exitCode = 1;
      return;
    }
    if (mode === "silent") setTimeout(() => {}, 60_000);
    else if (mode === "token-flood") {
      // Streams cumulative turn.completed usage events while staying alive:
      // lets tests observe live metering, per-node caps, and budget kills.
      // No SIGTERM handler: a budget kill must surface as a signaled death.
      let total = 0;
      const step = () => {
        total += 600;
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: total, output_tokens: 1 } }));
        if (total < 10_000_000) timer = setTimeout(step, 10);
      };
      let timer = setTimeout(step, 5);
      return;
    }
    else if (mode === "worker-reserve-flood") {
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 600, output_tokens: 1 } }));
      setTimeout(() => {}, 60_000);
      return;
    }
    else if (mode === "token-flood-timeout") {
      // One cumulative turn.completed usage event, then silence while alive:
      // the wall-clock kill lands before 80 turns can trigger rotation.
      // No SIGTERM handler: the timeout kill surfaces as a signaled death and
      // the transcript backfills the observed usage.
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 600, output_tokens: 1 } }));
      setTimeout(() => {}, 60_000);
      return;
    }
    else if (mode === "heartbeat") setInterval(() => console.error("working"), 10);
    else if (mode === "rollout-budget") {
      console.log(JSON.stringify({type:"turn.failed",error:{message:"shared rollout token budget exhausted"}}));
    } else if (mode === "quota-429") {
      console.log(JSON.stringify({type:"turn.failed",error:{message:"You've hit your usage limit. Please try again at 12:58 PM"}}));
      process.exitCode = 1;
    } else if (mode === "judge-reserve-overrun") {
      const text = judge
        ? JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "judge completed from reserve", findings: [] })
        : JSON.stringify({ status: "done", summary: "worker completed", verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:80,output_tokens:1,cached_input_tokens:0}}));
      setTimeout(() => process.exit(0), 200);
    } else if (mode === "exhausted") {
      console.log(JSON.stringify({type:"turn.failed",error:{code:"budget_exceeded",message:"budget_exceeded"}}));
    } else if (mode === "judge-tool-host-disabled" && prompt.startsWith("Review node")) {
      console.log(JSON.stringify({type:"item.completed",item:{id:"item_tool_host",type:"error",message:"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \`features.code_mode_host\` and install \`codex-code-mode-host\`."}}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({verdict:"pass",maxSeverity:"none",summary:"fabricated",findings:[]})}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
    } else if (prompt.includes("FAIL_WORKER") || (mode === "worker-fail" && !prompt.startsWith("Review node")) || (mode === "judge-fail" && prompt.startsWith("Review node")) || mode === "failure-with-usage") {
      console.log(JSON.stringify({type:"turn.failed",error:{message:"deliberate failure",usage: mode === "failure-with-usage" ? {input_tokens:7,output_tokens:3,cached_input_tokens:2} : undefined}}));
    } else {
      const emitted = judge
        ? mode === "critical"
          ? JSON.stringify({verdict:"fail",maxSeverity:"critical",summary:"critical defect",findings:[{severity:"critical",description:"broken [works]",evidence:"test failed"}]})
          : JSON.stringify({verdict:"fail",maxSeverity:"minor",summary:"minor advisory",findings:[{severity:"minor",description:"style [works]",evidence:"line 1"}]})
        : mode === "blocked-context"
          ? JSON.stringify({ status: "blocked_context", summary: "missing context", verification: [], artifacts: [], missingContext: ["missing.txt"] })
          : JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
      const text = !judge && protocolModes.has(mode) ? protocolResult(emitted) : emitted;
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}));
    }
  });
}
`;
  return writeExecutable(path, source);
}

/**
 * @param {string} directory
 * @param {"pass"|"402"|"secret"} [mode]
 * @returns {string}
 */
export function fakeExecJsonl(directory, mode = "pass") {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-jsonl-")), "fake-jsonl.mjs");
  const script = process.platform === "win32" ? `const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) {
  console.log("fake-jsonl 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const request = JSON.parse(input);
    if (mode === "402" || mode === "secret") {
      console.log(JSON.stringify({ schemaVersion: 1, type: "run.failed", error: { code: "payment_required", message: "402 Payment Required " + (process.env.FABERUN_TEST_LIVE_SECRET ?? "") } }));
      return;
    }
    const judge = request.prompt.includes("Review node");
    const result = judge
      ? JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "clean", findings: [] })
      : JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "fake-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 }, costUsd: 0.01 }));
  });
}
` : `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'fake-jsonl 1.0.0'
  exit 0
fi
request=$(cat)
if [ ${JSON.stringify(mode)} = "402" ] || [ ${JSON.stringify(mode)} = "secret" ]; then
  printf '%s\\n' '{"schemaVersion":1,"type":"run.failed","error":{"code":"payment_required","message":"402 Payment Required '"\${FABERUN_TEST_LIVE_SECRET:-}"'"}}'
  exit 0
fi
case "$request" in
  *"Review node"*) result='{"verdict":"pass","maxSeverity":"none","summary":"clean","findings":[]}' ;;
  *) result='{"status":"done","summary":"worker complete","verification":[],"artifacts":[],"missingContext":[]}' ;;
esac
printf '%s\\n' '{"schemaVersion":1,"type":"run.completed","result":'"$(printf '%s' "$result" | sed 's/"/\\\\"/g; s/^/"/; s/$/"/')"',"continuationId":"fake-thread","usage":{"inputTokens":5,"outputTokens":2,"cacheReadInputTokens":1},"costUsd":0.01}'
`;
  // The POSIX half carries its own `#!/bin/sh`, so it needs the exec bit and
  // nothing else: `writeExecutable` would put node in front of a shell
  // script. The Windows half is node, and reaches this host through the
  // `.cmd` shim that writes.
  if (process.platform !== "win32") {
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  }
  return writeExecutable(path, script);
}

/**
 * The stand-in is named `agy` inside its own directory so a PATH lookup finds
 * it by the same name the real binary has. `agy models` answers in the
 * measured shape: `id<TAB>display name` lines on stdout, a progress line on
 * stderr. The listing is fixed, never the host's, and carries one id the
 * declared catalogue does not have.
 *
 * @param {string} directory
 * @returns {string}
 */
export function fakeAgy(directory) {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-agy-")), "agy");
  const source = `if (process.argv.includes("--version")) {
  console.log("agy 1.0.0");
} else if (process.argv.includes("models")) {
  console.error("Fetching available models...");
  console.log("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)");
  console.log("gemini-3.1-pro-low\\tGemini 3.1 Pro (Low)");
  console.log("claude-sonnet-4-6\\tClaude Sonnet 4.6");
} else {
console.log(JSON.stringify({event:"init",conversation_id:"fake-conversation"}));
console.log(JSON.stringify({event:"result",result:{
  conversation_id:"fake-conversation",
  status:"SUCCESS",
  response:"READY",
  usage:{input_tokens:4,output_tokens:1,cache_read_tokens:2}
}}));
}
`;
  return writeExecutable(path, source);
}

/**
 * A stand-in for the DeepSeek Harness that speaks the `sdk` JSON-RPC profile:
 * the initialize handshake, `session.event` notifications, and the `turn/end`
 * reason whose `error.code` decides failover. Modes name the transcript the
 * harness should produce, so the adapter's folding is testable without a real
 * harness, a provider, or a network.
 *
 * @param {string} directory
 * @param {"pass"|"no-usage"|"quota"|"two-verdicts"|"silent"|"blocked"|"tool"} mode
 * @returns {string}
 */
export function fakeDsh(directory, mode = "pass") {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-dsh-")), `fake-dsh-${mode}.mjs`);
  const source = `const mode = ${JSON.stringify(mode)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv.includes("--version")) {
  console.log("fake-dsh 0.1.5-rc.1");
} else if (mode === "silent") {
  process.exitCode = 1;
} else {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
      }
      if (request.method !== "session/prompt") continue;
      const sessionId = request.params.sessionId;
      const event = (payload) => send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: payload } });
      const text = (value, usage) => event({ type: "assistant/message", data: {
        message: { role: "assistant", content: [{ type: "text", text: value }] },
        ...(usage ? { usage } : {}),
      } });
      const usage = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 800 };
      if (mode === "pass") {
        text("working", usage);
        text(JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] }), usage);
        event({ type: "turn/end", data: { reason: { kind: "completed" } } });
      } else if (mode === "tool") {
        event({ type: "tool/call", data: { turn: 1, step: 1, callId: "call_1", name: "read", arguments: JSON.stringify({ file_path: "src/a.mjs" }) } });
        event({ type: "tool/result", data: { message: { source: { callId: "call_1" }, content: [] } } });
        text(JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] }), usage);
        event({ type: "turn/end", data: { reason: { kind: "completed" } } });
      } else if (mode === "no-usage") {
        text(JSON.stringify({ status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [] }));
        event({ type: "turn/end", data: { reason: { kind: "completed" } } });
      } else if (mode === "two-verdicts") {
        text(JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "one", findings: [] }), usage);
        text(JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "two", findings: [] }), usage);
        event({ type: "turn/end", data: { reason: { kind: "completed" } } });
      } else if (mode === "quota") {
        event({ type: "assistant/message", data: { message: { role: "assistant", content: [] }, usage } });
        event({ type: "turn/end", data: { reason: { kind: "error", error: {
          message: "429 Too Many Requests: usage limit exhausted, reset at 2026-09-10T12:00:00Z",
          code: "QUOTA",
          providerRetryAfterMs: 60000,
        } } } });
      } else if (mode === "blocked") {
        event({ type: "turn/end", data: { reason: { kind: "blocked" } } });
      }
    }
  });
}
`;
  return writeExecutable(path, source);
}

/**
 * @template T
 * @param {string} directory
 * @param {"pass"|"no-usage"|"quota"|"two-verdicts"|"silent"|"blocked"|"tool"} mode
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withFakeDsh(directory, mode, body) {
  const previous = process.env.FABERUN_DSH_BIN;
  process.env.FABERUN_DSH_BIN = fakeDsh(directory, mode);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.FABERUN_DSH_BIN;
    else process.env.FABERUN_DSH_BIN = previous;
  }
}

/**
 * Resolve each name to an absolute, executable path found on the current
 * PATH, the same lookup `command -v` performs. Throws with the offending name
 * when one cannot be found, so a caller building a restricted PATH fails with
 * a clear message rather than a confusing downstream ENOENT.
 *
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
export function binariesInPath(names) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  /** @type {Record<string, string>} */
  const resolved = {};
  for (const name of names) {
    const hit = dirs
      .map((dir) => join(dir, name))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (!hit) throw new Error(`binariesInPath: "${name}" is not on PATH (${process.env.PATH ?? ""})`);
    resolved[name] = hit;
  }
  return resolved;
}

/**
 * Run `body` with PATH and HOME pointed at a throwaway directory.
 *
 * The zcode adapter repairs a host whose CLI resolves to nothing: it looks for
 * the ZCode app bundle and writes a `zcode` shim into a PATH install dir. A
 * test that exercises that adapter's default resolution without this wrapper
 * reads the developer's real PATH and, on a machine that has the app but no
 * shim, installs one into their real `~/.local/bin` as a side effect of running
 * the suite.
 *
 * `options.binaries` names executables a test still needs despite the empty
 * PATH (e.g. `sh`, `tar`): each is resolved from the real PATH before it is
 * emptied, via {@link binariesInPath}, then exposed inside the throwaway
 * directory as a symlink under its plain name. Any binary not named stays as
 * unresolvable as it would be on a genuinely empty PATH.
 *
 * @template T
 * @param {() => T | Promise<T>} body
 * @param {{binaries?: string[]}} [options]
 * @returns {Promise<T>}
 */
export async function withEmptyPath(body, options = {}) {
  const { binaries = [] } = options;
  const resolved = binariesInPath(binaries);
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
  const directory = mkdtempSync(join(tmpdir(), "runner-empty-path-"));
  for (const [name, target] of Object.entries(resolved)) {
    symlinkSync(target, join(directory, name));
  }
  process.env.PATH = directory;
  process.env.HOME = directory;
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The environment that points a spawned CLI at `home` as the operator's own
 * home directory.
 *
 * What the product asks is `os.homedir()`, and that reads a different variable
 * per platform: `HOME` on POSIX, `USERPROFILE` on Windows. A fixture that sets
 * only one of them relocates the home on one platform and is silently ignored
 * on the other — where the test then writes into the real home, or fails
 * looking for what it wrote.
 *
 * @param {string} home
 * @returns {Record<string, string>}
 */
export function homeEnv(home) {
  return process.platform === "win32" ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

/**
 * @param {string} nodePath
 * @returns {string|null}
 */
export function readStatus(nodePath) {
  try {
    return JSON.parse(readFileSync(nodePath, "utf8")).status;
  } catch {
    return null;
  }
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
export function closeResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
}
