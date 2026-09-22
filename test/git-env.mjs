/**
 * The git every test process spawns, pinned — a side-effect module the way
 * `scoped-home.mjs` is, because a fixture repository is created in a temporary
 * directory with no `.gitattributes` and no local config and otherwise takes
 * whatever the machine holds globally. `GIT_CONFIG_*` reaches every git this
 * suite runs: its own, the product's, and any CLI the product spawns.
 *
 * `core.fsmonitor=false`: a repository with the file system monitor enabled
 * starts a detached `git fsmonitor--daemon` that outlives the directory it
 * watched, and this suite creates a throwaway repository per fixture —
 * measured 2026-09-20 on Windows 11, an afternoon of runs left 4810 of them
 * holding 39 GB, until no further test process could start.
 *
 * `core.autocrlf=false`: the default on Windows is `true`, and git then hands
 * back `\r\n` for the bytes a fixture wrote as `\n`. Measured 2026-09-22 on a
 * GitHub windows-latest runner, where it is the global default: tests failed
 * comparing a file they had just written to the one git checked out — a sealed
 * attempt, a recovered cost, a declared read carried into a worktree. The
 * repository under test belongs to the suite, and the suite writes LF.
 *
 * The runner owns this, not `helpers.mjs`: package.json preloads this file
 * into every test process, including the files that import no helper at all —
 * `test/repo/workspace.test.mjs` is one, and it is where the CRLF failure
 * outlived the first fix. `helpers.mjs` imports it too, for a file run on its
 * own.
 */

process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_1 = "false";
