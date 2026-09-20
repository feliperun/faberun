---
type: ADR
id: "0009"
title: "A campaign runs on Windows: spawning, killing and seeing the tree"
status: active
date: 2026-09-20
---

## Context

[ADR 0007](0007-windows-install-and-directory-links.md) claimed install, update
and self-check on Windows, and said out loud that running a campaign there was
not claimed. This extends that boundary, and records what was in the way.

Four things stood between an installed copy and a finished node. Each was
measured on Windows 11 with node 24 on 2026-09-20, and each is invisible until
something real runs: the full suite was 910 pass / 332 fail before any of them.

- **A harness installed by npm is a `.cmd`.** `spawn` refuses it with EINVAL
  since the argument-injection fix, and `spawn("claude")` with only
  `claude.cmd` on PATH is ENOENT, because `spawn` does not read `PATHEXT`.
- **A shebang is a POSIX kernel feature.** An executable handed over as a
  POSIX script — the extensionless file npm writes beside its `.cmd`, a
  harness wrapper written by hand — is EFTYPE.
- **There is no process group to kill.** `process.kill(pid)` ends one process,
  so the harness under a gate, or the `node` under a `.cmd` shim, keeps
  running. A full suite run stranded 105 `node` fixtures and then hung waiting
  for one of them.
- **Git cannot see past 260 characters, and says nothing.** With one file at a
  268-character path, `git add --all` exits 0 and tracks nothing. A tool whose
  gate is the diff of what a worker changed cannot afford that.

## Decision

**The platform module owns how a command is run and how it is stopped, and
every spawn and kill in the engine goes through it.**

- **`spawnInvocation(executable, args)`** answers what this platform must be
  asked. On Windows it resolves a bare name through `PATHEXT`, runs a `.cmd`
  or `.bat` through `%ComSpec% /d /s /c`, and reads a `#!` line and runs the
  interpreter named there. Arguments through the command interpreter are
  quoted for `CommandLineToArgvW` and caret-escaped twice, because the
  interpreter consumes one layer and the `%*` every npm shim forwards with
  consumes the second. Used by the provider gate, the version probe, the live
  preflight, and verification commands — `npm test` on Windows is `npm.cmd`.
- **`killTarget(target, signal)`** ends a process and everything it started:
  the process group on POSIX, `taskkill /T /F` on Windows, which has no group
  to signal and no graceful signal for a console process. Used by every
  termination path, including the gate's own, where the process being held is
  the command interpreter and the harness is its child.
- **`gitArguments(args)`** prefixes `-c core.longpaths=true` on Windows, so
  git sees the whole tree rather than silently skipping part of it.
- **Test fixtures are executable on the host that runs them.** `writeExecutable`
  writes a `.cmd` beside the module on Windows — the shape npm installs a Node
  CLI as — so the suite exercises the spawn path a real Windows machine takes
  rather than a POSIX one it cannot.

## Options considered

- **Emulate the POSIX shape** (rejected): teaching the tests to write files
  Windows can run, without the product learning the same, would leave the
  product broken for every npm-installed harness and the suite green anyway.
- **`shell: true`** (rejected): it works and it concatenates arguments instead
  of escaping them, which is the injection the EINVAL exists to prevent.
- **One platform module every spawn and kill goes through** (chosen): the
  behaviour is in one place, POSIX is unchanged by construction, and a test
  asserts each primitive against the file system rather than against
  `process.platform`.

## Consequences

- A gated campaign runs on Windows with the harness CLIs a Windows machine
  actually has. Proven 2026-09-20 end to end on Windows 11 with Anthropic
  models alone: a worker wrote a module and its test, the controller ran the
  verification, an Opus judge graded a Sonnet worker's output against a
  judgment item and returned a verdict, and the node landed `done`.
- Nothing about POSIX changes: each primitive returns its previous behaviour
  there, and the suite on Linux and macOS is the check on that.
- **Still not claimed:** `faberun seat`, which is tmux, and therefore POSIX.
  A Windows operator drives runs directly.
- **A known limit no configuration reaches:** `git worktree add` dies with
  `'$GIT_DIR' too big` once the repository's own `.git/worktrees/<name>` path
  passes about 160 characters — a fixed buffer in Git for Windows. A
  repository a few directories down a drive is fine; one under a long
  temporary path is not.

## References

- [ADR 0007](0007-windows-install-and-directory-links.md) — install, update
  and self-check, whose scope this extends.
- `src/host/platform.mjs` — the three primitives and the measurements behind
  each.
- `test/host/platform.test.mjs` — each asserted against the file system, so
  the same test states the same promise on either platform.
