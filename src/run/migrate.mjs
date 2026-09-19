/**
 * `faberun migrate`: the one command that moves a repository's legacy
 * in-tree runs root into the project's directory under the home (R7).
 *
 * Separate from `run/paths.mjs` because that module resolves where state is
 * read from and must keep answering throughout a migration, while this module
 * owns the move itself, whose entire safety story is ordering. The resolver
 * answers the home side the moment `<home>/projects/<id>/runs` exists, so the
 * copy is never written there: it is staged at the sibling `runs.incoming`,
 * verified, and published by one rename within the project's directory —
 * same filesystem, so atomic. A reader therefore sees either the complete
 * legacy tree, which keeps answering with its warning until the instant the
 * rename lands, or the complete home copy, never a partial authoritative
 * tree; a process killed mid-copy leaves nothing resolvable under the home.
 *
 * The controller lock is keyed by pid and process-start token, not by path,
 * so the check before the copy cannot promise anything about the moment of
 * removal: a resume that begins after that check and before the removal
 * would have its state pulled out from under it. The re-check between the
 * verified copy and the publish is what turns that race into a refusal, and
 * a refused migration leaves the complete original in the tree and nothing
 * authoritative under the home. A kill between the publish and the removal —
 * the only two adjacent calls that touch both trees — is finished, not
 * redone, by the next run: it verifies the published copy still holds every
 * byte the original holds and removes the original.
 *
 * Idempotent by the same shape. A second run after a completed migration
 * finds no legacy root and reports nothing to move — the normal case for an
 * operator rerunning the command to be sure. A re-run after an interrupted
 * one discards the staging copy it finds and copies anew: staging is never
 * merged with, so no combination of two half-copies can ever be published.
 *
 * The target shape `<home>/projects/<id>/runs` and its staging sibling are
 * composed here from `projectsDir` plus names `run/paths.mjs` keeps private;
 * widening that module's surface for one caller is worse than spelling the
 * two literals here, next to this comment.
 */
import { cpSync, existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { campaignsDir } from "../campaign/layout.mjs";
import { readRemotes } from "../cli/project.mjs";
import { faberunHome } from "../host/home.mjs";
import { projectsDir, registerProject } from "../host/projects.mjs";
import { lockStale, readLock } from "./lock.mjs";
import { RUNS_DIR_NAME } from "./paths.mjs";
import { errorCode } from "../util.mjs";

/** @typedef {{runDir: string, pid: number|undefined}} LiveLease */
/** @typedef {{moved: boolean, legacy: string, target: string|null, runs: number, campaigns: number}} MigrateResult */

/**
 * Move the legacy runs root at `<cwd>/.runs` into the home layout:
 * `<home>/projects/<project id>/runs` for the project `cwd` registers as,
 * with its git remotes recorded so a later repository move can be
 * reassociated by remote. Fully synchronous, like every reader of run state
 * in this tree.
 *
 * The migration refuses — before anything is written — while any run under
 * the legacy root holds a live controller lock, and refuses again after the
 * copy has verified, before the copy is published and the original removed.
 *
 * `options.leasesOf` replaces the live-lease scan. It exists so the
 * between-copy-and-removal re-check has a named test: a fully synchronous
 * migration cannot be interrupted from outside, so the race is staged from
 * the injected scan instead.
 *
 * @param {string} cwd
 * @param {{home?: string, leasesOf?: (tree: string) => LiveLease[]}} [options]
 * @returns {MigrateResult}
 */
export function migrateRunState(cwd, options = {}) {
  const home = options.home ?? faberunHome();
  const leasesOf = options.leasesOf ?? liveLeases;
  const legacy = join(cwd, RUNS_DIR_NAME);
  if (!existsSync(legacy)) return { moved: false, legacy, target: null, runs: 0, campaigns: 0 };
  refuseLiveLeases(leasesOf(legacy));
  const project = registerProject(home, cwd, readRemotes(cwd));
  const projectDir = join(projectsDir(home), project.id);
  const target = join(projectDir, "runs");
  // A published copy beside an untouched original is the one kill this
  // ordering cannot route through staging: the previous attempt got through
  // the rename and died before the removal. The copy needs no re-copying —
  // only proof that it still holds every byte the original holds, after
  // which removing the original finishes the move. Paths under the published
  // copy that the original lacks are runs controllers appended after it
  // became authoritative; this branch never writes to the copy, so nothing
  // of theirs is at risk.
  if (existsSync(target)) {
    verifyCopy(legacy, target);
    const runs = countRunDirs(legacy);
    const campaigns = countCampaigns(legacy);
    refuseLiveLeases(leasesOf(legacy));
    rmSync(legacy, { recursive: true });
    return { moved: true, legacy, target, runs, campaigns };
  }
  const staging = join(projectDir, "runs.incoming");
  // A staging left by an interrupted attempt is a partial copy of a tree
  // that may have changed since; it is discarded, never merged with.
  rmSync(staging, { recursive: true, force: true });
  // verbatimSymlinks: the default resolves a copied link's target to an
  // absolute path back into the tree being removed, which would dangle the
  // moment the removal ran; verbatim keeps the literal target, so relative
  // links (the worktrees' dependency symlinks) survive the move.
  cpSync(legacy, staging, { recursive: true, verbatimSymlinks: true });
  verifyCopy(legacy, staging);
  verifyNothingExtra(legacy, staging);
  const runs = countRunDirs(legacy);
  const campaigns = countCampaigns(legacy);
  // A lease found here began after the first check: its controller is still
  // resolving the legacy tree — the copy is not published yet, so there is
  // nothing else to resolve — and the publish would strand it on a tree
  // about to be removed. Refusing leaves the complete original answering and
  // nothing authoritative under the home; the re-run once the holder exits
  // discards the staging, copies anew, and publishes.
  refuseLiveLeases(leasesOf(legacy));
  // The publish is the rename, and the rename is the only thing that ever
  // creates `runs`: from this instant the home side is authoritative and
  // complete, and nothing reads the legacy tree again except this removal.
  renameSync(staging, target);
  rmSync(legacy, { recursive: true });
  return { moved: true, legacy, target, runs, campaigns };
}

/**
 * Every controller lock under `tree` whose holder is still alive. The lock
 * file's name is spelled here because `run/lock.mjs` keeps the constant
 * private and this scan reads a whole tree, not one run directory. Symlinked
 * directories are not descended into: the locks that lease this tree are the
 * ones inside it.
 *
 * @param {string} tree
 * @returns {LiveLease[]}
 */
function liveLeases(tree) {
  /** @type {LiveLease[]} */
  const leases = [];
  /** @param {string} dir @returns {void} */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name === "controller.lock") {
        const lock = readLock(dir);
        if (!lockStale(lock)) {
          leases.push({ runDir: dir, pid: lock && !("invalid" in lock) ? lock.pid : undefined });
        }
      }
    }
  };
  walk(tree);
  return leases;
}

/** @param {LiveLease[]} leases @returns {void} */
function refuseLiveLeases(leases) {
  const lease = leases[0];
  if (lease) {
    throw new Error(`run ${lease.runDir} holds a live controller lock (pid ${lease.pid ?? "unknown"}); stop the run or wait for its controller to exit, then run migrate again`);
  }
}

/**
 * What verify means here: every path under `source` must exist under `copy`
 * with the same content — directories recursively, symlinks by their literal
 * target, everything else byte for byte. That comparison is exactly the
 * guarantee removal needs: once the original is gone the copy is the only
 * holder of this state, so "holds every byte the original held" is the whole
 * of what must be true, and byte-for-byte equality is the strongest check
 * that proves it without trusting the copy step's own bookkeeping.
 *
 * @param {string} source
 * @param {string} copy
 * @returns {void}
 */
function verifyCopy(source, copy) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(copy, entry.name);
    if (entry.isDirectory()) {
      // lstat, not stat: a copied symlink to a directory must not pass as
      // the directory it points at.
      if (!lstatSync(to, { throwIfNoEntry: false })?.isDirectory()) throw verifyFailure(from, to);
      verifyCopy(from, to);
    } else if (entry.isSymbolicLink()) {
      if (readLinkOrUndefined(to) !== readlinkSync(from)) throw verifyFailure(from, to);
    } else if (readOrUndefined(to)?.equals(readFileSync(from)) !== true) throw verifyFailure(from, to);
  }
}

/**
 * The staging copy must also hold nothing the original lacks. It was created
 * by discarding any earlier staging and copying in one step, so an extra
 * path means the copy step wrote outside its instructions — and the publish
 * would make that invented state authoritative.
 *
 * @param {string} source
 * @param {string} copy
 * @returns {void}
 */
function verifyNothingExtra(source, copy) {
  for (const entry of readdirSync(copy, { withFileTypes: true })) {
    const inSource = join(source, entry.name);
    const inCopy = join(copy, entry.name);
    if (entry.isDirectory()) {
      if (!lstatSync(inSource, { throwIfNoEntry: false })?.isDirectory()) throw verifyExtraFailure(inCopy);
      verifyNothingExtra(inSource, inCopy);
    } else if (readOrUndefined(inSource) === undefined && readLinkOrUndefined(inSource) === undefined) {
      throw verifyExtraFailure(inCopy);
    }
  }
}

/** @param {string} from @param {string} to @returns {Error} */
function verifyFailure(from, to) {
  return new Error(`migration copy does not verify: ${from} is missing or different at ${to}; nothing was published or removed`);
}

/** @param {string} path @returns {Error} */
function verifyExtraFailure(path) {
  return new Error(`migration copy does not verify: ${path} is not part of the original; nothing was published or removed`);
}

/** @param {string} path @returns {Buffer|undefined} */
function readOrUndefined(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {string} path @returns {string|undefined} */
function readLinkOrUndefined(path) {
  try {
    return readlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {string} runsDir @returns {number} */
function countRunDirs(runsDir) {
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runsDir, entry.name, "contract.json")))
    .length;
}

/** @param {string} runsDir @returns {number} */
function countCampaigns(runsDir) {
  const campaigns = campaignsDir(runsDir);
  if (!existsSync(campaigns)) return 0;
  return readdirSync(campaigns, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}
