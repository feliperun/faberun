# Operator-loop review, 2026-09-14

A review of the skill from the operator's chair, prompted by one complaint: the
factory hangs for hours in the middle of a campaign, does not tell anyone, and
does not go to the end without being asked. The 2026-09-13 review proved the
mechanics by running them; this one reads the control loop and the feedback
surfaces against what 162 recorded runs actually did, and asks why the
operator ends up being the watchdog.

The answer is not that the factory hangs inside a model. It **stops on purpose
and goes quiet**, and when a controller is alive but frozen, **nothing in the
tree can tell**. Everything below is evidence for those two sentences and a
ranked plan to close them.

## Method

- Full read of `engine/`, `harnesses/`, `report/`, `notify/`, `campaign/`,
  `cli/`, `run/lock.mjs`, every `references/*.md`, and the records from
  2026-08-28 to 2026-09-13 (`RETROSPECTIVE-*`, `ADENDO-01`, `ADENDO-02`,
  `REVIEW-2026-09-13`). Every claim about the code cites the line.
- Forensic pass over `/Users/frb/dev/frb/skills/.runs/` and the archived
  campaign records under `docs/campaigns/`: per-run wall clock from first to
  last event, the largest idle gap and the event pair around it, error codes,
  `usage.jsonl` per role, `status.json` controller fields,
  `supervisor-attention.json`, `cancel.request.json`, handoff and journal
  sizes. Nothing was run; nothing was changed.
- Several mechanisms in the older runs no longer exist (session rotation,
  token ceilings, the 15 s supervisor lease). Where a finding rests on them it
  says so; the class it belongs to is checked against today's code.

## What the runs recorded

| Inventory | Value |
| --- | --- |
| Run directories | 162 (143 top-level, 19 under `archive/`) · 17 campaigns · 366 nodes · 1,216 events |
| Disk | 450 MB: `worktrees/` 208 MB (22 left behind, one 3.66 MB fixture bundle copied 10×), `logs/` 161 MB, `control/` 41 MB. No gc, no rotation, no retention |
| Terminal runs | 83 (done 44, canceled 15, exhausted 15, failed 9) |
| Non-terminal runs | **79** (blocked **73**, running 5, stalled 1) |
| Runs over 1 h / over 2 h | 36 / 14, out of 133.7 h total |
| Runs needing more than one attempt on a node | 66 of 162 |

`blocked` is the modal outcome of the whole dataset.

### Where the hours went

| Run | State | Wall clock | Largest gap | Before the gap → after it |
| --- | --- | --- | --- | --- |
| `…-glm-rotation-policy-runtime-fix-20260831-take15` | blocked | 9h18 | **8h49** | `running→running` (recovery `reconciled`) 02:50:16Z → `running→blocked` `unknown_effect_reconciled` 11:39:57Z. `supervisor-attention.json` stamped 02:50:49Z, *"detached bootstrap failed before readiness for pid 72337"* — 32 s into the gap. Dead for 8 h 49 m; the closing event was written by the returning human |
| `if-audit-drivers-20260910` | blocked | 7h42 | **4h38** | `pending→blocked` `dependency_failed` 04:13:53Z → `blocked→pending` 08:51:39Z. An earlier gap of 2h09 has the same shape. **6h47 of 7h42 waiting for a human**, root cause `judge_unavailable` twice on one node |
| `intent-factory-lean-p0-unblock-20260905` | blocked | 6h08 | **5h45** | `pending→blocked` `dependency_failed` 07:02:23Z → `failed→pending` 12:47:18Z. Trigger: `unexpected_write` on a file the orchestrator committed mid-run |
| `…-p0-unblock-20260907-take6-continuation` | done | 5h19 | 1h32 | `pending→running` → `running→pending`, a worker call in flight |
| `archive/…-hardening-final-20260819-take15` | blocked | 4h21 | 1h20 | `pending→running` → `running→exhausted` `wall_clock_timeout`, twice on the same node |

51 runs have a gap over 30 min and 19 over 60 min. 44 of those gaps sit behind a
worker in flight; 7 sit behind a dead or blocked run. **Three of the five
largest are the second kind.** The lean campaign's own journal put a number on
it at 2026-09-07T02:54Z: *"27 h of campaign, about 25 h idle; dead windows of
5.7 h, 1.1 h, 11.7 h, all with the Ford channel delivering every terminal
notification (13 delivered) and no path back to the orchestrator session."*

### What stopped the runs

| Error code | Count | Share |
| --- | --- | --- |
| `dependency_failed` | **137** | **52 %** — a sibling failed; this node never ran |
| `provider_error` | 23 | |
| `unexpected_write` | 18 | |
| `budget_exceeded` + `budget_attention` (pre-lean) | 28 | |
| `stall_timeout` | 10 | |
| `context_missing` | 10 | |
| `revision_cap` | 9 | |
| `rotation_handoff_pending` (pre-lean) | 9 | |
| `judge_unavailable` | 8 | |
| `wall_clock_timeout` | 6 | |
| `unknown_effect_reconciled` | 6 | |

Phase 0 of the lean campaign is the concentrated form: seven contracts between
2026-09-06T12:47Z and 2026-09-07T14:05Z, 18 worker attempts and 29 invocations
for four logical nodes. Take 1 died to a scope violation caused by the
orchestrator's own commit; takes 2 and 3 to `revision_cap` after two judge
rejections on work the journal records as complete; take 4 to a 3600 s wall
clock 58 minutes into writing tests, then a poisoned `--resume` killed at 900 s
of silence; take 5 to a stall the harness could not tell from a long-context
pause (a successful attempt in the same phase had a 971 s silent gap); takes 6
and 7 to cross-node regressions and an exhausted allowance. The campaign's own
retrospective: *"64 percent of the damage was collateral from a sibling node."*

### What the tokens bought

`usage.jsonl` exists in 46 runs, 193 invocations.

| Role | Calls | Avg prompt (uncached + cache read) | Avg output | Avg duration | Max duration | Total cost |
| --- | --- | --- | --- | --- | --- | --- |
| worker | 101 | **9,253,515** (98.9 % cache read) | 46,178 | **867 s** | **6,064 s** | $188.85 |
| judge | 92 | 507,102 | 5,893 | 95 s | 587 s | $34.11 |

The authored prompts are the other way round (`*.worker.prompt` averages
7,775 B, `*.judge.prompt` 21,944 B): the worker's nine million tokens accumulate
*during* the call, in the provider's own loop. The two most expensive nodes in
the history — `status-and-notify` at **$34.69** (148.4 M cache read, 84 min)
and `controller-lock` at **$28.21** (121.1 M, 82 min) — both ended
**canceled**, with `"reason": null`, as do all 18 `cancel.request.json` files.

### What the campaign layer kept

| Campaign | `HANDOFF.md` | `journal.jsonl` | Span |
| --- | --- | --- | --- |
| `intent-factory-efficiency-20260901` | 16,374 B | 283,886 B · 497 lines | 89.5 h |
| `intent-factory-lean-20260905` | **16,384 B** (at the cap, self-reports elision, ends on an empty heading) | 155,803 B · 257 lines | 72.9 h for ~21 h of run time |
| `intent-factory-retrospective-20260829` | 16,022 B | 31,385 B | 85.3 h |
| `intent-factory-measurement-20260910` | 15,906 B | 26,076 B | — |
| `run-harness-hardening-20260819` | 15,135 B | 20,044 B | 208.1 h |

Five of seventeen handoffs are at or within 1.5 KB of the 16 KiB ceiling
(`campaign/layout.mjs:21`); every resume after that point starts from a lossy
history. 420 of 1,213 journal entries (35 %) are `liveness` records; one node
wrote four identical `blocked` records in 1.6 s.

### The controller never says it is alive

Across all 47 `status.json` files, 45 report `controller.state: "active"` with a
pid, and `lastTick` is `null` in 47 of 47. None of those pids is alive today.
`render.mjs:315` hard-codes `lastTick: null` for a live lock and computes it
(`:318`) only once the lock is already stale. A dead controller and a working
one are indistinguishable on disk, which is exactly why the 8h49, 5h45 and 4h38
gaps went unobserved.

## Why

### A. Stopping is silent

1. **`blocked` is terminal.** `engine/prompts.mjs:8-16` puts it in `TERMINAL`,
   so `dependency_failed`, `judge_unavailable`, `revision_cap`,
   `context_missing` and every attention code end the run cleanly. The
   controller exits; `supervise.mjs:87` counts the node as terminal;
   `supervise.mjs:132-134` reports `done` and returns. The watchdog that
   exists for dead controllers sees a parked run as a finished one.
2. **The final line goes nowhere.** `scheduler.mjs:372` writes
   `[run] <id> done · <runDir>` to stdout; `cli/launch.mjs:51` detaches the
   controller with `stdio: "ignore"`. Same for the final report two lines
   later.
3. **Push is inert by default.** `notify/index.mjs:112-113` returns
   `noTransport` whenever `INTENT_FACTORY_NOTIFY_BIN` is unset, which is every
   environment except the tests; the only bundled adapter, `os-macos`,
   declares `canWake: false`. `references/operations.md:129-131` still
   promises three retries with backoff that `notify/index.mjs:9-11` does not
   implement.
4. **Attention fires once and never again.** `engine/notify-queue.mjs:49-61`
   dedupes on `notify.jsonl` forever. There is no re-nag, no escalation, no
   age. The one exception is `runtime_tier_exhausted` with a parseable reset,
   which `supervise.mjs:73-85` retries at the instant.
5. **The signal that reaches every session is stale.** The AGENTS.md managed
   block is rewritten only by `campaign init` and `campaign close`
   (`cli/campaign.mjs:216`, `:314`), never by the controller, so a run that
   finished hours ago still reads *active — resume or supervise it*.
6. **The pull path the docs prescribe has no wake.** `references/rules.md:13-17`
   forbids repeated `status` calls and says to interrupt only on terminal
   states — correct for tokens, but nothing delivers the terminal state.
   `campaign watch --wake` (`cli/campaign.mjs:121-203`) is the one
   push-shaped watcher and it emits to stdout (`:138`), has no `--detach`,
   never touches the notify queue, and is unmentioned in `SKILL.md`. The
   operator's actual workaround — arming it under a Monitor — is in a memory
   file, not in the skill.

### B. A live controller has no liveness

1. **No heartbeat, no progress age.** `superviseRun` relaunches only when
   `progress.state === "unfinished" && !controllerAlive(runDir)`
   (`supervise.mjs:136-138`), and `controllerAlive` is lock liveness alone
   (`:104-107`). The heartbeat specified in `ADENDO-01` §B1.6 and
   `ADENDO-02` §B4.6 (*"a nonterminal run stalled for 40 minutes is visible as
   stale liveness, never a silent active state"*) was never shipped; the lean
   campaign deleted `heartbeat.mjs` (rule 6 of `RETROSPECTIVE-2026-09-08`).
   `lifecycle.mjs:123-133` still computes `livenessState()`; it has zero
   callers in `src/`.
2. **Verification can freeze the loop forever.** `run-command.mjs:214` settles
   only on `close`, which waits for stdio EOF; a grandchild that escaped the
   process group and holds the pipe never closes it. That `await` is on the
   loop's critical path (`lifecycle.mjs:442`): no stall check, no status
   render, no dispatch.
3. **So can a mechanical proof.** `judge-gate.mjs:124-131` spawns with
   `shell: true`, no `detached`, and the timeout kills the shell only. Proofs
   run serially per Definition-of-Done item.
4. **A node can be `running` with no job.** `settle.mjs:119` hands integration
   to `integrate.mjs:99-110`, which can return `null` (`:244`) or act on a
   different node's transaction without calling back for this one. The job
   was already deleted (`lifecycle.mjs:180`); the node stays `running`; the
   loop spins at 1 Hz with nothing to print.
5. **Orphan adoption busy-waits serially.** `recover.mjs:103-115` polls to
   `startedAt + timeoutSec` per orphan inside the serial resume loop with no
   stall rule: N orphans is N × 40 min before the run drives again.
6. **Git has no timeout.** Every `spawnSync` in `repo/worktree.mjs` and
   `repo/integrate.mjs` runs without `timeout:`; `index.lock` contention is a
   silent freeze.

### C. Timeouts cannot tell thinking from dead, and a kill discards the work

- Stall detection is stdout/stderr **mtime** (`process.mjs:330-341`) and is
  skipped outright for non-streaming harnesses (`:321`: `zcode`, `exec-jsonl`,
  `replay`). The lean journal records a 971 s silent gap inside a successful
  attempt and a 900 s stall that killed another — the same signal.
- `wall_clock_timeout` and `stall_timeout` are in `NON_FAILOVER_CODES` and
  `NODE_DEADLINE_CODES` (`backoff.mjs:31-37`, `:55-58`): the node dies with no
  retry, and the worktree is not sealed first. Take 4 lost 58 minutes of work
  mid-file this way.
- The tier-exhaustion hold (`retry.mjs:149-161`) honours any announced reset
  before the node deadline with no cap and no attention when it is long.
- 2 of ~40 timing constants carry a measured justification; none of them is
  in the control loop.

### D. Where the tokens go

- **Gate retry reuses the session.** `settle.mjs:54` re-dispatches with
  `retryPrompt`, and `dispatch.mjs:91-93` returns `mode: "reuse"` with the
  prior continuation id whenever runtime identity matches — the provider
  re-reads the whole failed transcript, then gets the packet again on top.
  The bounded `## Previous attempt` section (`retry.mjs:23`, 8 KiB) already
  carries the evidence.
- **The judge gets the test logs of passing tests.** `prompts.mjs:144`
  stringifies `state.verification` whole: 2 KiB stdout + 2 KiB stderr per
  attempt per command, green or red. Worst case exceeds the 64 KiB guard and
  fails the node `judge_prompt_too_large`.
- **The judge is always the strongest model.** `runtime-discovery.mjs:158-163`
  picks the highest tier of the opposite vendor; `judge-gate.mjs:63-66` skips
  it only when no item is `judgment: true`. There is no green-and-small skip.
- **No advisory cost signal at all.** `run/usage.mjs:5-8` is reporting-only by
  design; cost appears once, on `run.terminal`. The two canceled nodes above
  spent $62.90 with no line anywhere saying so while it happened.
- **Orchestrator side.** `references/handoffs.md:5` says *read `HANDOFF.md`*
  (16 KiB, saturated) when `operator-brief.md` (4 KiB, `layout.mjs:23`) exists
  for exactly that. `references/contract.md` is 21.5 KB of authoring detail
  loaded by any session that touches a contract; `operations.md` carries
  Dashboard, Remote API and Operator seat sections (`:95`, `:106`, `:164`)
  that no launch or supervise turn needs. `findings` renders evidence
  unbounded (`render.mjs:411-425`; up to 32 × 6 KiB per node). `compactCost`
  prints six decimals (`util.mjs:206`). `retry.mjs:14-15` still documents
  `--max-input-tokens`, a flag that no longer exists. The root `README.md`
  links `references/release-1.md` and `references/session-memory.md`, both
  deleted, and describes DeepSeek as reached *through Codex custom providers*.

### E. Where the operator's hours go

Nine distinct commands and roughly thirty arguments for one happy-path run
(`campaign init`, author the contract by hand, `validate`, `preflight`,
`run --detach`, `supervise --detach`, `campaign attach`, then `status` ×N, then
`campaign note` and `close`). `--session-id` is required on six campaign verbs
with no default. Two of ten CLI error strings say what to do next; `usage()` is
one eleven-line blob and there is no `--help`.

Each authoring mistake costs a full take. The retrospectives record the same
four classes recurring: write scope that did not close (three times),
verification slower than its cap (twice), a judge envelope the provider
rejected (three times), the orchestrator committing into the target mid-run
(once, and it cost 5h45). The 2026-09-13 review's authoring items (`validate
--explain`, `readFiles` deferred to a dependency's `writeFiles`) address the
first; nothing yet addresses the last.

### F. The product changes under its own campaigns

219 commits touched the skill in the last 30 days; 102,714 lines were added
and 56,521 deleted in the last 14. Every campaign runs on code that did not
exist the week before, and the 2026-09-13 review found three of eight defects
invisible to 660 unit tests within minutes of a live run. Part of "it hangs for
hours" is a factory debugging itself at campaign cost.

## What I would build next

Ranked by hours returned to the operator per line of code.

### 1. A heartbeat, and a supervisor that reads it

`driveRun` writes `<run-dir>/heartbeat.json` every iteration: `at`,
`iteration`, `activeNode`, `lastProgressAt` (last node state transition or
provider output). `superviseRun` treats a heartbeat older than
`max(stallTimeoutSec, 2 × interval)` as dead even with a live lock: terminate
the controller's process group, take the lock, relaunch. `render.mjs:315` reads
`lastTick` from the same file. This alone would have caught every gap in the
top table that was not a model in flight, and it is the ADENDO-01 item the lean
campaign deleted before implementing.

### 2. Tell the session, not just the human

- On `run.terminal` and every `attention`, rewrite the AGENTS.md managed block
  (`repo/signal.mjs`) and append one line to `.runs/inbox.jsonl`. The next
  session's first token knows.
- Default `INTENT_FACTORY_NOTIFY_BIN` to `os-macos` on darwin; print the export
  hint on the first `no_transport` receipt of a run. Bring the Ford adapter the
  operator keeps outside the repo in as a named transport.
- Give `campaign watch --wake` a `--detach`, route its lines through the
  notify queue, and put it in `SKILL.md` as the way a session arms itself.
- Fix `operations.md:129-131` to say what `notify/index.mjs` does.

### 3. `blocked` becomes parked, not finished

- Split `TERMINAL` into terminal (`done`, `no-op`, `canceled`) and parked
  (`blocked`, `failed`, `exhausted`, `stalled`). `supervise` reports
  `attention` separately from `done` and keeps ticking.
- Re-emit `attention` on an escalating schedule (10 min, 1 h, 4 h) until a
  `resume` clears it; `notify-queue.mjs` keys the dedupe on the schedule slot.
- One automatic retry before parking for the codes whose remedy is *try
  again*: `judge_unavailable`, `provider_error`, `stall_timeout` with a
  non-empty seal. Dependants wait (`waiting`, not `blocked`) while their
  parent still has a retry; `dependency_failed` cascades only when the parent
  is out. This is the 52 %.

### 4. Absolute timers, and seal before kill

- `run-command.mjs` and `judge-gate.mjs`: spawn `detached`, kill the group,
  and settle the promise from the timer with `timedOut: true` rather than
  waiting for `close`; destroy the streams on kill. Add `timeout:` to every
  `spawnSync` under `repo/`.
- Loop invariant in `scheduler.mjs`: a node that is non-terminal, not
  `pending`, and absent from `running` transitions to `blocked` with
  `integration_unresolved` instead of spinning.
- On `wall_clock_timeout` and `stall_timeout`, seal the attempt worktree
  first; the next attempt is cut from the seal, the rule every other retry
  already follows. Remove the two codes from `NON_FAILOVER_CODES` so one retry
  is possible.
- Stall for streaming harnesses: last tool event or process CPU delta, not
  file mtime. For `zcode`, a dedicated cap rather than none. Cap the
  tier-exhaustion hold and raise attention when the hold exceeds one supervise
  interval.

### 5. Spend less per node

- Force a fresh session on gate retry (`continuationId: null` in the
  `applyRejection` path); the `Previous attempt` section is the evidence.
- Send the judge `{argv, passed}` for green commands and output tails only for
  red ones.
- `gate.skipWhen: { verificationGreen: true, maxChangedPaths: N }` checked in
  `startJudge` before `judgeRequired`.
- An advisory per-node line — never a kill — on the tick a node crosses a
  configured cost or duration: `[warn] node X · $12.40 · 51 min`. The
  no-ceiling rule stands; the operator just gets to see it.
- Add `worker $X · judge $Y` to the totals line.

### 6. A status that answers the question

`status` gains a progress line — `3/7 nodes · 43 % · ~34 min left (median
8m12s/node)` — from settled node durations; `status --brief` prints the
`derivePointer` record as one line for a supervising model (~50 tokens);
`compactCost` shows two decimals in tables. `next` moves into `SKILL.md` as the
first command of any resuming session, and stops listing a corrupt 2026-08-18
campaign ahead of the active one. A `dashboard` verb starts the server, mints
the token and prints the URL.

### 7. Cheaper to read

`handoffs.md` points at `operator-brief.md` first and `HANDOFF.md` only on a
cold takeover. `contract.md` splits into a 2 KB cheatsheet and the full
reference. Dashboard, Remote API and Operator seat leave `operations.md` for a
`surfaces.md` that nothing routes to by default. `findings` truncates evidence
to 512 B with `--full`. The journal dedupes consecutive identical `liveness`
records at write time. Delete the `--max-input-tokens` sentence in
`retry.mjs`; fix the two dead links and the DeepSeek sentence in the root
`README.md`.

### 8. Protect the run from its operator

`run` refuses a dirty target tree and records `HEAD`; the controller aborts
the attempt with a named code if `HEAD` moves during a run. `preflight
--time-verification` runs by default inside `run`. Both are the two authoring
classes the 2026-09-13 items do not cover.

### 9. Run campaigns on a frozen build

Tag a `stable` ref of the skill and launch controllers from it (the
`.runs/control/` snapshot already exists for this); promote only after the
live eval class from the 2026-09-13 review passes against the CLIs as shipped
this week.

## Start here

1. Heartbeat and a supervisor that acts on it (§1). Smallest change, largest
   return: it closes the hours-long gaps.
2. Session wake, notify on by default, signal block rewritten on every
   terminal (§2). Closes "I have to keep asking".
3. Parked instead of terminal, escalating re-nag, one automatic retry,
   dependants waiting (§3). Closes "it does not go to the end".
4. Absolute timers and seal-before-kill (§4).
5. Fresh session on retry, lean judge input, green-and-small skip (§5).

## Deliberately not changed

- **No hard spend ceiling.** The 2026-09-02 incident (`ADENDO-02` §1) and the
  lean decision to delete every ceiling were measured; §5 proposes a line of
  output, not a stop.
- **No rewrite.** The signals this review wants consumed — node `updatedAt`,
  `livenessState()`, `usage.jsonl` per role, `status.json` checkpoints — are
  already written. What is missing is the loop that reads them.
- **Log and worktree gc** is recorded here (161 MB and 208 MB) and left for its
  own proposal; it costs disk, not hours.
- **Provider preambles** (codex ~35 k tokens per turn against claude's ~4.3 k)
  are the largest fixed token cost and are the provider's to trim; the one
  local lever is preferring tier-1 harnesses where a cross-vendor pair allows.
