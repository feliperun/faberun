import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { reassociateProject } from "../../src/cli/project.mjs";
import { findProjectByPath, registerProject } from "../../src/host/projects.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";

const BIN = fileURLToPath(new URL("../../bin/faberun.mjs", import.meta.url));

/** @returns {string} a fresh, empty `$FABERUN_HOME` */
function home() {
  return mkdtempSync(join(tmpdir(), "faberun-project-home-"));
}

/**
 * @returns {string} a fresh, empty directory standing in for a repository,
 *   realpath-resolved: the registry keys on it, since $TMPDIR itself is a
 *   symlink on macOS (`/var` -> `/private/var`).
 */
function repo(name = "repo") {
  const path = mkdtempSync(join(tmpdir(), `faberun-project-${name}-`));
  return realpathSync(path);
}

test("a moved path re-associates and the campaigns under it are still reachable", () => {
  const directory = home();
  const oldPath = repo("old");
  const campaignFile = join(oldPath, RUNS_DIR_NAME, "campaigns", "feature-42", "campaign.json");
  mkdirSync(join(oldPath, RUNS_DIR_NAME, "campaigns", "feature-42"), { recursive: true });
  writeFileSync(campaignFile, JSON.stringify({ id: "feature-42" }));

  const registered = registerProject(directory, oldPath, ["git@example.com:org/repo.git"]);

  // Simulate the operator's own `mv`: the directory, with everything under
  // it, moves on disk before faberun is ever told about it.
  const newPath = `${oldPath}-moved`;
  renameSync(oldPath, newPath);

  const record = reassociateProject(directory, newPath, { from: oldPath });
  assert.equal(record.id, registered.id, "the id is unchanged by the move");
  assert.equal(record.path, newPath);

  assert.equal(findProjectByPath(directory, oldPath), null, "the old path is no longer registered");
  const found = findProjectByPath(directory, newPath);
  assert.ok(found, "the new path finds the same project");
  assert.equal(found.id, registered.id);

  // Nothing under the repository was touched by the registry move: the
  // campaign the operator's own `mv` carried along is still exactly there.
  assert.equal(JSON.parse(readFileSync(join(newPath, RUNS_DIR_NAME, "campaigns", "feature-42", "campaign.json"), "utf8")).id, "feature-42");
});

test("re-associating a path no project knows fails with a message naming what it looked for", () => {
  const directory = home();
  const unregisteredOld = join(directory, "never-registered");
  const newPath = repo("new");
  assert.throws(
    () => reassociateProject(directory, newPath, { from: unregisteredOld }),
    (error) => error instanceof Error && error.message.includes(unregisteredOld),
  );
});

test("running it twice is not an error", () => {
  const directory = home();
  const oldPath = repo("old");
  const newPath = repo("new");
  const registered = registerProject(directory, oldPath, []);

  const first = reassociateProject(directory, newPath, { from: oldPath });
  assert.equal(first.id, registered.id);

  // The second call names the same --from, which is no longer registered
  // (the first call already moved it) -- but the project it would have moved
  // is already sitting at newPath, so this is a no-op, not a failure.
  const second = reassociateProject(directory, newPath, { from: oldPath });
  assert.equal(second.id, registered.id);
  assert.equal(second.path, newPath);

  // Calling it a third time with no --from at all, naming only the
  // already-current path, is the same no-op.
  const third = reassociateProject(directory, newPath);
  assert.equal(third.id, registered.id);
});

test("with no --from, the project is found by matching the remotes reported at the new path", () => {
  const directory = home();
  const oldPath = repo("old");
  const newPath = repo("new");
  const registered = registerProject(directory, oldPath, ["git@example.com:org/repo.git", "https://example.com/org/repo.git"]);

  const record = reassociateProject(directory, newPath, {
    remotesOf: (path) => { assert.equal(path, newPath); return ["https://example.com/org/repo.git"]; },
  });
  assert.equal(record.id, registered.id);
  assert.equal(record.path, newPath);
});

test("with no --from and no remote match, reassociateProject fails naming the path it looked at", () => {
  const directory = home();
  registerProject(directory, repo("old"), ["git@example.com:org/repo.git"]);
  const newPath = repo("new");
  assert.throws(
    () => reassociateProject(directory, newPath, { remotesOf: () => [] }),
    (error) => error instanceof Error && error.message.includes(newPath),
  );
});

test("with no --from and remotes shared by two projects, reassociateProject refuses to guess", () => {
  const directory = home();
  registerProject(directory, repo("a"), ["git@example.com:org/repo.git"]);
  registerProject(directory, repo("b"), ["git@example.com:org/repo.git"]);
  const newPath = repo("new");
  assert.throws(
    () => reassociateProject(directory, newPath, { remotesOf: () => ["git@example.com:org/repo.git"] }),
    /pass --from to disambiguate/u,
  );
});

test("the CLI dispatches `project --from` and prints the moved id and path", () => {
  const directory = home();
  const oldPath = repo("old");
  registerProject(directory, oldPath, []);
  const newPath = repo("new");
  const result = spawnSync(process.execPath, [BIN, "project", newPath, "--from", oldPath], {
    encoding: "utf8",
    env: { ...process.env, FABERUN_HOME: directory, FORCE_COLOR: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[project\] .+ · .+\n$/u);
  assert.ok(result.stdout.includes(newPath));
  assert.equal(result.stderr, "");
});

test("the CLI reports an unknown --from as one plain line, not a stack", () => {
  const directory = home();
  const unregisteredOld = join(directory, "never-registered");
  const newPath = repo("new");
  const result = spawnSync(process.execPath, [BIN, "project", newPath, "--from", unregisteredOld], {
    encoding: "utf8",
    env: { ...process.env, FABERUN_HOME: directory, FORCE_COLOR: "0" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), `no project is registered at ${unregisteredOld}`);
  assert.doesNotMatch(result.stderr, /\n\s+at /u, "no stack trace reaches the operator");
});

test("running the CLI invocation twice exits 0 both times", () => {
  const directory = home();
  const oldPath = repo("old");
  registerProject(directory, oldPath, []);
  const newPath = repo("new");
  const args = [BIN, "project", newPath, "--from", oldPath];
  const env = { ...process.env, FABERUN_HOME: directory, FORCE_COLOR: "0" };
  const first = spawnSync(process.execPath, args, { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, args, { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(existsSync(newPath), true);
});
