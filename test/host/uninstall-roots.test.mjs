import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  REMOVAL_OUTSIDE_ROOTS,
  RemovalRefusedError,
  canonicalPath,
  isWithinRemovalRoots,
  removalRoots,
  removeWithinRemovalRoots,
} from "../../src/host/uninstall-roots.mjs";

/** @param {string} prefix @returns {string} a fresh throwaway directory */
function temp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a file, making its parent directories on the way, so a fixture reads
 * as the path it is about rather than three setup lines.
 *
 * @param {string} path @param {string} [text] @returns {string}
 */
function write(path, text = "x") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * A directory link. `junction` is a Windows directory link that needs no
 * Developer Mode or elevation, and node ignores the type on POSIX, so one call
 * states the same fixture on every platform. The target is absolute, which a
 * Windows junction requires.
 *
 * @param {string} target @param {string} linkPath @returns {void}
 */
function linkDirectory(target, linkPath) {
  symlinkSync(target, linkPath, "junction");
}

test("removal roots come from the injected HOME and FABERUN_HOME, never the real home", () => {
  const home = temp("roots-home-");
  const faberun = temp("roots-faberun-");
  assert.deepEqual(removalRoots({ HOME: home, FABERUN_HOME: faberun }), [canonicalPath(home), canonicalPath(faberun)]);
  // Only HOME: the effective install root is that home's `.faberun`.
  assert.deepEqual(removalRoots({ HOME: home }), [canonicalPath(home), canonicalPath(join(home, ".faberun"))]);
  // An environment that names neither has no allowed root, even though
  // `process.env.FABERUN_HOME` is set for this suite and `process.env.HOME` is
  // the operator's. A fallback would show up here as a non-empty list.
  assert.deepEqual(removalRoots({}), []);
});

test("removes a file and a directory inside the effective roots", () => {
  const faberun = temp("remove-inside-");
  const env = { HOME: temp("remove-inside-home-"), FABERUN_HOME: faberun };
  const file = write(join(faberun, "config.json"));
  const dir = join(faberun, "versions", "1.0.0");
  write(join(dir, "faberun.mjs"));
  removeWithinRemovalRoots(file, env);
  assert.equal(existsSync(file), false);
  removeWithinRemovalRoots(dir, env);
  assert.equal(existsSync(dir), false);
});

test("removes the FABERUN_HOME root itself", () => {
  const faberun = temp("remove-root-");
  write(join(faberun, "current"));
  removeWithinRemovalRoots(faberun, { HOME: temp("remove-root-home-"), FABERUN_HOME: faberun });
  assert.equal(existsSync(faberun), false);
});

test("refuses a target outside the effective roots and leaves it untouched", () => {
  const home = temp("refuse-home-");
  const outside = temp("refuse-outside-");
  const sentinel = write(join(outside, "keep.txt"));
  const env = { HOME: home, FABERUN_HOME: join(home, ".faberun") };
  assert.throws(
    () => removeWithinRemovalRoots(outside, env),
    (error) => error instanceof RemovalRefusedError && error.code === REMOVAL_OUTSIDE_ROOTS,
  );
  assert.equal(existsSync(sentinel), true);
});

test("refuses a link that resolves outside the roots and never deletes its target", () => {
  const home = temp("escape-home-");
  const outside = temp("escape-outside-");
  const sentinel = write(join(outside, "keep.txt"));
  const link = join(home, "current");
  linkDirectory(outside, link);
  const env = { HOME: home, FABERUN_HOME: join(home, ".faberun") };
  assert.throws(
    () => removeWithinRemovalRoots(link, env),
    (error) => error instanceof RemovalRefusedError && error.code === REMOVAL_OUTSIDE_ROOTS,
  );
  assert.equal(existsSync(outside), true, "the link's target survives");
  assert.equal(existsSync(sentinel), true);
});

test("refuses an entry reached through a link out of the roots", () => {
  const home = temp("nested-home-");
  const outside = temp("nested-outside-");
  const sentinel = write(join(outside, "keep.txt"));
  linkDirectory(outside, join(home, "linked"));
  const env = { HOME: home, FABERUN_HOME: join(home, ".faberun") };
  assert.throws(
    () => removeWithinRemovalRoots(join(home, "linked", "keep.txt"), env),
    (error) => error instanceof RemovalRefusedError && error.code === REMOVAL_OUTSIDE_ROOTS,
  );
  assert.equal(existsSync(sentinel), true);
});

test("unlinks a link that stays inside the roots without following it", () => {
  const faberun = temp("link-inside-");
  const target = join(faberun, "real");
  write(join(target, "keep.txt"));
  const link = join(faberun, "link");
  linkDirectory(target, link);
  const env = { HOME: temp("link-inside-home-"), FABERUN_HOME: faberun };
  removeWithinRemovalRoots(link, env);
  assert.equal(existsSync(link), false, "the link itself is gone");
  assert.equal(existsSync(join(target, "keep.txt")), true, "the directory it named is not");
});

test("compares a symlinked root in its resolved form", () => {
  const real = temp("root-real-");
  const link = join(temp("root-parent-"), "link");
  linkDirectory(real, link);
  const file = write(join(real, "faberun.mjs"));
  const env = { HOME: link, FABERUN_HOME: link };
  assert.deepEqual(removalRoots(env), [canonicalPath(real)]);
  removeWithinRemovalRoots(join(link, "faberun.mjs"), env);
  assert.equal(existsSync(file), false);
});

test("refuses every removal when the injected environment names no root", () => {
  const directory = temp("no-roots-");
  const sentinel = write(join(directory, "keep.txt"));
  assert.throws(
    () => removeWithinRemovalRoots(directory, {}),
    (error) => error instanceof RemovalRefusedError && error.code === REMOVAL_OUTSIDE_ROOTS,
  );
  assert.equal(existsSync(sentinel), true);
});

test("reports containment against resolved roots", () => {
  const faberun = temp("within-");
  const env = { HOME: temp("within-home-"), FABERUN_HOME: faberun };
  const roots = removalRoots(env);
  assert.equal(isWithinRemovalRoots(join(faberun, "config.json"), roots), true);
  assert.equal(isWithinRemovalRoots(temp("within-other-"), roots), false);
});
