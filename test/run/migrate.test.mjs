import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "../../src/run/lock.mjs";
import { migrateRunState } from "../../src/run/migrate.mjs";
import { RUNS_DIR_NAME, projectIdForRunsDir, runsRoot } from "../../src/run/paths.mjs";
import { findProjectByPath, projectsDir, registerProject } from "../../src/host/projects.mjs";

// A pid the kernel will not hand out while the test runs: its holder is dead.
const DEAD_PID = 2_147_483_647;

/**
 * A legacy in-tree runs root with one run (journal, logs), one campaign and
 * one attempt worktree carrying a symlink — the shapes a migration must move
 * whole. Returns the root's path.
 *
 * @param {string} repo
 * @returns {string}
 */
function seedLegacyRuns(repo) {
  const legacy = join(repo, RUNS_DIR_NAME);
  const runDir = join(legacy, "legacy-run");
  mkdirSync(join(runDir, "logs"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), "{}\n");
  writeFileSync(join(runDir, "events.jsonl"), '{"to":"running"}\n{"to":"done"}\n');
  writeFileSync(join(runDir, "logs", "worker.jsonl"), "line\n");
  mkdirSync(join(legacy, "campaigns", "legacy-campaign"), { recursive: true });
  writeFileSync(join(legacy, "campaigns", "legacy-campaign", "ledger.jsonl"), '{"event":1}\n');
  mkdirSync(join(legacy, "worktrees", "legacy-run"), { recursive: true });
  writeFileSync(join(legacy, "worktrees", "legacy-run", "file.txt"), "content\n");
  symlinkSync("file.txt", join(legacy, "worktrees", "legacy-run", "link.txt"));
  return legacy;
}

/**
 * Point `FABERUN_HOME` at a fresh temporary directory for the duration of
 * `run`, so no test touches the operator's real home.
 *
 * @param {(home: string) => void} run
 * @returns {string} the temporary home
 */
function withTemporaryHome(run) {
  const home = mkdtempSync(join(tmpdir(), "faberun-migrate-home-"));
  const previous = process.env.FABERUN_HOME;
  process.env.FABERUN_HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.FABERUN_HOME;
    else process.env.FABERUN_HOME = previous;
  }
  return home;
}

/**
 * The runs directory and its staging sibling for `repo`'s project under
 * `home`, after the project has been registered.
 *
 * @param {string} home @param {string} repo @returns {{target: string, staging: string}}
 */
function projectRunPaths(home, repo) {
  const project = /** @type {NonNullable<ReturnType<typeof registerProject>>} */ (registerProject(home, repo));
  const projectDir = join(projectsDir(home), project.id);
  return { target: join(projectDir, "runs"), staging: join(projectDir, "runs.incoming") };
}

test("migrate runs moves the legacy tree under the home and the resolver answers there", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.ok(result.target);
    assert.equal(result.runs, 1);
    assert.equal(result.campaigns, 1);
    assert.equal(existsSync(legacy), false, "the legacy root is removed only after the copy verified");
    assert.equal(readFileSync(join(result.target, "legacy-run", "events.jsonl"), "utf8"), '{"to":"running"}\n{"to":"done"}\n');
    assert.equal(readFileSync(join(result.target, "legacy-run", "logs", "worker.jsonl"), "utf8"), "line\n");
    assert.equal(readFileSync(join(result.target, "campaigns", "legacy-campaign", "ledger.jsonl"), "utf8"), '{"event":1}\n');
    assert.equal(readFileSync(join(result.target, "worktrees", "legacy-run", "file.txt"), "utf8"), "content\n");
    assert.equal(readlinkSync(join(result.target, "worktrees", "legacy-run", "link.txt")), "file.txt", "symlinks move as symlinks");
    // The project the migration registered is the one the reading side
    // resolves, and it now answers the home copy with no legacy root left.
    const project = findProjectByPath(home, repo);
    assert.equal(projectIdForRunsDir(result.target), project?.id);
    assert.equal(runsRoot(repo), result.target);
  });
});

test("migrate runs a second time finds nothing to move", () => {
  withTemporaryHome(() => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    seedLegacyRuns(repo);
    const first = migrateRunState(repo);
    const second = migrateRunState(repo);
    assert.equal(first.moved, true);
    assert.equal(second.moved, false);
    assert.equal(second.target, null);
    assert.ok(first.target);
    assert.equal(existsSync(first.target), true, "the completed migration is untouched by the re-run");
  });
});

test("migrate runs refuses a live lease and removes nothing", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const handle = acquire(join(legacy, "legacy-run"));
    try {
      assert.throws(() => migrateRunState(repo), /live controller lock/u);
      assert.equal(existsSync(legacy), true, "the legacy root stays");
      assert.equal(findProjectByPath(home, repo), null, "a refused migration registers nothing under the home");
    } finally {
      handle.release();
    }
  });
});

test("migrate runs re-checks the lease between the copy and the removal", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const runDir = join(legacy, "legacy-run");
    /** @type {string[]} */
    const checked = [];
    /** @type {ReturnType<typeof acquire>[]} */
    const latecomers = [];
    // A migration is fully synchronous, so the resume that races it must be
    // staged from the injected lease scan: the first check passes, the run
    // takes the lock while the copy runs, and the check before the publish
    // has to find it — a single check at the start is a race, not a
    // guarantee, because the lock is keyed by pid and start token, not path.
    assert.throws(() => migrateRunState(repo, {
      leasesOf(tree) {
        checked.push(tree);
        if (checked.length === 1) return [];
        latecomers.push(acquire(runDir));
        return [{ runDir, pid: process.pid }];
      },
    }), /live controller lock/u);
    assert.equal(checked.length, 2, "the lease is checked before the copy and again before the removal");
    assert.equal(existsSync(legacy), true, "the original is not removed under a live lease");
    // The refusal publishes nothing: the resolver still answers the complete
    // original, never a half-moved state under the home.
    const { target, staging } = projectRunPaths(home, repo);
    assert.equal(existsSync(target), false, "a refused migration leaves nothing authoritative under the home");
    assert.equal(runsRoot(repo), legacy);
    // What it does leave is the verified staging copy, and the re-run after
    // the holder exits finishes the move from there.
    assert.equal(readFileSync(join(staging, "legacy-run", "contract.json"), "utf8"), "{}\n");
    for (const handle of latecomers) handle.release();
    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.equal(existsSync(legacy), false);
    assert.equal(runsRoot(repo), result.target);
  });
});

test("migrate runs past a stale lock whose holder is proven dead", () => {
  withTemporaryHome(() => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    writeFileSync(join(legacy, "legacy-run", "controller.lock"), `${JSON.stringify({
      schemaVersion: 1,
      pid: DEAD_PID,
      processStartToken: null,
      startedAt: new Date(0).toISOString(),
      hostname: "dead-host",
    })}\n`);
    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.equal(existsSync(legacy), false);
  });
});

test("migrate discards a stale staging copy instead of merging with it", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    seedLegacyRuns(repo);
    const { staging } = projectRunPaths(home, repo);
    // What an interrupted attempt leaves: a staging copy cut off partway.
    mkdirSync(join(staging, "legacy-run"), { recursive: true });
    writeFileSync(join(staging, "legacy-run", "events.jsonl"), '{"to":"running"}\n');
    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.ok(result.target);
    assert.equal(existsSync(staging), false, "the staging copy is renamed into place, not left beside the target");
    assert.equal(readFileSync(join(result.target, "legacy-run", "events.jsonl"), "utf8"), '{"to":"running"}\n{"to":"done"}\n', "the published tree is the fresh copy of the original, never a merge with the stale staging");
  });
});

test("migrate finishes a previous attempt whose copy published but whose removal never ran", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const { target } = projectRunPaths(home, repo);
    // The previous attempt died between the publish and the removal; a
    // controller then appended a run under the now-authoritative home side.
    cpSync(legacy, target, { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(target, "post-publish-run"), { recursive: true });
    writeFileSync(join(target, "post-publish-run", "events.jsonl"), '{"to":"running"}\n');
    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.equal(result.target, target);
    assert.equal(existsSync(legacy), false, "the re-run only removes the original the published copy was verified against");
    assert.equal(readFileSync(join(target, "legacy-run", "events.jsonl"), "utf8"), '{"to":"running"}\n{"to":"done"}\n');
    assert.equal(readFileSync(join(target, "post-publish-run", "events.jsonl"), "utf8"), '{"to":"running"}\n', "the run a controller appended after the publish survives the completion");
  });
});

test("migrate refuses a published copy that does not verify against the legacy tree", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const { target } = projectRunPaths(home, repo);
    cpSync(legacy, target, { recursive: true, verbatimSymlinks: true });
    rmSync(join(target, "legacy-run", "events.jsonl"));
    assert.throws(() => migrateRunState(repo), /does not verify/u);
    assert.equal(existsSync(legacy), true, "the original stays until the published copy is proven to hold it");
    assert.equal(existsSync(join(target, "legacy-run", "events.jsonl")), false, "nothing is copied over or repaired behind the operator's back");
  });
});
