import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, linkDirectory, tarExecutable } from "../../src/host/platform.mjs";

/**
 * The three platform primitives, asserted against the file system rather than
 * against `process.platform`: a link that resolves to its target, a repoint
 * that keeps the old version on disk, an archive unpacked from an absolute
 * path, and a command found under the name this platform runs it by are the
 * same promises whichever platform keeps them.
 */

/** @returns {{root: string, one: string, two: string}} a home with two versions on disk */
function versions() {
  const root = mkdtempSync(join(tmpdir(), "platform-link-"));
  const one = join(root, "versions", "1.0.0");
  const two = join(root, "versions", "2.0.0");
  for (const [dir, marker] of [[one, "one"], [two, "two"]]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.txt"), marker);
  }
  return { root, one, two };
}

test("linkDirectory points a link at a target reached through it", () => {
  const { root, one } = versions();
  const link = join(root, "current");
  linkDirectory(link, join("versions", "1.0.0"));
  assert.equal(realpathSync(link), realpathSync(one));
  assert.equal(readFileSync(join(link, "marker.txt"), "utf8"), "one");
});

test("linkDirectory repoints an existing link and leaves the version it pointed at on disk", () => {
  const { root, one, two } = versions();
  const link = join(root, "current");
  linkDirectory(link, join("versions", "1.0.0"));
  linkDirectory(link, join("versions", "2.0.0"));
  assert.equal(readFileSync(join(link, "marker.txt"), "utf8"), "two");
  assert.equal(realpathSync(link), realpathSync(two));
  // The failure this guards: removing a directory link by its contents takes
  // the previous release with it, and an update that deletes what it replaced
  // has no version to fall back to.
  assert.ok(existsSync(join(one, "marker.txt")), "the previous version survives the repoint");
  assert.ok(!existsSync(`${link}.tmp`), "no temporary link is left behind");
});

test("linkDirectory resolves a relative target against the link's own directory, not the cwd", () => {
  const { root, two } = versions();
  const link = join(root, "nested", "current");
  mkdirSync(join(root, "nested"), { recursive: true });
  linkDirectory(link, join("..", "versions", "2.0.0"));
  assert.equal(realpathSync(link), realpathSync(two));
});

test("a POSIX link keeps the relative target the layout is written in", { skip: process.platform === "win32" ? "a junction stores an absolute path" : false }, () => {
  const { root } = versions();
  const link = join(root, "current");
  linkDirectory(link, join("versions", "1.0.0"));
  assert.equal(readlinkSync(link), join("versions", "1.0.0"));
});

test("tarExecutable unpacks an archive named by an absolute path", () => {
  const { root, one } = versions();
  const archive = join(root, "release.tgz");
  const destination = join(root, "unpacked");
  mkdirSync(destination);

  const created = spawnSync(tarExecutable(), ["-czf", archive, "-C", join(root, "versions"), "1.0.0"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const extracted = spawnSync(tarExecutable(), ["-xzf", archive, "--strip-components=1", "-C", destination], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);

  // The Windows failure this is the fix for: the GNU tar Git for Windows puts
  // on PATH reads the `C:` of an absolute path as a remote host and exits with
  // "Cannot connect to C: resolve failed". The round trip is the whole
  // assertion — which tar was chosen is the implementation's business.
  assert.equal(readFileSync(join(destination, "marker.txt"), "utf8"), readFileSync(join(one, "marker.txt"), "utf8"));
});

/**
 * Run `body` with PATH (and, on Windows, PATHEXT) pointed at `directory`.
 *
 * @template T
 * @param {string} directory
 * @param {() => T} body
 * @returns {T}
 */
function withPath(directory, body) {
  const previous = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  process.env.PATH = directory;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("findExecutable resolves a bare name to the file on PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "find-executable-"));
  // The spelling each platform actually runs: `tool.cmd` is a command on
  // Windows and the extensionless `tool` is a command everywhere else.
  const name = process.platform === "win32" ? "tool.cmd" : "tool";
  writeFileSync(join(directory, name), "");
  withPath(directory, () => {
    assert.equal(findExecutable("tool"), join(directory, name));
    assert.equal(findExecutable("absent"), null);
  });
});

test("findExecutable prefers the runnable extension over an extensionless file of the same name", { skip: process.platform === "win32" ? false : "PATHEXT is a Windows mechanism" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "find-executable-pathext-"));
  // What npm lays down: `npm.cmd`, which Windows runs, beside `npm`, a POSIX
  // shell script it cannot. Reporting the second is reporting a file no
  // Windows process can execute — and before PATHEXT was consulted at all,
  // `node` itself, which is only ever `node.exe`, reported as missing.
  writeFileSync(join(directory, "npm"), "#!/bin/sh\n");
  writeFileSync(join(directory, "npm.cmd"), "@echo off\n");
  withPath(directory, () => {
    assert.equal(findExecutable("npm"), join(directory, "npm.cmd"));
    assert.equal(findExecutable("npm.cmd"), join(directory, "npm.cmd"), "a name that already carries its extension still resolves");
  });
});
