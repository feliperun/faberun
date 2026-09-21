---
id: durable-state-integrity-phase-4
title: "State written by an older version of the product is repaired, not condemned"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: ae88f35
---

# State written by an older version of the product is repaired, not condemned

## Intent

Phase 4 of `durable-state-integrity`, carved so the out-of-session planner can
draft it. R6 and R7 are quoted verbatim below in the owner's Portuguese; the
measures, non-goals and constraints are this phase's own.

Two places where durable state the product itself wrote is now unreadable or
unmovable by the product, with no command that advances. The campaign's first
three phases stopped the product from *losing* and *misreporting* state; this
one is about state it already has and cannot repair.

## Measured state

Measured 2026-09-21 at `ae88f35`, against this operator's real state.

**The unreadable record.** `faberun campaign list` reports
`run-harness-audit-20260818 · corrupt · campaign.status must be active or
closed`. Its `campaign.json` carries `id, goal, linkedRunIds, createdAt,
updatedAt` and no `status`: it was written 2026-08-18, before the field
existed. `validateCampaign` (`src/campaign/record.mjs:62`) requires it.

The tree already holds the idiom for this, six lines below the throw:
`contracts` and `landBranch` are *"optional on read so a recorded historical
campaign stays readable; a campaign written by `initializeCampaign` always
carries them."* `status` was made required without that courtesy, so one
record is condemned permanently and no verb repairs it.

**The migration that cannot finish.** `faberun migrate` exits with

```
migration copy does not verify: .runs/control/second-opinions is missing or
different at <home>/runs/control/second-opinions; nothing was published or removed
```

The source is seven ordinary files with ordinary permissions; the destination
does not exist at all; this repository still carries 13 MB under `.runs/`.
`verifyCopy` (`src/run/migrate.mjs:191`) compares a staging copy against the
source and refuses to publish on any difference, which is the right shape —
why that directory never reached the copy is what this phase must find.

**A premise this phase had to falsify first.** The requirement inherited the
claim that five read-only `controller-snapshots` directories were the blocker.
They are `drwxr-xr-x`, owner-writable. Not read-only, and not the blocker.

| Indicator | Today | Target |
| --- | --- | --- |
| Campaign records `campaign list` calls `corrupt` | 1 | 0 |
| Verbs that repair such a record | 0 | 1 |
| `migrate` outcome | refuses, same error every run | completes, or names what would let it |
| Bytes of `.runs/` still in the repository | 13 MB | 0 |

## Requirements

### R6. Registro de campanha de versão anterior é reparado

- **statement:** `migrate` cura registro de campanha escrito antes de um campo
  existir, aplicando o mesmo default que a escrita atual aplicaria, e reporta o
  que curou; depois dele nenhum registro é reportado `corrupt` por campo
  ausente; um registro corrompido por outro motivo continua sendo reportado.
- **proof:** `command: node --test test/campaign/record-repair.test.mjs`

### R7. A migração conclui, ou diz o que fazer para concluir

- **statement:** `migrate` não fica indefinidamente recusando a passagem
  inteira: ou completa a cópia, ou nomeia em uma linha o que o operador precisa
  fazer para que ela complete. Enquanto recusa, o estado não fica dividido
  entre o repositório e a home sem caminho de saída.
- **proof:** `command: node --test test/run/migrate-completes.test.mjs`

## Non-goals

- Do not introduce campaign schema versioning. R6 repairs a missing field with
  the default current writes apply; it does not migrate between declared
  versions.
- Do not weaken `verifyCopy`. Refusing to publish a copy that does not match
  the source is correct, and a migration that publishes unverified state would
  be a worse defect than the one being fixed.
- Do not silently rewrite a record that is corrupt for any reason other than a
  field absent because it postdates the record. Anything else stays reported.
- Do not delete `.runs/` from the repository by hand as the fix. The point is
  that the command works.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0`. Neither requirement adds a contract field.
- No `.mjs` file exceeds 800 lines. `src/campaign/record.mjs` is at 130 and
  `src/run/migrate.mjs` at 278, so both have room.
- `npm run typecheck` clean; `noUnusedLocals` stays on.
- Every directory-wide verification command declares `--test-concurrency=1`,
  and its declared timeout is measured with that flag on. Measured serialised
  2026-09-21: `test/campaign/` 117s, `test/repo/` 44s,
  `test/run/migrate.test.mjs` 1s, the shared ratchets 2s, `npm run check` 13s,
  `npm run typecheck` 3s.
- No definition-of-done proof uses `--test-name-pattern`; point it at a whole
  file. The rule and its measurement are in `AGENTS.md`.
- `VERIFICATION_LIMITS.maxTimeoutSec` is 600. `test/engine/` as a directory
  stays out of the arrays: it cannot be measured on this machine, where the
  attempt was killed for low memory.
- A repair must be reported. A migration or a repair that fixes something
  without saying so is the defect this campaign spent three phases removing.
- One contract for the phase, every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Records reported `corrupt` for an absent field | 1 | 0 | `campaign list` |
| Records reported `corrupt` for any other reason | 0 | still reported | tests |
| Repairs the output names | 0 of 0, since no repair exists | every one performed | tests |
| `migrate` runs that end with state split and no instruction | every one | 0 | tests |
| Bytes of `.runs/` still in the repository after `migrate` | 13 MB | 0 | `du` |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The repair invents a status for a campaign that was genuinely active | medium | The default must be the one current writes apply, stated in the packet and reported when used; a record predating the field has not been driven since it existed |
| Repairing on read hides the fact that a record was old | medium | R6 requires the repair to be reported, not silent |
| Relaxing the validator lets a genuinely malformed record through | high | A non-goal, and a success metric: a record corrupt for any other reason stays reported |
| The migrate cause turns out to be in the copy step, not the verifier | medium | Expected. The measured state names the verifier as correct and the copy as unexplained; the node's job is to find which |
| Fixing migrate on this operator's state does not generalise | medium | The proof is a test with a fixture reproducing the shape, not a one-off run against the live tree |
