/**
 * Running a spec's declared commands against the repository as it stands:
 * the `measure` a planning fact is collected from, and the `proof` a
 * requirement claims. One spawn shape serves both, because they are the same
 * act — read the repository by running what the author wrote — and only the
 * caller's question differs.
 *
 * It lives apart from `repo-facts.mjs` for one measurable reason: `spec
 * validate` invokes no model, and the suite proves it by walking
 * `plan/spec.mjs`'s runtime import graph and refusing any reach into
 * `engine/` or `harnesses/`. `repo-facts.mjs` reaches `host/preflight.mjs`
 * for its verification timings, and that reaches every harness adapter. This
 * module imports node builtins and two environment variable names, so the
 * validator can run a proof without the graph growing a harness.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { NOTIFY_BIN_ENV } from "../notify/index.mjs";
import { NOTIFY_SESSION_ENV } from "../notify/session.mjs";

/** @typedef {import("./spec.mjs").SpecRequirement} SpecRequirement */
/** @typedef {{now?: () => number, run?: typeof import("node:child_process").spawnSync, pathExists?: (target: string) => boolean}} MeasureProbes */
/** @typedef {{requirementId: string|null, kind: "command"|"path", ref: string, pass: boolean, detail: string}} RequirementProofResult */

export const MEASURE_TIMEOUT_MS = 30_000;
/**
 * A proof is a test run, not a fact probe. Measured 2026-09-24: R6 of
 * `evals-with-a-budget` takes 98 s pinned to its file, and under the 30 s fact
 * bound the runner died on SIGTERM with exit 1, read as a failing proof. Ten
 * minutes has no measurement behind it beyond covering the slowest proof seen.
 */
const PROOF_TIMEOUT_MS = 600_000;
export const MEASURE_OUTPUT_CAP_BYTES = 4096;

/** How much of a failing proof's own output a finding carries: enough to name the failure, never the whole log. */
const PROOF_DETAIL_CAP = 200;

/**
 * The same named few `timeVerificationCommands` subtracts before spawning a
 * measurement (SIDE_EFFECT_ENV_KEYS in src/host/preflight.mjs, which is
 * module-private and could not be edited by the node that added this): a
 * measure must not notify a human and must not be redirectable at a live,
 * paid harness binary. A subtraction of a named few, not an allowlist — PATH,
 * HOME and every ordinary variable still pass through unchanged.
 */
export const MEASURE_SIDE_EFFECT_ENV_KEYS = [
  NOTIFY_BIN_ENV,
  NOTIFY_SESSION_ENV,
  "FABERUN_CODEX_BIN",
  "FABERUN_CLAUDE_BIN",
  "FABERUN_AGY_BIN",
  "FABERUN_DSH_BIN",
  "FABERUN_ZCODE_BIN",
  "FABERUN_EXEC_JSONL_BIN",
];

/**
 * The shell-capture core every declared command goes through: stripped
 * side-effect environment, an injectable `run` for tests, a hard timeout, and
 * output capped and reported as truncated rather than silently cut.
 *
 * The command goes through the shell (`spawnSync` with `shell: true`), so a
 * spec author's own pipe — `| wc -l`, `| grep -v …` — works exactly as typed
 * at a terminal. A non-zero exit is returned, never thrown: whether that is a
 * fact or a failure is the caller's question, not this function's.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {MeasureProbes} [probes]
 * @returns {{output: string, exitCode: number|null, truncated: boolean}}
 */
export function runShellCapture(cwd, command, probes = {}) {
  const { output, exitCode, truncated } = runShellFull(cwd, command, probes);
  const bytes = Buffer.from(output, "utf8");
  return {
    output: truncated ? bytes.subarray(0, MEASURE_OUTPUT_CAP_BYTES).toString("utf8") : output,
    exitCode,
    truncated,
  };
}

/**
 * The shell run behind `runShellCapture`, returning the whole output: a
 * pinned-test check has to see every test the runner reported, and the
 * matching line can sit far past the 4 KiB a measurement keeps.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {MeasureProbes} [probes]
 * @param {number} [timeoutMs]
 * @returns {{output: string, exitCode: number|null, truncated: boolean, timedOut: boolean}}
 */
function runShellFull(cwd, command, probes = {}, timeoutMs = MEASURE_TIMEOUT_MS) {
  const run = probes.run ?? spawnSync;
  const env = { ...process.env };
  for (const key of MEASURE_SIDE_EFFECT_ENV_KEYS) delete env[key];
  // A nested `node --test` that inherits NODE_TEST_CONTEXT stays a runner
  // child and prints no result at all (measured 2026-09-21, AGENTS.md), so a
  // proof run from inside a test runner would have nothing to show.
  delete env.NODE_TEST_CONTEXT;
  const result = run(command, { shell: true, cwd, timeout: timeoutMs, encoding: "utf8", env });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const timedOut = /** @type {NodeJS.ErrnoException|undefined} */ (result.error)?.code === "ETIMEDOUT";
  return { output: combined, exitCode: result.status, truncated: Buffer.byteLength(combined, "utf8") > MEASURE_OUTPUT_CAP_BYTES, timedOut };
}

/** `--test-name-pattern` in a shell command, quoted or bare, `=` or space. */
const NAME_PATTERN_FLAG = /--test-name-pattern(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/u;
/** A passing test as the spec reporter (`✔ name (1ms)`) or TAP (`ok 1 - name`) prints it. */
const PASSING_TEST_LINE = /^\s*(?:\u2714\s+|ok \d+ - )(.+?)(?:\s+\(\d[\d.]*m?s\))?\s*$/gmu;

/**
 * Whether a `node --test --test-name-pattern=<p>` proof ran a test named by
 * its pattern. Node exits 0 when the pattern matches nothing, printing only
 * the file, so the exit code alone cannot tell a proof from its absence.
 * Returns null when the command carries no pattern.
 *
 * @param {string} command
 * @param {string} output
 * @returns {boolean|null}
 */
function patternMatchedATest(command, output) {
  if (!/\bnode\b[^|;&]*--test\b/u.test(command)) return null;
  const flag = NAME_PATTERN_FLAG.exec(command);
  if (!flag) return null;
  const pattern = new RegExp(flag[1] ?? flag[2] ?? flag[3], "u");
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, "");
  return [...plain.matchAll(PASSING_TEST_LINE)].some((line) => pattern.test(line[1]) && !/\.m?[jt]s$/u.test(line[1].trim()));
}

/**
 * Run every requirement's declared `proof` against the repository as it
 * stands right now. `spec validate`'s traceability rule only checks that
 * `requirement.proof` is present, never that it passes, so a proof anchored
 * to a form the artifact no longer has still reads as covered. Measured
 * 2026-09-22: two requirements of one campaign's spec named a proof neither
 * could satisfy and `--strict-traceability` said nothing about either,
 * because it never ran them.
 *
 * A `judgment` proof cannot run without a model and is left unattempted —
 * absent from the results rather than reported as passing — the same
 * restraint `measureRequirements` already applies to its own unwired kinds.
 *
 * @param {string} cwd
 * @param {SpecRequirement[]} requirements
 * @param {MeasureProbes} [probes]
 * @returns {RequirementProofResult[]}
 */
export function proveRequirements(cwd, requirements, probes = {}) {
  /** @type {RequirementProofResult[]} */
  const results = [];
  for (const requirement of requirements) {
    const proof = requirement.proof;
    if (!proof?.ref) continue;
    if (proof.kind === "command") {
      const { output, exitCode, timedOut } = runShellFull(cwd, proof.ref, probes, PROOF_TIMEOUT_MS);
      const matched = exitCode === 0 ? patternMatchedATest(proof.ref, output) : null;
      const detail = timedOut
        ? `timed out after ${PROOF_TIMEOUT_MS / 1000} s`
        : exitCode !== 0
        ? `exit ${exitCode ?? "no exit code (killed or never started)"}${output.trim() ? `: ${output.trim().slice(0, PROOF_DETAIL_CAP)}` : ""}`
        : matched === false ? "exit 0, but its --test-name-pattern matched no test: the proof ran nothing" : "exit 0";
      results.push({ requirementId: requirement.id, kind: "command", ref: proof.ref, pass: exitCode === 0 && matched !== false, detail });
      continue;
    }
    if (proof.kind === "path") {
      const target = isAbsolute(proof.ref) ? proof.ref : join(cwd, proof.ref);
      const exists = probes.pathExists ? probes.pathExists(target) : existsSync(target);
      results.push({ requirementId: requirement.id, kind: "path", ref: proof.ref, pass: exists, detail: exists ? "exists" : "no such path" });
    }
  }
  return results;
}
