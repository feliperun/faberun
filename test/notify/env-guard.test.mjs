import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../setup.mjs";
import { NOTIFY_BIN_ENV, NOTIFY_ENV_NAMES, withoutNotifyEnv } from "../../src/notify/index.mjs";
import { NOTIFY_SESSION_ENV } from "../../src/notify/session.mjs";

// The ratchet behind a defect that has now happened twice, once per variable:
// a fixture controller inherited a live notify transport and delivered for
// real -- FABERUN_NOTIFY_BIN to a phone (2026-09-16), FABERUN_NOTIFY_SESSION
// to a live Claude Code session (2026-09-21, from the operator's own run,
// whose worker ran test/repo/). Every name src/notify exports must be
// neutralised at the suite boundary and stripped at the child boundary.

const root = fileURLToPath(new URL("../..", import.meta.url));
const setupPath = join(root, "test", "setup.mjs");

test("every notify variable src/notify exports is named by test/setup.mjs, so a third transport cannot slip past the suite", () => {
  const setup = readFileSync(setupPath, "utf8");
  assert.ok(NOTIFY_ENV_NAMES.length >= 2, "both transports are listed");
  assert.ok(NOTIFY_ENV_NAMES.includes(NOTIFY_BIN_ENV) && NOTIFY_ENV_NAMES.includes(NOTIFY_SESSION_ENV));
  for (const name of NOTIFY_ENV_NAMES) {
    assert.match(setup, new RegExp(`(delete process\\.env\\.${name}|process\\.env\\.${name} = )`, "u"), `test/setup.mjs neutralises ${name} unconditionally`);
  }
  for (const line of setup.split("\n")) {
    assert.doesNotMatch(line, /^\s*if \(!process\.env\.FABERUN_NOTIFY_/u, "the guard must not be conditional on the variable being unset: set is the dangerous case");
  }
});

test("after the setup module loads, no notify variable of the outer environment survives into a test process", () => {
  assert.equal(process.env[NOTIFY_SESSION_ENV], undefined);
  assert.ok(process.env[NOTIFY_BIN_ENV]?.endsWith("noop-notify.mjs"), `the transport is the no-op, got ${process.env[NOTIFY_BIN_ENV]}`);
});

test("npm test preloads the setup module into every test process, and the preload reaches a child test file that imports nothing", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts.test, /--import \.\/test\/setup\.mjs --test /u, "the preload is the suite-wide boundary; helpers.mjs only covers files that import it");

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

test("the harness spawn passes its child an environment with no notify transport", () => {
  const source = readFileSync(join(root, "src", "harnesses", "index.mjs"), "utf8");
  assert.match(source, /env: withoutNotifyEnv\(process\.env\)/u, "a worker or judge never inherits a transport; the controller alone delivers");
  assert.doesNotMatch(source, /env: process\.env,/u);
});
