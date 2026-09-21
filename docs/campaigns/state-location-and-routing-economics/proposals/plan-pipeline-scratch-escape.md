# The resolver flip broke `faberun plan`'s own readFiles

Written 2026-09-19, found before committing node 1's (2i,
`the-resolver-answers-from-the-home`) seal, by running the full
`finalVerification` set instead of trusting the judge's `pass` verdict alone.

## What broke

`test/cli/plan.test.mjs` started throwing `readFiles[1] escapes cwd` from
`validateRelativePath` (`src/contract/task-packet.mjs:307`) in four tests, all
going through `runPlanningPipeline`. Not a test-fixture bug: `src/plan/
pipeline.mjs` itself regressed.

## Root cause

`plansDir` (`campaignTree(cwd, campaignId)/plans/<phase>`) used to nest inside
`cwd`, because `campaignTree` resolved through the old `<cwd>/.runs/...`
layout. Since R2 it resolves under the home (`runsRoot` in `src/run/
paths.mjs`), permanently, for any project not mid-migration. The pipeline
writes three scratch files there — `repo-facts.json`, `plan.working.json`,
`findings-round-N.json` — and hands each to the next discovery node through
`taskPacket.readFiles`, whose containment rule requires every entry to
resolve inside `cwd`. With `plansDir` outside `cwd`, `relative(cwd,
repoFactsPath)` produces a path that climbs out and back in through the home
directory — `readFiles[1]` in the draft contract, since `readFilesForKind`
puts `repoFactsPath` second. The other two escaped the same way, one round
later, in the review and revise stages.

## Fix

`src/plan/pipeline.mjs` stages these three scratch families under a new,
`cwd`-local, gitignored directory instead of under `plansDir`:
`<cwd>/.faberun-plan/<campaignId>/<phase>/`. Deliberately not `.runs` — a
project with nothing under the home yet reads a present `<cwd>/.runs` as an
unmigrated legacy layout (`runsRoot`'s first check), and this directory must
never trip that. `plansDir` itself (under the home) still holds the durable
record nothing reads through `readFiles`: `pipeline.jsonl`, each stage's own
`nodes/*.contract.json`, and — on the contested path — the final `plan.json`.
`.faberun-plan/` added to `.gitignore` alongside `.runs/`.

Verified: `test/cli/plan.test.mjs` (7/7), `test/cli/` (98/98), `test/plan/`
(47/47), and the full `finalVerification` set from node 1's own contract —
`test/run/`+`test/host/` (137, 1 pre-existing skip), `test/engine/`+
`test/campaign/` (445/445), `test/repo/` (57/57), `test/seat/`+`test/web/`
(50/50) — all green with the fix in place.

## A question this raises, not answered here

`declaredReadBytes` (`src/engine/dispatch.mjs:283`) and the worker prompt
itself resolve `readFiles` against the attempt **worktree**, a real `git
worktree add` checkout of `contract.cwd`'s committed history
(`src/repo/worktree.mjs:179-195`) — not `contract.cwd` directly. Whether an
untracked, gitignored file like these scratch ones (old layout or new) is
actually visible inside that worktree when a real worker process reads it is
a separate question this fix does not answer; `validateContract`'s own
containment check (what broke here) runs against `contract.cwd` at
authoring time, before any worktree exists. Every planning-stage run this
campaign has landed so far went through the replay harness in tests, never a
live worker reading a live worktree, so this has not actually been exercised
end to end. Worth a discovery node before `faberun plan` is trusted against
a real harness.
