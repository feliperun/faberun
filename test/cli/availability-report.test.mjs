import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, packet, writeContract } from "../helpers.mjs";

const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/**
 * A codex stand-in that reports a version, answers the preflight hello, and
 * appends one marker per hello, so a test can prove whether doctor asked.
 *
 * @param {string} counterPath
 * @returns {string}
 */
function countingCodex(counterPath) {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-availability-")), "fake-codex.mjs");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-codex 9.9.9");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (!input.includes("FABERUN_PREFLIGHT_OK")) {
      console.error("unexpected prompt");
      process.exit(1);
    }
    appendFileSync(${JSON.stringify(counterPath)}, "asked\\n");
    console.log(JSON.stringify({type:"thread.started",thread_id:"preflight-hello"}));
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] })}}));
    console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A codex stand-in whose version parses and whose provider never says a
 * word: the exact shape a version-only `ok` used to bless.
 *
 * @returns {string}
 */
function silentCodex() {
  const path = join(mkdtempSync(join(tmpdir(), "runner-fake-silent-")), "fake-codex-silent.mjs");
  writeFileSync(path, `#!${process.execPath}
if (process.argv.includes("--version")) {
  console.log("fake-codex 9.9.9");
} else {
  setInterval(() => {}, 60_000);
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * @param {string} executable
 * @returns {Record<string, unknown>}
 */
function singleRuntimeContract(executable) {
  return fixture({
    runtimeDefaults: { worker: "luna", judge: "luna" },
    runtimes: { luna: { harness: "codex", model: "gpt-5.6-luna", executable } },
    nodes: [{ id: "build", type: "backend", runtime: "luna", taskPacket: packet(), gate: false }],
  });
}

/**
 * The report's host-fact half must be green so a test's status assertion is
 * about the live verdict and nothing else: `.runs/` ignored is the one check
 * a bare fixture repository otherwise fails.
 *
 * @param {string} directory
 * @returns {void}
 */
function ignoreRuns(directory) {
  writeFileSync(join(directory, ".gitignore"), ".runs/\n");
}

/**
 * @param {string} directory
 * @param {string|null} contractPath
 * @param {Record<string, string>} [env]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function doctorCli(directory, contractPath, env = {}) {
  const result = spawnSync(process.execPath, [runner, "doctor", "--json", "--cwd", directory, ...(contractPath === null ? [] : [contractPath])], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/** @param {string} stdout @returns {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */
function parseReport(stdout) {
  return /** @type {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} */ (JSON.parse(stdout));
}

test("doctor asks the live question and reports the verdict beside the version", () => {
  const directory = mkdtempSync(join(tmpdir(), "availability-doctor-ask-"));
  const counterPath = join(directory, "live-asks.log");
  ignoreRuns(directory);
  const contractPath = writeContract(directory, singleRuntimeContract(countingCodex(counterPath)));
  const first = doctorCli(directory, contractPath);
  assert.equal(first.status, 0, first.stderr);
  const report = parseReport(first.stdout);
  const version = report.checks.find((check) => check.name === "harness luna");
  assert.ok(version, "the version check is still reported");
  assert.equal(version.ok, true, version.detail);
  assert.match(version.detail, /9\.9\.9/u);
  const verdict = report.checks.find((check) => check.name === "availability luna");
  assert.ok(verdict, "the live verdict is reported beside the version");
  assert.equal(verdict.ok, true, verdict.detail);
  assert.match(verdict.detail, /answered · .*live done/u);
  assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1, "the verdict cost exactly one ask");

  // A verdict recorded inside the preflight window is reused, not re-bought:
  // the second report asks nothing and says whose verdict it rode on.
  const second = doctorCli(directory, contractPath);
  assert.equal(second.status, 0, second.stderr);
  const reused = parseReport(second.stdout).checks.find((check) => check.name === "availability luna");
  assert.ok(reused, "the second report still carries the live verdict");
  assert.equal(reused.ok, true, reused.detail);
  assert.match(reused.detail, /answered · verdict reused · observed /u);
  assert.equal(readFileSync(counterPath, "utf8").trim().split("\n").length, 1, "the second report asked nothing");
});

test("doctor without a contract says it asked nothing and asks nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "availability-doctor-nocontract-"));
  const counterPath = join(directory, "live-asks.log");
  const executable = countingCodex(counterPath);
  // The contract exists on disk; doctor was simply not given it, so there is
  // nothing routed to ask about and it must say so.
  writeContract(directory, singleRuntimeContract(executable));
  const report = parseReport(doctorCli(directory, null, { FABERUN_CODEX_BIN: executable }).stdout);
  const contract = report.checks.find((check) => check.name === "contract");
  assert.ok(contract, "the contract check is reported");
  assert.equal(contract.ok, true);
  assert.equal(contract.detail, "no contract.json provided; skipping runtime probes");
  assert.ok(report.checks.every((check) => !check.name.startsWith("availability")), "no verdict is claimed when nothing was asked");
  assert.ok(report.checks.every((check) => !check.name.startsWith("harness ")), "no version is probed when nothing is routed");
  assert.equal(existsSync(counterPath), false, "no provider was contacted");
});

test("a runtime whose version parses but whose provider is silent is not reported as ok", () => {
  const directory = mkdtempSync(join(tmpdir(), "availability-doctor-silent-"));
  ignoreRuns(directory);
  const contractPath = writeContract(directory, singleRuntimeContract(silentCodex()));
  const result = doctorCli(directory, contractPath, { FABERUN_PREFLIGHT_TIMEOUT_SEC: "2" });
  const report = parseReport(result.stdout);
  const version = report.checks.find((check) => check.name === "harness luna");
  assert.ok(version, "the version check is still reported");
  assert.equal(version.ok, true, "the version parses");
  assert.match(version.detail, /9\.9\.9/u);
  const verdict = report.checks.find((check) => check.name === "availability luna");
  assert.ok(verdict, "the live verdict is reported beside the version");
  assert.equal(verdict.ok, false, verdict.detail);
  assert.match(verdict.detail, /no answer · .*preflight_timeout/u);
  // The missing verdict is a finding on its own line, never a host-fact
  // failure: doctor exits as it always has, and blocking on silence stays
  // the dispatch gate's decision — made on exactly this cause.
  assert.equal(report.ok, true, "the exit code keeps answering the host-fact question");
  assert.equal(result.status, 0, result.stderr);
});

test("doctor names the cause when the provider could not even be started", () => {
  const directory = mkdtempSync(join(tmpdir(), "availability-doctor-spawn-"));
  ignoreRuns(directory);
  const contractPath = writeContract(directory, singleRuntimeContract("/nonexistent/codex-fixture"));
  const result = doctorCli(directory, contractPath, { FABERUN_PREFLIGHT_TIMEOUT_SEC: "5" });
  const report = parseReport(result.stdout);
  const version = report.checks.find((check) => check.name === "harness luna");
  assert.ok(version, "the static finding is still reported");
  assert.equal(version.ok, false, "the missing binary stays a static finding beside the live one");
  const verdict = report.checks.find((check) => check.name === "availability luna");
  assert.ok(verdict, "the live verdict is reported beside the static finding");
  assert.equal(verdict.ok, false, verdict.detail);
  assert.match(verdict.detail, /no answer · .*spawn_error/u);
  // The advisory fold covers only the live lines: a static finding — a
  // routed binary that is not there — still fails doctor, as it always has.
  assert.equal(report.ok, false, "a static failure still gates the exit code");
  assert.equal(result.status, 1, result.stderr);
});
