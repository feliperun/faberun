import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The seat is a tmux session with one window per campaign, and none of it may
 * bind the run engine to tmux. These four tests pin the lifecycle, the
 * degradation without tmux, the status payload, and -- most important -- that a
 * dead pane leaves a run untouched. No test here starts a real harness or a
 * real tmux server: the tools are a shim on PATH, and the pane is any process.
 */

const RUNNER_CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/**
 * A `tmux` shim for PATH. It records every invocation and answers exactly the
 * two questions the seat asks: does the session exist, and what windows does it
 * list.
 *
 * @param {string} directory
 * @param {{hasSession?: boolean, windows?: string[][], log?: string}} [options]
 * @returns {{path: string, log: string}}
 */
function fakeTmux(directory, options = {}) {
  const path = join(directory, "tmux");
  const log = options.log ?? join(directory, "tmux.log");
  const windows = (options.windows ?? []).map((row) => row.join("\t")).join("\n");
  const script = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");`,
    `if (args[0] === "has-session") process.exit(${options.hasSession === true ? 0 : 1});`,
    `if (args[0] === "list-windows") process.stdout.write(${JSON.stringify(windows ? `${windows}\n` : "")});`,
    "process.exit(0);",
  ].join("\n");
  writeFileSync(path, `${script}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

/**
 * @param {string} directory
 * @param {{hasSession?: boolean, windows?: string[][], log?: string}} [options]
 * @returns {Record<string, string|undefined>}
 */
function envWithFakeTmux(directory, options = {}) {
  fakeTmux(directory, options);
  return { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` };
}

/**
 * @param {string[]} args
 * @param {Record<string, string|undefined>} [env]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function seatCli(args, env = process.env) {
  const result = spawnSync(process.execPath, [RUNNER_CLI, ...args], { encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("seat start creates session", () => {
  const directory = mkdtempSync(join(tmpdir(), "seat-start-"));
  const env = envWithFakeTmux(directory, { hasSession: false });
  const result = seatCli(["seat", "start", "campaign-a", "--harness", "claude", "--cwd", directory], env);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(directory, "tmux.log"), "utf8");
  assert.match(calls, /new-session/u, "the first window creates the session");
  assert.match(calls, /-s intent-factory-seat/u, "the session has the documented name");
  assert.match(calls, /-n campaign-a/u, "the window is named for the campaign");
  assert.match(calls, /claude/u, "the harness argv is what tmux launches");
  assert.match(result.stdout, /\[seat\] campaign-a started with claude/u);
  assert.match(result.stdout, /tmux attach -t intent-factory-seat:campaign-a/u);
});

test("seat degrades without tmux", () => {
  const directory = mkdtempSync(join(tmpdir(), "seat-no-tmux-"));
  const emptyBin = join(directory, "bin");
  mkdirSync(emptyBin);
  // PATH holds a directory with no tmux: the binary is genuinely masked, not
  // covered by a shim that would make the test pass for the wrong reason.
  const env = { ...process.env, PATH: emptyBin };

  const status = seatCli(["seat", "status", "--json", "--cwd", directory], env);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.tmux, false, "status admits tmux is unavailable");
  assert.deepEqual(payload.seats, []);

  const attach = seatCli(["seat", "attach", "campaign-a", "--cwd", directory], env);
  assert.equal(attach.status, 1, "there is nothing to reattach to");
  assert.match(attach.stderr, /tmux is not available; cannot reattach/u);

  const campaign = seatCli(["campaign", "list", "--cwd", directory], env);
  assert.equal(campaign.status, 0, campaign.stderr);
  assert.match(campaign.stdout, /\[campaign\] none/u, "campaign commands still work without tmux");
});

test("seat status json", () => {
  const directory = mkdtempSync(join(tmpdir(), "seat-status-"));
  const env = envWithFakeTmux(directory, {
    hasSession: true,
    windows: [
      ["campaign-a", "0", "claude", "claude"],
      ["campaign-b", "1", "codex", "codex"],
    ],
  });
  const result = seatCli(["seat", "status", "--json", "--cwd", directory], env);
  assert.equal(result.status, 0, result.stderr);
  const payload = /** @type {{schemaVersion: number, session: string, tmux: boolean, seats: {campaign: string, harness: string|null, canRenderAmbient: boolean}[]}} */ (JSON.parse(result.stdout));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.session, "intent-factory-seat");
  assert.equal(payload.tmux, true);
  assert.deepEqual(payload.seats.map((seat) => seat.campaign), ["campaign-a", "campaign-b"]);
  assert.equal(payload.seats[0].harness, "claude");
  assert.equal(payload.seats[0].canRenderAmbient, true, "only claude renders ambient state");
  assert.equal(payload.seats[1].harness, "codex");
  assert.equal(payload.seats[1].canRenderAmbient, false);
});

test("seat pane death does not touch the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seat-pane-death-"));
  const runDir = join(directory, ".runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  const statusPath = join(runDir, "status.json");
  const before = JSON.stringify({ schemaVersion: 1, run: "run-1", nodes: [{ id: "build", status: "running" }] });
  writeFileSync(statusPath, before);

  // Any process stands in for the harness pane. It owns nothing the run
  // controller reads, so killing it is invisible to the run state.
  const pane = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolveSpawn) => pane.once("spawn", resolveSpawn));
  const exited = new Promise((resolveExit) => pane.once("exit", resolveExit));
  pane.kill("SIGKILL");
  await exited;

  assert.equal(readFileSync(statusPath, "utf8"), before, "the run status is byte-identical after the pane dies");
});
