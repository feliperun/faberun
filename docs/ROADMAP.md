# Roadmap

## Thesis

Faberun is not one more agent orchestrator.

> **Own your software factory. Rent intelligence, don't lock yourself into it.**

Models, harnesses and vendors change continuously. Claude Code, Codex, Gemini,
DeepSeek and local models are **replaceable workers**. The permanent asset is
the intent, the requirements, the plan, the execution graph, the decisions, the
evidence, the evals, the history, the success criteria, and the accumulated
knowledge of how this repository gets software delivered.

The goal is to shorten the distance between **intent** and **software that works
and is provably correct**.

Two measurements support the thesis rather than assuming it:

- The `orchestration-arms` campaign found that *how* work is organised (faberun
  vs a session vs subagents) does not move the bill when the model is held
  constant, while swapping in a cheap writer moves it 16 to 50 times. Its record
  is versioned at `docs/campaigns/orchestration-arms/`; `RM-065` landed it on
  `main`.
- The `rec-audit-remediation` campaign, the first against a repository faberun
  did not write, fixed 22 audit findings in a Zig codebase for US$ 1.35, with a
  `deepseek-flash` writer and a `glm-5.3-flash` judge that cost 2.8% of the bill
  and caught the campaign's only real finding.

The interchangeable part is where the leverage is.

## How this file works

One line per idea, entered the moment it is thought of. This file is the single
source of truth for uncommitted ideas; it is versioned, because the main
consumer of these ideas is an agent reading `docs/`, and because the last place
they lived was not.

- **Ids are stable and never reused.** `RM-###`, assigned in order of entry, not
  of priority. Moving an item between priorities does not change its id.
- **States**: `idea`, `measured`, `specified`, `running`, `landed`, `dropped`.
- **An item at `measured` or beyond cites the measurement.** An item with no
  measurement is not invalid; it must say so. This is the comment rule of this
  repository applied to planning: record measurement, not intent.
- **Promoting means writing the spec**, not moving a row. An item becomes
  `docs/campaigns/<id>/spec/SPEC.md` in the format `faberun spec validate`
  checks; the spec declares requirements; requirements already travel to the
  node. This file is the missing step above that chain, not a replacement for
  it. A `specified` row names the campaign and the requirement that carry it.
- **Dropped items keep their reason.** Without it the same bad idea returns
  every few months and is re-evaluated from zero. The evidence on a dropped item
  has to survive the same scrutiny as a live one: if it returns carrying a wrong
  count, whoever picks it up looks for the wrong thing.
- **The managed signal block in `AGENTS.md` is a summary, not a source.** It
  truncates, and it can attribute an orphan attention record to the wrong
  campaign. Count runs by listing the run directories.

### Why this file exists

The ideas this repository generates were being lost. Sixteen written proposals,
each with its own measurement and named for what it found, lived only under
`.runs/…/proposals/`, which is gitignored, and `campaign close` copies the
journal, the campaign record and every `usage.jsonl` into
`docs/campaigns/<id>/ledger/` but **not the proposals**. They were rescued into
`docs/campaigns/state-location-and-routing-economics/proposals/` when this file
was created. `RM-030` fixes the leak at its cause.

---

## Now: the `leaving-home` program

Every priority below competes for the same attention, so the next five
campaigns are fixed in order by [the program](campaigns/leaving-home/PROGRAM.md).
Its goal is the P0 sentence extended by one step: *I trust faberun enough to
leave a campaign running without watching it, and to put it in a friend's
hands.* Only after that does anything get announced.

| # | campaign | what it closes | gate to the next |
| --- | --- | --- | --- |
| 0 | [`first-target-frictions`](campaigns/first-target-frictions/spec/SPEC.md) | the frictions from the first real target (`rec`) and the Campaign Brief run that kill a node or add noise to measurement | the suite is green under load on the owner's macOS; an ignore-source write is warned; no judge needs write access |
| 1 | [`evidence-you-can-recompute`](campaigns/evidence-you-can-recompute/spec/SPEC.md) | every number faberun states about itself recomputes from `main`; recovery stops counting as failure | the baseline recomputes from versioned ledgers; the `orchestration-arms` record is on `main`; the skill docs have one byte budget |
| 2 | [`evals-with-a-budget`](campaigns/evals-with-a-budget/spec/SPEC.md) | the paired benchmark and the judge canary, with a hard budget and a band | three repetitions of the complex round; the canary measured on two judge runtimes; D9 recorded |
| 2b | [`choose-the-judges`](campaigns/choose-the-judges/spec/SPEC.md) | judges and planner roles chosen by measurement: a canary corpus not written only by the family it tests, two repetitions, the owner's candidate judges and three planner role configurations | D9 revised into a judge matrix by worker vendor; D11 on planner roles |
| 3 | [`safe-to-hand-to-a-friend`](campaigns/safe-to-hand-to-a-friend/spec/SPEC.md) | a planner that stops when revision does not converge, finds unwritable proofs and carries human steps (it went 0 for 10 contracts in the last three campaigns); environment allowlist, sandbox cost stated, executed getting-started, repo facts beyond Node, ways back from a contested plan, a refused packet and a defective packet, uninstall | a planted secret never reaches a worker; the owner's next campaign closes with no hand-written contract |
| 4 | [`friends-pilot`](campaigns/friends-pilot/spec/SPEC.md) | three to five people run a real campaign in their own repositories; what they live returns as redacted data and friction with an id here | D10 recorded |

Rules that hold for the whole program: no new harness, no UI, no rewrite in
another language, no new verb outside those five specs; no ceiling in
`test/docs/docs-diet.test.mjs` rises; no test calls a provider; cheap writers
by default; every campaign closes with `faberun spec validate --strict-traceability
--run-proofs` green.

### Where every other item stands

Nothing below is abandoned by being outside the program. Each one waits for a
reason, and the reason is the thing that would move it.

| items | why they wait | what moves them |
| --- | --- | --- |
| `RM-005`, `RM-049` | authoring-time checking is its own campaign; the program's reauthor path (`RM-025`) treats the symptom first | the pilot's `context_missing` count |
| `RM-011`, `RM-012`, `RM-014` | an intent eval is exploratory until the canary reports (D3) | D9 |
| `RM-017`, `RM-018` | metering and refusal classes improve a measurement the program first has to make recomputable | `evidence-you-can-recompute` closing |
| `RM-019`, `RM-020`, `RM-021` | the program applies cheap writers as an operating rule; turning that into a product default needs D9 and Q6 | D9, then Q6 |
| `RM-023`, `RM-024`, `RM-026` | the planner verbs a stranger would want; the pilot says which one matters first | pilot frictions |
| `RM-027` to `RM-029`, `RM-048` | real sandboxing stays after autonomy (D2); the program ships the environment allowlist as the minimum | D2 revisited after the pilot |
| `RM-032`, `RM-033` | loop detection and asynchronous questions matter most once someone else pays the bill | pilot cost per participant |
| `RM-034` | positioning comes after there is something measured to position | D10 |
| `RM-046`, `RM-047` | memory needs a stable baseline to be measured against (D6) | `evals-with-a-budget` closing |
| `RM-059`, `RM-080` | recorded, with no requirement yet | see the rows |

---

## P0: Stabilise before expanding

The goal is not features. It is reaching the point of thinking: *I trust faberun
enough to leave a campaign running without watching it.*

"Campaigns in progress" means the campaign that is actually running, not the
parked runs of closed ones; see decision D1.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-001 | Resume the parked runs from earlier campaigns | 8 runs parked across four campaigns: `adversarial-planner` (4), `chain-ergonomics-and-fairness` (2), `become-faberun` (1), `env-independence-and-generated-docs` (1) | dropped: D1 |
| RM-004 | `faberun plan` has never run end to end against a live harness | falsified 2026-09-21: two plans, four stages each, real workers on GLM-5.3-Flash and gpt-5.6-sol reading real worktrees, no replay | dropped: falsified |
| RM-049 | `validateContract` checks containment against `contract.cwd` at authoring time, before any worktree exists | the surviving half of RM-004; unchanged by the live-harness evidence | idea |
| RM-005 | The couplings that kill packets are not import edges | six packets refused `context_missing` **after passing `validate`**, so the gap is not the deterministic check, which already refuses | measured |
| RM-051 | A worker that writes an ignore source fails the node, and no document says so | `snapshot_ignore_changed` killed a node whose only defect was one `.gitignore` line the packet asked for; `captureIgnoreSources` (`src/repo/workspace.mjs`) tracks `.faberunignore`, `.gitignore`, `.git/config` and git's per-worktree paths, and the error names none of them. The same class cost an earlier campaign 80 minutes when a package-install hook wrote `.husky/_/.gitignore`: two occurrences, both found by accident | landed: `d34d1d9`, `first-target-frictions` R1, 2026-09-23 |
| RM-052 | A file the verification creates in the worktree reaches the integration commit | `rec`'s suite wrote `rec-wav-test-<pid>.*` in the CWD, and 14 of them crossed the seal into the remediation branch. `scopeFindings` records unexpected *writes*; nothing records untracked *artifacts* a verification left behind | landed: `1d47973`, `first-target-frictions` R2, 2026-09-23 |
| RM-053 | A detached controller dies with the launcher's cgroup, and the park message does not say the run exists | launching from a shell whose scope was torn down left `attention: detached bootstrap did not become ready for pid 31966 (launch_failed)` and a run directory with every node `pending` and `controller: none`; the same run finished under a durable `resume` | landed: `826dd0e`, `first-target-frictions` R3, 2026-09-23 |
| RM-056 | No test gives a contract a budget under one second | two tests (`done-when 1 and 4`, `a judge timeout re-asks once`) fail under parallel load on macOS; the same contention family `orchestration-arms` found in `test/run/process.test.mjs` | landed: `72b08e5`, `first-target-frictions` R4, 2026-09-23 |
| RM-057 | The planner never freezes a verification shorter than its measured duration | in the Campaign Brief run a reviewer assigned `timeoutSec: 120` to the final gate while repo facts measured 178,904 ms and 246,955 ms for two of its parts | landed: `614010b` and `33825a8`, `first-target-frictions` R5, 2026-09-23 |
| RM-058 | A read-only judge still delivers its verdict | the Campaign Brief run had to grant the `codex-sol` judge `workspace-write` so it could persist `review.json` | landed: `7d23785`, `first-target-frictions` R6, 2026-09-23 |
| RM-059 | The planner can propose a dependency that does not exist | a Campaign Brief draft proposed an npm package for `mdhtml` that resolves to an unrelated package; there is no deterministic way yet to tell a legitimate new dependency from an invented one | idea |
| RM-080 | `!job.logDir` in the liveness detector is dead for every existing harness after #54 | found reviewing #54; kept on purpose because it states the author's intent, and removing it would redesign someone else's decision without need | idea: owner decision |
| RM-081 | A node without a gate still runs its Definition of Done proofs | measured on `evidence-you-can-recompute`: every node carried `gate: false`, and a `grep` proof that could only fail was never run; the engine settled gate-less nodes straight to done | landed: `fix/campaign-frictions`, 2026-09-23 |
| RM-082 | Every test file isolates its own home | the planner's repo facts, `spec validate --run-proofs` and a bare `node --test` left `clean-closure`, `spoken-closure` and `ledger-equivalence` campaigns in the operator's real `~/.faberun`; only `npm test` preloaded the scope | landed: `fix/campaign-frictions`, 2026-09-23 |
| RM-083 | A proof whose test-name pattern matches nothing fails | `spec validate --run-proofs` reported `evidence-you-can-recompute` R6 proven before R6 existed | landed: `fix/campaign-frictions`, 2026-09-23 |
| RM-084 | A campaign that changes faberun's own `src/` can refresh the controller snapshot | the chain parked contracts A2 to A4 of `evidence-you-can-recompute` with `controller_snapshot_changed` and no command to refresh; they ran by hand | landed: `fix/campaign-frictions`, 2026-09-23 |
| RM-085 | A seal commit message passes the repository's commit convention | every `faberun <run> <node> attempt N` seal fails commitlint, so each campaign PR is rebuilt as a squash | landed: `fix/campaign-frictions`, 2026-09-23 |
| RM-086 | `faberun plan` run inside a tmux pane died during repo facts | twice on 2026-09-23 the plan and its pane vanished mid repo facts with no exit line, while `plan --detach` survived the same tree; running every `node --test test/<dir>` without a terminal did not reproduce it, so the cause needs a controlling terminal and is unknown | idea: measured, not reproduced |

**`RM-005` was rewritten after being checked against the tree, and the
correction matters.** The deterministic half already exists: `validateContract`
runs `scopeClosureFindings` and `crossNodeScopeFindings` and *refuses*
(`src/contract/index.mjs:359-370`), naming the exact file and the reason,
independent of harness and model. As first written, this item would have
commissioned what is already built.

What is missing is the class of coupling those detectors cannot see. All four
(`imports`, `symbols`, `directory`, `cross-node`) follow **syntactic** edges. The
six packets that died were coupled by convention, which has no edge to follow:

- a new persisted field obliges its validator (`snapshot.mjs`,
  `source-identity.mjs`) and its typedef;
- a new `events.jsonl` type obliges `docs/FIELD-OWNERSHIP.md`;
- a new CLI option obliges the option table.

The proof the gap is real: those packets **passed** `validate` and the worker
refused afterwards. Validate approved; execution declined.

The original sentence still holds, and now points at work that does not exist: a
lesson in a memory file is advice to one agent; the same lesson as a check is a
property of the tool. This particular lesson is literally a memory file today.

`RM-005` is large enough to be its own campaign, and its theme (authoring-time
checking) is not what the program is about.

---

## P1: Campaign Brief

The human review surface for a plan, answering *is this worth pressing Play?* in
a few minutes. It does not replace the technical plan, which stays large; the
plan becomes a drill-down.

The brief carries: intent in one sentence; expected outcome; measurable success
criteria; the requirements with a **coverage matrix** (requirement, responsible
nodes, evidence); the execution graph, showing what runs in parallel and what
blocks what; **decisions split into those needing human judgment and those
delegable**; only the relevant risks; an execution estimate (workers, models,
nodes, cost range, duration); and the planned evals.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-006 | Campaign Brief as a pre-execution approval artefact | `docs/campaigns/campaign-brief/spec/SPEC.md` R1 to R2 | landed (#63) |
| RM-007 | Requirement Coverage Matrix in the brief | same spec, R3 | landed (#63) |
| RM-008 | Render the graph, the risks, the human decisions and the planned evals | same spec, R4 | landed (#63) |
| RM-009 | Cost and duration estimate as a range | same spec, R5 | landed (#63) |
| RM-010 | Publish the brief as a shareable artefact | same spec, R7 to R8: portable `mdhtml` plus a loopback server; external publication stays out (D8) | landed (#63) |
| RM-045 | An `mdhtml` theme built from `DESIGN.md`, so the rendered brief looks like Faberun | same spec, R6 | landed (#63) |

The brief is authored in Markdown and rendered with `mdhtml` into a portable,
self-contained document, keeping Markdown as the source. The theme is Faberun's
own (D5). A minimal loopback server opens the local file in a browser (D8).
From the program on, every frozen plan goes through `faberun campaign brief
generate` and is read before the first run, and the pilot starts each
participant there.

**Two briefs (D7).** `src/campaign/brief.mjs` writes `operator-brief.md`: a
4 KiB capsule of durable facts so a *fresh seat can take over a running
campaign*, a pure function of recorded facts with no model involved. The
pre-execution approval artefact is `campaign-brief.md`.

---

## P2: Intent evals

There is a difference between *the code works* and *the original intent was
satisfied*. Three levels:

1. **Mechanical**: build, lint, tests, files, commands, schemas, contracts,
   migrations. Largely present.
2. **Behavioural**: browser, API, integration, full flow, produced data,
   observable behaviour.
3. **Intent**: was the problem that started this campaign actually solved?
   Compare intent, requirements, acceptance criteria, evidence and outcome, and
   report per-requirement PASS/PARTIAL with the missing evidence named.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-011 | Intent evaluation report per campaign | none yet | idea |
| RM-012 | Proof `kind: behavior \| preservation` on a `command` proof, checked at dispatch against the post-integration base | proposed by the Astra review; distinguishes `vacuous_proof`, `behavior_already_green`, `broken_baseline`, `baseline_inconclusive`. `spec validate --run-proofs` (#56) runs a proof but does not classify it | idea |
| RM-013 | Judge calibration canary | 0 findings on 34 judged nodes in `orchestration-arms` while costing 24 to 45% of the bill; 1 real finding in 9 verdicts of the `glm-5.3-flash` judge in `rec-audit-remediation`, for 2.8% of its bill. The canary (35 cases, 2026-09-24) gives gpt-5.6-sol recall 1.00 and false alarms 0.20, glm-5.3-flash 0.83 and 0, claude-sonnet-5 0.30 and 0; D9 reads it | landed: `evals-with-a-budget` R5 to R7, R11, 2026-09-24 |
| RM-091 | A canary corpus that does not favour the family that wrote it | all 25 defect cases were rebuilt by `claude-opus-5-5`; a judge of the same family would be read inflated; 10 of 25 defects now come from gpt-6-sol and deepseek-v4-pro, and every case records its author | landed: `choose-the-judges` R1 to R2, 2026-09-24 |
| RM-092 | A judge matrix by worker vendor instead of one judge | the vendor rule refuses a same-vendor judge, so the best judge depends on the worker; the owner's candidates include two that cannot judge the default workers; `node evals/judge-canary-matrix.mjs` builds the matrix from the result files, and D9 reads it | landed: `choose-the-judges` R3 to R4, 2026-09-24 |
| RM-093 | Planner roles chosen by measurement | the reviewer was right and the reviser diverged in `evidence-you-can-recompute`; `draft` and `revise` share the worker role, `review` uses the judge role; three configurations planned the same phase and none froze, D11 reads why | landed: `choose-the-judges` R5, 2026-09-24 |
| RM-014 | Acceptance suite external to the writer, run against the sealed artefact | the paired benchmark already hides its acceptance from the arms; nothing does it for an ordinary campaign | idea |
| RM-068 | A `judgment` item says what no command can check | every judged node in `orchestration-arms` carried a judgment item next to a mechanical proof, which is why arm A paid a judge | landed: `evals-with-a-budget` R10, 2026-09-24 |

`RM-011` and `RM-013` were to be built in parallel (D3). The program builds the
canary first: until it reports, an intent eval's confidence number is an
exploratory signal, not assurance, and must be read as one.

---

## P3: Dataset

Start recording systematically now, not when the system is "ready".

**Already recorded** per invocation in `usage.jsonl`: `attempt`, `inputTokens`,
`outputTokens`, `cacheReadInputTokens`, `costUsd`, `costProvenance`, `model`,
`nodeId`, `role`, `runId`, `runtimeId`, `session`, `startedAt`, `finishedAt`,
`invocationId`. So this priority is mostly *aggregate, preserve and expose*, not
*record from scratch*.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-015 | Add the missing per-node dimensions: taskKind, vendor, harness, retries, judge used and judge outcome, tests run, human intervention | 15 of ~25 desired fields already exist; the pilot export needs most of them | specified in part: `friends-pilot` R2 |
| RM-016 | Per-campaign roll-up: intent, complexity, nodes, duration, cost, retries, human interventions, success rate, replans, final eval outcome | `faberun metrics` exists and reads runs | landed in part: `evidence-you-can-recompute` R5, R9, 2026-09-23 |
| RM-017 | Per-request metering for codex | zcode has no stream, so the measure differs per harness; 4 of 10 arms in the complex round have no request count | idea |
| RM-018 | Classify `blocked_context` refusals into four kinds: correct refusal, false refusal, harness incompatibility, implementation failure, without auto-escalating to a more expensive model | none yet | idea |
| RM-060 | A closed ledger carries every source the projectors read | `preserveCampaignLedger` copies journal, record and `usage.jsonl`; the projectors also read `events.jsonl` and node snapshots, which now live only in the operator's home | landed: `evidence-you-can-recompute` R1 to R2, 2026-09-23 |
| RM-061 | `campaign reledger` completes the ledger of an already closed campaign | the campaigns closed since 2026-09-15 have ledgers without events or snapshots | landed: `evidence-you-can-recompute` R3, 2026-09-23 |
| RM-062 | An unknown cost names its reason | 73 of 186 invocations `unknown` in `state-location-and-routing-economics`; 1 of 21 in `durable-state-integrity` after `RM-022` | landed: `evidence-you-can-recompute` R4, 2026-09-23 |
| RM-063 | The North Star is an indicator | D4 chose it; nothing in `src/` or `evals/` computes it | landed: `evidence-you-can-recompute` R5, 2026-09-23 |
| RM-066 | The baseline recomputes from versioned ledgers | `evals/baseline.json` dates from 2026-09-12 and cites five absolute paths on the owner's machine | landed: `evidence-you-can-recompute` R6, 2026-09-23 |

---

## P4: Empirical routing

Routing stops being opinion and becomes accumulated evidence: for this
repository and this class of task, pick on cost-adjusted success rate.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-019 | Cheap writer as the per-class default (taskKind × acceptance kind; high risk excluded), as a static policy first | a cheap writer moved cost 16 to 50 times in `orchestration-arms`; `rec-audit-remediation` closed 12 of 12 nodes with `deepseek-flash` for US$ 0.47 of worker spend | measured; applied as a program rule |
| RM-020 | Ledger scorecard in "recommend" mode, promoted to auto-select only above a floor | proposed floor: at least 60 distinct nodes, 5 campaigns, 60 days, 20 random, pass@1 of 95% with lower bound of 90%, 10% exploration | idea |
| RM-021 | `DEFAULT_ROUTING_TABLE` is empty; routing is taskKind + riskTier only | verified in `src/plan/pipeline.mjs` | measured |
| RM-055 | `metrics` counts an operator's deliberate re-issue as a failure | `nodesDoneRate` 0.7778 over 18 node records, and all four non-done records come from the two runs the operator canceled to re-issue a contract after a packet defect, one of which had produced the work that landed. `replace-contract` already records the substitution | landed: `evidence-you-can-recompute` R9, 2026-09-23 |

**See open question Q6.** The floor in `RM-020` is what separates evidence from
anecdote, and it is not yet agreed. The fallback judge is part of routing too:
in `rec-audit-remediation` the `claude-sonnet-5` fallback cost 62% of the
campaign for three nodes, because no same-tier alternative was declared.

---

## P5: Make faberun invisible

The user states what they want and how they will know it worked; the factory
decides whether to research, how to plan, which workers and models, how to split
the graph, when to parallelise, when to judge, when to retry, and when to
escalate to a human.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-023 | `faberun spec author`: notes to a structured spec, with an adversarial spec review | the `spec-author` and `spec-review` templates already exist in `src/plan/template.mjs`; no verb invokes them | measured |
| RM-024 | `faberun plan` freezes one contract **per phase** and stitches the campaign manifest itself | today it freezes one contract and never calls `add-contract`; a human sequences the phases | measured |
| RM-025 | `reauthor`: a discovery node that takes a frozen packet plus its `blocked_context` and returns a new validated packet, with a round budget | `context_missing` is terminal by construction; the only exit is `resume --answer` or a human re-authoring | specified: `safe-to-hand-to-a-friend` R10 |
| RM-026 | Adversarial research/discovery before planning, with findings that cite verifiable evidence | `repo-facts` already gives measured facts; architectural understanding is what the draft lacks | idea |
| RM-054 | A packet defect has no operator override, so the only exit discards the attempt's good work | the failed `test-hygiene` attempt had already deleted the 14 artifacts and fixed `testDir()`; re-issuing the contract re-ran from zero because a failed attempt's seal is not on the new run's ancestry. `resume --answer` is the right mechanism and covers only `context_missing` | specified: `safe-to-hand-to-a-friend` R13 |
| RM-072 | Repo facts find verification commands outside Node | `readScripts` reads only `package.json`; `rec` (Zig) was planned by hand | specified: `safe-to-hand-to-a-friend` R7 |
| RM-073 | A stranger's first campaign completes offline, end to end | no test covers `init`, `plan`, `run` and `close` on an unfamiliar repository | specified: `safe-to-hand-to-a-friend` R8 |
| RM-074 | A contested plan hands the operator a decision, and resumes from the answers | the planner contested both plans of `durable-state-integrity` and the implementation plan of the Campaign Brief; in each case a human wrote or fixed the contract | specified: `safe-to-hand-to-a-friend` R9 |
| RM-087 | A revise that does not reduce critical findings stops the pipeline | `evidence-you-can-recompute`: the revise reached 28 criticals in round 4 with mechanically invalid output (`proof.ref` as text), and US$ 3.79 of planning never froze | specified: `safe-to-hand-to-a-friend` R14 |
| RM-088 | A proof no node can write is found before review, without a model | the reviewer of `evidence-you-can-recompute` found a proof whose test file was in no node's `writeFiles` and a `grep -c` measure that exits 1 at zero; both were spec defects a deterministic check would have caught | specified: `safe-to-hand-to-a-friend` R15 |
| RM-089 | The plan carries a human step the spec declares | the `reledger` step of `evidence-you-can-recompute` R3 was declared a human boundary and the plan had no way to represent it, so the node that needed its output could never run | specified: `safe-to-hand-to-a-friend` R16 |
| RM-090 | The managed signal block of `AGENTS.md` alone does not block a launch | during `first-target-frictions` every launch was refused as uncommitted until the operator restored `AGENTS.md`; source identity already excludes the block | specified: `safe-to-hand-to-a-friend` R17 |

`RM-025` is the bottleneck in practice: the information needed to fix the packet
usually arrives *inside* the refusal. `RM-026` lowers how often `RM-025` is
needed; instrument the `context_missing` rate before and after to know whether it
paid.

---

## P6: Real sandboxing

A worktree is not a sandbox, and the repository already says so: a packet is an
instruction and a detector, not a container. Only a `claude` worker is stopped
mechanically, and only on `Write`/`Edit`/`NotebookEdit`; a write through `Bash`
is never inspected, and no other harness is prevented at all.

If the promise becomes *start the campaign and go do something else*, isolation
stops being optional. The program does not build it (D2); it builds the minimum
that makes handing faberun to someone else acceptable.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-027 | Level 1: isolated container | none yet | idea |
| RM-028 | Level 2: container + restricted filesystem + controlled secrets | none yet | idea |
| RM-029 | Levels 3 to 4: ephemeral microVM; policy-based capabilities (network allowlist, filesystem scope, docker/cloud denied, no secrets) | none yet | idea |
| RM-048 | Evaluate `akitaonrails/ai-jail` as the isolation layer | it wraps a command, and a harness binary already resolves through `FABERUN_<HARNESS>_BIN` or `runtime.executable`, so it is testable without a code change | idea |
| RM-050 | `workspace-write` cannot run a toolchain that caches in `$HOME`, and the documentation does not say so | measured 2026-09-22 with `dsh`/`deepseek-flash`: under `workspace-write` the compiler dies `manifest_create ReadOnlyFileSystem` before its first source file, and under `danger-full-access` the same packet compiles in 19 s. `references/contract.md` describes `workspace-write` as "executes and writes inside the worktree", which is exactly the half that blocks a compiler | specified: `safe-to-hand-to-a-friend` R12 |
| RM-069 | A worker sees only the environment it was allowed | `src/engine/gate.mjs` builds the worker's environment from the whole `process.env`; an inherited `CODEX_VERSION` masked a probe during the Campaign Brief run | specified: `safe-to-hand-to-a-friend` R1 to R4 |

The honest statement of the risk stays the one at the top of this section: a
worker runs arbitrary commands with the operator's own credentials, and nothing
but the worker's own restraint keeps it in the repository. The pilot protocol
says so to every participant.

### `ai-jail` as a candidate

OS-level isolation rather than a container: bubblewrap plus Landlock, seccomp and
limits on Linux, `sandbox-exec` on macOS. Network off by default, private
ephemeral home, agent state not mounted unless asked, and GPU, display, Docker,
SSH and host IPC denied by default. Configured in TOML at three levels: an
untrusted project file, a trusted global one, and CLI flags.

Three things make it a good fit here:

- **The integration seam already exists.** `ai-jail` wraps a command, and
  `src/harnesses/claude/index.mjs` resolves its binary as
  `FABERUN_CLAUDE_BIN ?? runtime.executable ?? "claude"`. A wrapper script, or a
  contract declaring `executable`, tests the whole idea before a line of faberun
  changes.
- **The threat models agree.** Its README says it is "a useful layer, not a
  replacement for a disposable VM when running hostile code"; this repository
  already says scope "keeps an honest worker inside its lane" and "does not
  contain an adversarial one". Both target the honest worker that errs, not the
  attacker.
- **It is cheaper than the route sketched above.** Levels 1 and 2 assumed
  containers; this reaches a comparable restriction with no Docker, which
  matters for an install whose `dependencies` are `{}`.

Four questions to settle before adopting, each of which changes the answer:

1. **Network.** A worker must reach its vendor's API, so it cannot run with the
   default network-off. Does `--network` allow a per-host allowlist, or is it
   all-or-nothing? Half the value rides on this.
2. **Worktrees and git.** Attempt worktrees live under
   `~/.faberun/projects/<id>/runs/worktrees/…` while the repository lives
   elsewhere, and a worktree's `.git` is a *file* pointing back at the main
   repository. A jail that mounts only the worktree breaks git. The mapping has
   to cover both, which widens the very boundary being drawn.
3. **macOS.** The strong backend is Linux; the macOS path uses Apple's
   deprecated `sandbox-exec`. On the machine this factory runs on today, the
   protection is the weaker of the two and rests on a deprecated interface.
4. **Credentials.** Agent state is not mounted unless `--agent-state` is passed,
   but a worker must authenticate. Passing it mounts the credentials the jail was
   meant to keep away. The jail protects the rest of the host from the agent; it
   does not protect the agent's own credentials from the agent.

---

## P7: Human judgment, not a human proxy

Not a system where the human presses Approve five times; that turns a person
into a Jira. Intervention belongs at irreversible decisions, relevant
architectural changes, product trade-offs, risk, high cost, genuine ambiguity,
conflicts between requirements, and the final result. The human exercises
judgment; they do not transport information.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-030 | `campaign close` preserves `proposals/` in the ledger | 16 proposals lived only in gitignored `.runs/`; the close copies journal, record and usage, not these | landed: `evidence-you-can-recompute` R1, 2026-09-23 |
| RM-031 | Emit `judgment` proofs only where no `command`/`path` proof covers the item, and support `gate.skipWhen` | `judgeRequired` already skips the judge when no `judgment` item exists, and `gate.skipWhen` exists; R10 makes a `judgment` item name what no command checks, the emission half is still open | landed in part: `evals-with-a-budget` R10, 2026-09-24 |
| RM-032 | Detect unproductive loops and stop them | 23 turns with no result accounted for 25% of one campaign's spend; `process.mjs` restarts the stall clock on any event | measured |
| RM-094 | A provider refusal is shared across processes and stops the next launch | `choose-the-judges`, 2026-09-24: a probe answered `quota_exhausted` was cached as an answer; six canaries on two accounts each found the exhausted quota by failing on their own, and zcode's `[1308]` reached stderr only | landed: `bce1e01`, `76387b9`, 2026-09-24 |
| RM-095 | A stochastic class asks cases in parallel | the judge canary asked one case at a time: `deepseek-v4-pro` took 2 h 55 min for 70 cases, median 135 s each | landed in the canary: `0632839`, 2026-09-24; the paired class still runs arms one at a time |
| RM-096 | Read the provider's own usage window before spending | every codex call records `rate_limits` (5-hour and weekly `used_percent`, `resets_at`); on 2026-09-24 the weekly window went from 86% to about 93% in one canary reading, and nothing read it | measured |
| RM-097 | A planning stage whose detached launch fails is retried and named | `choose-the-judges` R5: `plan --detach` died twice with no plan written ("detached bootstrap failed before readiness"), about 40 minutes lost | measured |
| RM-098 | Repository facts are measured once per commit and reused | each of the four R5 plans measured the same suites again, about 15 minutes each | measured |
| RM-099 | The planner's reviewer and the frozen contract's judge are configured apart, with a reviewer list of its own (D11) | R5 (b): `--runtime-defaults judge=` set both, so a same-vendor reviewer made every frozen node's judge unroutable (`runtime_routing_unmet`) in all four rounds | measured |
| RM-100 | One command waits for a run or a plan to need attention or finish | the operator's own polling broke three times in `choose-the-judges` (text parsing, a sandbox that cannot see the controller), delaying the detection of a parked node | measured |
| RM-101 | The judge is chosen from an ordered list per node, with a fallback of several hops | D9 (2026-09-24): first entry of another canonical provider, skipping one out of quota or above 90% of its Codex window; a contract names one judge and one fallback today | decided: D9 |
| RM-102 | A single-provider mode, opt-in | an operator with one provider has no cross-vendor judge. Explicit opt-in (for example `judgeIndependence: same-vendor`); the judge is another model of the same or a higher class than the worker (Sonnet works, Opus or Fable judges); the Campaign Brief, the report and the metrics mark "same-provider review"; the judge canary gains a reading of that case | decided: owner, 2026-09-24 |
| RM-103 | Finding severity is calibrated | in the `choose-the-judges` canary a third of the planted defects drew only `minor` findings, so a `[major, critical]` gate passes them: gpt-6-sol recalls 0.98 counting any cited rejection and 0.70 blocking | measured |
| RM-104 | A plan's `proof.ref` is accepted as the verification command's text or its index | the invalid `proof.ref` that contested plans came from gpt-5.6-luna's revise and from claude-opus-5-5's draft alike (`choose-the-judges` R5), so it is the format, not a model | measured |
| RM-033 | Ask the owner asynchronously (WhatsApp, then `campaign resolve`) instead of keeping a session alive to be present when a question appears | none yet | idea |
| RM-070 | The getting-started walkthrough is executed, not only read | its first output shows `.runs/campaigns/hello`; the CLI prints a path under the home layout | specified: `safe-to-hand-to-a-friend` R5 |
| RM-071 | No current document describes the legacy run layout as current | 31 lines cite `.runs` across `GETTING-STARTED.md`, `CONCEPTS.md`, `ARCHITECTURE.md` and `README.md` | specified: `safe-to-hand-to-a-friend` R6 |
| RM-075 | Leaving is one command | nothing undoes what `setup`, `init` and `skills register` write outside the target repository | specified: `safe-to-hand-to-a-friend` R11 |

---

## P8: Positioning and evidence

Faberun is not "a better way to use Claude" or "a tool for Codex". It is an
independent layer between human intent and computational intelligence. What it
says about itself has to be measured first, and measured by people other than
its author.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-034 | State vendor neutrality explicitly in the README and public docs | none yet; waits for D10 | idea |
| RM-035 | Permanent paired benchmark: versioned corpus, same writer/base/acceptance, randomised order, repetitions, CI95 resampled by task | the `spike/arms/` driver produced two rounds; the complex round has one repetition, and two identical sonnet runs differed by about 40%. `evals --class paired` measured the complex round three times per arm on 2026-09-24 (`evals/results/paired/combined-*.json`): USD per proof A 3.49..4.73, B 2.01..2.22, D 1.93..2.07, E 0.048..0.050, H 0.077..0.113, J 0.074..0.095, every arm 2 of 2 proofs; H1 refuted for A against B, H4 refuted | landed: `evals-with-a-budget` R1 to R4, R8, R11, 2026-09-24 |
| RM-036 | External validation with 3 to 5 developers who already use agents | the signal is spontaneous reuse, not "nice" | specified: `friends-pilot` R6 |
| RM-064 | The skill and its references share one byte budget | 12 ceiling raises between 2026-09-13 and 2026-09-22, each justified, none offset | landed: `evidence-you-can-recompute` R8, 2026-09-23 |
| RM-065 | The `orchestration-arms` record lives on `main` | the thesis above cites it; it exists only on `spike/orchestration-arms` | landed: `evidence-you-can-recompute` R7, 2026-09-23 |
| RM-067 | Every stochastic eval class has a hard budget | no class has one; the complex round alone recorded US$ 28.85, including voided launches. Both stochastic classes now take `--budget-usd`; R11 spent US$ 58.05 on the paired round and US$ 22.64 on the canary, with voided and unknown spend named | landed: `evals-with-a-budget` R1, 2026-09-24 |
| RM-076 | A redacted campaign export a participant reads before sending | a ledger carries paths, requirement text, notes and the repository name | specified: `friends-pilot` R2 |
| RM-077 | Friction is a journal type | 16 journal types, none for "this blocked me" | specified: `friends-pilot` R3 |
| RM-078 | Pilot bundles aggregate into one deterministic table | none yet | specified: `friends-pilot` R4 to R5 |
| RM-079 | A pilot protocol written before the first invitation | none yet | specified: `friends-pilot` R1 |

### North Star

> **Intent to verified outcome**: the elapsed time from stating an intent to a
> proven result.

Chosen over "validated work produced without human intervention" (D4). The
rejected metric rewards removing the human, which at the limit erodes precisely
the judgment P7 exists to protect; this one does not, and it also rewards
cutting rework and waiting, which are where the time actually goes. `RM-063`
makes it an indicator.

`human interventions per campaign` stays worth watching as a diagnostic, but it
is not the target: a campaign that asks about a destructive migration is behaving
correctly, and a number that punishes it would be measuring the wrong thing.

---

## P9: Sovereign cross-harness memory

Last in the queue on purpose. The reasoning is sequencing, not doubt about the
value (D6).

The incoherence it closes is real: execution is vendor-neutral while operator
knowledge sits in one harness's memory directory. Everything learned about this
repository lives under `~/.claude/projects/…/memory/`, which a `codex`, `dsh`,
`agy` or `zcode` worker cannot read. The same applies to the prose half of what
the factory has learned (16 proposals, the campaign ledgers, every journal):
none of it indexed, all of it reachable only by manual grep.

Two gains are expected, and both are claims to be measured rather than assumed:
**learning sovereignty across harnesses**, and **token economy**, because recall
of something already established is cheaper than re-establishing it. Adopting a
mature tool rather than building one is deliberate; this repository prefers
established libraries over reimplementation.

`akitaonrails/ai-memory` is the candidate: git-backed markdown as the source of
truth, a derived SQLite index (FTS5, entities, optional vectors), zero-LLM by
default, one Rust binary, and a stated philosophy of owning the files rather
than renting an API, which is this roadmap's own thesis applied to memory.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-046 | Portable cross-harness memory, evaluated against `akitaonrails/ai-memory` | operator knowledge is unreadable to any worker outside one harness; the recall corpus is unindexed | idea |
| RM-047 | Before/after paired benchmark quantifying what the memory layer changes | the instrument is `RM-035`; the baseline is whatever the stabilised factory measures without it | idea |

### Two constraints that decide the integration shape

Both are load-bearing, and the obvious integration violates them.

- **It attaches to the orchestrator and the planner, never to a worker or a
  judge.** A memory surface inside a worker is an undeclared read source: it
  breaks reproducibility and makes `declaredReadBytes` a fiction. The planner
  consults memory and *materialises* what matters into the packet, so recalled
  knowledge arrives as declared `readFiles` like any other fact.
  `src/plan/repo-facts.mjs` is the natural seam; it already collects measured
  facts the draft reads.
- **Worker and judge must not share a memory they both write.**
  `src/plan/template.mjs` enforces that a reviewer's packet carries the spec, the
  repository facts and the artefact under review, never the author's packet,
  transcript or summary. A shared write surface would let the judge see the
  author's reasoning, which does not weaken adversarial review, it dissolves it.

It also stays optional, the way `FABERUN_NOTIFY_BIN` is: `dependencies` is `{}`
today and that is a deliberate, tested property of the install.

---

## Not now

Deliberately out of scope: realtime collaboration, a complex visual editor, an
in-house comment system, a large dashboard, a marketplace, SaaS, billing,
sophisticated observability, many new agent types, covering every possible
vendor, and a rewrite in another language. Prove the core first.

---

## Landed

| id | item | where | when |
| --- | --- | --- | --- |
| RM-081 to RM-085 | Product frictions found running `first-target-frictions` and `evidence-you-can-recompute`: gate-less nodes run their proofs, tests isolate their home, a vacuous proof fails, the controller snapshot can be refreshed, seals follow the commit convention | `fix/campaign-frictions` | 2026-09-23 |
| RM-030, RM-055, RM-060 to RM-066, RM-016 (part) | The `evidence-you-can-recompute` campaign: complete ledgers and reledger, metrics from a ledger, unknown-cost reasons, the North Star, recovery-aware rates, the orchestration-arms record on main, one docs byte budget, a baseline that recomputes from versioned ledgers | `feat/evidence-you-can-recompute` | 2026-09-23 |
| RM-051 to RM-053, RM-056 to RM-058 | The `first-target-frictions` campaign: ignore-source warning, verification artefacts kept out of the seal, stranded-run resume, no sub-second test budget, measured verification timeouts, read-only judge | `d34d1d9`, `1d47973`, `826dd0e`, `72b08e5`, `614010b`, `33825a8`, `7d23785` | 2026-09-23 |
| RM-002 | Close the `durable-state-integrity` campaign | `f46d5e6`; 10 requirements, 13 runs, US$ 1.88 | 2026-09-22 |
| RM-003 | `cancel` is proven against a genuinely live invocation | `e550650` | 2026-09-22 |
| RM-006 to RM-010, RM-045 | The Campaign Brief: approval artefact, coverage matrix, graph and risks, cost range, portable HTML and loopback server, Faberun theme | #63 | 2026-09-23 |
| RM-037 | A declared `maxParallel` is honoured by every dispatch path | `1a981d4` (#29) | 2026-09-21 |
| RM-038 | A frozen contract carries the parallelism its sizing proved | `ed0baa2` (#25) | 2026-09-21 |
| RM-039 | A review round inherits findings the last one left open | `ed0baa2` (#25) | 2026-09-21 |
| RM-040 | A write onto the file that proves the work is not an advisory | `982846a` (#26) | 2026-09-21 |
| RM-041 | A failing ratchet is not an invitation to edit the ratchet | `2c9dd69` (#23) | 2026-09-21 |
| RM-042 | The squash-message gate revalidates when the body it reads changes | `2d84906` (#30), assertion `7a7d301` | 2026-09-21 |
| RM-043 | The brand ratchet measures tracked source, not the working directory | `27f57ef` (#24) | 2026-09-21 |
| RM-044 | Assertions read the text the CLI produced, not the terminal's colour | `675b8f4` (#28) | 2026-09-21 |
| RM-022 | A runtime prices from the vendored seed | phase 4, `state-location-and-routing-economics` | 2026-09-21 |

---

## Decisions

Owner decisions. Recorded here because each one closed a real conflict between
the stated direction and the repository, and a decision without its reason gets
relitigated.

**D1: "Campaigns in progress" means the running campaign, not the parked runs.**
The eight parked runs of earlier campaigns are historical record, not a backlog;
nothing is resumed on their account. `RM-001` is dropped.

**D2: Sandboxing stays at P6, after autonomy.** The level sketch is not a design
and will be argued when the work starts. The risk is recorded rather than
mitigated: today a worker runs arbitrary commands with the operator's own
credentials. The program's environment allowlist (`RM-069`) narrows what those
commands can see; it does not contain them.

**D3: Intent evals and judge calibration are built in parallel.** The cost is
accepted and named: until the canary reports, an intent eval's confidence figure
is exploratory signal, not assurance. The program builds the canary first.

**D4: The North Star is intent to verified outcome.** "Validated work without
human intervention" was rejected because, optimised literally, it erodes the
human judgment P7 exists to protect.

**D5: The brief renders with `mdhtml`, themed from Faberun's own design
system.** `DESIGN.md` is the source of truth for the identity and already
specifies the palette, the glyphs and the documentation rules, so the theme is
derived from it rather than invented. No third-party or employer design system
is used here, for the reason the repository already states: nothing from a
private or employer repository lands in this one.

**D6: Cross-harness memory goes last, and must prove itself against a
baseline.** The value is not in doubt: learning sovereignty across harnesses and
token economy, without reimplementing what already exists. The sequencing is the
point: stabilise faberun first and measure it well enough that it demonstrates
its own worth unaided, so there is a baseline. Only then adopt the memory layer,
and quantify it with a before/after paired benchmark. A layer adopted before the
baseline exists can never be shown to have helped.

**D7: Keep two briefs with different names.** Owner decision 2026-09-21:
`operator-brief.md` remains the small, model-free continuity capsule for a fresh
seat taking over a running campaign. `campaign-brief.md` is the pre-execution
approval artefact. Merging them would make the continuity capsule depend on the
richer approval workflow and obscure which document an operator should review
before pressing Play.

**D8: Share the first Campaign Brief as portable HTML with local browser
access.** Owner decision 2026-09-21: `mdhtml` produces a self-contained file
that opens offline; Faberun also offers a minimal server bound to loopback so
the operator can open that document through a local browser URL. External
publication and automatic PR comments are not part of the first release.

**D9: The judge comes from an ordered list, chosen per node.** Owner decision
2026-09-24, revising the D9 of 2026-09-24 (one judge, gpt-5.6-sol) after the
`choose-the-judges` canary: 35 cases, 25 defects of which 10 were written
outside the Anthropic family by faberun nodes (5 by gpt-6-sol, 5 by
deepseek-v4-pro), two repetitions, `evals/results/judge-canary/` at `3fcd6b0`.

- The list, in order: `gpt-6-sol`, `claude-opus-5-5`, `glm-5.3-flash`.
- For each node the judge is the first entry whose canonical provider (openai,
  anthropic, zhipu, deepseek, google) is not the worker's, skipping an entry
  that is out of quota or whose Codex usage window is above 90%. The fallback
  is the next eligible entry.
- Out of the list: `deepseek-v4-pro` (0.28 blocking recall), `glm-5.3`, the GLM
  5.3 Pro, which recalls less than flash at nine times the price,
  `gpt-5.6-sol` (superseded by gpt-6-sol at half the cost per verdict) and
  `claude-sonnet-5` (0.30 in the first canary).
- The judge stays blocking.

Blocking recall and false alarms, recomputed from the result files without a
model. A case blocks when the verdict is `fail`, a finding cites an item, and
its highest severity is in `failOn` (`src/engine/review.mjs`). Verdicts are
pooled over every reading of the corpus; refused calls are outside both rates.

| judge | verdicts | recall, `failOn: [minor, major, critical]` | false alarms | recall, `failOn: [major, critical]` | false alarms |
| --- | --- | --- | --- | --- | --- |
| gpt-6-sol | 88 | 0.98 | 0.26 (7/27) | 0.70 | 0.11 (3/27) |
| claude-opus-5-5 | 70 | 0.76 | 0.10 (2/20) | 0.62 | 0.10 (2/20) |
| glm-5.3-flash | 68 | 0.85 | 0 (0/22) | 0.52 | 0 (0/22) |
| glm-5.3 | 99 | 0.79 | 0 (0/32) | 0.52 | 0 (0/32) |
| gpt-5.6-sol | 19 | 1.00 | 0 (0/7) | 0.58 | 0 (0/7) |
| deepseek-v4-pro | 70 | 0.48 | 0 (0/20) | 0.28 | 0 (0/20) |

Cost per verdict, priced: gpt-6-sol 0.070, claude-opus-5-5 0.132,
glm-5.3-flash 0.011 USD. No judge favoured its own family: claude-opus-5-5
recalled 0.70 on the 20 defect verdicts written outside the Anthropic family
and 0.80 inside it; deepseek-v4-pro judged its own family's defects worst
(0.30). With `minor` in `failOn`, glm-5.3-flash recalls more than
claude-opus-5-5 (0.85 against 0.76); the list keeps the owner's order. A third
of the planted defects draw only `minor` findings and pass a `[major,
critical]` gate (`RM-103`). The list and its multi-hop fallback are `RM-101`;
today a contract still names one judge and one fallback.

**D11: Planning has its own reviewer list; Fable and Astra review plans and
never judge a worker's node.** Owner decision 2026-09-24, from R5 of
`choose-the-judges` (`evals/results/planner-roles/`): none of three role
configurations froze. The reviewers (claude-opus-5-5, gpt-6-astra) found real
defects in all three. What diverged was the reviser, and not by model: an
invalid `proof.ref` came from gpt-5.6-luna's revise and from claude-opus-5-5's
draft alike (`RM-087`, `RM-104`). A same-vendor reviewer made every frozen node's
judge unroutable, because one `--runtime-defaults judge=` names both roles.
Depends on `RM-099`.

### Reserved, not yet taken

- **D10: going public.** Announce or not, from the pilot's table, D9 and the
  open P0 items. Taken at the close of `friends-pilot`.

## Open questions for the owner

Still open. Each changes what gets built, so none is decided here.

**Q6: When may empirical routing decide on its own?** The proposed floor is
deliberately conservative (at least 60 nodes, 5 campaigns, 60 days, pass@1 of
95%). A lower floor starts saving sooner and risks learning from noise. Where is
the line?

**Q7: The stochastic budget.** `evals-with-a-budget` declares US$ 100 for its
first real readings: about US$ 60 for three repetitions of six arms of the
complex round and about US$ 20 for the canary on two judge runtimes. Confirm or
change before that campaign's last phase.

**Q8: Who is in the pilot.** Three to five people who already use coding agents,
each with a repository of their own that has a remote and no automatic deploy.
The names are the owner's to choose, and the invitations go out only after the
program's third campaign closes.
