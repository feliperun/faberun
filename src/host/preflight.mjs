/**
 * Environment preflight: the host facts a run depends on, checked before the
 * first dispatch and again by `doctor` on demand.
 *
 * Four checks gate a dispatch — free disk, a functional git, the worktree
 * state, and every routed runtime binary present and versioned. A gate that
 * fails leaves the run materialized and resumable: the controller records the
 * report as run evidence and stops, so the operator fixes the host and
 * resumes instead of starting over and paying for the finished nodes twice.
 *
 * A version is not a verdict: a binary that answered `--version` can still
 * hold a dead credential or a spent quota. With a contract, `doctor` asks
 * each routed runtime the same live question the dispatch gate asks and
 * reports that verdict beside the version checks — the `models` surfaces
 * name this report the authoritative word on availability — and without a
 * contract it says plainly that it asked nothing. The verdict is the
 * report, not the gate: a runtime with no answer is a finding on its own
 * line, while the exit code keeps answering the host-fact question it
 * always answered, because blocking on silence is the dispatch gate's job
 * and it blocks on exactly those causes.
 *
 * A check may be advisory, meaning it reports a fact without blocking: a
 * merely dirty worktree is normal in this repository (the run captures a
 * dirtyTreeFingerprint for it), while unmerged paths or an interrupted git
 * operation are not, because a worker's scope diff cannot be read against
 * them. Set FABERUN_REQUIRE_CLEAN_WORKTREE=1 to make any dirt fatal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, getHarness, probeRuntime } from "../harnesses/index.mjs";
import { liveSilenceCause } from "../engine/live-silence.mjs";
import { addRuntimeRequirement, failoverTargets, runtimeSnapshot } from "../engine/failover.mjs";
import { pricingSeedAge } from "../engine/pricing-seed.mjs";
import { validateContract } from "../contract/index.mjs";
import { sharedVerificationCommands } from "../contract/final-verification.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS, discoverRuntimes } from "../engine/runtime-discovery.mjs";
import { errorMessage } from "../util.mjs";
import { boundedGitSync } from "../repo/worktree.mjs";
import { routeRuntime } from "../contract/runtime.mjs";
import { NOTIFY_BIN_ENV, deliverableEventTypes, noTransportWarning, notifySettingProblems } from "../notify/index.mjs";
import { NOTIFY_SESSION_ENV, sessionWakeNotice } from "../notify/session.mjs";
import { findExecutable } from "./platform.mjs";
import { colorLevel, statusToken } from "../cli/brand.mjs";
import { RUNS_DIR_NAME } from "../run/paths.mjs";
import { availabilityKey, readAvailability, recordAvailability } from "../run/availability.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").RuntimeSnapshot} RuntimeSnapshot */
/** @typedef {import("../harnesses/index.mjs").CapabilityRequirements} CapabilityRequirements */
/** @typedef {import("../harnesses/index.mjs").ProbeResult} ProbeResult */
/** @typedef {import("../engine/runtime-discovery.mjs").RuntimeAvailability} RuntimeAvailability */
/** @typedef {Map<string, {runtime: RuntimeSnapshot, requiredCapabilitySets: CapabilityRequirements[], routed: boolean}>} ReachableRuntimes */
/** @typedef {{name: string, ok: boolean, advisory: boolean, detail: string}} EnvCheck */
/** @typedef {{schemaVersion: number, ok: boolean, checks: EnvCheck[]}} EnvReport */

const ENV_PREFLIGHT_SCHEMA_VERSION = 1;

/** Free space below this leaves no room for logs, capsules, and snapshots. */
const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;

/** Worktree states in which a scope diff is not readable. */
const GIT_IN_PROGRESS = Object.freeze({
  MERGE_HEAD: "merge",
  CHERRY_PICK_HEAD: "cherry-pick",
  REVERT_HEAD: "revert",
  BISECT_LOG: "bisect",
});

/** @param {string} name @param {string} detail @returns {EnvCheck} */
const pass = (name, detail) => ({ name, ok: true, advisory: false, detail });

/** @param {string} name @param {string} detail @param {boolean} [advisory] @returns {EnvCheck} */
const fail = (name, detail, advisory = false) => ({ name, ok: false, advisory, detail });

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string}}
 */
function git(dir, args) {
  const result = boundedGitSync(["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: result.error ? null : result.status, stdout: String(result.stdout ?? "") };
}

/** @param {NodeJS.ProcessEnv} env @returns {number} */
export function minFreeDiskBytes(env) {
  const raw = env.FABERUN_MIN_FREE_DISK_BYTES;
  if (raw === undefined) return DEFAULT_MIN_FREE_DISK_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError("FABERUN_MIN_FREE_DISK_BYTES must be a non-negative number of bytes");
  return parsed;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Free space on the filesystem holding the run. A filesystem that cannot
 * report statfs is advisory: an unknown figure must not block a dispatch.
 *
 * @param {string} cwd
 * @param {number} minFreeBytes
 * @returns {EnvCheck}
 */
export function checkDisk(cwd, minFreeBytes) {
  let free;
  try {
    const stats = statfsSync(cwd);
    free = Number(stats.bsize) * Number(stats.bavail);
  } catch (error) {
    return fail("disk", `free space unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const detail = `${formatBytes(free)} free · threshold ${formatBytes(minFreeBytes)}`;
  return free >= minFreeBytes ? pass("disk", detail) : fail("disk", `${detail} · free at least ${formatBytes(minFreeBytes - free)} more`);
}

/**
 * A functional git, not merely a git on PATH: the run reads HEAD and diffs
 * the worktree through it, so a git that cannot execute is fatal.
 *
 * @param {string} cwd
 * @returns {EnvCheck}
 */
export function checkGit(cwd) {
  const version = boundedGitSync(["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (version.error || version.status !== 0) return fail("git", `git is not executable: ${version.error ? version.error.message : `exit ${version.status}`}`);
  const label = String(version.stdout ?? "").trim() || "git";
  if (!existsSync(cwd)) return fail("git", `${label} · cwd does not exist: ${cwd}`);
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return fail("git", `${label} · execution requires a git work tree with at least one commit`);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) return fail("git", `${label} · repository must have at least one commit before an isolated execution can start`);
  return pass("git", `${label} · HEAD ${head.stdout.trim().slice(0, 12)}`);
}

/**
 * @param {string} cwd
 * @param {boolean} requireClean
 * @returns {EnvCheck}
 */
export function checkWorktree(cwd, requireClean) {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return pass("worktree", `${cwd} is not a git work tree; nothing to compare`);
  const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
  const root = gitDir.status === 0 ? resolve(cwd, gitDir.stdout.trim()) : null;
  if (root) {
    if (existsSync(join(root, "rebase-merge")) || existsSync(join(root, "rebase-apply"))) return fail("worktree", "a rebase is in progress; finish or abort it before dispatching");
    for (const [file, operation] of Object.entries(GIT_IN_PROGRESS)) {
      if (existsSync(join(root, file))) return fail("worktree", `a ${operation} is in progress; finish or abort it before dispatching`);
    }
  }
  const status = git(cwd, ["status", "--porcelain"]);
  if (status.status !== 0) return fail("worktree", "git status failed; the worktree state is unknown");
  const lines = status.stdout.split("\n").filter((line) => line.trim());
  const conflicted = lines.filter((line) => /^(DD|AU|UD|UA|DU|AA|UU)/u.test(line));
  if (conflicted.length) return fail("worktree", `${conflicted.length} unmerged path${conflicted.length === 1 ? "" : "s"}; resolve the conflict before dispatching`);
  if (!lines.length) return pass("worktree", "clean");
  const detail = `${lines.length} dirty path${lines.length === 1 ? "" : "s"}`;
  return requireClean
    ? fail("worktree", `${detail}; FABERUN_REQUIRE_CLEAN_WORKTREE demands a clean tree`)
    : fail("worktree", `${detail}; recorded in the run's dirtyTreeFingerprint`, true);
}

/**
 * Every runtime the run committed to — a node's or a default's named runtime,
 * and the failover target it declares — must resolve to a binary that exists
 * and reports a version. A version-less runtime is fatal up front because a
 * resume refuses a runtime whose probe came back null.
 *
 * A runtime that is merely a candidate is held to a weaker rule: at least one
 * of them has to resolve. A role that names no runtime lets availability
 * discovery choose at dispatch, so every catalogue entry is reachable without
 * any of them being chosen, and demanding a binary for each of them refused a
 * run over a harness it would never have started. Measured 2026-09-21 on the
 * owner's machine: `codex reported no version` blocked a launch whose work was
 * routed to `zcode`. What is still fatal is a catalogue where nothing resolves
 * — then there is no route at all, and discovery has nothing to choose.
 *
 * @param {ReachableRuntimes} runtimes
 * @param {Record<string, string|null>} harnessVersions
 * @param {string} [cwd] the run cwd a relative executable is resolved against
 * @returns {EnvCheck}
 */
export function checkRuntimeBinaries(runtimes, harnessVersions, cwd = ".") {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unavailableCandidates = [];
  /** @type {string[]} */
  const resolved = [];
  let candidates = 0;
  let candidatesResolved = 0;
  for (const [id, { runtime, routed }] of runtimes) {
    // The harness owns the resolution: a per-runtime executable, an
    // FABERUN_*_BIN override, and each harness's default binary all
    // land here, and a relative path belongs to the run cwd, not to ours.
    const executable = getHarness(runtime.harness).executable(runtime);
    const found = findExecutable(executable.includes("/") || executable.includes("\\") ? resolve(cwd, executable) : executable);
    const version = harnessVersions[id] ?? null;
    if (!routed) candidates += 1;
    const problem = found === null
      ? `${id}: ${executable} not found on PATH`
      : version === null ? `${id}: ${executable} reported no version` : null;
    if (problem === null) {
      resolved.push(`${id} ${version}`);
      if (!routed) candidatesResolved += 1;
    } else if (routed) problems.push(problem);
    else unavailableCandidates.push(problem);
  }
  if (problems.length) return fail("runtime binaries", problems.join(" · "));
  if (candidates > 0 && candidatesResolved === 0) {
    return fail("runtime binaries", `no catalogue runtime resolves, so availability discovery has nothing to choose: ${unavailableCandidates.join(" · ")}`);
  }
  const aside = unavailableCandidates.length ? ` · not candidates: ${unavailableCandidates.join(" · ")}` : "";
  return pass("runtime binaries", resolved.length ? `${resolved.join(" · ")}${aside}` : "no routed runtime");
}

/**
 * @param {{cwd: string, runtimes: ReachableRuntimes, harnessVersions?: Record<string, string|null>, env?: NodeJS.ProcessEnv}} options
 * @returns {EnvReport}
 */
export function environmentPreflight(options) {
  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const checks = [
    checkDisk(cwd, minFreeDiskBytes(env)),
    checkGit(cwd),
    checkWorktree(cwd, env.FABERUN_REQUIRE_CLEAN_WORKTREE === "1"),
    checkRuntimeBinaries(options.runtimes, options.harnessVersions ?? {}, cwd),
  ];
  return { schemaVersion: ENV_PREFLIGHT_SCHEMA_VERSION, ok: checks.every((check) => check.ok || check.advisory), checks };
}

/**
 * The named no-transport check, advisory so it never gates a dispatch. It is
 * rendered by `preflight` and warned about by `doctor` and the foreground
 * launch, but it is kept out of `environmentPreflight`'s own check set so the
 * dispatch gate stays exactly the host facts it always was.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EnvCheck}
 */
export function notifyTransportCheck(env = process.env) {
  const problems = notifySettingProblems(env);
  if (problems.length) return fail("notify transport", problems.join("; "), true);
  const warning = noTransportWarning(env);
  if (warning) return fail("notify transport", warning, true);
  const external = env[NOTIFY_BIN_ENV] ? `${NOTIFY_BIN_ENV}=${env[NOTIFY_BIN_ENV]}` : `${NOTIFY_BIN_ENV} unset`;
  const events = [...deliverableEventTypes(env)].join(",");
  return pass("notify transport", `${external} · ${sessionWakeNotice(env)} · events: ${events}`);
}

/** @param {EnvReport} report @returns {EnvCheck[]} the checks that block a dispatch */
export function blockingChecks(report) {
  return report.checks.filter((check) => !check.ok && !check.advisory);
}

/** The share of its declared timeout a command may take before it is a warning. */
const VERIFICATION_DURATION_WARN_RATIO = 0.8;

/**
 * Every distinct verification command the contract declares, with the
 * strictest timeout any node gives it and the nodes that share it. The
 * contract-wide `sharedVerification` set is included once, under the name
 * `sharedVerification`, because every node runs it.
 *
 * Commands are keyed by argv and cwd, never merged across different argv, so
 * one measurement stands in for every node that declares the same command —
 * a contract that puts `npm test` on three nodes gets timed once.
 *
 * @param {ValidatedContract} contract
 * @returns {{argv: string[], cwd?: string, timeoutSec: number, nodes: string[]}[]}
 */
export function declaredVerificationCommands(contract) {
  /** @type {Map<string, {argv: string[], cwd?: string, timeoutSec: number, nodes: string[]}>} */
  const commands = new Map();
  const declarations = [
    ...contract.nodes.flatMap((node) => (node.taskPacket?.verification ?? []).map((command) => ({ command, node: node.id }))),
    ...sharedVerificationCommands(contract).map((command) => ({ command, node: "sharedVerification" })),
    ...(contract.finalVerification ?? []).map((command) => ({ command, node: "finalVerification" })),
  ];
  for (const { command, node } of declarations) {
    const timeoutSec = command.timeoutSec ?? 120;
    const key = JSON.stringify([command.argv, command.cwd ?? null]);
    const existing = commands.get(key);
    if (existing) {
      existing.timeoutSec = Math.min(existing.timeoutSec, timeoutSec);
      if (!existing.nodes.includes(node)) existing.nodes.push(node);
    } else {
      commands.set(key, { argv: command.argv, cwd: command.cwd, timeoutSec, nodes: [node] });
    }
  }
  return [...commands.values()];
}

/**
 * Environment names removed before spawning a timing candidate. The probe
 * only measures how long a command takes; a subtraction of a named few, not
 * an allowlist, so PATH, HOME and every ordinary variable the command needs
 * to run at all still pass through unchanged.
 */
const SIDE_EFFECT_ENV_KEYS = [
  NOTIFY_BIN_ENV, // a measurement must not notify a human
  NOTIFY_SESSION_ENV, // nor wake the harness session it was measured from
  "FABERUN_CODEX_BIN", // could redirect the timed command at a live, paid codex binary instead of this repository's own fixtures
  "FABERUN_CLAUDE_BIN", // same, for the claude harness
  "FABERUN_AGY_BIN", // same, for the agy harness
  "FABERUN_DSH_BIN", // same, for the dsh harness
  "FABERUN_ZCODE_BIN", // same, for the zcode harness
  "FABERUN_EXEC_JSONL_BIN", // same, for the exec-jsonl harness
];

/**
 * Run every declared verification command once and report what it actually
 * costs against the timeout the contract gives it.
 *
 * A verification entry is capped at 600s by the schema, and nothing else in
 * the toolchain measures whether a command fits: a suite that grows past its
 * declared timeout only announces itself by failing a node that did its work
 * correctly, after the tokens are spent. Campaign
 * faberun-suite-speed-20260909 lost roughly 49 minutes and two nodes
 * to exactly that — `npm test` at 644s against a declared 600s.
 *
 * A non-zero exit is reported, never failed on: a node may legitimately be
 * the thing that turns a red command green. Only duration decides `ok`.
 *
 * @param {ValidatedContract} contract
 * @param {{now?: () => number, run?: typeof spawnSync}} [probes] injectable for tests
 * @returns {EnvCheck[]}
 */
export function timeVerificationCommands(contract, probes = {}) {
  const now = probes.now ?? (() => Date.now());
  const run = probes.run ?? spawnSync;
  const env = { ...process.env };
  for (const key of SIDE_EFFECT_ENV_KEYS) delete env[key];
  return declaredVerificationCommands(contract).map((command) => {
    const label = command.argv.join(" ");
    const name = `verification timing · ${label}`;
    const shared = command.nodes.length > 1 ? ` · declared by ${command.nodes.join(", ")}` : "";
    // Let a slow command overrun its declared timeout so the report can say by
    // how much; killing it at the declared value would only prove "at least".
    const ceilingSec = Math.min(Math.max(command.timeoutSec * 2, command.timeoutSec + 120), 1800);
    const startedAt = now();
    const result = run(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd ? resolve(contract.cwd, command.cwd) : contract.cwd,
      timeout: ceilingSec * 1_000,
      stdio: "ignore",
      encoding: "utf8",
      env,
    });
    const seconds = (now() - startedAt) / 1_000;
    const measured = `${seconds.toFixed(1)}s measured against ${command.timeoutSec}s declared`;
    const exit = result.status === null ? `killed by ${result.signal ?? "timeout"}` : `exit ${result.status}`;
    if (result.error && /** @type {{code?: string}} */ (result.error).code === "ENOENT") {
      return fail(name, `${command.argv[0]} is not on PATH${shared}`);
    }
    if (seconds >= command.timeoutSec) {
      return fail(name, `${measured}: this command cannot pass its own verification entry${shared} · ${exit}`);
    }
    if (seconds >= command.timeoutSec * VERIFICATION_DURATION_WARN_RATIO) {
      return fail(name, `${measured}: within ${Math.round((1 - VERIFICATION_DURATION_WARN_RATIO) * 100)}% of the cap, so growth will break it${shared} · ${exit}`, true);
    }
    return pass(name, `${measured}${shared} · ${exit}`);
  });
}

/**
 * Collect initial worker/judge runtimes and every runtime reachable through
 * the one declared fallback hop, preserving each capability requirement so a
 * runtime a run might fall over to is checked before it runs.
 *
 * The enumeration is exactly the reachable-state set the run can actually
 * occupy: a node's role starts on its assigned runtime, and — if that
 * runtime declares a `fallback` — may take exactly one hop to it. It never
 * re-derives `failoverTargets` from the hop target itself, so a chain like
 * A.fallback=B, B.fallback=C never probes C for a node assigned A: that node
 * can take only one hop, and its reachable set stops at B.
 *
 * @param {ValidatedContract} contract
 * @returns {ReachableRuntimes}
 */
export function reachableRuntimes(contract) {
  /** @type {ReachableRuntimes} */
  const runtimes = new Map();
  for (const node of contract.nodes) {
    for (const role of /** @type {("worker"|"judge")[]} */ (["worker", ...(node.gate.enabled ? ["judge"] : [])])) {
      const explicit = role === "judge" ? node.gate.runtime ?? contract.runtimeDefaults?.judge : node.runtime ?? contract.runtimeDefaults?.worker;
      const fallbackId = role === "worker"
        ? Object.keys(contract.runtimes)[0]
        : Object.entries(contract.runtimes).find(([, candidate]) => candidate.vendor !== contract.runtimes[Object.keys(contract.runtimes)[0]]?.vendor)?.[0]
          ?? Object.keys(contract.runtimes)[0];
      if (!fallbackId) throw new Error("runtime discovery catalogue is empty");
      const runtime = explicit
        ? /** @type {RuntimeSnapshot} */ (routeRuntime(contract, node, role))
        : runtimeSnapshot(contract, fallbackId);
      // The judge role carries no extra capability set: the verdict contract
      // is enforced at the review boundary (judgePrompt embeds the schema in
      // the prompt text, parseJudge validates, the bounded re-ask arbiters),
      // so a harness without a schema channel — zcode — can still judge.
      const required = role === "judge"
        ? [runtime.requiredCapabilities, node.gate.requiredCapabilities]
        : [runtime.requiredCapabilities, node.requiredCapabilities];
      const requiredCapabilitySets = required.filter((item) => item !== undefined);
      if (explicit) addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets);
      const current = { node, role, runtimeId: /** @type {string} */ (runtime.id) };
      for (const fallbackRuntime of failoverTargets(contract, current)) {
        addRuntimeRequirement(runtimes, fallbackRuntime, requiredCapabilitySets, Boolean(explicit));
      }
      if (!explicit) {
        // Nothing names a runtime for this role, so availability discovery
        // picks one at dispatch and every catalogue entry is a candidate --
        // including the stand-in above, which was chosen as "the first entry"
        // and is no more routed than the rest. They are reachable, so their
        // capabilities still have to hold, but none of them is a runtime this
        // run committed to: requiring a binary for each turned one absent
        // harness into a refusal of a run that would never have used it.
        addRuntimeRequirement(runtimes, runtime, requiredCapabilitySets, false);
        for (const candidate of Object.keys(contract.runtimes)) {
          addRuntimeRequirement(runtimes, runtimeSnapshot(contract, candidate), requiredCapabilitySets, false);
        }
      }
    }
  }
  return runtimes;
}


/**
 * Read the live verdict off one `preflightContract` probe, in the detail it
 * embeds: `… · live <status> · <code>: …` for an ask that failed, and the
 * repository wording when no runtime could be asked at all. Any verdict a
 * provider produced — a quota refusal, an auth failure, unparsable output —
 * is an answer; a silence is a verdict of nothing and is never recorded, so
 * the operator who fixes the host is never told the fix "already answered".
 *
 * @param {ProbeResult} probe
 * @returns {{answered: boolean, cause: string|null, recorded: boolean}}
 */
function liveVerdict(probe) {
  if (probe.liveStatus === "done") return { answered: true, cause: null, recorded: true };
  // `liveSilenceCause` is the dispatch gate's own classification, imported
  // rather than restated. A second copy here had `command_invalid` in it,
  // which the gate deliberately does not: a command that could not be
  // constructed never reached a provider, so there is no availability verdict
  // to report either way. Two copies of this rule is how doctor and the gate
  // would come to disagree about whether an answer was an answer.
  const silence = liveSilenceCause(probe);
  if (silence !== null) return { answered: false, cause: silence, recorded: false };
  const match = / · live \S+ · ([a-z_]+):/u.exec(probe.detail ?? "");
  const cause = match?.[1] ?? null;
  if (cause === null) return { answered: false, cause, recorded: false };
  return { answered: true, cause, recorded: true };
}

/**
 * The live half of `doctor`: the verdict, not the version. The two catalogue
 * surfaces (`models`, `models --probe`) name this report the authoritative
 * word on availability, so with a contract doctor asks what the dispatch
 * gate asks — one trivial prompt per routed runtime through
 * `preflightContract` — and reports beside the version checks what
 * answered, naming the cause when nothing did.
 *
 * A verdict this machine recorded inside the preflight window is reused
 * rather than re-bought, and every ask that reached a provider is recorded
 * in turn: the store (`run/availability.mjs`) is the only cache; none is
 * built here.
 *
 * Every check returned here is advisory. `ok` carries the honest verdict —
 * false when nothing answered — but the lines never gate `doctor`'s exit
 * code: the report is where the operator reads what answered, and blocking
 * on silence is the dispatch gate's decision, made on the same causes. A
 * doctor that failed on a runtime it could not ask inside its own sandbox
 * (a relative-executable wrapper) would report the runtime broken when the
 * actual launch may resolve it fine.
 *
 * @param {string} contractPath the authored contract, re-read and re-validated by the ask
 * @param {ReachableRuntimes} runtimes
 * @returns {Promise<EnvCheck[]>}
 */
async function liveAvailabilityChecks(contractPath, runtimes) {
  /** @type {Map<string, RuntimeAvailability>} */
  const fresh = new Map();
  for (const [id, { runtime }] of runtimes) {
    const verdict = readAvailability(availabilityKey({
      harness: runtime.harness,
      model: runtime.model,
      executable: getHarness(runtime.harness).executable(runtime),
    }));
    if (verdict) fresh.set(id, verdict);
  }
  if (runtimes.size > 0 && fresh.size === runtimes.size) {
    return [...runtimes.keys()].map((id) => {
      const verdict = /** @type {RuntimeAvailability} */ (fresh.get(id));
      return {
        name: `availability ${id}`,
        ok: true,
        advisory: true,
        detail: `answered · verdict reused · observed ${verdict.observedAt ?? "unknown instant"}`,
      };
    });
  }
  // The ask is imported where it runs: live-preflight imports this module's
  // reachableRuntimes, so a static edge here would be the runtime import
  // cycle the source gate bans. At call time both modules are fully
  // evaluated; this is a plain cache hit, not a cycle.
  const { preflightContract } = await import("../engine/live-preflight.mjs");
  // measured 2026-09-22 (dispatch gate): four routed runtimes asked in
  // parallel took about 18s, so 60s is the budget; FABERUN_PREFLIGHT_TIMEOUT_SEC
  // is the same operator override the gate honours.
  const override = Number(process.env.FABERUN_PREFLIGHT_TIMEOUT_SEC);
  const timeoutSec = process.env.FABERUN_PREFLIGHT_TIMEOUT_SEC !== undefined && Number.isFinite(override) && override > 0 ? override : 60;
  const probes = await preflightContract(contractPath, { liveTimeoutSec: timeoutSec });
  recordAvailability(probes.filter((probe) => liveVerdict(probe).recorded).map((probe) => availabilityKey(probe)));
  return probes.map((probe) => {
    const verdict = liveVerdict(probe);
    return {
      name: `availability ${probe.id ?? probe.harness}`,
      ok: verdict.answered,
      advisory: true,
      detail: verdict.answered
        ? `answered · ${probe.detail ?? `the provider answered (${verdict.cause})`}`
        : `no answer · ${probe.detail ?? `cause ${verdict.cause ?? "unknown"}`}`,
    };
  });
}

const HARNESS_BIN_OVERRIDES = Object.freeze({
  codex: "FABERUN_CODEX_BIN",
  claude: "FABERUN_CLAUDE_BIN",
  agy: "FABERUN_AGY_BIN",
  zcode: "FABERUN_ZCODE_BIN",
  "exec-jsonl": "FABERUN_EXEC_JSONL_BIN",
});

/**
 * Environment doctor: repository prerequisites, ignored .runs, required
 * binaries, the dispatch environment gate, and (when a contract is given)
 * the harness versions beside the live availability verdict per routed
 * runtime — the report `models` defers to. Without a contract it says
 * plainly that it asked nothing.
 *
 * The exit code answers the host-fact question it always answered: the
 * live availability lines carry their verdict (false when nothing
 * answered) but are advisory, because blocking on silence is the dispatch
 * gate's job and a runtime doctor could not ask inside its own sandbox is
 * not thereby a runtime the launch cannot run.
 *
 * @param {string|undefined} contractPath
 * @param {{cwd?: string, json?: boolean, discover?: boolean}} values
 * @returns {Promise<boolean>}
 */
export async function doctorCommand(contractPath, values) {
  const repoDir = resolve(values.cwd ?? ".");
  /** @type {{name: string, ok: boolean, advisory?: boolean, detail: string}[]} */
  const checks = [];
  const gitRepo = isGitWorkTree(repoDir);
  checks.push({ name: "git repository", ok: gitRepo, detail: gitRepo ? repoDir : "not inside a git work tree" });
  const runsIgnored = isRunsIgnored(repoDir);
  checks.push({
    name: ".runs ignored",
    ok: runsIgnored,
    detail: runsIgnored ? ".runs/ is git-ignored" : ".runs/ is not git-ignored; add .runs/ to .gitignore",
  });
  for (const binary of ["node", "npm"]) {
    const found = findExecutable(binary);
    checks.push({ name: `binary ${binary}`, ok: found !== null, detail: found ?? "not found on PATH" });
  }
  checks.push({ name: "runner schema", ok: true, detail: `protocol ${PROTOCOL_SCHEMA_VERSION} · runner ${CONTRACT_VERSION}` });
  // A stale seed still prices better than no seed, so this check informs and
  // never fails: a fact beside the runner-schema line, not a gate like the
  // advisory checks below it, which exist because they can genuinely fail.
  const seedAge = pricingSeedAge();
  checks.push({
    name: "pricing seed",
    ok: true,
    detail: seedAge.stale
      ? `models.dev rates vendored ${seedAge.fetchedAt} · ${seedAge.ageDays} days old; re-vendor src/engine/pricing-seed.json`
      : `models.dev rates vendored ${seedAge.fetchedAt}`,
  });
  /** @type {Set<string>} */
  let usedHarnesses = new Set();
  /** @type {Set<string>} */
  const overriddenHarnesses = new Set();
  /** @type {ReachableRuntimes} */
  let routedRuntimes = new Map();
  /** @type {Record<string, string|null>} */
  const harnessVersions = {};
  /** @type {Record<string, import("../engine/runtime-discovery.mjs").RuntimeAvailability>} */
  let discovered = {};
  let dispatchCwd = repoDir;
  if (contractPath) {
    const absolute = resolve(contractPath);
    try {
      const contract = validateContract(JSON.parse(readFileSync(absolute, "utf8")), absolute);
      checks.push({ name: "contract", ok: true, detail: `${contract.id} · ${contract.nodes.length} node${contract.nodes.length === 1 ? "" : "s"}` });
      const runtimes = reachableRuntimes(contract);
      routedRuntimes = runtimes;
      dispatchCwd = contract.cwd;
      usedHarnesses = new Set([...runtimes.values()].map(({ runtime }) => runtime.harness));
      for (const runtime of Object.values(contract.runtimes)) {
        if (typeof runtime.executable === "string") overriddenHarnesses.add(runtime.harness);
      }
      for (const [id, { runtime, requiredCapabilitySets }] of runtimes) {
        const probe = await probeRuntime(runtime, { cwd: contract.cwd, requiredCapabilitySets });
        harnessVersions[id] = probe.version;
        checks.push({ name: `harness ${probe.id ?? runtime.harness}`, ok: probe.ok, detail: probe.detail ?? (probe.ok ? "ok" : "probe failed") });
      }
      // The verdict beside the version: a binary that answered --version is
      // not thereby a provider that answered, and the report names which of
      // the two failed because the remedies differ.
      checks.push(...await liveAvailabilityChecks(absolute, runtimes));
    } catch (error) {
      checks.push({ name: "contract", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "contract", ok: true, detail: "no contract.json provided; skipping runtime probes" });
  }
  if (values.discover === true) {
    const discoveryRuntimes = contractPath
      ? (() => {
        try { return validateContract(JSON.parse(readFileSync(resolve(contractPath), "utf8")), resolve(contractPath)).runtimes; } catch { return {}; }
      })()
      : /** @type {Record<string, import("../contract/index.mjs").ValidatedRuntime>} */ (DISCOVERY_RUNTIME_DEFINITIONS);
    discovered = await discoverRuntimes(discoveryRuntimes, { cwd: dispatchCwd });
    const available = Object.values(discovered).filter((entry) => entry.available).length;
    checks.push({
      name: "runtime discovery",
      ok: available > 0,
      detail: Object.entries(discovered).map(([id, entry]) => `${id}: ${entry.available ? "available" : `unavailable (${entry.reason})`}${entry.exhaustedUntil ? ` until ${entry.exhaustedUntil}` : ""}`).join(" · ") || "no runtimes discovered",
    });
  }
  // A PATH-only check must not fail a runtime whose binary is supplied through
  // an explicit executable or a FABERUN_*_BIN override; the harness probe above
  // already validated whatever the runtime actually resolves to. `zcode` is
  // absent on purpose — its binary is a shim the harness writes on first use, so
  // a PATH miss here is the normal state of a fresh machine, not a missing
  // dependency; `dsh` runs through its own SDK client, not a PATH binary.
  for (const binary of ["codex", "claude", "agy", "exec-jsonl"]) {
    const overrideName = /** @type {Record<string, string>} */ (HARNESS_BIN_OVERRIDES)[binary];
    const overridden = overriddenHarnesses.has(binary) || Boolean(process.env[overrideName]);
    const found = findExecutable(binary);
    const required = usedHarnesses.has(binary) && !overridden;
    checks.push({
      name: `binary ${binary}`,
      ok: !required || found !== null,
      detail: overridden && !found ? "resolved via executable or env override" : required ? (found ?? "required by contract but not found on PATH") : (found ? "present" : "not on PATH (not required by this contract)"),
    });
  }
  for (const check of environmentPreflight({ cwd: dispatchCwd, runtimes: routedRuntimes, harnessVersions }).checks) {
    checks.push({ name: check.name, ok: check.ok || check.advisory, detail: check.ok ? check.detail : `${check.detail} (advisory)` });
  }
  // The live availability lines never gate the verdict: a no-answer is the
  // finding it is on its own line (ok false, cause named), and what still
  // fails doctor is every host fact and static probe — which is why the
  // nonexistent-binary case below exits non-zero while a merely silent
  // provider does not.
  const ok = checks.every((check) => check.ok || check.advisory === true);
  const transportWarning = noTransportWarning(process.env);
  if (transportWarning) process.stderr.write(`${statusToken("warn", colorLevel(process.env, process.stderr.isTTY))} ${transportWarning}\n`);
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, repo: repoDir, ok, checks, ...(values.discover === true ? { runtimes: discovered } : {}) }, null, 2)}\n`);
  } else {
    const level = colorLevel(process.env, process.stdout.isTTY);
    for (const check of checks) process.stdout.write(`${statusToken(check.ok ? "ok" : "fail", level)} ${check.name} · ${check.detail}\n`);
  }
  return ok;
}

/**
 * @param {string} repoDir
 * @returns {boolean}
 */
function isGitWorkTree(repoDir) {
  if (existsSync(join(repoDir, ".git"))) return true;
  try {
    const result = boundedGitSync(["-C", repoDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 && String(result.stdout).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Whether the runs directory name is ignored in `repoDir`.
 *
 * Not dead cleanup after run state moved under the faberun home: an attempt
 * worktree is still a git working tree, and R3 keeps the worker's result
 * sidecar inside it, under `.runs/`. The ignore line is what keeps that
 * sidecar out of the worktree's scope diff, so this check -- and the
 * `.gitignore` line `cli/init.mjs` writes -- survive the move.
 *
 * @param {string} repoDir
 * @returns {boolean}
 */
function isRunsIgnored(repoDir) {
  try {
    const result = boundedGitSync(["-C", repoDir, "check-ignore", "-q", RUNS_DIR_NAME], { stdio: ["ignore", "ignore", "ignore"] });
    if (result.status === 0) return true;
  } catch {
    // A git that cannot run leaves the check-ignore answer unknown; fall through to reading .gitignore directly.
  }
  try {
    const gitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
    return gitignore.split(/\r?\n/u).some((line) => /^\.runs\/?$/u.test(line.trim()));
  } catch {
    return false;
  }
}
