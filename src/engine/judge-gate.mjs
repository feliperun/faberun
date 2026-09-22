/**
 * Conditional judge gate for schema-2 Definition of Done items.
 *
 * Deterministic items carry a mechanical `proof` (a verification command, a
 * workspace path, or a `verification` entry reused by reference) and gate
 * first: the controller settles them and no judge invocation is spent until
 * they pass. The judge arbitrates only `judgment` items, and a gate-failing
 * rejection whose findings cite no judgment item id is a judge protocol
 * failure — one bounded re-ask, then blocked attention — that never consumes a
 * worker revision.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { reviewMode, UNCITED_REJECTION_REASON } from "../contract/review-modes.mjs";
import { JUDGE_LIMITS } from "../contract/judge-envelope.mjs";
import { sharedVerificationCommands } from "../contract/final-verification.mjs";
import { killTarget } from "../host/platform.mjs";

/** @typedef {import("../contract/definition-of-done.mjs").DefinitionOfDoneItem} DefinitionOfDoneItem */
/** @typedef {import("../contract/verification.mjs").VerificationCommand} VerificationCommand */
/** @typedef {import("../contract/definition-of-done.mjs").DefinitionOfDoneProof} DefinitionOfDoneProof */
/** @typedef {import("../contract/index.mjs").ExecutionOverride} ExecutionOverride */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../contract/index.mjs").VerificationState} VerificationState */

const MAX_PROOF_OUTPUT_BYTES = 4 * 1024;

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string}
 */
function boundedText(value, maxBytes = MAX_PROOF_OUTPUT_BYTES) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // The marker costs 3 bytes in UTF-8 and a byte-aligned cut can land inside a
  // multibyte character, whose replacement costs 3 more. Reserve the marker and
  // then shrink until the encoded result actually fits: a finding that exceeds
  // the validator's evidence ceiling is not truncated downstream, it throws, and
  // the throw kills the controller mid-gate.
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return "";
  let room = maxBytes - markerBytes;
  let out = `${bytes.subarray(0, room).toString("utf8")}${marker}`;
  while (room > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
    room -= 1;
    out = `${bytes.subarray(0, room).toString("utf8")}${marker}`;
  }
  return out;
}

/** @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node @returns {DefinitionOfDoneItem[]} */
function mechanicalItems(node) {
  return (node.definitionOfDone ?? []).filter((item) => item.proof !== undefined);
}

/** @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node @returns {DefinitionOfDoneItem[]} */
export function judgmentItems(node) {
  return (node.definitionOfDone ?? []).filter((item) => item.judgment === true);
}

/** A gated node runs the judge only when its review mode is not `none` and a Definition of Done item carries judgment:true; an empty, purely deterministic, or review-free checklist settles mechanically without spending a judge invocation. @param {{definitionOfDone?: DefinitionOfDoneItem[], gate?: {enabled?: boolean, review?: unknown}}} node @returns {boolean} */
export function judgeRequired(node) {
  return reviewMode(node.gate) !== "none"
    && (node.definitionOfDone ?? []).some((item) => item.judgment === true);
}

/**
 * The green-and-small escape hatch: the contract declared `gate.skipWhen`, the
 * controller verification passed, and the persisted workspace scope recorded no
 * more changed paths than the declared ceiling. Both conditions must hold, and
 * this predicate overrides `judgment: true` — that is its whole purpose. It
 * composes with `reviewMode` rather than replacing it: `judgeRequired` still
 * owns the `none` case, and a gate with no `skipWhen` behaves exactly as before.
 *
 * @param {{gate?: {skipWhen?: {verificationGreen: true, maxChangedPaths: number}}}} node
 * @param {{verification?: {passed?: boolean}|null, scope?: {changedPathCount?: number, changedPaths?: string[]}|null}} state
 * @returns {boolean}
 */
export function judgeSkippedByScope(node, state) {
  const skipWhen = node.gate?.skipWhen;
  if (!skipWhen) return false;
  if (state.verification?.passed !== true) return false;
  const changed = typeof state.scope?.changedPathCount === "number"
    ? state.scope.changedPathCount
    : Array.isArray(state.scope?.changedPaths) ? state.scope.changedPaths.length : null;
  return typeof changed === "number" && changed <= skipWhen.maxChangedPaths;
}

/**
 * @param {DefinitionOfDoneItem[]} items
 * @param {string} cwd
 * @param {{timeoutMs?: number, verification?: VerificationState|null}} [options]
 * @returns {Promise<Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>>}
 */
async function runMechanicalProofs(items, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const recorded = options.verification?.commands ?? [];
  const results = [];
  for (const item of items) {
    const proof = item.proof;
    if (proof === undefined) continue;
    results.push(proof.kind === "path"
      ? await provePath(item.id, proof, cwd)
      : proof.kind === "verification"
        ? proveVerification(item.id, proof, recorded)
        : await proveCommand(item.id, proof, cwd, timeoutMs));
  }
  return results;
}

/**
 * Reuse the recorded result of one controller verification entry: pass or fail
 * and its bounded output, with nothing executed. The reference is positional,
 * so the entry this attempt recorded is exactly the entry the packet named.
 *
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {Array<{argv: string[], passed: boolean, attempts?: Array<{exitCode?: number|null, stdout?: string, stderr?: string}>}>} recorded
 * @returns {{id: string, kind: "verification", ref: string, pass: boolean, detail: string}}
 */
function proveVerification(id, proof, recorded) {
  const index = Number.parseInt(proof.ref, 10);
  const entry = Number.isInteger(index) ? recorded[index] : undefined;
  if (!entry) {
    return { id, kind: "verification", ref: proof.ref, pass: false, detail: `verification command ${proof.ref} has no recorded result for this attempt` };
  }
  const attempt = entry.attempts?.at(-1);
  const output = [attempt?.stderr, attempt?.stdout].find((text) => typeof text === "string" && text.trim()) ?? "";
  const detail = entry.passed
    ? `reused recorded verification result: ${entry.argv.join(" ")} passed`
    : boundedText(`reused recorded verification result: ${entry.argv.join(" ")} failed: ${output.trim()}`);
  return { id, kind: "verification", ref: proof.ref, pass: entry.passed === true, detail };
}

/**
 * A command proof that declares a node:test filter (`--test-name-pattern`,
 * `--test-skip-pattern`) is judged on more than its exit code, because the
 * runner exits 0 whether its filter selected anything or not. The proof runs
 * with the TAP reporter selected through `NODE_OPTIONS` and is refused when the
 * output carries TAP's zero-plan line. Measured 2026-09-21 on node v26.8.1: a
 * filter that matches emits `1..0` zero times, a filter that matches nothing
 * emits it exactly once, a run with no filter emits it zero times, and an empty
 * suite under a matching filter emits no nested zero plan. The default reporter
 * cannot make the distinction -- both cases print identical counters, because
 * the tick is the file rather than a test. The reporter goes through the
 * environment because appending `--test-reporter=tap` to the command string is
 * a no-op whenever a test file precedes it: node reads its own options
 * left to right, so the flag lands among the script's arguments and the runner
 * never sees it.
 */
const TEST_FILTER_FLAGS = ["--test-name-pattern", "--test-skip-pattern"];
const TAP_ZERO_PLAN = /^1\.\.0$/mu;

/**
 * The environment a filtered proof runs under: the ambient environment with
 * the TAP reporter selected through `NODE_OPTIONS`, minus `NODE_TEST_CONTEXT`.
 * That marker belongs to whichever test runner spawned this process; a nested
 * `node --test` that inherits it stays a runner child and emits no TAP at all
 * (measured 2026-09-21: with the marker the zero-plan line never appears,
 * without it exactly once) -- and a proof is judged as its own top-level run,
 * not as the suite's child.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function envForFilteredProof() {
  const { NODE_TEST_CONTEXT: _outer, NODE_OPTIONS: existing, ...ambient } = process.env;
  return { ...ambient, NODE_OPTIONS: existing ? `${existing} --test-reporter=tap` : "--test-reporter=tap" };
}

/**
 * The node:test filters a command string declares, in argv order, as flag and
 * value. Presence alone changes behaviour (the appended reporter and the
 * zero-plan look-up); the value is read for the refusal detail alone, which is
 * why a whitespace split is close enough even though the command runs through
 * a shell.
 *
 * @param {string} ref
 * @returns {Array<{flag: string, value: string}>}
 */
function declaredTestFilters(ref) {
  const tokens = ref.split(/\s+/u).filter(Boolean);
  /** @type {Array<{flag: string, value: string}>} */
  const filters = [];
  for (const [index, token] of tokens.entries()) {
    for (const flag of TEST_FILTER_FLAGS) {
      if (token.startsWith(`${flag}=`)) filters.push({ flag, value: unquote(token.slice(flag.length + 1)) });
      else if (token === flag) filters.push({ flag, value: unquote(tokens[index + 1] ?? "") });
    }
  }
  return filters;
}

/** @param {string} value @returns {string} */
function unquote(value) {
  return value.replace(/^['"]|['"]$/gu, "");
}

/** @param {Array<{flag: string, value: string}>} filters @returns {string} */
function filterNames(filters) {
  return filters.map(({ flag, value }) => `${flag} "${value}"`).join(", ");
}

/**
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<{id: string, kind: "command"|"path", ref: string, pass: boolean, detail: string}>}
 */
async function proveCommand(id, proof, cwd, timeoutMs) {
  const ref = proof.ref;
  const filters = declaredTestFilters(ref);
  return new Promise((settle) => {
    // Detached on POSIX so the shell leads its own process group: `shell: true`
    // means the timeout must kill the group, not the shell, or the command the
    // shell started keeps running and keeps the result pending forever.
    const child = spawn(ref, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...(filters.length ? { env: envForFilteredProof() } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (/** @type {{id: string, kind: "command", ref: string, pass: boolean, detail: string}} */ result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdout?.destroy(); } catch {
        // The stream already closed; destroying it again is a no-op.
      }
      try { child.stderr?.destroy(); } catch {
        // The stream already closed; destroying it again is a no-op.
      }
      settle(result);
    };
    const timer = setTimeout(() => {
      terminateProofGroup(child);
      finish({ id, kind: "command", ref, pass: false, detail: boundedText(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_PROOF_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_PROOF_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ id, kind: "command", ref, pass: false, detail: boundedText(error.message) });
    });
    child.on("close", (code, signal) => {
      // Its own detail, not an ordinary command failure: the command succeeded,
      // so what failed is that the declared filter selected nothing to prove.
      if (code === 0 && signal === null && filters.length > 0 && TAP_ZERO_PLAN.test(stdout)) {
        finish({
          id,
          kind: "command",
          ref,
          pass: false,
          detail: boundedText(`${filterNames(filters)} selected no test: exit 0 over a TAP plan of 1..0, so the proof measured nothing`),
        });
        return;
      }
      const detail = signal !== null ? `killed by ${signal}` : `exit ${code ?? "?"}`;
      const pass = code === 0 && signal === null;
      finish({ id, kind: "command", ref, pass, detail: pass ? detail : boundedText(`${detail}: ${(stderr || stdout).trim()}`) });
    });
  });
}

/**
 * Kill the proof command's process group, then make sure it is gone. The group
 * is the shell and everything it started; killing only the shell was the bug
 * that let a timed-out proof hold the pipe and never settle.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function terminateProofGroup(child) {
  const pid = child.pid;
  if (!pid) return;
  const signal = (/** @type {NodeJS.Signals} */ name) => {
    try {
      killTarget(process.platform === "win32" ? pid : -pid, name);
    } catch {
      try { child.kill(name); } catch {
        // ESRCH: the group and the leader are already gone.
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 100).unref();
}

/**
 * @param {string} id
 * @param {DefinitionOfDoneProof} proof
 * @param {string} cwd
 * @returns {Promise<{id: string, kind: "command"|"path", ref: string, pass: boolean, detail: string}>}
 */
async function provePath(id, proof, cwd) {
  const ref = proof.ref;
  try {
    const target = isAbsolute(ref) ? ref : resolve(cwd, ref);
    const info = await stat(target);
    return { id, kind: "path", ref, pass: true, detail: `${info.isDirectory() ? "directory" : "file"} exists` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, kind: "path", ref, pass: false, detail: boundedText(message) };
  }
}

/**
 * Verdict a deterministic gate from its per-item mechanical results: pass only
 * when every proof passed.
 *
 * @param {Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>} results
 * @returns {import("./prompts.mjs").JudgeVerdict}
 */
export function mechanicalVerdict(results) {
  const failed = results.filter((result) => !result.pass);
  if (!failed.length) {
    return {
      verdict: "pass",
      maxSeverity: "none",
      summary: "every deterministic Definition of Done item passed",
      findings: [],
    };
  }
  return {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "deterministic Definition of Done item failed",
    findings: failed.map((result) => ({
      severity: "critical",
      description: `Definition of Done item [${result.id}] failed its ${result.kind} proof`,
      evidence: boundedText(`${result.ref}: ${result.detail}`),
    })),
  };
}

/**
 * The deterministic evidence a judge protocol re-ask must reuse: the round's
 * mechanical proofs already passed before the first ask, so the re-ask prompt
 * reports every deterministic item as proven without re-running any proof.
 *
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @returns {Array<{id: string, kind: "command"|"path"|"verification", ref: string, pass: boolean, detail: string}>}
 */
function provenDeterministicResults(node) {
  return mechanicalItems(node).map((item) => {
    const proof = /** @type {DefinitionOfDoneProof} */ (item.proof);
    return { id: item.id, kind: proof.kind, ref: proof.ref, pass: true, detail: "" };
  });
}

/**
 * Deterministic evidence of one gate round plus its mechanical verdict. The
 * first ask settles every mechanical proof (a command proof executes; a
 * verification proof reuses its recorded result); a judge protocol re-ask
 * reuses the round's proven items and never re-runs a proof, so a flaky second
 * execution cannot consume a worker revision on the protocol failure path.
 *
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @param {string} cwd
 * @param {boolean} reask
 * @param {number} timeoutMs
 * @param {VerificationState|null} [verification] this attempt's recorded verification results
 * @returns {Promise<{verdict: import("./prompts.mjs").JudgeVerdict, results: Array<{id: string, pass: boolean, detail: string}>}>}
 */
export async function deterministicGate(node, cwd, reask, timeoutMs, verification = null) {
  const results = reask
    ? provenDeterministicResults(node)
    : await runMechanicalProofs(mechanicalItems(node), cwd, { timeoutMs, verification });
  return { verdict: mechanicalVerdict(results), results };
}

/**
 * Node's test runner prints `test at <path>:<line>:<column>` immediately before
 * each failing test. That is the only place the file a suite accused is written
 * down, so it is read exactly as the runner wrote it -- inventing a format of
 * our own would lie the first time the runner changed.
 */
const NODE_TEST_LOCATION = /^test at (.+?):\d+(?::\d+)?\s*$/gmu;

/** @param {unknown} value @returns {string} */
function stripAnsi(value) {
  return String(value ?? "").replace(/\u001b\[[0-9;]*m/gu, "");
}

/**
 * Test files named by the captured output of failing verification commands.
 *
 * @param {Array<{attempts?: Array<{stdout?: string, stderr?: string}>}>} commands
 * @returns {string[]}
 */
function namedTestFiles(commands) {
  /** @type {string[]} */
  const paths = [];
  const seen = new Set();
  for (const command of commands) {
    for (const attempt of command.attempts ?? []) {
      for (const stream of [attempt.stdout, attempt.stderr]) {
        for (const match of stripAnsi(stream).matchAll(NODE_TEST_LOCATION)) {
          const path = match[1].trim();
          if (!path || seen.has(path)) continue;
          seen.add(path);
          paths.push(path);
        }
      }
    }
  }
  return paths;
}

/**
 * Whether a path named by verification output sits inside the write scope the
 * node persisted. `state.scope.boundary` is the captured form of the packet's
 * `writeFiles` plus `writeRoots`, so it is the only copy of the declared scope
 * available at settlement time; `fileRoots` are exact paths, the rest of
 * `roots` cover their subtree.
 *
 * @param {{scope?: {boundary?: {files?: string[], roots?: string[], fileRoots?: string[]}}|null}|null|undefined} state
 * @returns {(path: string) => boolean}
 */
function declaredWriteCoverage(state) {
  const boundary = state?.scope?.boundary;
  const files = new Set(boundary?.files ?? []);
  const fileRoots = new Set(boundary?.fileRoots ?? []);
  const directoryRoots = (boundary?.roots ?? []).filter((root) => !fileRoots.has(root));
  return (path) =>
    files.has(path) ||
    fileRoots.has(path) ||
    directoryRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Whether a path named by verification output belongs to the contract's own
 * `sharedVerification` suite -- the repository ratchets the operator appends to
 * every node -- rather than to the node's own work. An argv entry names either
 * the file the runner was given or a directory it walked.
 *
 * Deliberately not caught: a `sharedVerification` that reaches the ratchet
 * without naming it in argv (`npm test`, or any script that picks the files
 * itself). No token matches, the file is not recognized as a ratchet, and the
 * contract-defect advice applies to it as it did before. Widening the match to
 * guess what a script runs would be worse than the gap it closes.
 *
 * @param {{sharedVerification?: VerificationCommand[]}} contract
 * @returns {(path: string) => boolean}
 */
function sharedVerificationCoverage(contract) {
  const argv = sharedVerificationCommands(contract).flatMap((command) => command.argv);
  return (path) => argv.some((token) => token === path || path.startsWith(`${token}/`));
}

/**
 * The operator-facing description for a failing ratchet: a check the contract
 * itself declared, that runs on every node, and that this node's change broke.
 *
 * It says nothing about the write scope on purpose. Telling the operator to
 * hand the node the ratchet licenses the next worker to edit the rule it just
 * violated -- observed 2026-09-21, when a node that pushed
 * `src/report/render.mjs` to 801 lines was advised to add the 800-line ratchet
 * to its `writeFiles`. The remedy is already inside the node's scope: its own
 * code.
 *
 * @param {string[]} paths
 * @returns {string}
 */
function ratchetFailureDescription(paths) {
  const files = paths.join(", ");
  return boundedText(
    `deterministic verification failed in ${files}, which the contract runs on every node as sharedVerification: this node's change broke a repository-wide rule. The remedy is in the node's own code -- bring the change back within the rule the check enforces. The check itself is not the node's to change, and relaxing it is not a fix`,
    JUDGE_LIMITS.descriptionBytes,
  );
}

/**
 * The operator-facing description for a failure that named a test outside the
 * declared write scope. The defect is not in the worker's code: the worker is
 * forbidden from touching the test, so the contract that withheld it is what
 * has to change. The message names the file and says to fix the contract.
 *
 * @param {string[]} paths
 * @returns {string}
 */
function undeclaredTestDescription(paths) {
  const files = paths.join(", ");
  const noun = paths.length === 1 ? "file" : "files";
  const pronoun = paths.length === 1 ? "it" : "them";
  return boundedText(
    `deterministic verification failed in undeclared test ${noun} ${files}; the node's writeFiles does not include ${pronoun}, so the worker cannot fix the failing test. This is a contract defect, not a worker defect: add ${files} to writeFiles or scopeAcknowledged and re-dispatch`,
    JUDGE_LIMITS.descriptionBytes,
  );
}

/**
 * The deterministic controller-verification failure verdict, kept next to the
 * Definition of Done gate so every deterministic failure settles identically.
 *
 * The contract is a parameter because an undeclared test file has two opposite
 * remedies and only the contract tells them apart: a ratchet it declared in
 * `sharedVerification` is the node's code to fix, while any other withheld test
 * is the contract's scope to widen.
 *
 * @param {{sharedVerification?: VerificationCommand[]}} contract
 * @param {{verification?: {commands?: Array<{argv: string[], passed?: boolean, attempts?: Array<{stdout?: string, stderr?: string, exitCode?: number|null, timedOut?: boolean}>}>, error?: unknown}|null, scope?: {boundary?: {files?: string[], roots?: string[], fileRoots?: string[]}}|null}} state
 * @returns {import("./prompts.mjs").JudgeVerdict}
 */
export function verificationFailureVerdict(contract, state) {
  const failedCommands = (state.verification?.commands ?? []).filter((command) => !command.passed);
  const evidence = failedCommands.length
    ? failedCommands.map((command) => `${command.argv.join(" ")}: ${(command.attempts ?? []).map((attempt) => `exit=${attempt.exitCode ?? "-"}${attempt.timedOut ? " timeout" : ""}`).join(", ")}`).join("; ")
    : state.verification?.error ?? "verification controller failed to execute a command";
  const declared = declaredWriteCoverage(state);
  const undeclared = namedTestFiles(failedCommands).filter((path) => !declared(path));
  const isRatchet = sharedVerificationCoverage(contract);
  const ratchets = undeclared.filter(isRatchet);
  const withheld = undeclared.filter((path) => !isRatchet(path));
  const descriptions = [
    ...(ratchets.length ? [ratchetFailureDescription(ratchets)] : []),
    ...(withheld.length ? [undeclaredTestDescription(withheld)] : []),
  ];
  return {
    verdict: "fail",
    maxSeverity: "critical",
    summary: "deterministic verification failed",
    findings: (descriptions.length ? descriptions : ["deterministic verification failed"]).map((description) => ({
      severity: "critical",
      description,
      evidence: boundedText(evidence),
    })),
  };
}

/**
 * The commands the integration candidate failed that the attempt had passed.
 *
 * A non-empty list means the two worktrees disagree about the environment
 * rather than about the work: the same commit ran the same command twice with
 * different outcomes. Without naming that, the failure reads as a defect in
 * the node's own changes — which is how a missing `node_modules` link in the
 * candidate once cost a campaign four attempts on already-correct work.
 * Commands are matched by position, never by comparing joined argv, since a
 * joined argv loses argument boundaries.
 *
 * @param {unknown} attempt the attempt's recorded verification
 * @param {unknown} candidate the candidate's recorded verification
 * @returns {string[]}
 */
export function candidateOnlyFailures(attempt, candidate) {
  const attemptCommands = verificationCommands(attempt);
  return verificationCommands(candidate)
    .map((command, index) => ({ command, counterpart: attemptCommands[index] }))
    .filter((pair) => pair.command.passed === false && pair.counterpart?.passed === true)
    .map((pair) => (pair.command.argv ?? []).join(" "));
}

/** @param {unknown} evidence @returns {Array<{argv?: string[], passed?: boolean}>} */
function verificationCommands(evidence) {
  const commands = /** @type {{commands?: unknown}} */ (evidence ?? {}).commands;
  return Array.isArray(commands) ? commands : [];
}

/**
 * A gate-failing judge verdict on a node with judgment items is a protocol
 * failure when none of its findings cites any judgment item id.
 *
 * @param {{verdict: string, findings: Array<{description: string, evidence: string}>}} verdict
 * @param {{definitionOfDone?: DefinitionOfDoneItem[]}} node
 * @returns {boolean}
 */
export function uncitedRejection(verdict, node) {
  const items = judgmentItems(node);
  if (verdict.verdict !== "fail" || items.length === 0) return false;
  const ids = new Set(items.map((item) => item.id));
  return !verdict.findings.some((finding) => citesItem(finding.description, ids) || citesItem(finding.evidence, ids));
}

/** @param {string} text @param {Set<string>} ids @returns {boolean} */
function citesItem(text, ids) {
  return text.split(/[^A-Za-z0-9._-]+/u).some((token) => ids.has(token));
}

/**
 * The execution-override kind that records a spent judge protocol re-ask. The
 * snapshot validator takes any override kind; only the kinds the recovery path
 * interprets are named in the contract's typedef, so this one is read and
 * written through the same record cast the recovery scan uses.
 */
const JUDGE_REASK_KIND = "judge-reask";

/** @param {ExecutionOverride} override @returns {boolean} */
function isJudgeReask(override) {
  return /** @type {Record<string, unknown>} */ (override).kind === JUDGE_REASK_KIND;
}

/** @param {NodeSnapshot} state @returns {Record<string, unknown>|null} */
function judgeReaskRecord(state) {
  const record = [...(state.executionOverrides ?? [])].reverse().find(isJudgeReask);
  return record ? /** @type {Record<string, unknown>} */ (record) : null;
}

/**
 * Spend the one bounded re-ask of the current judge round on the node state
 * itself. The record is only mutated in memory: the caller's transition — the
 * same atomic node write that persists the re-ask dispatch, the recovered
 * pending judge, or the blocked attention — carries it to disk. Bound and node
 * therefore move together, so no crash window can skip the permitted re-ask or
 * grant a second one.
 *
 * @param {NodeSnapshot} state
 * @param {string} [reason] what the re-ask answers, which selects its instruction
 */
export function markJudgeReask(state, reason = UNCITED_REJECTION_REASON) {
  if (judgeReaskOutstanding(state)) return;
  const record = /** @type {ExecutionOverride} */ (/** @type {unknown} */ ({
    kind: JUDGE_REASK_KIND,
    at: new Date().toISOString(),
    phase: "judge",
    reason,
  }));
  state.executionOverrides = [...(state.executionOverrides ?? []), record];
}

/** Whether the current judge round already spent its one bounded re-ask. @param {NodeSnapshot} state @returns {boolean} */
export function judgeReaskOutstanding(state) {
  return judgeReaskRecord(state) !== null;
}

/**
 * What the outstanding re-ask answers, so the re-dispatched prompt carries the
 * instruction the defect calls for.
 *
 * @param {NodeSnapshot} state
 * @returns {string|undefined}
 */
export function judgeReaskReason(state) {
  const reason = judgeReaskRecord(state)?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Release the bound when a judge round settles on a verdict that is not a protocol failure, so the next round is asked afresh. @param {NodeSnapshot} state */
export function clearJudgeReask(state) {
  if (!judgeReaskOutstanding(state)) return;
  state.executionOverrides = (state.executionOverrides ?? []).filter((item) => !isJudgeReask(item));
}

/**
 * Drop the routing override and progress snapshot so a fresh worker attempt
 * routes and meters from scratch.
 * @param {{routing?: {currentOverride?: unknown}|null, progress?: unknown}} state
 */
export function resetPhaseRouting(state) {
  if (state.routing) state.routing.currentOverride = null;
  state.progress = null;
}
