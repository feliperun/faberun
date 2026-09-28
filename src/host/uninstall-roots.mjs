/**
 * Root confinement for `faberun uninstall`.
 *
 * `uninstall` is the one verb that deletes outside the target repository, and
 * the only thing between a stray link and the operator's home is this module.
 * Every candidate is resolved through the links on the way to it -- a POSIX
 * symlink or a Windows directory junction, which `realpathSync` follows the
 * same way -- and compared against the effective `HOME` and `FABERUN_HOME`
 * named by the *injected* environment. The roots come from
 * `home.mjs`'s `effectiveHome`, not from `faberunHome`, because the latter may
 * fall back to `os.homedir()`: a normal command legitimately acts on the
 * operator's own home, but a delete scoped to a throwaway home must never
 * silently aim at the real one. When the environment names neither root there
 * is no allowed root and every removal is refused.
 *
 * The comparison is not only at the top of the tree. `removeWithinRemovalRoots`
 * re-resolves each entry immediately before unlinking it, so a directory whose
 * own name resolves outside the roots -- `$FABERUN_HOME/current` pointing at
 * `/etc`, say -- cannot smuggle its target into the recursive delete. A link
 * that resolves outside is refused even though unlinking it would not follow
 * the link, because a caller that hands over a resolved path deserves the same
 * answer as one that hands over the path the resolution produced.
 *
 * Isolation is a requirement of the command, not a convenience: every test and
 * every attempt to run `uninstall` during the work points `HOME` and
 * `FABERUN_HOME` at a throwaway directory, and this module's refusal of the
 * empty environment is what makes the fallback impossible to reintroduce.
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { effectiveHome } from "./home.mjs";

/** The `code` a removal outside the effective roots carries. */
export const REMOVAL_OUTSIDE_ROOTS = "uninstall_outside_roots";

/** Raised when a removal target is not under the effective HOME/FABERUN_HOME. */
export class RemovalRefusedError extends Error {
  /**
   * @param {string} target the resolved path a caller asked to delete
   * @param {string[]} roots the roots it was compared against
   */
  constructor(target, roots) {
    super(
      roots.length
        ? `refusing to remove ${target}: it resolves outside ${roots.join(", ")}`
        : `refusing to remove ${target}: the injected environment names no HOME or FABERUN_HOME`,
    );
    this.name = "RemovalRefusedError";
    this.code = REMOVAL_OUTSIDE_ROOTS;
    this.target = target;
    this.roots = roots;
  }
}

/**
 * `path` with every link on the way to it resolved.
 *
 * A path that does not exist yet is canonicalised through its deepest existing
 * ancestor and the remaining names appended. That is what keeps a not-yet-made
 * leaf under a symlinked parent comparable: `$TMPDIR` on macOS is `/var`, a
 * link to `/private/var`, so `removalRoots` resolving `$FABERUN_HOME` while
 * `$FABERUN_HOME/versions` does not exist still has to agree with the
 * `/private/var/...` realpath of a target that does.
 *
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent), basename(absolute));
  }
}

/**
 * The roots `uninstall` may delete inside, resolved and de-duplicated: the
 * effective `HOME` and `FABERUN_HOME` the injected environment names. When
 * `FABERUN_HOME` is unset and a home is known, the install root is that home's
 * `.faberun`; when neither is known the list is empty and nothing may be
 * removed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function removalRoots(env = process.env) {
  const home = effectiveHome(env);
  const canonicalHome = home === null ? null : canonicalPath(home);
  const configured = env.FABERUN_HOME;
  const canonicalFaberun = typeof configured === "string" && configured
    ? canonicalPath(configured)
    : canonicalHome === null
      ? null
      : canonicalPath(join(canonicalHome, ".faberun"));
  return [...new Set([canonicalHome, canonicalFaberun].filter((root) => root !== null))];
}

/**
 * Whether `root` contains `target` (or is it). The comparison is on resolved
 * absolute paths, so `..` segments and case-normalised Windows spellings do
 * not matter.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function contains(root, target) {
  if (target === root) return true;
  const step = relative(root, target);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

/**
 * Whether `target`, once resolved, sits under one of `roots`.
 *
 * @param {string} target
 * @param {string[]} roots
 * @returns {boolean}
 */
export function isWithinRemovalRoots(target, roots) {
  const canonicalTarget = canonicalPath(target);
  return roots.some((root) => contains(canonicalPath(root), canonicalTarget));
}

/**
 * Resolve `target` and return it, or throw {@link RemovalRefusedError} when it
 * is not under one of `roots`. The resolved path is what a caller should delete
 * or report, so the resolution is not repeated at the deletion site.
 *
 * @param {string} target
 * @param {string[]} roots
 * @returns {string}
 */
export function assertWithinRemovalRoots(target, roots) {
  const canonicalTarget = canonicalPath(target);
  const canonicalRoots = roots.map(canonicalPath);
  if (!canonicalRoots.some((root) => contains(root, canonicalTarget))) {
    throw new RemovalRefusedError(canonicalTarget, canonicalRoots);
  }
  return canonicalTarget;
}

/**
 * Remove `target`, recursively, every deletion preceded by a fresh resolution
 * and containment check. Links are unlinked, never followed: the check on a
 * link is about where it points, and a link that points outside is refused, so
 * its target cannot be reached through it.
 *
 * A target that does not exist is simply absent; only a target that resolves
 * outside the effective roots raises. When the environment names no root, every
 * target raises.
 *
 * @param {string} target
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {void}
 */
export function removeWithinRemovalRoots(target, env = process.env) {
  const roots = removalRoots(env);
  if (roots.length === 0) throw new RemovalRefusedError(canonicalPath(target), roots);
  removeChecked(target, roots);
}

/**
 * @param {string} target
 * @param {string[]} roots canonical and already non-empty
 * @returns {void}
 */
function removeChecked(target, roots) {
  /** @type {import("node:fs").Stats} */
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw error;
  }
  // Resolve immediately before this entry's own deletion. `lstat` does not
  // follow the link, so a directory link is unlinked below rather than walked.
  assertWithinRemovalRoots(target, roots);
  if (stats.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  if (stats.isDirectory()) {
    for (const name of readdirSync(target)) removeChecked(join(target, name), roots);
    // Re-check after the children, so a directory swapped for an escaping link
    // in the meantime is not removed by the `rmdir` either.
    assertWithinRemovalRoots(target, roots);
    rmdirSync(target);
    return;
  }
  unlinkSync(target);
}
