import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tarExecutable } from "../../src/host/platform.mjs";

/**
 * install.ps1 against local sources only, the same three scenarios
 * install-sh.test.mjs covers for the POSIX installer: a tarball with the GitHub
 * archive shape, a plain directory, and an upgrade that has to move `current`.
 * No test reaches the network.
 *
 * The script runs under `powershell.exe`, Windows PowerShell 5.1, rather than
 * `pwsh`: 5.1 is the shell every Windows has and the one a copy-pasted install
 * line lands in, and it is stricter than pwsh about TLS and strict mode.
 */

const WINDOWS_ONLY = process.platform === "win32" ? false : "install.ps1 is the Windows installer";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL_PS1 = join(ROOT, "install.ps1");
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
// Both by absolute path: one test empties PATH, and a shell that cannot be
// found reports the same "no node" the test is looking for, from the wrong
// cause.
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
const COMSPEC = process.env.ComSpec ?? join(SYSTEM32, "cmd.exe");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const COPIED = ["bin", "src", "skills", "integrations", "package.json"];

/**
 * A `faberun-test/` staging directory holding the paths an install needs,
 * optionally carrying a different package version so an upgrade is observable.
 *
 * @param {string} [version]
 * @returns {{parent: string, dir: string}}
 */
function stageTree(version) {
  const parent = mkdtempSync(join(tmpdir(), "install-ps1-stage-"));
  const dir = join(parent, "faberun-test");
  mkdirSync(dir);
  for (const entry of COPIED) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  if (version !== undefined) {
    const path = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.version = version;
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { parent, dir };
}

/**
 * @param {string} parent
 * @returns {string} a `.tar.gz` whose single top-level member is `faberun-test/`
 */
function tarballOf(parent) {
  const target = join(mkdtempSync(join(tmpdir(), "install-ps1-tar-")), "faberun-test.tar.gz");
  const result = spawnSync(tarExecutable(), ["-czf", target, "-C", parent, "faberun-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, `tar failed: ${result.stderr}`);
  return target;
}

/** @returns {{root: string, home: string, bin: string}} */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "install-ps1-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

/**
 * @param {{home: string, bin: string}} space
 * @param {string} source
 * @param {string} version
 * @param {Record<string, string>} [extraEnv]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runInstall(space, source, version, extraEnv = {}) {
  return spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1], {
    encoding: "utf8",
    env: {
      ...process.env,
      FABERUN_HOME: space.home,
      FABERUN_BIN_DIR: space.bin,
      FABERUN_INSTALL_SOURCE: source,
      FABERUN_VERSION: version,
      FABERUN_NO_SETUP: "1",
      ...extraEnv,
    },
  });
}

/**
 * The state the installer promises: `versions/<v>/bin/faberun.mjs`, `current`
 * pointing at it, both shims in the bin directory, and a `faberun.cmd` that
 * prints the version through them.
 *
 * @param {{home: string, bin: string}} space
 * @param {string} version
 * @returns {void}
 */
function assertInstall(space, version) {
  const versionDir = join(space.home, "versions", version);
  const binary = join(versionDir, "bin", "faberun.mjs");
  assert.ok(existsSync(binary), `missing ${binary}`);

  const current = join(space.home, "current");
  assert.ok(lstatSync(current).isSymbolicLink(), `${current} is not a link`);
  assert.equal(realpathSync(current), realpathSync(versionDir), `${current} does not resolve to ${versionDir}`);

  // Two shims because Windows has two shells: PATHEXT finds `faberun.cmd` from
  // cmd and PowerShell, and Git Bash resolves neither PATHEXT nor `.cmd`, so it
  // finds only the extensionless POSIX script.
  const cmdShim = join(space.bin, "faberun.cmd");
  const shShim = join(space.bin, "faberun");
  for (const shim of [cmdShim, shShim]) {
    assert.ok(existsSync(shim), `missing ${shim}`);
    assert.match(readFileSync(shim, "utf8"), /current[\\/]bin[\\/]faberun\.mjs/u, `${shim} does not run through current`);
  }

  const result = spawnSync(COMSPEC, ["/c", cmdShim, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `faberun ${version}`);
}

test("install.ps1 installs a release tarball and is idempotent", { skip: WINDOWS_ONLY }, () => {
  const space = workspace();
  const tarball = tarballOf(stageTree().parent);

  const first = runInstall(space, tarball, PACKAGE_VERSION);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /\[ok\] installed/);
  assertInstall(space, PACKAGE_VERSION);

  const second = runInstall(space, tarball, PACKAGE_VERSION);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /\[ok\] installed/);
  assertInstall(space, PACKAGE_VERSION);
});

test("install.ps1 installs from a source directory", { skip: WINDOWS_ONLY }, () => {
  const space = workspace();
  const result = runInstall(space, stageTree().dir, PACKAGE_VERSION);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[ok\] installed/);
  assertInstall(space, PACKAGE_VERSION);
});

test("install.ps1 repoints current when FABERUN_VERSION changes", { skip: WINDOWS_ONLY }, () => {
  const space = workspace();
  const first = runInstall(space, stageTree(PACKAGE_VERSION).dir, PACKAGE_VERSION);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assertInstall(space, PACKAGE_VERSION);

  const [major, minor, patch] = PACKAGE_VERSION.split(".").map(Number);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  const second = runInstall(space, stageTree(nextVersion).dir, nextVersion);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

  // The regression a `Remove-Item -Recurse` over the junction would cause: the
  // link resolves to the new version and the old one is still on disk, because
  // removing `current` must remove the link and never what it points at.
  assertInstall(space, nextVersion);
  assert.ok(existsSync(join(space.home, "versions", PACKAGE_VERSION, "bin", "faberun.mjs")), "the previous version survives the repoint");
});

test("install.ps1 fails when node is missing from PATH", { skip: WINDOWS_ONLY }, () => {
  const space = workspace();
  const empty = mkdtempSync(join(tmpdir(), "install-ps1-nopath-"));
  const result = runInstall(space, stageTree().dir, PACKAGE_VERSION, {
    // PowerShell itself is launched by absolute name, so an empty PATH leaves
    // the script running with nothing to find.
    PATH: empty,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /\[fail\] node/);
});
