# Spec: register-skill-and-harden — the installation registers the skill everywhere, and the factory absorbs its own retrospective

Campaign `register-skill-and-harden` (2026-09-16) follows `become-faberun`.
It has two sources: the owner's request that installing Faberun registers the
orchestrator skill in every harness that keeps skills, and the retrospective
of the previous campaign, whose lessons were paid for in re-runs. It runs
under `faberun supervise campaign`, so the chain coordinator fixed in the
previous campaign is exercised end to end for the first time.

Target: `/Users/frb/dev/frb/skills` (GitHub `feliperun/faberun`), main at
`e0f479f` or later. Workers on `dsh-deepseek-flash` (owner's rule), judge
`claude-opus-5`, cross-vendor.

## Decisions already made

- **Workers are told what their sandbox cannot do.** Every worker prompt says
  the controller's verification is the proof and that running commands
  oneself is optional and only for quick, process-free ones. Each harness
  adapter declares `signalsProcesses` (`true`, `false`, or `null` for
  unmeasured); when the resolved worker harness declares `false`, dispatch
  appends a `## Sandbox` section naming the limitation. Measured 2026-09-16:
  dsh `workspace-write` cannot signal other processes or read `ps`; claude with
  `bypassPermissions` can; codex, agy and exec-jsonl are unmeasured.
- **dsh workers get a clean git environment.** The Claude Code shell exports
  `GIT_CONFIG_COUNT/KEY_*/VALUE_*`; dsh keeps the VALUE half and drops the
  KEY half, so `git init` fails inside the worker. The dsh adapter strips that
  family and sets `GIT_TERMINAL_PROMPT=0` instead.
- **`sharedVerification`.** A contract-level command list, same schema as
  `finalVerification`, appended to every node's verification (attempt and
  candidate), counted in budgets and in `preflight --time-verification`. It is
  for the fast ratchets (source shape, field ownership, brand, docs diet), so
  a node whose write set breaks a repository rule fails on its own attempt,
  not on the phase-terminal node's full suite.
- **Deterministic engine tests.** `seal-before-kill` done-when 3 and the judge
  re-ask durability test in `judge.test.mjs` failed twice under load with no
  code change. Their races are removed at the source: the re-ask verdict is
  persisted before the blocked transition by construction, the seal test does
  not depend on a 0.6 s wall clock winning against a provider write, and both
  are proven by `repeat: 4` in the node's verification.
- **`scopeAcknowledged` defers like `readFiles`.** An entry may name a path a
  transitive dependency creates (in `writeFiles` or under `writeRoots`).
- **Unpriced usage is visible.** A role whose invocations carry no cost is
  rendered as `unpriced` with its token totals, never as `-` or `$0`.
- **`faberun skills register`.** Discovers the skill directories of the
  installed harnesses (claude `~/.claude/skills`, codex `~/.codex/skills`, the
  shared `~/.agents/skills`; zcode and agy by measuring their conventions on
  this machine; dsh has none) and links `faberun` into each, pointing at
  `$FABERUN_HOME/current/skills/faberun` when installed by `install.sh`
  (follows updates) or at the checkout otherwise; `--copy` copies. `faberun
  setup` offers it and `--yes` does it, so `install.sh` registers the skill
  on a fresh machine.
- Historical documents, golden fixtures and the previous campaign's records
  are never edited. `CONTRACT_VERSION` stays `0.3.0`.

## Non-goals

- Pricing tables for DeepSeek (numbers unknown to the authors; `pricing` in
  a runtime remains the operator's declaration).
- Dashboard restyle, Windows installer, org transfer.
- Any change to the chain coordinator itself: this campaign proves it by
  running under it.

## Phase 1 — worker side (run `register-skill-and-harden-1-worker-side`)

1. **worker-sandbox-awareness.** Capability `signalsProcesses` in the
   registry and every adapter; the verification paragraph of the three
   prompt renderers; the dispatch-time `## Sandbox` section; the dsh
   environment hygiene; tests and the two reference documents.
2. **shared-verification.** The contract field, its merge into every node's
   verification, budgets, preflight timing, tests and documentation.

## Phase 2 — engine determinism (run `register-skill-and-harden-2-engine-determinism`)

1. **deterministic-seal-and-reask.** The two tests and the ordering they
   depend on, proven by repetition.
2. **scope-acknowledged-deferral.** Deferral for `scopeAcknowledged`.
3. **unpriced-usage-visible.** Role totals in `report`/`status` when cost is
   unknown.

## Phase 3 — skill registration (run `register-skill-and-harden-3-skill-registration`)

1. **skills-register.** The verb, discovery of harness skill directories,
   setup integration, manual entry, tests.
2. **registration-docs.** README and GETTING-STARTED say what installing
   does to each harness.

## After the campaign (orchestrator)

Land on main, push, let release-please open the next release PR, install the
new version through `faberun update`, run `faberun skills register` for real
on this machine, record the retrospective, close the campaign.
