# Spec: become-faberun — the repository becomes Faberun

Campaign `become-faberun` turns this repository from a personal skills
catalogue that happens to contain a tool into the home of that tool, renamed
**Faberun**, and runs that transformation through the tool itself. Every
node below is executed by a Faberun worker, verified by Faberun's own
verification and judged by a cross-vendor judge; the orchestrator authored
this spec, `DESIGN.md`, the four contracts, and nothing in `src/`.

Target: `/Users/frb/dev/frb/skills` (GitHub `feliperun/faberun`, already
renamed; the `faberun` organisation exists and is empty). Node 22+, plain ESM
`.mjs`, JSDoc-typed, zero runtime dependencies. All artefacts in English.

## What the owner asked for

1. Rename every reference from intent-factory to Faberun.
2. Move the source out of `skills/mine/intent-factory/` to the repository
   root, keep the commit history, and reorganise the tree.
3. Give the CLI an installer, a self-updater and versioned releases
   (release-please).
4. Replace evolution-internal docs with user-facing ones: a real README, a
   vision, the concepts, a command manual, a getting-started path, using the
   `init-agentkit` structure (VISION, ARCHITECTURE, GETTING-STARTED, ADRs).
5. First-run onboarding on a fresh machine: check Node and requirements,
   detect installed harnesses, ask which ones to use.
6. A visual identity of its own: the hornero nest as the mark, the five-color
   palette, recorded in `DESIGN.md`.
7. Keep the skills; they become features of the CLI. The agent kit stays,
   optional.
8. Do all of it as a campaign of the tool on itself.

## Decisions already made

- **Name and package.** Project *Faberun*, command and package `faberun`,
  GitHub `feliperun/faberun` (a transfer to the `faberun` organisation is the
  owner's call, and GitHub redirects either way). Env prefix `FABERUN_`,
  ref namespace `refs/faberun/<run>/…`, attempt branches
  `faberun/<run>/<node>/<attempt>`, tmux session `faberun-seat`, managed
  block markers `faberun-active`, seal commits `faberun <run> <node> attempt <n>`.
- **Two versions, kept apart.** The package version (`package.json`, moved by
  release-please, printed by `faberun --version`) and the contract protocol
  version (`contractVersion`, today `0.3.0`, the constant currently named
  `INTENT_FACTORY_VERSION`). The constant is renamed `CONTRACT_VERSION` and
  stays at `0.3.0`; contracts authored for this campaign say
  `"contractVersion": "0.3.0"` and must keep validating after the rename.
- **Layout.** `src/`, `test/`, `evals/`, `bin/`, `integrations/` at the
  root. `docs/` holds the user-facing docs; `docs/history/` the dated
  retrospectives, specs and reviews; `docs/campaigns/` the campaign records
  (including this spec); `docs/FIELD-OWNERSHIP.md` stays live and
  test-backed; `docs/harnesses/` holds harness references (`zcode-cli.md`).
  Skills live at `skills/<name>/`: `skills/faberun/` (the orchestrator
  skill: `SKILL.md` + `references/`) and `skills/init-agentkit/`. The
  `bulk-read` skill folder is removed; `bulk-read` remains a CLI command and
  is documented in the manual and the skill references.
- **History is not rewritten.** `docs/history/**`, `docs/campaigns/**` and
  `evals/golden/**` keep every `intent-factory` they contain; a contract
  records what a worker was told. The rename is enforced on the live tree
  only, by a ratchet test.
- **Moves preserve history without `git mv`.** Workers run inside a sandbox
  that cannot write the shared `.git` directory, so they use `mv`; git's
  rename detection makes `git log --follow` work on the sealed commit.
- **Distribution.** GitHub Releases cut by release-please
  (`release-type: node`, tags `vX.Y.Z`, `bump-minor-pre-major`). The
  installer and the self-updater fetch the release tarball
  (`archive/refs/tags/vX.Y.Z.tar.gz`); no build step, no npm publish in this
  campaign (`npx github:feliperun/faberun` keeps working through
  `package.json#bin`).
- **Install layout.** `$FABERUN_HOME` (default `~/.faberun`):
  `versions/<v>/` (extracted tarballs), `current -> versions/<v>`,
  `config.json` (user runtime choices), `update-check.json` (cache).
  `$FABERUN_BIN_DIR` (default `~/.local/bin`) gets `faberun ->
  $FABERUN_HOME/current/bin/faberun.mjs`.
- **Onboarding.** `faberun setup` detects harnesses through the existing
  discovery (`discoverRuntimes` over `DISCOVERY_RUNTIME_DEFINITIONS`), asks
  which to enable and which runtime is the default worker and judge (the
  judge must resolve to a different vendor), and writes `config.json`.
  Composition of omitted `runtimes` honours that config. `faberun init`
  prepares a target repository: `.runs/` ignored, the `faberun` skill
  installed into `.claude/skills/`, and optionally the agent kit
  (`skills/init-agentkit/scripts/install-agentkit.sh`, `--greenfield` or
  `--stable`, always asked).
- **No spend ceiling, no new machinery in the engine** beyond what the
  config hook and the `campaign unpark` fix need.
- **Line grammar and the `[ok]`/`[warn]`/`[fail]` tokens do not change.**
  Colour is added around them; tests and the statusline script keep
  matching plain text.

## Non-goals

- Restyling the web dashboard to `DESIGN.md` (follow-up).
- Publishing to npm; transferring the repository to the organisation.
- Rewriting historical documents or golden fixtures.
- Windows support for `install.sh` (PowerShell installer is a follow-up).
- Any change to the contract schema or the judge protocol.

## Operating rules for this campaign

- Ids say what the work is, never only when it ran: campaign `become-faberun`,
  runs `become-faberun-<n>-<what>`, phases and nodes named for their outcome.
  The owner asked for this on 2026-09-15 after seeing `p1`/`p2` ids.
- One contract per phase, registered in the campaign manifest at `init`;
  `supervise campaign become-faberun` drives the chain, promoting each run
  onto `campaign/become-faberun`. The orchestrator lands that branch on
  `main` at the end, after running the full suite once more.
- The controller runs from an immutable `git archive` snapshot under
  `.runs/control/become-faberun/controller/`, so workers editing `src/`
  never change the code that is driving them.
- Verification budgets were measured before authoring (see the campaign
  record); no packet asks a worker to run the whole suite. Workers never run
  `npm install` in a worktree (husky's `prepare` dirties the ignore snapshot).
- A parked run is continued with `resume`, never re-authored. If the chain
  parks with `contract_validation_failed` on a later contract, that contract
  is fixed and re-registered in a follow-up campaign; the manifest digest is
  not edited by hand.

## Phase 1 — layout and rename (run `become-faberun-1-move-and-rename`)

Two autonomous nodes, sequential; the second is the phase terminal and runs
the full suite as `finalVerification`.

**move-to-root.** Everything under `skills/mine/intent-factory/` moves to the
root as decided above; the four root tests join `test/` (`installer` under
`test/cli/`, `signal` under `test/repo/`, `session-start` and `ci-policy`
under `test/host/`); the skill's `AGENTS.md` merges into the root `AGENTS.md`
as a *Source tree rules* section; `skills/mine/` and `skills/README.md`
disappear; `.claude/skills/` symlinks point at `skills/faberun` and
`skills/init-agentkit`; `package.json`, `tsconfig.json`, `ci.yml`,
`bin/skills.mjs`, the path-fixing tests (`source-shape`, `docs-diet`,
`link-check`, `command-surface`, `reserved-articles`, `installer`,
`field-ownership`) and `README.md` name the new paths; `docs/history/README.md`
gains the 2026-09-15 mapping.
*Done when:* `skills/mine` does not exist; `npm run check`, `tsc`, the
targeted tests and the deterministic evals pass; `git diff --stat -M` shows
renames, not rewrites, for `src/**`.

**rename-to-faberun.** Every live occurrence of `intent-factory`,
`Intent Factory`, `intentfactory` and `INTENT_FACTORY` becomes `faberun`,
`Faberun`, `faberun` and `FABERUN` (the version constant becomes
`CONTRACT_VERSION`); `bin/intent-factory.mjs` becomes `bin/faberun.mjs`;
`package.json` is renamed `faberun` with the pitch as description;
`package-lock.json` follows; the ref namespace, branch prefix, tmux session,
managed-block markers, seal messages, usage lines, dashboard title,
statusline text and the skill's `name:` change as decided; the root
`AGENTS.md` managed block carries the new markers; a ratchet test
`test/repo/brand.test.mjs` asserts the live tree is free of the old name.
*Done when:* the ratchet passes; `git diff --quiet HEAD -- docs/history
docs/campaigns evals/golden` is clean; targeted tests, `tsc` and evals pass;
the full suite passes as the phase's final verification.

## Phase 2 — the CLI as a product (run `become-faberun-2-cli-product`)

Execution packets with closed scope. The `src/cli.mjs` chain is sequential;
`campaign-unpark` is independent.

1. **brand-and-banner.** `src/cli/brand.mjs` implements `DESIGN.md`: colour capability,
   `paint`, glyphs, the banner, `faberun` with no arguments and `--help`
   print banner plus usage on a TTY, `faberun --version` prints
   `faberun <package version>` from `src/host/package.mjs`; `[ok]`/`[warn]`/
   `[fail]` tokens gain colour in `doctor` and `preflight` without changing
   their text. Tests in `test/cli/brand.test.mjs`.
2. **self-update.** `faberun update [--check] [--json]` against the GitHub
   Releases API (`FABERUN_RELEASES_URL` override), install layout as decided,
   verification by executing the new version's `--version` before the
   `current` symlink moves, `update-check.json` cache read by the banner and
   refreshed by `doctor`. Tests with a local `node:http` server and a
   fixture tarball; no network in tests.
3. **skills-verb.** `faberun skills list | install [name…] [--global] [--force]
   [--target <dir>]` replaces `bin/skills.mjs`; the installer test drives the
   new verb through `bin/faberun.mjs`.
4. **setup-onboarding.** `faberun setup [--yes] [--harnesses a,b] [--worker <id>]
   [--judge <id>] [--json]`: requirements, discovery, prompts, `config.json`;
   `composeAssignments` honours the config. Tests inject discovery results.
5. **init-repository.** `faberun init [--cwd <dir>] [--yes] [--no-skill] [--agentkit]
   [--greenfield|--stable]`: `.runs/` ignored, skill installed, agent kit
   offered and run through the shipped installer script.
6. **install-script.** `install.sh` at the root, POSIX `sh`, requirements, version
   resolution (`FABERUN_VERSION`, latest release, `main` when no release
   exists yet), `FABERUN_INSTALL_SOURCE` for offline installs, idempotent,
   runs `faberun setup` on an interactive TTY. Tested with a local tarball.
7. **campaign-unpark.** `faberun campaign unpark <id>` clears a parked
   campaign's `attention` once the referenced run is no longer parked, with a
   `campaign.unparked` journal event — the chain today has no way back from
   `parked`, which this campaign would otherwise hit first.

*Done when:* each node's tests, `tsc` and `test/docs/` pass; the phase's
final verification runs the full suite.

## Phase 3 — documentation and releases (run `become-faberun-3-docs-and-releases`)

Five nodes, two in parallel; `docs-index` is the terminal node.

1. **release-pipeline.** `.github/workflows/release-please.yml`,
   `release-please-config.json`, `.release-please-manifest.json`, a seeded
   `CHANGELOG.md`; `ci-policy` test extended to pin the release workflow.
2. **command-manual.** `docs/COMMANDS.md`: every verb and subcommand with synopsis,
   flags, exit codes and one example; `command-surface` test rewritten to
   compare the manual (not the README) with the CLI in both directions.
3. **vision-and-concepts.** `docs/VISION.md` (from the pitch) and
   `docs/CONCEPTS.md` (intent, campaign, contract, run, node, packet, worker,
   judge, gate, harness, runtime, vendor, worktree, integration, promotion,
   seat, handoff, attention).
4. **getting-started-and-adrs.** `docs/GETTING-STARTED.md`,
   `docs/ARCHITECTURE.md`, `docs/adr/` with README and ADRs 0001–0006
   (record decisions; root-managed AI guidance; harness- and model-agnostic
   orchestration; closed packets with cross-vendor judges; the repository
   becomes the Faberun CLI; GitHub Releases distribution and self-update).
5. **docs-index.** `docs/README.md` as the documentation map, the docs link
   line at the top of `AGENTS.md`, link check green across `docs/`.

## Phase 4 — the front door (run `become-faberun-4-front-door`)

1. **readme-front-door.** A user-facing `README.md`: icon, pitch, install one-liner,
   quickstart (`setup` → `init` → first campaign), how it works in five
   sentences, harness table, links into `docs/`, development, licence.
2. **skill-references.** `skills/faberun/SKILL.md` and
   `references/operations.md` name `setup`, `init`, `update` and `skills`
   within the docs-diet ceilings, raising a ceiling only by the bytes the new
   commands cost and saying so in the test.

## After the campaign (orchestrator)

Land `campaign/become-faberun` on `main`, push, confirm CI, let
release-please open the first release PR, enable "Allow GitHub Actions to
create and approve pull requests" if it is off, install the built CLI on this
machine through `install.sh`, record the retrospective, close the campaign,
and copy the contracts into `docs/campaigns/become-faberun/control/`.

## Appendix — positioning (the owner's pitch, verbatim)

**Faberun is a development orchestration system that turns intent into
verified software.**

The name comes from two ideas: **Faber** is Latin for *maker*, *craftsman*,
*builder* — someone who transforms raw material into something useful through
skill, process, and tools. **Run** is what software does. Together, Faberun
represents the transition from **making** to **running**.

Not just generating code. Not just executing a plan. Not just another coding
agent. Faberun manages the process around software creation: plans, tasks,
dependencies, execution, validation, evidence, retries, and progress toward a
defined outcome.

It is intentionally **model-agnostic and harness-agnostic**. Claude Code,
Codex, OpenCode, or whatever comes next are workers. Claude, GPT, Gemini, or
another model are engines. Faberun sits above them. It keeps the intent,
coordinates the work, tracks what has actually been completed, validates the
result, and decides what should happen next.

The name also reflects a core belief behind the project: *software should be
built, not merely generated.* A craftsman does not depend on one hammer.
Faberun does not depend on one model or one agent. Tools can change. Models
can change. Harnesses can change. The work remains.

**Faberun — from intent to running software.**
