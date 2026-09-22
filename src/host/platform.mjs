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
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync, symlinkSync } from "node:fs";
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

/** A command script Windows runs through the command interpreter, not directly. */
const COMMAND_SCRIPT = /\.(?:cmd|bat)$/iu;

/**
 * How this platform has to be asked to run `executable` with `args`.
 *
 * POSIX hands both back untouched. Windows has two problems with the binaries
 * a harness actually installs as, and both are this function's business so no
 * caller has to know about either.
 *
 * A command name resolves through `PATHEXT`, and `spawn` does not do it: with
 * only `claude.cmd` on PATH, `spawn("claude")` is ENOENT. So a bare name is
 * resolved here first.
 *
 * And a `.cmd` or `.bat` cannot be spawned directly at all — node refuses it
 * with EINVAL since the argument-injection fix — so it runs through
 * `%ComSpec% /d /s /c`. Every argument is quoted for `CommandLineToArgvW` and
 * then caret-escaped *twice*: the interpreter consumes one layer parsing the
 * command line, and the `%*` that every npm-written shim forwards its
 * arguments with consumes the second. Measured 2026-09-20 on Windows 11 —
 * with one layer, an argument containing `&` is truncated at it; with two,
 * spaces, quotes, `&`, `|`, `%`, `^`, `()` and `!` all arrive intact.
 *
 * A relative executable — `./my-worker.mjs`, the shape a contract names a
 * wrapped harness by — is relative to the directory the child will run in, and
 * the caller is the only one who knows it. Without `cwd` the shebang is looked
 * for beside *this* process instead, found nowhere, and the spawn fails as
 * EFTYPE with nothing said about why.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd?: string}} [options] the directory the child will run in
 * @returns {{command: string, args: string[], options: {windowsVerbatimArguments?: boolean}}}
 */
export function spawnInvocation(executable, args, options = {}) {
  if (process.platform !== "win32") return { command: executable, args, options: {} };
  const named = executable.includes("/") || executable.includes("\\");
  const resolved = named
    ? (options.cwd === undefined ? executable : resolve(options.cwd, executable))
    : (findExecutable(executable) ?? executable);
  if (COMMAND_SCRIPT.test(resolved)) {
    const line = [quoteArgument(resolved), ...args.map((argument) => escapeThroughShim(quoteArgument(argument)))].join(" ");
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  const shebang = interpreterOf(resolved);
  if (shebang) return { command: shebang[0], args: [...shebang.slice(1), resolved, ...args], options: {} };
  return { command: resolved, args, options: {} };
}

/**
 * The interpreter a `#!` line names, or null when the file has none.
 *
 * A shebang is a POSIX kernel feature, so Windows hands the same file back as
 * EFTYPE. Reading the line and running the interpreter is what cross-spawn —
 * and therefore npm — does on Windows, and it is the only way an executable
 * handed over as a POSIX script (`FABERUN_CODEX_BIN` pointed at the
 * extensionless file npm installs beside its `.cmd`, a harness wrapper written
 * by hand) runs there at all.
 *
 * @param {string} path
 * @returns {string[]|null} the interpreter and its own arguments
 */
function interpreterOf(path) {
  /** @type {number|undefined} */
  let handle;
  try {
    handle = openSync(path, "r");
    const head = Buffer.alloc(256);
    const read = readSync(handle, head, 0, 256, 0);
    const first = head.subarray(0, read).toString("utf8").split(/\r?\n/u, 1)[0];
    if (!first.startsWith("#!")) return null;
    const line = first.slice(2).trim();
    if (!line) return null;
    // A whole line that names a real file is the interpreter, spaces and all:
    // every fixture here is written with `#!${process.execPath}`, and on
    // Windows that is `C:\Program Files\nodejs\node.exe`. Splitting it on
    // whitespace the POSIX way would ask for `C:\Program`.
    if (existsSync(line)) return [line];
    // An interpreter named by a POSIX path that this host does not have:
    // `#!/bin/sh` is not a file on Windows, but `sh` is a command there
    // wherever Git for Windows is installed, which is wherever this tool runs.
    const named = line.includes(" ") ? null : findExecutable(line.slice(line.lastIndexOf("/") + 1));
    if (named) return [named];
    // `#!/usr/bin/env node` names the interpreter in its own argument.
    const parts = line.split(/\s+/u).filter(Boolean);
    if (!parts.length) return null;
    if (/(?:^|[\\/])env(?:\.exe)?$/iu.test(parts[0])) return parts.slice(1).length ? parts.slice(1) : null;
    return parts;
  } catch {
    // Unreadable, a directory, or gone: there is no shebang to honour, and the
    // spawn below reports the real reason.
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * One argument, quoted the way `CommandLineToArgvW` reads it back: a backslash
 * run before a quote doubles, and a trailing run doubles so the closing quote
 * survives.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteArgument(value) {
  return `"${String(value).replace(/(\*)"/gu, '$1$1\\"').replace(/(\+)$/u, "$1$1")}"`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeThroughShim(value) {
  return value.replace(/[()%!^"<>&|]/gu, "^$&").replace(/[()%!^"<>&|]/gu, "^$&");
}

/**
 * End a process and everything it started, the way this platform can.
 *
 * On POSIX the caller passes a negative pid and the kernel signals the whole
 * process group, which is what every signalling path here already does.
 * Windows has no process group to signal: `process.kill(pid)` ends that one
 * process, and the provider a gate spawned — or the `node` a `.cmd` shim
 * started — keeps running. Measured 2026-09-20: a full suite run on Windows 11
 * stranded 105 `node -e "setInterval(…)"` fixtures this way, and then hung
 * waiting for one of them to die.
 *
 * `taskkill /T` walks the tree from the pid. `/F` is the only ending Windows
 * offers a console process, so there is no graceful step to escalate from —
 * which is why every caller already skips its `SIGKILL` escalation there.
 * A non-zero exit means no such process, read the way a POSIX `ESRCH` is: the
 * target is gone, which is not a failure to report.
 *
 * @param {number} target a pid, or on POSIX a negative process-group id
 * @param {string|number} signal
 * @returns {unknown}
 */
export function killTarget(target, signal) {
  if (process.platform !== "win32") return process.kill(target, signal);
  const result = spawnSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "taskkill.exe"), ["/PID", String(Math.abs(target)), "/T", "/F"], { stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`taskkill found no process ${Math.abs(target)}`), { code: "ESRCH" });
  return true;
}

/**
 * The `git` argument list every invocation here carries.
 *
 * **`core.fsmonitor=false`, on every platform.** A repository with the file
 * system monitor enabled starts `git fsmonitor--daemon --detach` on first use,
 * and the daemon outlives the directory it watched. This tool creates a
 * worktree per attempt and its suite creates a throwaway repository per
 * fixture, so the daemons accumulate: measured 2026-09-20 on Windows 11, one
 * afternoon of suite runs left **4810** of them holding 39 GB, until the
 * machine could not start another test process. Nothing here benefits from a
 * daemon watching a tree that is about to be deleted.
 *
 * **`core.longpaths=true`, on Windows.** It caps a path at 260 characters
 * unless the program opts out, and git's
 * own `core.longpaths` is off by default even where the OS itself allows long
 * paths. The run layout is deep on purpose — `projects/<id>/runs/worktrees/
 * <run>/<node>.<attempt>` before the repository's own tree begins — so a file
 * a worker writes a few directories down reaches the cap easily.
 *
 * What makes this worth a flag on every call is *how* git fails there.
 * Measured 2026-09-20 on Windows 11, a repository holding one file at a
 * 268-character path: `git add --all` exits 0 and tracks nothing. With
 * `core.longpaths=true` it exits 0 and tracks the file. A tool whose gate is
 * the diff of what a worker changed cannot afford a git that silently cannot
 * see part of the tree.
 *
 * It does not lift every limit: `git worktree add` dies with `'$GIT_DIR' too
 * big` once the repository's own `.git/worktrees/<name>` path passes about 160
 * characters, and that guard is a fixed buffer no configuration reaches.
 *
 * **`core.autocrlf=false`, on Windows.** The default there is `true`, and it
 * rewrites line endings on the way into the index and out of a checkout. This
 * tool's gate is a byte comparison of what a worker changed, and a rewrite it
 * did not make is indistinguishable from one it did: measured 2026-09-22 on a
 * GitHub windows-latest runner, a declared read carried into an attempt
 * worktree came back changed after passing through git, the scope gate called
 * it an `unexpected_write`, and the adopted node failed for a file nobody had
 * touched. The attempt worktree is this tool's own directory and its content
 * is what the run commits; the operator's checkout keeps whatever they
 * configured.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function gitArguments(args) {
  const platformArgs = process.platform === "win32"
    ? ["-c", "core.longpaths=true", "-c", "core.autocrlf=false"]
    : [];
  return ["-c", "core.fsmonitor=false", ...platformArgs, ...args];
}
