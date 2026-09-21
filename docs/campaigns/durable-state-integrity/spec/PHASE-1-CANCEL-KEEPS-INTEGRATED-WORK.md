---
id: durable-state-integrity-phase-1
title: "A cancelled run never orphans the work its nodes integrated"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: e3ae6a6
---

# A cancelled run never orphans the work its nodes integrated

## Intent

Phase 1 of `durable-state-integrity`, carved out so the out-of-session planner
can draft it. R1 and R2 are quoted verbatim below in the owner's Portuguese;
the measures, non-goals and constraints around them are this phase's own.

`cancel` is right to release the run ref and the attempt branches: they are git
names the next launch of the same contract id needs back, and the operator
asking to cancel is asking for exactly that. The comment in
`src/engine/cancel.mjs` says so, and then makes one claim too many -- that the
sha "remains in the persisted snapshot regardless". The sha does. The commit
does not: a commit no ref reaches is unreachable, and `git gc` is entitled to
prune it. For a node that never integrated, nothing is lost. For a node whose
work was already integrated onto the run's candidate, the product deletes the
only thing pointing at delivered work.

This is not hypothetical and it is not a reading of the code. It happened on
2026-09-21 in this repository, and the recovery is still visible in the tree.

## Measured state

Measured 2026-09-21 at `e3ae6a6`:

- `src/engine/cancel.mjs` is 190 lines. Its final block releases every
  `state.worktree.branch` through `releaseAttemptWorktree` and then calls
  `deleteRef(contract.cwd, runRefName(contract.id))`.
- `grep -rn "integratedHead" src/` returns six matches: the typedef
  (`src/contract/index.mjs`), the validator (`src/contract/snapshot.mjs`, twice),
  and the three writers (`src/engine/settle.mjs:199`, `src/engine/resume.mjs:601`,
  `src/engine/scheduler.mjs:290`). **No reader, and nothing that creates a ref
  from it.**
- `src/repo/worktree.mjs` is 419 lines and already exports `createRunRef`,
  `runRefName`, `candidateRefName`, `updateRefConditional` and `deleteRef`. The
  verb this phase needs is a sibling of one that exists, not a new mechanism.
- `test/engine/cancel.test.mjs` is 67 lines and asserts nothing about
  reachability after the cancel.
- The live evidence: this repository carries three tags -- `recover-r18`,
  `recover-r19`, `recover-r19-final` -- created by hand on 2026-09-21 to stop
  `git gc` from pruning the work of two nodes whose run had been cancelled. The
  shas were read out of the node snapshots' `integratedHead` and
  `worktree.commit` fields. `git for-each-ref --contains e8df29a1` reports four
  refs today and would report zero without that manual rescue.

Existing pieces this phase reuses rather than reimplements: `createRunRef` and
`runRefName` in `src/repo/worktree.mjs`, the `integratedHead` field already
written by `settle.mjs` and `resume.mjs`, and the idempotence contract that
`removeWorktree` and `deleteRef` already honour.

## Requirements

### R1. Cancelar uma run não torna trabalho integrado inalcançável

- **statement:** ao liberar o ref da run e os branches de tentativa, `cancel`
  cria antes uma referência durável para cada `integratedHead` não nulo dos nós
  daquela run; um `git gc --prune=now` depois do cancelamento não remove nenhum
  commit que um nó tenha integrado.
- **proof:** `command: node --test --test-name-pattern="cancel keeps integrated work reachable"`

### R2. Um cancelamento diz o que preservou

- **statement:** a saída de `cancel` nomeia cada referência que criou e cada
  artefato que liberou, de forma que o operador saiba onde procurar sem ler
  snapshot de nó; o mesmo cancelamento rodado duas vezes não cria referência
  duplicada nem falha.
- **proof:** `command: node --test --test-name-pattern="cancel reports what it preserved"`

## Non-goals

- Do not stop releasing the run ref or the attempt branches. Releasing them is
  what makes the contract id relaunchable, and that behaviour is correct.
- Do not preserve the attempt worktree directory. A worktree is scratch; an
  integrated commit is not.
- Do not add a field to the node snapshot. `integratedHead` already exists and
  already carries what this phase needs.
- Do not add a prune or expiry command for the preserved refs. They are cheap,
  the existing opt-in prune already reports before removing, and inventing a
  second lifecycle here is speculative.
- Do not touch `docs/history/`, any campaign already recorded under
  `docs/campaigns/`, or `evals/golden/`.

## Constraints

- `CONTRACT_VERSION` stays `0.3.0`. This phase adds no contract field.
- No `.mjs` file exceeds 800 lines. `src/repo/worktree.mjs` is at 419 and
  `src/engine/cancel.mjs` at 190, so both have room; raising the ceiling is not
  a fix in either case.
- `npm run typecheck` must be clean; `noUnusedLocals` stays on.
- The preserved ref lives under the namespace the run already owns
  (`refs/faberun/<run-id>/…`), so the existing tooling that reasons about that
  namespace keeps working.
- Cancel stays idempotent in both directions: a second cancel must neither fail
  nor create a duplicate ref, exactly as `deleteRef` and `removeWorktree`
  already behave.
- No test bounds a measured duration from above, and none depends on a binary
  on `PATH` or on machine layout.
- Every verification command has its duration measured before it is given a
  declared timeout; a DoD command proof is capped at 120s by the scheduler.
- One contract for the phase, with every node and edge authored in one turn.

## Success criteria

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Refs pointing at a node's `integratedHead` after cancel | 0 | 1 per integrated node | tests |
| Integrated commits surviving `git gc --prune=now` after cancel | 0 without manual rescue | all | tests |
| Manual steps to locate a cancelled run's integrated work | 4 (read snapshot, extract sha, tag, verify) | 0 | `cancel` output |
| Hand-made rescue tags needed in this repository | 3 | 0 for future cancels | tree |
| Lines in `src/engine/cancel.mjs` | 190 | under 800 | ratchet |

If the phase's own measurement shows an `integratedHead` is already reachable
through some other ref the run leaves behind, the correct outcome is to record
that measurement and reduce R1 to a test proving the reachability, creating no
new ref.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The preserved ref accumulates and nobody prunes it | medium | R2 names it in the output; the existing prune is opt-in and reports before removing |
| Creating a ref before releasing the others leaves a half-cancelled run on failure | high | Create every preserved ref before the first release, so a failure mid-way leaves more reachable, never less |
| A second cancel duplicates or fails on the existing ref | medium | A constraint, and R2's statement requires the second run to be a no-op |
| The new ref collides with the namespace `relaunch` scans for refusals | high | The ref must be distinguishable from the run ref the bootstrap refuses; the phase proves a relaunch after cancel still works |
| The change is written against `worktree.commit` instead of `integratedHead` | medium | The measured state names `integratedHead` as the field and lists its three writers; `worktree.commit` is attempt scratch |
