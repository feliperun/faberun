import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProjectByPath, projectsDir, readProject, registerProject } from "../../src/host/projects.mjs";
import { faberunHome } from "../../src/host/home.mjs";

/** @returns {string} a fresh, empty `$FABERUN_HOME` */
function home() {
  return mkdtempSync(join(tmpdir(), "faberun-projects-"));
}

/**
 * A fake repository path under `directory`, realpath-resolved: the registry
 * keys on `realpathSync`, since $TMPDIR itself is a symlink on macOS
 * (`/var` -> `/private/var`), so a fixture path built from `mkdtempSync`'s
 * raw return value would otherwise never match what got stored.
 *
 * @param {string} directory @param {string} name @returns {string}
 */
function repoPath(directory, name) {
  const path = join(directory, name);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

test("projectsDir sits beside the rest of the home layout", () => {
  const directory = home();
  assert.equal(projectsDir(directory), join(directory, "projects"));
});

test("a path that has never been seen registers and comes back with the same id", () => {
  const directory = home();
  const repo = repoPath(directory, "repo-a");
  const project = registerProject(directory, repo, ["git@example.com:a/repo-a.git"]);
  assert.ok(project.id, "a new project gets an id");
  assert.equal(project.path, repo);
  const found = findProjectByPath(directory, repo);
  assert.deepEqual(found, project, "the same path finds the same record");
});

test("the same path registers once, not twice", () => {
  const directory = home();
  const repo = repoPath(directory, "repo-a");
  const first = registerProject(directory, repo, ["origin"]);
  const second = registerProject(directory, repo, ["origin"]);
  assert.equal(second.id, first.id, "a second registration of the same path keeps the same id");
  assert.equal(first.createdAt, second.createdAt, "the original creation time is kept");
});

test("two different paths are two ids", () => {
  const directory = home();
  const a = registerProject(directory, repoPath(directory, "repo-a"));
  const b = registerProject(directory, repoPath(directory, "repo-b"));
  assert.notEqual(a.id, b.id);
  const foundA = findProjectByPath(directory, repoPath(directory, "repo-a"));
  const foundB = findProjectByPath(directory, repoPath(directory, "repo-b"));
  assert.ok(foundA && foundB, "both paths are found");
  assert.notEqual(foundA.id, foundB.id);
});

test("a project records the remotes it was given", () => {
  const directory = home();
  const repo = repoPath(directory, "repo-a");
  const remotes = ["origin", "upstream"];
  const project = registerProject(directory, repo, remotes);
  assert.deepEqual(project.remotes, remotes);
  const reread = readProject(directory, project.id);
  assert.ok(reread, "the project reads back");
  assert.deepEqual(reread.remotes, remotes);
});

test("re-registering with a changed remote list replaces it in place, without a new id", () => {
  const directory = home();
  const repo = repoPath(directory, "repo-a");
  const first = registerProject(directory, repo, ["origin"]);
  const second = registerProject(directory, repo, ["origin", "upstream"]);
  assert.equal(second.id, first.id, "a changed remote is information about the same project, not a new one");
  assert.deepEqual(second.remotes, ["origin", "upstream"]);
});

test("findProjectByPath and readProject return null for what was never registered", () => {
  const directory = home();
  assert.equal(findProjectByPath(directory, repoPath(directory, "nowhere")), null);
  assert.equal(readProject(directory, "not-an-id"), null);
});

test("the registry survives being read by a second process", () => {
  const directory = home();
  const repo = repoPath(directory, "repo-a");
  const project = registerProject(directory, repo, ["origin"]);
  const script = `
    const { findProjectByPath } = await import(${JSON.stringify(new URL("../../src/host/projects.mjs", import.meta.url).href)});
    const found = findProjectByPath(${JSON.stringify(directory)}, ${JSON.stringify(repo)});
    process.stdout.write(JSON.stringify(found));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), project, "a second process reads the same, whole record");
});

test("registerProject and findProjectByPath honour FABERUN_HOME the way faberunHome resolves it", () => {
  const directory = home();
  const env = { FABERUN_HOME: directory };
  const repo = repoPath(directory, "repo-a");
  const project = registerProject(faberunHome(env), repo, []);
  const found = findProjectByPath(faberunHome(env), repo);
  assert.ok(found, "the registered project is found");
  assert.equal(found.id, project.id);
});
