# Making the orchestrator's accuracy deterministic

Written 2026-09-18, answering the owner's question: the orchestrator got phase 1e
right after getting nine earlier scopes wrong, and that is memory, not a
guarantee. A fresh agent on any harness, with no memory, would repeat the nine.
What follows is what the product can decide for itself, so that being right stops
depending on who is driving.

## The defect this question uncovered

`src/repo/scope-closure.mjs` already holds the right machinery: three mechanical
detectors and a cross-node check. The cross-node check earned its keep today — it
refused a contract of mine where one node wrote `test/helpers.mjs` while another
node's tests imported it.

But `reverseImportFindings` abstains exactly when it is most needed. Line 266
skips every importer when the packet declares no symbols, and lines 269-274 raise
a finding only for an importer that takes one of the packet's **declared**
symbols. The detector's reach is therefore a function of what the author
remembered to write down.

Proven against this campaign's own record:

| fact | value |
| --- | --- |
| node | `one-module-owns-the-run-paths` (contract 1b) |
| `writeFiles` | includes `src/repo/worktree.mjs` |
| `symbols` | `runsRoot`, `runDirectory`, `RUNS_DIR_NAME` |
| `evals/compare.mjs:10` | imports `attemptWorktreePath`, `candidateWorktreePath` from that exact file |
| outcome | `takesDeclared` false, no finding, node blocked on a worker's `context_missing` after a paid attempt |

The contradiction is sharper than a missing feature. `AGENTS.md` instructs the
author to declare in `symbols` a name the node *introduces* and never one it
merely relocates, because a widely imported name fails scope closure against
every importer. That advice is right for the rule it was written for, and it
steers the author to omit precisely the names that would make this detector fire.
The written guidance and the detector's filter point in opposite directions, and
the only thing holding them together is the author's judgement. That is the
probabilistic seam.

## Three tiers, in order of how much they buy

**1. Derive, do not trust.** A written file's exports are readable from the tree.
The detector should union the packet's declared `symbols` with the names the
written files export *today*, and raise a finding for any importer taking one of
those. The author's declaration stops being the input and becomes a redundancy.
This alone closes the omissions at `evals/compare.mjs`, `src/engine/notify-queue.mjs`
and `test/cli/cli.test.mjs` — three of the nine — and it needs no new field, no
new discipline and no memory.

**2. Carry provenance, and re-run it.** A packet claim that came from a
measurement should carry the command that produced it, so `validate` re-runs the
command and refuses when the tree no longer matches. Two of the nine came from an
inventory that was true when authored and false when launched: `src/report/progress.mjs`
was created by a later phase, and a grep scoped to `src/` and `test/` never saw
`evals/`. A measurement that cannot be re-run is an assertion; one that can is a
check.

**3. Refuse the undecidable instead of guessing it.** Where a node introduces a
name another file already exports, and that file is not in the write set, refuse
the contract at authoring time — that is the duplicate-export ratchet, decidable
statically, and it cost a node two exhausted attempts to discover at runtime.
Where the *location* of a change is genuinely unknown, no static check can help;
the product should make `mode: "discovery"` the cheap default rather than letting
an execution packet encode a guess.

## What stays probabilistic, honestly

Tier 3's second half does not become deterministic, it becomes *cheap*. The
worker's `context_missing` and the judge remain the backstop, and they worked
every time in this campaign — every one of the nine was caught, none reached
main. Determinism moves the line between "caught before the money" and "caught
after it"; it does not remove the need for a reviewer.

## Why this belongs in the product and not in a memory file

Every check above runs inside `faberun validate` and `faberun preflight`, which
execute regardless of harness, model, or whether the operator has ever seen this
repository. A lesson in a memory file is advice to one agent. The same lesson as
a check is a property of the tool.
