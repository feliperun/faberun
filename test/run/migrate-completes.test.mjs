import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunState } from "../../src/run/migrate.mjs";
import { RUNS_DIR_NAME } from "../../src/run/paths.mjs";
import { projectsDir, registerProject } from "../../src/host/projects.mjs";

/**
 * The completion of a migration whose published copy already exists: the
 * branch verifies the published copy against the original and runs no copy
 * of its own, so a path the original gained after the copy was taken can
 * never reach it. Measured 2026-09-21 against this repository's own trees:
 * `.runs/control/second-opinions` — seven ordinary files — was written into
 * the original after the home side had become authoritative, and every
 * migrate run refused on it with a line that named the mismatch alone. The
 * refusal must instead carry the resolution, and following it must complete
 * the move. These tests stage that exact shape with fixtures, never against
 * a live tree.
 */

/**
 * A legacy in-tree runs root with one run in it — enough state for a
 * migration to have something to move.
 *
 * @param {string} repo
 * @returns {string} the legacy root's path
 */
function seedLegacyRuns(repo) {
  const legacy = join(repo, RUNS_DIR_NAME);
  const runDir = join(legacy, "legacy-run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "contract.json"), "{}\n");
  writeFileSync(join(runDir, "events.jsonl"), '{"to":"running"}\n{"to":"done"}\n');
  // The published copy already holds a control directory, as the home side
  // had in the measured failure — the gained path is new inside it, not the
  // directory itself.
  mkdirSync(join(legacy, "control"), { recursive: true });
  writeFileSync(join(legacy, "control", "records.txt"), "record\n");
  return legacy;
}

/**
 * The directory an off-resolver writer drops into the original after the
 * copy was published: the measured shape, `control/second-opinions` holding
 * seven ordinary files with ordinary permissions.
 *
 * @param {string} legacy
 * @returns {void}
 */
function gainSecondOpinions(legacy) {
  const dir = join(legacy, "control", "second-opinions", "astra-2026-09-21");
  mkdirSync(dir, { recursive: true });
  for (const name of ["01-prompt.md", "02-astra.md", "03-prompt.md", "04-astra.md", "README.txt", "round1.events.jsonl", "round2.events.jsonl"]) {
    writeFileSync(join(dir, name), `${name}\n`);
  }
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
 * The error `body` throws, or null when it returns normally. `assert.throws`
 * with a pattern proves the throw but hands back nothing, and the assertions
 * here are about what the refusal says.
 *
 * @template T
 * @param {() => T} body
 * @returns {Error|null}
 */
function thrown(body) {
  try {
    body();
    return null;
  } catch (error) {
    return /** @type {Error} */ (error);
  }
}

/**
 * The published runs directory for `repo`'s project under `home`, after the
 * project has been registered.
 *
 * @param {string} home @param {string} repo @returns {string}
 */
function projectTarget(home, repo) {
  const project = /** @type {NonNullable<ReturnType<typeof registerProject>>} */ (registerProject(home, repo));
  return join(projectsDir(home), project.id, "runs");
}

test("a published copy that predates a path the original gained refuses naming the resolution, and the named action completes the move", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const target = projectTarget(home, repo);
    // The copy is published before the original gains the directory: the
    // temporal shape of the measured failure.
    cpSync(legacy, target, { recursive: true, verbatimSymlinks: true });
    gainSecondOpinions(legacy);

    const refusal = thrown(() => migrateRunState(repo));
    assert.ok(refusal, "migrate refuses");
    assert.match(refusal.message, /does not verify/u);
    // The refusal names a real path on this host, and a real path on Windows
    // is spelled with backslashes: the assertion is that the message names the
    // missing directory, not which separator the platform writes it with.
    assert.match(refusal.message, /control[\\/]second-opinions/u, "the refusal names the path that never reached the copy");
    assert.match(refusal.message, /run migrate again/u, "the refusal names the action that completes the migration");
    assert.equal(existsSync(legacy), true, "the original stays");
    assert.equal(existsSync(join(target, "control", "second-opinions")), false, "nothing is copied over behind the operator's back");

    // The operator follows the named action: carry the difference into the
    // published copy by hand.
    cpSync(join(legacy, "control"), join(target, "control"), { recursive: true, verbatimSymlinks: true });

    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.equal(result.target, target);
    assert.equal(existsSync(legacy), false, "the next run proves the completed copy and removes the original");
    assert.equal(readdirSync(join(target, "control", "second-opinions", "astra-2026-09-21")).length, 7);
  });
});

test("a published copy whose shared file the original later changed refuses naming the reconciliation, and settling it completes the move", () => {
  withTemporaryHome((home) => {
    const repo = mkdtempSync(join(tmpdir(), "faberun-migrate-repo-"));
    const legacy = seedLegacyRuns(repo);
    const target = projectTarget(home, repo);
    cpSync(legacy, target, { recursive: true, verbatimSymlinks: true });
    appendFileSync(join(legacy, "legacy-run", "events.jsonl"), '{"to":"done-late"}\n');

    const refusal = thrown(() => migrateRunState(repo));
    assert.ok(refusal, "migrate refuses");
    assert.match(refusal.message, /does not verify/u);
    assert.match(refusal.message, /events\.jsonl/u, "the refusal names the differing path");
    assert.match(refusal.message, /run migrate again/u);
    assert.equal(existsSync(legacy), true, "the original stays");
    assert.equal(
      readFileSync(join(target, "legacy-run", "events.jsonl"), "utf8"),
      '{"to":"running"}\n{"to":"done"}\n',
      "the published bytes are never overwritten behind the operator's back",
    );

    // The operator settles the differing bytes in favour of the original.
    cpSync(join(legacy, "legacy-run", "events.jsonl"), join(target, "legacy-run", "events.jsonl"));

    const result = migrateRunState(repo);
    assert.equal(result.moved, true);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(join(target, "legacy-run", "events.jsonl"), "utf8"), '{"to":"running"}\n{"to":"done"}\n{"to":"done-late"}\n');
  });
});
