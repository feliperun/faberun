---
type: ADR
id: "0006"
title: "GitHub Releases and npm distribution with install.sh and self-update"
status: active
date: 2026-09-15
---

## Context

A user needs a one-command install and an update path, and the maintainer needs
releases that follow the Conventional Commits already required at the root. The
runtime is plain ESM with zero runtime dependencies, so there is no build step
to publish; the only moving parts are the version number, the release archive
and the installed layout. An updater that switches the live version before
proving the new binary runs can brick an installation that was working.

## Decision

**Distribute over one version through GitHub Releases and the npm registry, and
verify a newly installed binary before switching to it.**

- **release-please** (`release-type: node`, tags `vX.Y.Z`,
  `bump-minor-pre-major`) opens the release PR and cuts the GitHub Release from
  the merged history.
- **GitHub Releases** is the archive channel: `install.sh` and `faberun update`
  fetch `archive/refs/tags/vX.Y.Z.tar.gz`.
- **npm** is the registry channel: the package `faberun` is published from CI
  with npm trusted publishing (OIDC) and provenance, so its versions follow the
  GitHub releases; `npm install -g faberun` and `npx faberun` read it.
- **Install layout** under `$FABERUN_HOME` (default `~/.faberun`):
  `versions/<v>/` for the extracted releases, `current -> versions/<v>` for
  the live version, `config.json` for the user's runtime choices, and
  `update-check.json` for the banner's cached check. `$FABERUN_BIN_DIR`
  (default `~/.local/bin`) gets `faberun -> $FABERUN_HOME/current/bin/faberun.mjs`.
- **Verify before switch:** an install runs the new version's `--version`
  before the `current` symlink moves. `install.sh` is POSIX `sh`,
  idempotent, and falls back to `main` while no release exists;
  `FABERUN_VERSION` pins a version and `FABERUN_INSTALL_SOURCE` installs from a
  local tarball or directory.

## Options considered

- **GitHub Releases only** (rejected as the only channel): it covers
  `install.sh` and self-update but leaves no `npm install -g` or `npx` path.
- **Hand-cut tags and a manual npm publish** (rejected): the version drifts
  from the commit history and the publish loses provenance.
- **GitHub Releases plus npm with trusted publishing and provenance, over one
  version** (chosen).

## Consequences

- A release is a release PR and a tag; the installer, the self-updater, npm and
  npx agree on one number.
- The updater never points `current` at a binary it has not executed, and a
  failed verification leaves the previous version live.
- `faberun --version` prints the package version, kept separate from the
  contract protocol version (`contractVersion`) that appears in contracts.
- No build step and no runtime dependency means the tarball is the source tree.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *Decisions already
  made* → *Distribution*, *Install layout*, and *Phase 2* items 2 and 6,
  *Phase 3* item 1.
- [install.sh](../../install.sh) — requirements, version resolution,
  `FABERUN_INSTALL_SOURCE`, verify-before-switch.
- `src/cli/update.mjs` and `src/host/home.mjs` — the layout the installer and
  the updater share.
