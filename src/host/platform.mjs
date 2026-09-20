/**
 * The three primitives whose implementation differs on Windows, in one module
 * because the callers that need them — the updater repointing `current`, the
 * skill registration linking a directory, the doctor and the banner asking
 * whether a binary is there — must all get the same answer.
 *
 * A directory link is a junction on Windows. A directory *symlink* there needs
 * Developer Mode or an elevated shell, so `symlinkSync` on a stock machine
 * fails with EPERM; a junction needs no privilege, resolves through
 * `realpathSync` — which is how `installedVersionDir` identifies the running
 * version — and reports `isSymbolicLink()` true, so every reader already
 * written against the POSIX layout keeps working.
 *
 * `tar` is the one in System32 when it is there (bsdtar, shipped with Windows
 * since 10 1803). Git for Windows puts a GNU tar on PATH that reads the `C:` in
 * an absolute path as a remote host and fails with `Cannot connect to C:`, and
 * whichever of the two comes first on PATH is not something this tool gets to
 * choose. install.ps1 resolves it the same way for the same reason.
 *
 * A command name is a name plus `PATHEXT` on Windows. `node` on PATH is
 * `node.exe` and there is no extensionless file beside it, so a lookup that
 * only joins the bare name reports the running interpreter as missing.
 */
import { existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Point `linkPath` at `target`, replacing whatever link is already there. A
 * relative `target` is relative to the link's own directory, which is the form
 * the install layout is written in (`current -> versions/<v>`).
 *
 * On POSIX the swap is atomic: a sibling temporary link then a rename, so a
 * concurrent reader sees either the old target or the new one, never a missing
 * link. On Windows it cannot be — renaming a directory over an existing
 * junction fails with EPERM — so the link is removed and remade, and a reader
 * in the moment between the two finds nothing there.
 *
 * @param {string} linkPath
 * @param {string} target
 * @returns {void}
 */
export function linkDirectory(linkPath, target) {
  if (process.platform === "win32") {
    // A junction stores an absolute target; a relative one would be recorded
    // against the process cwd rather than the link's directory.
    const absolute = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(absolute, linkPath, "junction");
    return;
  }
  const temporary = `${linkPath}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, linkPath);
}

/**
 * The `tar` to spawn on this machine.
 *
 * @returns {string}
 */
export function tarExecutable() {
  if (process.platform !== "win32") return "tar";
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar";
}

/**
 * The first directory on PATH that holds `name`, or null. Exported because the
 * doctor, the banner and the skill registration all count the same binaries,
 * rather than each keeping a copy of the lookup that can disagree.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function findExecutable(name) {
  const candidates = executableCandidates(name);
  if (name.includes("/") || name.includes("\\")) {
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const path = join(dir, candidate);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * The file names a command name can have on this platform: itself on POSIX,
 * itself plus every `PATHEXT` spelling on Windows.
 *
 * PATHEXT comes first and the bare name last, because that is the order
 * Windows itself runs them in: `node` on PATH is `node.exe`, a CLI npm
 * installed is `<name>.cmd`, and the extensionless file npm leaves beside it is
 * a shell script no Windows process can execute. Measured 2026-09-18 on Windows
 * 11: without the extensions `doctor` reported `binary node · not found on
 * PATH` from a process that node itself was running.
 *
 * @param {string} name
 * @returns {string[]}
 */
function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  // Lowercased so the reported path reads like the file on disk: PATHEXT is
  // upper case by convention, the file system is not case sensitive.
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.trim().toLowerCase()).filter(Boolean);
  return [...extensions.map((extension) => `${name}${extension}`), name];
}
