/**
 * Writing a stand-in binary the host can actually run, in its own module
 * because two files need it and one of them is `setup.mjs`, which
 * `helpers.mjs` imports — the function cannot live in the importer.
 *
 * A shebang is a POSIX kernel feature. On Windows the same file spawns as
 * EFTYPE, which is why every fixture runtime here used to report "no version"
 * there — a `.cmd` beside the module is what that platform runs, and it is the
 * same shape npm installs a Node CLI as, so the suite exercises the spawn path
 * a real Windows machine takes.
 */
import { chmodSync, writeFileSync } from "node:fs";

/**
 * @param {string} path the module's path, ending in `.mjs` or bare
 * @param {string} body the program, without a shebang line
 * @returns {string} the path to spawn
 */
export function writeExecutable(path, body) {
  if (process.platform !== "win32") {
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o755);
    return path;
  }
  const script = path.endsWith(".mjs") ? path : `${path}.mjs`;
  writeFileSync(script, body);
  const shim = `${path.replace(/\.mjs$/u, "")}.cmd`;
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return shim;
}
