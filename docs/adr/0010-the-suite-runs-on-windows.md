---
type: ADR
id: "0010"
title: "The suite runs on Windows: ownership, detachment, and what a platform can prove"
status: active
date: 2026-09-21
---

## Context

[ADR 0009](0009-a-campaign-runs-on-windows.md) claimed that a campaign runs on
Windows and left the suite red on purpose: 910 pass / 332 fail before that work,
1027 / 93 after it, measured on Windows 11 with node 24. A campaign running is
not the same claim as a suite passing, and the gap was where the remaining
Windows defects lived.

Closing it found nine product defects, not a pile of fragile tests. Each was
invisible on POSIX, and three of them would have met any operator who tried to
use the tool there:

- **`run --detach` never worked.** The controller was spawned with
  `detached: true` everywhere except Windows, where it was off because that
  platform has no process group to create. But on Windows the flag also means
  breakaway from the job object libuv puts every non-detached child in, and
  that job is killed when the parent exits. Measured 2026-09-21: the controller
  bootstrapped to `ready`, printed a pid, and was gone a second later, leaving
  the node `pending` with nothing said about why.
- **A controller never terminated the provider it started.** Ownership was
  proven by a process start token, and Windows records none — `wmic` is gone
  from Windows 11 26200 and the PowerShell that replaced it costs ~400 ms per
  probe. So every recorded invocation was unverifiable, and
  `terminateInvocation`, `cancelRun` and resume's orphan reaping all returned
  without signalling anything. That is the mechanism behind ADR 0009's
  measured 105 stranded fixtures, and it also hung the suite: two test runners
  from earlier sessions were still alive hours later, waiting on a provider
  nobody had killed.
- **A notification never arrived.** The transport is a binary an operator binds
  by hand, which on Windows is a `.cmd` shim or a script; it was spawned
  directly, and every delivery failed silently.

The rest were the same shape: a spawn point that had not gone through the
platform module (the dsh runner, the provider catalogue probe, the bulk-read
delegation, the seat's tmux), a relative executable whose shebang was looked
for beside the controller instead of beside the child, a suggested command
quoted for a shell that reads a single quote literally, an ENOSPC injection
matching a path spelled with the wrong separator, and a git that started a file
system monitor daemon per fixture repository — 4810 of them in one afternoon,
holding 39 GB.

## Decision

**A platform difference is either fixed in the product or stated in the test.
Neither is allowed to be silent.**

- **Every spawn goes through `spawnInvocation`, and it now takes the child's
  `cwd`.** A contract names a wrapped harness by a relative path
  (`./my-worker.mjs`); only the caller knows what it is relative to, and
  reading the shebang from anywhere else is EFTYPE with no explanation. The
  remaining direct spawns are gone: dsh runner, notify transport, catalogue
  probe, bulk-read delegation, seat tmux.
- **`--detach` detaches on every platform**, for a different reason on each: a
  new session on POSIX, breakaway from the job object on Windows, where it also
  means `DETACHED_PROCESS` — no console window, which discarded stdio already
  implied.
- **On Windows, a live recorded pid is proof of ownership.** It is the same
  evidence `killTarget` already acts on there. The pid-reuse defence is what is
  given up, and `process-identity.mjs` says so: a pid recycled into an
  unrelated process between the record and the kill reads as owned. Never
  terminating anything is the worse failure, and it was the one in place.
- **`gitArguments` carries `core.fsmonitor=false` everywhere**, and the suite
  passes the same setting through `GIT_CONFIG_*` so a git spawned by a CLI this
  tool spawned inherits it. Nothing here benefits from a daemon watching a tree
  that is about to be deleted.
- **A test states the platform's own form, or skips with the reason.** A
  fixture writes the file this host can run and names the home variable this
  host reads; an assertion about an exec bit, a process group, a dying signal
  handler or a symlinked scope holds only where the platform has one, and the
  `host-layout` guard's `guard-exempt` marker carries the reason inline.

## Options considered

- **Force `core.symlinks=true` on Windows** (rejected): it would make a
  symlinked scope resolve the way POSIX resolves it, and it would also make
  checkout fail outright on every host without the privilege — which is what
  git's own probe reports, since a fresh `git init` there writes `false` even
  where node can create a link. A run that cannot start is worse than a scope
  spelled one way instead of two.
- **A Windows start token via PowerShell** (rejected): ~400 ms on a path a
  controller walks on every lock read, to defend against a pid recycled inside
  one run's lifetime. Measured and written down rather than paid for.
- **Leave the suite red and keep the narrow install job** (rejected): the three
  defects above were only findable by running it, and a job nobody expects to
  pass protects nothing.

## Consequences

- **CI runs the full suite on Windows.** The `windows-install` job becomes a
  full matrix job: `npm ci`, `npm run check`, `npm run typecheck`, `npm test`
  and both deterministic eval classes, with `fetch-depth: 0` because
  `test/plan/existing-specs.test.mjs` resolves each spec's baseline commit.
- **The deterministic eval class is 20/20 on Windows**, and every case still
  discriminates.
- Known limits, each named where it bites: no start token, so pid reuse is
  undetectable; a repository's symlinks materialize as regular files in an
  attempt worktree, so a scope declared through one resolves to a single
  spelling; a terminated process is an ordinary non-zero exit, so the
  signal-death retry cannot fire; `faberun seat` is still unclaimed, because
  tmux is still POSIX. [ADR 0009](0009-a-campaign-runs-on-windows.md) carries
  the fifth, which belongs with these because an operator meets it the same
  way: `git worktree add` fails with `'$GIT_DIR' too big` once the internal
  `.git/worktrees/<name>` path passes about 160 characters, a fixed buffer in
  Git for Windows that no configuration reaches. A repository a few
  directories from the drive root is fine; one under a long temporary path is
  not.

## References

- [ADR 0009](0009-a-campaign-runs-on-windows.md) — the campaign claim this
  extends, and the platform module every spawn and kill goes through.
- `src/engine/process-identity.mjs` — the ownership rule and what Windows
  gives up.
- `src/cli/launch.mjs` — why a detached controller is detached on every
  platform.
- `test/host-layout-guard.mjs` — the guard that makes a platform branch in a
  test declare its reason.
