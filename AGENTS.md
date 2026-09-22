# AGENTS.md

> [Vision](docs/VISION.md) · [Roadmap](docs/ROADMAP.md) · [Concepts](docs/CONCEPTS.md) · [Architecture](docs/ARCHITECTURE.md) · [Getting started](docs/GETTING-STARTED.md) · [Commands](docs/COMMANDS.md) · [ADRs](docs/adr/README.md) · [Design](DESIGN.md)

Write the minimum code that runs. No fluff, no gold-plating.

- Do not preserve backward compatibility. Remove obsolete paths instead of adding
  compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements.
  Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end,
  and add each new capability on top of a product that already works. Never trade a
  working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity
  or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a capability
  without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only
  works for now and is meant to be replaced later.
- Study how established products solve the problem before designing a solution. Adopt
  their proven patterns and conventions rather than inventing an approach from scratch.

## Repository rules

- **`AGENTS.md` is the single source of guidance.** `CLAUDE.md`, `GEMINI.md`,
  `CURSOR.md` and `AGENT.md` are symlinks to it.
  Never edit a symlink; never let one drift into a real file.
- **Templates are portable, this file is not.** Anything under a skill's
  `templates/` is copied into other repositories, so it must stay generic —
  placeholders (`{{PROJECT}}`, `{{CHECK_SUITE}}`, `{{DATE}}`,
  `{{SENTRUX_VERSION}}`), no project-specific paths, no personal data.
- **Never commit secrets.** Tokens, credentials, and service-account JSON stay in a
  secret manager or a gitignored `.env`. The `pre-commit` hook scans the staged diff;
  do not work around it.
- **Nothing from a private or employer repository lands here** without an explicit
  decision. This repo is intended to be public.
- **Conventional Commits required.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`. One logical change per commit.
- **Never `--no-verify`.** If a hook blocks, fix the underlying issue.
- **Shell scripts** run under `set -euo pipefail` and are idempotent — re-running
  completes what is missing instead of duplicating or destroying.

## Faberun protocol

When using `faberun`, the orchestrator owns repository discovery. Read the
campaign `HANDOFF.md`, attach the current session, and record concise material
events before delegating. Give every execution worker a closed task packet with
exact read files, write files, decisions, non-goals, and verification commands.
Only an explicit read-only discovery node may explore beyond a supplied packet.

Two authoring rules, each paid for by a node that died without them. Declare in
`symbols` a name the node *introduces*, never one it merely uses — a widely
imported name fails scope closure against every importer, while a name the node
creates has none. And `writeFiles` lists what the change *forces* to change, not
only what it intends to: the schema validator for a field you add, the registry
that field is recorded in, and any reader your own instructions tell the worker
to touch. Keep a packet's `verification` to the few commands the node actually
needs; every command's output is serialized into the judge prompt, and a packet
with seven of them has exceeded the 64 KiB guard and killed its own node.

A third rule, paid for by a gate that certified nothing. **Never prove a
Definition of Done item with `--test-name-pattern` unless the packet names the
exact test string and requires the worker to use it.** Measured 2026-09-21:
`node --test --test-name-pattern="<anything that matches nothing>" <file>`
prints a tick for the *file*, reports `tests 1 pass 1 fail 0`, and exits `0` —
indistinguishable from a pattern that matched a real test. Three of one
phase's six DoD proofs named patterns no test carried, and the gate reported
that every deterministic item passed. Node has no flag that fails on an empty
match, so the only defence at authoring time is to pin the name or point the
proof at the whole file.

**Continuity beats restart.** Before starting new work, check `.runs/` and the
managed signal block at the bottom of this file: an active campaign or a
non-terminal run is work to continue — read its `HANDOFF.md`/`STATUS.md`,
re-attach the session, and `resume` or `supervise` — not to redo.

## Source tree rules

The repository rules above still apply. This section is the rules for *this
repository*, and every rule here is either enforced by a test or is a decision
you can check against the tree in one command. A rule nobody can fail is
decoration.

### Layout

`src/` is the source; nothing else under this repository is. Each directory is a
layer, and the layer names are the vocabulary:

| directory | owns |
| --- | --- |
| `cli.mjs`, `cli/` | argv, dispatch, usage. No domain logic. |
| `contract/` | the authored artefact: schema and validation. Reads only files the contract itself names (`taskPacketFile`); spawns nothing. |
| `plan/` | the out-of-session planner: spec format, repository facts, routing, sizing, freeze. Reads the target repository, never a provider. |
| `engine/` | the control loop: scheduler, node lifecycle, routing, gates. |
| `harnesses/` | one adapter per provider harness, plus what each one can run. |
| `campaign/` | the durable layer above runs. |
| `repo/` | anything that touches the target repository: git, worktrees, the workspace. |
| `run/` | the `.runs/` directory: store, lock, ledgers, gc. |
| `report/`, `web/` | the two ways a human reads a run. Presentation only. |
| `host/` | facts about the machine. |
| `notify/` | notification transports. |
| `util.mjs` | helpers with no domain. Nothing imports a layer from here. |

`bin/` is the entry point and calls into `src/`. `test/` mirrors `src/`.
`docs/history/` and `evals/golden/` are historical record — see
`docs/history/README.md` before "fixing" a path in either.

### Enforced rules

These fail `npm test`. `test/repo/source-shape.test.mjs` is where they live.

- **No file over 800 lines.** Counted on every `.mjs` under this repository. A
  file that grows past it is doing more than one job; find the second job and
  give it a module. Raising the ceiling is not a fix.
- **No runtime import cycle in `src/`.** The allowlist is empty and asserted
  empty. The entry that used to be there (`engine/lifecycle.mjs` ↔
  `engine/review.mjs`) was settlement living in the wrong module; extracting
  `engine/settle.mjs` removed it. JSDoc `import("…")` type references do not
  count — they are erased at runtime.
- **No top-level body defined twice in `src/`.** Compared by body with the
  declaration's *name stripped*, because a copy that was renamed is still a
  copy — a name-keyed version of this gate let a byte-identical `compactCost`
  live on in `cli.mjs` as `formatCost`. If two modules need it, it has one home
  and both import it.
- **No name exported from two `src/` modules.** A module-private helper may
  share a name — a standalone spawned program with its own `fail` or `usage` is
  idiomatic and nobody can import it by mistake. Two *exported* ones is the
  hazard: this tree had two `stableJson`s (a comparator and a pretty-printer)
  and two `requireText`s, one of which read a file. `harness` is exempt by name:
  every adapter exports it, and that uniformity *is* the registry interface.
- **No barrel modules.** A module that only re-exports gives every symbol two
  homes and makes "where does this come from" unanswerable. `lib.mjs` was one;
  it is gone.
- **No empty `catch {}` block in `src/`.** Asserted at the measured count,
  which is now zero: a swallowed error gets either a body or a comment naming
  the failure it expects and why ignoring it is correct. A comment is a
  legitimate answer — the rule is against silence, not against ignoring a
  failure.
- **Every module header stays**, ratcheted the same way: the count of `src/`
  modules with no leading block comment (30 of 84) only falls.
- **No test bounds a measured duration from above.** `assert.ok(elapsed < 500)`
  asserts how fast this machine is, and a loaded laptop falsifies it; this repo
  has had that bug. A *lower* bound is fine — it proves a delay happened, and a
  slower machine only makes it more true. Blocking waits of a second or more
  are ratcheted rather than banned: `run/lock.test.mjs` waits out a real lock
  TTL, and there is no honest way to prove expiry without letting time pass.
- **No unused declaration anywhere.** `noUnusedLocals` is on, so `npm run
  typecheck` is the gate. Turning it on after the splits found 392 dead
  imports, typedefs and helpers, most of them left behind by the splits
  themselves.

### Conventions

- **Plain ESM `.mjs`, typed with JSDoc.** `npm run typecheck` runs `tsc` over
  the whole tree in checkJS mode and must be clean. It is not optional tooling:
  it has caught a merged helper that would have broken four git probes silently,
  and eleven type errors in a file that had been hiding inside a string.
- **A module's header comment says what it owns and why it is separate.** Not
  what its functions do — the reader can see that. Why *this* boundary.
- **Comments record measurement, not intent.** `measured 2026-09-11: …` with the
  number is worth ten lines of description. If a limit, a timeout or a retry
  count has no measurement behind it, say that too.
- **No dead exports.** If nothing imports it, delete it. Two "shared" numeric
  helpers survived here for months with exactly one reference each: their own
  definition. `noUnusedLocals` catches the module-private half of this; the
  exported half still needs a reader.
- **Name a function for what it does, not for what it resembles.** Two
  `requireText`s existed; one read a file. Two `stableJson`s existed; one was a
  pretty-printer.

### Extraction and refactoring

Splitting a module is mechanical and should be scripted, not retyped — but:

- **Run `node --check` after every step, not at the end.** A scripted extractor
  that tracks braces and not brackets will cut `new Set([…])` in half, and the
  result parses as far as the next file.
- **Beware template literals holding code.** Three separate tools of mine were
  fooled by them in one day: an import anchored on "the last `import` in the
  file" landed inside a generated worker program; a dead-code deleter cut a
  template's opening line and left its body; and a definition scanner treated
  the template's column-0 contents as top-level. Mask them, or anchor on the
  leading import block only.
- **Check the module dependency graph before choosing boundaries.** If two
  candidate modules point at each other, the shared thing usually wants to be a
  third module — that is where `contract/schema-version.mjs`, `campaign/layout.mjs`
  and `campaign/record.mjs` came from.
- **Historical artefacts are not stale paths.** A campaign contract under
  `docs/campaigns/` records what a worker was actually told. Editing it makes
  the record lie about a run that already happened.

### Tests

- `test/` mirrors `src/` by directory. File names follow the module where one
  exists and the behaviour otherwise (`test/engine/routing.test.mjs` covers
  several modules) — the directory is the rule, the file name is a preference.
- **A test that asserts a live model's exact words is not a test of this code.**
  Assert the envelope, the token count, the wire. One such assertion failed
  twice in a day on wording alone.
- **A verification duration is a measurement.** Before putting a command in a
  packet or a `verification` array, run it and know how long it takes. Measure
  it with `--test-concurrency=1` if that is how it will run: the parallel
  default spawns one process per file, and on 2026-09-21 that killed
  `node --test test/engine/` twice with no exit code on a machine at 91%
  swap, exhausting a node whose work was sound.
- **A test that reads what another process writes must wait for a readiness
  signal, and the signal must be written *after* the thing it announces.**
  Bounding a duration from above is the famous version of this hazard; this
  is the same hazard wearing another shape, and it passes locally. Measured
  2026-09-22: the live-cancel fixtures were read as soon as they spawned, so
  three of four CI runners failed with `ENOENT` on a log the fixture had not
  written yet, while the fourth and the author's machine passed. The first
  fix wrote the readiness file *before* installing the signal handler, which
  proves only that the script started; the file has to come after, or the
  wait proves nothing. Poll for it — polling is a lower bound on elapsed
  time, never an assertion about how fast this machine is.
- **A provider fixture answers the liveness prompt without counting it.**
  The dispatch gate says hello to every routed runtime before any dispatch,
  so a provider is now invoked once per launch on top of every dispatched
  turn. Any fixture that counts, sequences or logs invocations sees that
  hello, and six of them did: `tier-exhaustion` asserts the evidence entries
  exactly, `failover` asserts request counts and continuation ids, `routing`
  keys its network failures on the call number, `seal-before-kill` hangs on
  call 1 by design so the hello *became* the hang, `spend` logs every worker
  prompt, and `runner-helpers`' result-file fixture numbers the attempt it
  reports, so an uncounted hello is the difference between "worker attempt 2"
  and a number nobody wrote. A fixture recognises the hello by `FABERUN_PREFLIGHT_OK` in
  the prompt and answers it, exactly as it already recognises a judge prompt
  by `Review node` — three kinds of prompt instead of two, same discipline.
  Condition on the prompt text and nothing else: a fixture that checks the
  environment, a path, or whether it is under test has stopped emulating a
  provider and started faking one.

- **A polling deadline is scaled by `SPAWN_WAIT_FACTOR`, never written as a
  raw number.** The rule above bans asserting how fast a machine is; a wait
  deadline is the same hazard one step removed, because it fails when the
  machine is slow rather than when the code is wrong. Measured 2026-09-22 over
  four Windows CI jobs, `run --detach leaves a controller that outlives the
  invoker` completed in 11.3s, 15.2s and 16.2s and then blew its 60s deadline
  on the fourth; the runner's tail is over 4x its median, so a bound chosen
  from the median turns contention into a red build. The factor is 6 on
  Windows and 1 everywhere else. Two of eight checks flickering destroys the
  signal more thoroughly than a slow suite does. Raising a bound separates
  flake-by-slowness from flake-by-hang and cannot cure the second: on the same
  runner `a gate exits once the directory holding its release file is gone`
  either completes in under half a second or never completes, and no deadline
  makes that test green.

- **Two `node --test` traps, both measured 2026-09-21 on v26.8.1, both of
  which make a check silently stop checking.** A `--test-reporter=` that
  appears *after* a test file on the command line is ignored — node reads its
  own options left to right, so the flag lands among the script's arguments;
  pass it before the files or through `NODE_OPTIONS`. And a nested
  `node --test` that inherits `NODE_TEST_CONTEXT` from the runner that spawned
  it stays a runner child and emits no TAP at all, so anything parsing its
  output sees nothing and concludes nothing is wrong. Both were found by the
  node implementing the empty-filter refusal, and either one would have made
  that refusal a gate that never fires.

## Production note

Rule 1 is written for side projects. Against a live system it can lead an agent to
equate "obsolete" with "safe to delete" and destroy data.

When this file governs anything in production:

- Soften rule 1: require migrations, backups, or explicit human approval before any
  destructive schema or data change.
- Weigh rule 1 against rule 7 case by case. Long-term correctness does not justify
  unreviewed destructive action against production data.
- Never grant an agent operating under this file unsupervised write or delete access
  to a production database.
