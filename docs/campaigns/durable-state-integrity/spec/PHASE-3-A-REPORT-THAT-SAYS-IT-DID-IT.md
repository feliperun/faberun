---
id: durable-state-integrity-phase-3
title: "Nothing reports success for work it did not do"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: 740f9f1
---

# Nothing reports success for work it did not do

## Intent

Phase 3 of `durable-state-integrity`, carved so the out-of-session planner can
draft it. R5, R8 and R9 are quoted verbatim below in the owner's Portuguese;
the measures, non-goals and constraints are this phase's own.

Three places where the product answers "done" without having done it. They are
grouped because they are one defect wearing three faces, and because each was
found by the campaign running itself rather than by reading the code:

- a journal note above the cap is shortened and the CLI prints `noted`;
- a definition-of-done proof whose filter matches no test exits `0` and the
  gate reports every deterministic item passed;
- an inbox attention with no campaign is attributed to every campaign at once,
  so `AGENTS.md` names the wrong one as needing attention.

The first two lose information the operator believes was kept. The third
invents information the operator believes was measured.

## Measured state

Measured 2026-09-21 at `740f9f1`.

**The journal.** `normalizeText` (`src/campaign/journal.mjs:390`) passes every
note through `boundedText` at `JOURNAL_TEXT_BYTES` (2048, `layout.mjs:24`),
which appends an ellipsis and returns. The write path reports success. This
happened to this campaign three times: two attempts to record the previous
campaign's queue, which is why `proposals/queue.md` exists as a loose file
instead of a journal entry, and once while writing the note that documents
this very defect -- 2131 bytes sent, 2048 stored, and `[campaign] open-question
noted` printed. The lost sentence was the author's own correction.

**The proof.** `node --test --test-name-pattern="<matches nothing>" <file>`
prints a tick for the *file*, reports `tests 1 pass 1 fail 0` and exits `0` --
byte-identical in shape to a pattern that matched a real test. Three of phase
1's six definition-of-done items named patterns no test carried, and the gate
reported that every deterministic item passed. Node has no flag that fails on
an empty match. The authoring-time defence landed in `AGENTS.md` at `5ca2dbf`;
this is the engine-side one.

**The attention.** `src/repo/signal.mjs:144` selects an inbox entry when
`entry.campaignId === campaign.id` **or** `entry.campaignId === null`. All 12
attention entries in the inbox carry `null`, so an orphan is attributed to
every campaign at once, permanently. `AGENTS.md` announced, under a campaign
created minutes earlier, an attention from a run of
`harden-chain-and-verification`, closed 2026-09-17. Each entry carries `runId`,
so the attribution is recoverable and is being discarded.

| Indicator | Today | Target |
| --- | --- | --- |
| Journal notes truncated with a success report | 3 in this campaign | 0 |
| DoD proofs that pass having run no test | 3 of 6 in phase 1 | 0 |
| Campaigns an orphan attention appears under | all | none |
| Inbox attention entries carrying `campaignId: null` | 12 of 12 | attributed by `runId` where possible |

## Requirements

### R5. Nota que não cabe é recusada, não encurtada em silêncio

- **statement:** gravar uma entrada de journal acima do teto falha nomeando o
  teto e o tamanho recebido, em vez de truncar e reportar sucesso; o teto
  continua sendo o mesmo valor, e a leitura de entradas já truncadas segue
  funcionando.
- **proof:** `command: node --test test/campaign/journal-refuses-oversized.test.mjs`

### R8. Prova que não rodou teste nenhum não é prova

- **statement:** um comando de verificação ou de prova de DoD que restringe
  quais testes rodam e não casa com nenhum é recusado em vez de aprovado; o
  resultado nomeia o filtro e diz que ele não selecionou teste algum.
- **proof:** `command: node --test test/engine/proof-selected-no-test.test.mjs`

### R9. Atenção sem campanha aparece em nenhuma, não em todas

- **statement:** uma entrada de atenção que não pode ser atribuída a uma
  campanha não é exibida sob todas elas; a atribuição sai do identificador de
  run que a entrada já carrega, e o que continuar sem dono é exibido fora de
  qualquer campanha.
- **proof:** `command: node --test test/repo/signal-attention-attribution.test.mjs`

## Non-goals

- Do not change `JOURNAL_TEXT_BYTES`. The defect is the silent discard, not the
  value, and a larger cap would only move the cliff.
- Do not rewrite journal entries already truncated. They are the record of what
  was stored; reading them must keep working exactly as it does.
- Do not make the engine parse test-runner output to count assertions. R8 needs
  to know whether the declared filter selected anything, not how much passed.
- Do not ban `--test-name-pattern`. A pinned pattern that matches is a
  legitimate proof; an empty match is the defect.
- Do not backfill `campaignId` into the 12 existing inbox entries by guessing.
  R9 resolves from `runId` where the run is known and shows the rest under no
  campaign.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0`. No requirement here adds a contract field.
- No `.mjs` file exceeds 800 lines; raising the ceiling is not a fix.
- `npm run typecheck` clean; `noUnusedLocals` stays on.
- **Every directory-wide verification command declares `--test-concurrency=1`,
  and its declared timeout is measured with that flag on.** Measured
  2026-09-21: this machine ran at 91 percent swap and the parallel default
  killed `node --test test/engine/` twice with no exit code, exhausting a node
  for an environmental reason while its work was sound.
- No definition-of-done proof uses `--test-name-pattern`. Point the proof at a
  whole file. The rule and the measurement behind it are in `AGENTS.md`.
- `VERIFICATION_LIMITS.maxTimeoutSec` is 600. A command that cannot finish
  inside it does not belong in a verification array; put that proof where the
  work already runs, as phase 2 did with `ci.yml`.
- No test bounds a measured duration from above; none depends on a binary on
  `PATH` or on machine layout.
- One contract for the phase, every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Journal notes silently truncated | 3 in this campaign | 0; a refusal instead | tests |
| A refusal that names the cap and the size received | absent | present | tests |
| DoD proofs passing on an empty filter match | 3 of 6 in phase 1 | 0 | tests |
| Campaigns an orphan attention appears under | all | none | `AGENTS.md` |
| Attentions attributed from the `runId` they carry | 0 of 12 | every one whose run is known | tests |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Refusing a long note breaks a caller that relies on truncation today | medium | R5 keeps the cap and the read path; only the write path changes, and every in-tree caller is checked |
| The empty-match check misreads a runner that legitimately selects nothing | medium | R8 refuses only when the command itself declares a filter; a command with no filter is unaffected |
| Resolving a campaign from `runId` is wrong for a run the campaign no longer links | medium | R9 shows an unresolvable attention under no campaign rather than guessing |
| The three requirements are unrelated enough to make one node incoherent | medium | They are three modules and should be three nodes; the phase groups them by defect class, not by file |
| Serialising verification pushes a command past 600 seconds | high | A constraint: measure with `--test-concurrency=1` on, and split a directory that no longer fits |
