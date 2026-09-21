# The stall kills were not the harness. They were faberun's own default.

Written 2026-09-19. Corrects two earlier journal entries and two things said
to the owner, which mischaracterized this as GLM/zcode reliability. It is not.

## What was observed

The resolver node's first attempt failed silently, repeatedly, across three
different contract ids (2e, 2f, 2g): sometimes `exit 1` with a fully empty
transcript, once `SIGKILL` with `exitCode: null`. Every occurrence closed
between 28 and 31 minutes after starting. The second attempt each time
completed normally and produced real work (including two genuine defect
findings — the eight-plus-five helper-less resolver callers, and the
campaign-ledger repoRoot bug).

## The actual cause, log-confirmed

`.runs/state-location-and-routing-economics-2g-state-lives-under-the-home/events.jsonl`
carries, verbatim, at the moment of the third kill:

```
"type":"auto_retry","errorCode":"stall_timeout"
```

`src/contract/runtime.mjs:39` declares `HARNESS_STALL_TIMEOUT_SEC = Object.freeze({ zcode: 1_800 })`
— a deliberate, pre-existing 30-minute default stall budget specifically for
the zcode harness, applied at contract-validation time (line 80) whenever a
zcode runtime does not declare its own `stallTimeoutSec`. My hand-authored
`zcode-glm-worker` entry in `runtimes.json` did not declare one, so every
node using it inherited exactly 1800 seconds — which is why every kill landed
within a minute or two of the 30-minute mark, never earlier, never much
later.

This was not the scheduler misfiring on a harness that should be exempt (the
adapter's own comment at `src/harnesses/zcode/index.mjs:65-71` warns stall
detection must not watch this harness's stdout/stderr mtime, and the code at
`src/engine/process.mjs:472-476` does correctly skip mtime-based tracking for
a non-streaming harness with no declared threshold) — it *is* stall-tracked,
deliberately, via a harness-level default, and 1800s turned out to be too
tight for this specific node's prompt (13 files in scope, several hundred
lines of instructions). The two nodes that completed cleanly on the first
try earlier in this campaign (the registry node, the CLI verb node) had
smaller prompts and finished well under 1800s.

## What this means for the earlier record

Two campaign journal entries — the `constraint` note calling this "a
reproducible first-attempt reliability gap in GLM" and the outcome note
calling attempts 1 and 3 "apparently a first-turn reliability gap in this
harness" — are wrong and are corrected by this file. The work was never
stalled. It was killed while genuinely in progress, confirmed by the live
process tree (`zcode-cli` plus its own `zcode-node-repl-mcp` child) observed
alive and running normally at every check during the "stalled" window.

## The fix applied

`stallTimeoutSec: 3300` declared explicitly on `zcode-glm-worker` in
`.runs/control/state-location-and-routing-economics/runtimes.json` and in
the two contracts still queued (`2g`/`2h`, `0c9`) at the time this was found
— 300 seconds of margin under the node's own 3600s hard `timeoutSec`, so a
genuinely stalled invocation is still caught, just not one that is 30-plus
minutes into real, unstreamed work.

## A second, smaller finding along the way

Relaunching the same contract id after cancelling a run that had a **live**
invocation running at cancel time refused with `run already exists`, even
after the run's own status showed all three nodes cancelled and the git ref
was confirmed released. Removing the leftover attempt worktree and branch by
hand did not clear the refusal either — the run directory itself was still
blocking it. This is the same class of defect phase 1g's
`a-cancelled-run-releases-what-it-will-never-reuse` fixed, but that fix was
verified against cancelling an already-terminal run (blocked, exhausted); it
may not fully apply when the invocation is genuinely still running at the
moment `cancel` is called. Worked around by giving the contract a fresh id
(`2h`) rather than relaunching under `2g`. Not investigated further under
this campaign's own time budget; recorded here as a real follow-up rather
than lost.
