---
type: ADR
id: "0007"
title: "Windows install: one layout, junctions for directory links"
status: active
date: 2026-09-20
---

## Context

[ADR 0006](0006-github-releases-distribution-and-self-update.md) defines one
install layout — `versions/<v>/`, `current -> versions/<v>`, a linked binary —
and two ways to get it: `install.sh` and `faberun update`. Both assume POSIX.
`install.sh` is `sh` and links with `ln -sfn`; the updater creates a symlink and
renames it over `current`; `skills register` symlinks a directory into each
harness's skills directory.

On Windows none of that holds, and the failures are silent rather than loud.
Measured 2026-09-18 on Windows 11 with node 24:

- A **directory symlink** needs Developer Mode or an elevated shell. On a stock
  machine `symlinkSync` fails with `EPERM`, so `update` and `skills register`
  both fail at their last step.
- **Renaming a directory over an existing junction** fails with `EPERM`, so the
  updater's atomic swap cannot be the mechanism there.
- **`findExecutable` never consulted `PATHEXT`**, so `doctor` reported
  `binary node · not found on PATH` from a process node was running, the banner
  counted no harnesses, and `skills register` reported every harness absent.
- **`tar` resolved to whichever tar is first on `PATH`.** Git for Windows
  installs a GNU tar that reads the `C:` of an absolute path as a remote host:
  `tar (child): Cannot connect to C: resolve failed`.

## Decision

**One install layout on every platform; the platform-specific primitives live
in one module.**

- **`install.ps1`** is the Windows installer: PowerShell 5.1, the same
  environment variables (`FABERUN_HOME`, `FABERUN_BIN_DIR`, `FABERUN_VERSION`,
  `FABERUN_INSTALL_SOURCE`, `FABERUN_NO_SETUP`), the same `[ok]`/`[fail]`
  output, the same idempotence, the same verify-before-switch, and the same
  hand-off to `faberun setup`.
- **A directory link is a junction on Windows.** It needs no privilege,
  `realpathSync` resolves it — which is how `installedVersionDir` identifies the
  running version — and `lstatSync().isSymbolicLink()` is true for it, so every
  reader written against the POSIX layout keeps working. `src/host/platform.mjs`
  owns `linkDirectory`, used by the updater and by `skills register`: an atomic
  rename over a sibling temporary link on POSIX, a remove and remake on Windows,
  where no atomic form exists.
- **`$FABERUN_BIN_DIR` gets two shims instead of one link**, and defaults to
  `$FABERUN_HOME\bin`: Windows cannot execute a `.mjs` through a link,
  `faberun.cmd` is what PowerShell and cmd find through `PATHEXT`, and the
  extensionless POSIX script is what Git Bash finds, since it resolves neither.
  `~/.local/bin` is on no Windows `PATH`; the install root owns its own.
- **`PATHEXT` is part of resolving a command**, with the bare name last:
  `node` on `PATH` is `node.exe`, and the extensionless file npm leaves beside
  `npm.cmd` is a shell script no Windows process can execute.
- **`tar` is System32's when it is there** (bsdtar, shipped since Windows 10
  1803), resolved by absolute path rather than taken from `PATH`.
- **Scope: install, update and self-check.** Running a campaign end to end on
  Windows is not claimed. The engine's process control (process groups,
  `SIGSTOP`, the detached controller) and the `seat` command are POSIX-shaped,
  and CI runs the full suite on Linux and macOS; the Windows job guards this
  surface only.

## Options considered

- **Require WSL or Git Bash and ship nothing** (rejected): `install.sh` under
  Git Bash still builds a layout the CLI is then run outside of, and the four
  failures above are in the product, not in the shell.
- **A pointer *file* instead of a link on Windows** (rejected): it divides the
  layout in two, and every reader — the updater, the banner, `skills register`,
  `installedVersionDir` — would need both branches forever.
- **Directory symlinks, requiring Developer Mode** (rejected): it makes a
  Windows setting a prerequisite for an install that does not need one.
- **One layout, junctions, and a platform module** (chosen).

## Consequences

- The Windows install is the same three facts as the POSIX one: a version
  directory, a `current` that points at it, and a binary reached through
  `current`. `faberun update` moves the same link.
- The `current` swap is atomic on POSIX and not on Windows. A reader in the
  moment between the remove and the remake finds nothing there; on a
  single-operator machine that window is one syscall wide, and no reader of the
  layout runs concurrently with an update by design.
- `doctor`, the banner and `skills register` report the truth on Windows, which
  they did not before, and the same code reports the same truth on POSIX.
- A second installer is a second thing to keep in step. The two are held
  together by the tests: `test/host/install-sh.test.mjs` and
  `test/host/install-ps1.test.mjs` assert the same layout from the same
  scenarios, each skipped on the platform it does not describe.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *Decisions already
  made* → *Install layout*.
- [ADR 0006](0006-github-releases-distribution-and-self-update.md) — the layout
  and the channels this extends.
- [install.ps1](../../install.ps1) — requirements, version resolution, the
  junction, the two shims.
- `src/host/platform.mjs` — `linkDirectory` and `tarExecutable`, shared by the
  updater and the skill registration.
