---
id: durable-state-integrity-phase-2
title: "A suite run leaves the operator's home exactly as it found it"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: 5ca2dbf
---

# A suite run leaves the operator's home exactly as it found it

## Intent

Phase 2 of `durable-state-integrity`, carved out so the out-of-session planner
can draft it. R3 and R4 are quoted verbatim below in the owner's Portuguese;
the measures, non-goals and constraints around them are this phase's own.

`test/helpers.mjs` already points `FABERUN_HOME` at a throwaway directory, and
the comment above it states the reason correctly: `runsRoot` registers every
path it resolves as a project, so an unset variable writes real project entries
into the operator's own `~/.faberun` as a side effect of running the tests.
The mechanism is right. Its reach is not: it applies only to files that import
it, which makes it a convention rather than a rule.

The argument for this phase is not the count of unscoped files. It is that the
same leak has already been fixed twice, one file at a time, and each fix left
the next file leaking.

## Measured state

Measured 2026-09-21 at `5ca2dbf`, against the operator's real `~/.faberun`,
which holds 394 project records.

Classifying every test file by resolving each `helpers.mjs` import to a path --
a plain grep is wrong here, because several directories carry their own local
`helpers.mjs` that scopes nothing, and counting those as scoped is what
produced an earlier, inflated figure:

| | count |
| --- | --- |
| test files | 136 |
| scope the home (root helper resolved, or own `FABERUN_HOME`) | 82 |
| scope nothing | 54 |

Running all 54 in one pass leaks exactly **1** record, and the same file leaks
it every time: `node --test test/contract/derived-fields.test.mjs` alone
reproduces it, twice out of two attempts.

The history is the argument. Grouping the accumulated records by origin and
creation day:

| day | eval fixtures | `statusline.test.mjs` | `derived-fields.test.mjs` |
| --- | --- | --- | --- |
| 2026-09-19 | 222 | 72 | 27 |
| 2026-09-20 | 0 | 0 | 29 |
| 2026-09-21 | 0 | 0 | 36 |

The eval fixtures stopped when `evals/case.mjs` gained
`withScopedFaberunHome`. `statusline.test.mjs` stopped when `e85a9e6` gave it
its own `FABERUN_HOME`. Neither has written a record since. The third file
never received either fix and is still writing one record per run, three days
running.

Existing pieces this phase reuses rather than reimplements: the `mkdtempSync`
and the comment in `test/helpers.mjs`, `withScopedFaberunHome` in
`evals/case.mjs` as the shape that already works, the `test` script in
`package.json`, and `test/repo/source-shape.test.mjs`, where this repository's
ratchets live.

## Requirements

### R3. Rodar a suíte não escreve na home do operador

- **statement:** a home de teste é escopada pelo runner, não por import: a suíte
  inteira resolve `FABERUN_HOME` para um diretório descartável, e um `npm test`
  completo deixa `~/.faberun` sem nenhum arquivo novo, alterado ou removido.
- **proof:** `command: node --test --test-name-pattern="a suite run leaves the operator home untouched"`

### R4. A regra de R3 é ratchet, não convenção

- **statement:** um arquivo de teste novo não consegue reintroduzir o vazamento;
  a regra vive junto das outras deste repositório e falha `npm test` quando
  violada, medindo o efeito e não a presença de um import.
- **proof:** `command: node --test --test-name-pattern="no test file can write to the real faberun home"`

## Non-goals

- Do not delete the 392 accumulated records. Purging is a command the operator
  runs and it already exists; this phase stops new ones being written.
- Do not remove the per-file scoping that already works. `test/helpers.mjs`
  and `withScopedFaberunHome` keep their behaviour; the runner-level scope is
  additive and makes them redundant rather than wrong.
- Do not change what `runsRoot` does. Registering a resolved path as a project
  is correct product behaviour; the defect is that a test run reaches the real
  home at all.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0`. This phase adds no contract field.
- No `.mjs` file exceeds 800 lines; raising the ceiling is not a fix.
- `npm run typecheck` must be clean; `noUnusedLocals` stays on.
- R4 must measure the **effect** on the home, not the presence of an import.
  An import-shaped assertion is what let two files leak past the last two
  fixes, and `derived-fields.test.mjs` imports a file literally named
  `helpers.mjs` while scoping nothing.
- R3 lands before R4, which measures it.
- No test bounds a measured duration from above, and none depends on a binary
  on `PATH` or on machine layout.
- Every verification command carries a measured duration before it is given a
  declared timeout. **When the command names a file the node itself creates,
  measure the directory that will contain it and say so** — a proxy file is
  not a measurement of the declared command, and an unmeasurable command is
  not an excuse for an invented number. Measured 2026-09-21: `test/repo/` 35s,
  `test/engine/` 158s, `npm run typecheck` 3s, `npm run check` 3s.
- One contract for the phase, with every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Records written to `~/.faberun` by a full `npm test` | 1 | 0 | tests |
| Test files that can leak | 54 | 0 | ratchet |
| Times this leak has been fixed one file at a time | 2, with a third still leaking | 0; the rule moves to the runner | tree |
| Records written by `derived-fields.test.mjs` per day | 27, 29, 36 on three consecutive days | 0 | `~/.faberun/projects` |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A runner-level scope breaks a test that legitimately needs the real home | medium | None is known to; R3 lands first and the suite is the proof. A test that truly needs it opts out explicitly and says why |
| The ratchet measures the import and a new file escapes it again | high | A constraint, and R4's statement requires the effect to be measured |
| The scoped home hides a product defect that only appears against a real home | medium | The product's own resolution path is unchanged; only the variable differs, which is what `withScopedFaberunHome` already relies on |
| A parallel test runner shares one scoped home and tests collide | medium | The existing helper already creates one `mkdtemp` per process; the runner-level scope must not narrow that to one shared directory |
