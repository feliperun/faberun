import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../setup.mjs";
import { fixture, initializeGit, packet, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { NOTIFY_BIN_ENV, NOTIFY_ENV_NAMES, withoutNotifyEnv } from "../../src/notify/index.mjs";
import { CLAUDE_SOCKET_ENV, CODEX_THREAD_ENV, NOTIFY_SESSION_ENV } from "../../src/notify/session.mjs";

// The ratchet behind a defect that has now happened twice, once per variable:
// a fixture controller inherited a live notify transport and delivered for
// real -- FABERUN_NOTIFY_BIN to a phone (2026-09-16), FABERUN_NOTIFY_SESSION
// to a live Claude Code session (2026-09-21, from the operator's own run,
// whose worker ran test/repo/). Every name src/notify exports must be
// stripped at the child boundary (the gate that launches every provider) and
// neutralised at the suite boundary.

const root = fileURLToPath(new URL("../..", import.meta.url));
const setupPath = join(root, "test", "setup.mjs");

test("every notify variable src/notify exports is named by test/setup.mjs, so a third transport cannot slip past the suite", () => {
  const setup = readFileSync(setupPath, "utf8");
  assert.ok(NOTIFY_ENV_NAMES.includes(NOTIFY_BIN_ENV) && NOTIFY_ENV_NAMES.includes(NOTIFY_SESSION_ENV));
  // Every `*_ENV` constant src/notify exports with a FABERUN_NOTIFY_ value
  // must be in the list -- a third transport added without joining it would
  // be this defect one generation on.
  const notifyDir = join(root, "src", "notify");
  const exported = readdirSync(notifyDir).filter((name) => name.endsWith(".mjs"))
    .flatMap((name) => [...readFileSync(join(notifyDir, name), "utf8").matchAll(/^export const \w+_ENV = "(FABERUN_NOTIFY_[A-Z_]+)";/gmu)].map((match) => match[1]));
  assert.ok(exported.length >= 2, "the scan finds the exported transport variables");
  for (const name of exported) assert.ok(NOTIFY_ENV_NAMES.includes(name), `${name} is exported by src/notify but missing from NOTIFY_ENV_NAMES`);
  for (const name of NOTIFY_ENV_NAMES) {
    assert.match(setup, new RegExp(`(delete process\\.env\\.${name}|process\\.env\\.${name} = )`, "u"), `test/setup.mjs neutralises ${name} unconditionally`);
  }
  for (const line of setup.split("\n")) {
    assert.doesNotMatch(line, /^\s*if \(!process\.env\.FABERUN_NOTIFY_/u, "the guard must not be conditional on the variable being unset: set is the dangerous case");
  }
});

test("after the setup module loads, no notify variable of the outer environment survives into a test process", () => {
  assert.equal(process.env[NOTIFY_SESSION_ENV], undefined);
  // The module on POSIX, the `.cmd` shim beside it on Windows — `setup.mjs`
  // writes whichever this host can spawn, and the guard is that the variable
  // names the no-op, not which of the two shapes it took.
  assert.match(process.env[NOTIFY_BIN_ENV] ?? "", /noop-notify\.(?:mjs|cmd)$/u, `the transport is the no-op, got ${process.env[NOTIFY_BIN_ENV]}`);
});

test("npm test preloads the setup module into every test process, and the preload reaches a child test file that imports nothing", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts.test, /^node --test /u);
  assert.match(manifest.scripts.test, /--import \.\/test\/setup\.mjs /u, "the preload is the suite-wide boundary; helpers.mjs only covers files that import it");
  assert.match(manifest.scripts.test, /--import \.\/test\/scoped-home\.mjs /u, "the home scope keeps its own preload beside this one: each owns its variables and each ratchet names its file");

  // A probe test file with no import of helpers.mjs at all, run the way npm
  // test runs a file, with both variables set in the outer environment.
  const probeDir = mkdtempSync(join(tmpdir(), "faberun-env-guard-"));
  const probe = join(probeDir, "probe.test.mjs");
  writeFileSync(probe, [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'test("probe", () => {',
    '  assert.equal(process.env.FABERUN_NOTIFY_SESSION, undefined, "session transport must be gone");',
    '  assert.ok(String(process.env.FABERUN_NOTIFY_BIN).endsWith("noop-notify.mjs"), "bin transport must be the no-op");',
    "});",
    "",
  ].join("\n"));
  const result = spawnSync(process.execPath, ["--import", setupPath, "--test", probe], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, [NOTIFY_SESSION_ENV]: "auto", [NOTIFY_BIN_ENV]: "/definitely/not/a/transport" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("withoutNotifyEnv strips exactly the notify transports and copies everything else", () => {
  const stripped = withoutNotifyEnv({ PATH: "/bin", [NOTIFY_BIN_ENV]: "/x", [NOTIFY_SESSION_ENV]: "auto", FABERUN_HOME: "/h" });
  assert.deepEqual(stripped, { PATH: "/bin", FABERUN_HOME: "/h" });
});

test("the gate and the availability probe both strip from the one list, and neither names a variable on its own", () => {
  const gate = readFileSync(join(root, "src", "engine", "gate.mjs"), "utf8");
  assert.match(gate, /for \(const name of NOTIFY_ENV_NAMES\) delete merged\[name\];/u, "the gate strips the list, not a literal");
  assert.doesNotMatch(gate, /delete merged\.FABERUN_NOTIFY_/u, "a literal here is the shape of the defect: one name guarded, the next one through");
  const probe = readFileSync(join(root, "src", "harnesses", "index.mjs"), "utf8");
  assert.match(probe, /env: withoutNotifyEnv\(process\.env\)/u);
  assert.doesNotMatch(probe, /env: process\.env,/u);
});

test("a provider launched by the real gate sees no notify variable, even when the controller carries both: the path that flooded a live session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notify-gate-env-"));
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  initializeGit(directory);
  // An exec-jsonl provider that records which FABERUN_NOTIFY_* names reached
  // it, then completes the node like the fixtures do. It records outside the
  // repository so the run's own tree stays clean.
  const providerDir = mkdtempSync(join(tmpdir(), "notify-gate-provider-"));
  const seen = join(providerDir, "provider-env.json");
  const provider = join(providerDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fake-jsonl 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith("FABERUN_NOTIFY_")).sort()));
    const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    console.log(JSON.stringify({ schemaVersion: 1, type: "run.completed", result, continuationId: "fake-thread", usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 } }));
  });
}
`);
  chmodSync(provider, 0o755);
  const path = writeContract(directory, fixture({
    id: "notify-gate-env-run",
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "jsonl", judge: "jsonl" },
    runtimes: { jsonl: { harness: "exec-jsonl", model: "fake", vendor: "exec-jsonl-worker", executable: provider } },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));

  // The controller runs in this process with the session transport bound, as
  // the operator's run had it. Its own session addresses are removed so the
  // controller resolves no session and wakes nobody while the test runs; the
  // variable it must not hand down is what the provider records.
  const saved = Object.fromEntries([NOTIFY_SESSION_ENV, CLAUDE_SOCKET_ENV, CODEX_THREAD_ENV].map((name) => [name, process.env[name]]));
  process.env[NOTIFY_SESSION_ENV] = "auto";
  delete process.env[CLAUDE_SOCKET_ENV];
  delete process.env[CODEX_THREAD_ENV];
  try {
    const result = await runContract(path);
    assert.equal(nodeState(result).status, "done");
    assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), [], "the provider must see no FABERUN_NOTIFY_* name at all");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
