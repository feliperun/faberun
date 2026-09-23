import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withEmptyPath } from "../helpers.mjs";

/**
 * install.sh against local sources only: a tarball with the GitHub archive
 * shape (one top-level `faberun-test/` directory) and a plain directory. No
 * test reaches the network. The upgrade case exists because a `current` link
 * repointed with a non-`-n` `ln` silently stays on the old version.
 */

// install.ps1 is the Windows installer and test/host/install-ps1.test.mjs covers
// it; this script is POSIX `sh`, and the layout it builds is made of symlinks a
// stock Windows refuses.
const POSIX_ONLY = process.platform === "win32" ? "install.sh is the POSIX installer" : false;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL_SH = join(ROOT, "install.sh");
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
  const parent = mkdtempSync(join(tmpdir(), "install-sh-stage-"));
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
  const target = join(mkdtempSync(join(tmpdir(), "install-sh-tar-")), "faberun-test.tar.gz");
  const result = spawnSync("tar", ["-czf", target, "-C", parent, "faberun-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, `tar failed: ${result.stderr}`);
  return target;
}

/** @returns {{root: string, home: string, bin: string}} */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "install-sh-"));
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
  return spawnSync("sh", [INSTALL_SH], {
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
 * pointing at it, `<bin>/faberun` through current, and a binary that prints its
 * own version.
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
  assert.ok(lstatSync(current).isSymbolicLink(), `${current} is not a symlink`);
  assert.equal(realpathSync(current), realpathSync(versionDir), `${current} does not resolve to ${versionDir}`);

  const link = join(space.bin, "faberun");
  assert.ok(lstatSync(link).isSymbolicLink(), `${link} is not a symlink`);
  assert.equal(readlinkSync(link), join(space.home, "current", "bin", "faberun.mjs"));
  assert.equal(realpathSync(link), realpathSync(binary));

  const result = spawnSync(link, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `faberun ${version}`);
}

test("install.sh installs a release tarball and is idempotent", { skip: POSIX_ONLY }, () => {
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

test("install.sh installs from a source directory", { skip: POSIX_ONLY }, () => {
  const space = workspace();
  const result = runInstall(space, stageTree().dir, PACKAGE_VERSION);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[ok\] installed/);
  assertInstall(space, PACKAGE_VERSION);
});

test("install.sh repoints current when FABERUN_VERSION changes", { skip: POSIX_ONLY }, () => {
  const space = workspace();
  const first = runInstall(space, stageTree(PACKAGE_VERSION).dir, PACKAGE_VERSION);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assertInstall(space, PACKAGE_VERSION);

  const [major, minor, patch] = PACKAGE_VERSION.split(".").map(Number);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  const second = runInstall(space, stageTree(nextVersion).dir, nextVersion);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

  // The regression the non-`-n` form caused: current stayed on the old version
  // because the temporary link was moved inside the directory it pointed at.
  assert.equal(readlinkSync(join(space.home, "current")), join("versions", nextVersion));
  assertInstall(space, nextVersion);
  assert.notEqual(realpathSync(join(space.home, "current")), realpathSync(join(space.home, "versions", PACKAGE_VERSION)));
});

// Every utility install.sh invokes for this scenario (a tarball source with
// FABERUN_VERSION set, so the curl/sed/head version-lookup branch never
// runs), minus node itself: sh to run the script, tar to extract the
// tarball, and mkdir/rm/mv/ln/chmod/cp to lay out the version and its links.
const INSTALL_SH_BINARIES_WITHOUT_NODE = ["sh", "tar", "mkdir", "rm", "mv", "ln", "chmod", "cp"];

test("install.sh fails when node is missing from PATH", { skip: POSIX_ONLY }, async () => {
  const space = workspace();
  const tarball = tarballOf(stageTree().parent);
  await withEmptyPath(() => {
    const result = spawnSync("sh", [INSTALL_SH], {
      encoding: "utf8",
      env: {
        ...process.env,
        FABERUN_HOME: space.home,
        FABERUN_BIN_DIR: space.bin,
        FABERUN_INSTALL_SOURCE: tarball,
        FABERUN_VERSION: PACKAGE_VERSION,
        FABERUN_NO_SETUP: "1",
      },
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /\[fail\] node/);
  }, { binaries: INSTALL_SH_BINARIES_WITHOUT_NODE });
});

test("withEmptyPath exposes only the binaries it is asked for", { skip: process.platform === "win32" ? "withEmptyPath empties a POSIX PATH and HOME" : false }, async () => {
  await withEmptyPath(() => {
    const missing = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "tar must not resolve when it was not requested");

    const present = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" });
    assert.equal(present.status, 0, present.stderr);
  }, { binaries: ["sh"] });
});
