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

One measurement already supports the thesis rather than assuming it: the
`orchestration-arms` campaign found that *how* work is organised (faberun vs a
session vs subagents) does not move the bill when the model is held constant,
while swapping in a cheap writer moves it 16–50x. The interchangeable part is
where the leverage is.

## How this file works

One line per idea, entered the moment it is thought of. This file is the single
source of truth for uncommitted ideas; it is versioned, because the main
consumer of these ideas is an agent reading `docs/`, and because the last place
they lived was not.

- **Ids are stable and never reused.** `RM-###`, assigned in order of entry, not
  of priority. Moving an item between priorities does not change its id.
- **States**: `idea` → `measured` → `specified` → `running` → `landed` →
  `dropped`.
- **An item at `measured` or beyond cites the measurement.** An item with no
  measurement is not invalid; it must say so. This is the comment rule of this
  repository applied to planning: record measurement, not intent.
- **Promoting means writing the spec**, not moving a row. An item becomes
  `docs/campaigns/<id>/spec/SPEC.md` in the format `faberun spec validate`
  checks; the spec declares requirements; requirements already travel to the
  node. This file is the missing step above that chain, not a replacement for
  it.
- **Dropped items keep their reason.** Without it the same bad idea returns
  every few months and is re-evaluated from zero.

### Why this file exists

The ideas this repository generates were being lost. Sixteen written proposals —
each with its own measurement, named for what it found — lived only under
`.runs/…/proposals/`, which is gitignored, and `campaign close` copies the
journal, the campaign record and every `usage.jsonl` into
`docs/campaigns/<id>/ledger/` but **not the proposals**. They were rescued into
`docs/campaigns/state-location-and-routing-economics/proposals/` when this file
was created. `RM-030` fixes the leak at its cause.

---

## P0 — Stabilise before expanding

The goal is not features. It is reaching the point of thinking: *I trust faberun
enough to leave a campaign running without watching it.*

"Campaigns in progress" means the campaign that is actually running, not the
parked runs of closed ones — see decision D1.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-001 | Resume the parked runs from earlier campaigns | 8 runs parked across `adversarial-planner` (4), `become-faberun` (1), `chain-ergonomics-and-fairness` (2) | dropped — D1 |
| RM-002 | Close the active `durable-state-integrity` campaign | cancel orphans integrated work; `npm test` writes into the operator's home; the journal truncates silently; an old record has no repair path | running |
| RM-003 | `cancel` against a genuinely live invocation is unverified | `a-cancelled-run-releases-what-it-will-never-reuse` was verified only against an already-terminal run; worked around by giving the contract a fresh id rather than relaunching | idea |
| RM-004 | `faberun plan` has never run end to end against a live harness | every planning stage landed so far went through the replay harness in tests; `validateContract`'s containment check runs before any worktree exists | measured |
| RM-005 | Make scope closure deterministic in the product | six packets were refused `context_missing` in one day, each naming the exact missing file; the orchestrator got phase 1e right only after getting nine earlier scopes wrong — that is memory, not a guarantee | measured |

`RM-005` is the load-bearing one. A lesson in a memory file is advice to one
agent; the same lesson as a check in `faberun validate` and `faberun preflight`
is a property of the tool, and runs regardless of harness, model, or whether the
operator has ever seen the repository.

---

## P1 — Campaign Brief

The human review surface for a plan, answering *is this worth pressing Play?* in
a few minutes. It does not replace the technical plan, which stays large; the
plan becomes a drill-down.

The brief should carry: intent in one sentence; expected outcome; measurable
success criteria; the requirements with a **coverage matrix** (requirement →
responsible nodes → evidence); the execution graph, showing what runs in
parallel and what blocks what; **decisions split into those needing human
judgment and those delegable**; only the relevant risks; an execution estimate
(workers, models, nodes, cost range, duration); and the planned evals.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-006 | Campaign Brief as a pre-execution approval artefact | — | idea |
| RM-007 | Requirement Coverage Matrix in the brief | requirement ids already travel from phase to node (R9–R11, shipped 0.14.0), so the data exists | idea |
| RM-008 | Render the graph, the risks, the human decisions and the planned evals | — | idea |
| RM-009 | Cost and duration estimate as a range | `usage.jsonl` already records `costUsd` with `costProvenance` per invocation | idea |
| RM-010 | Publish the brief as a shareable artefact (e.g. a PR comment linking to it) | — | idea |
| RM-045 | An `mdhtml` theme built from `DESIGN.md`, so the rendered brief looks like Faberun | the design system is already specified: Terra, Argila, Areia, Folha, Carvão, each with one meaning and one job | idea |

The brief is authored in Markdown and rendered with `mdhtml` into a portable,
self-contained document, keeping Markdown as the source. The theme is Faberun's
own — see decision D5.

**Name collision, see open question Q2.** `src/campaign/brief.mjs` already
writes `operator-brief.md`: a 4 KiB capsule of durable facts so a *fresh seat can
take over a running campaign*, a pure function of recorded facts with no model
involved. That is continuity, not approval. Two different artefacts currently
compete for one name.

---

## P2 — Intent evals

There is a difference between *the code works* and *the original intent was
satisfied*. Three levels:

1. **Mechanical** — build, lint, tests, files, commands, schemas, contracts,
   migrations. Largely present.
2. **Behavioural** — browser, API, integration, full flow, produced data,
   observable behaviour.
3. **Intent** — was the problem that started this campaign actually solved?
   Compare intent → requirements → acceptance criteria → evidence → outcome, and
   report per-requirement PASS/PARTIAL with the missing evidence named.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-011 | Intent evaluation report per campaign | — | idea |
| RM-012 | Proof `kind: behavior \| preservation` on a `command` proof, checked at dispatch against the post-integration base | proposed by the Astra review; distinguishes `vacuous_proof`, `behavior_already_green`, `broken_baseline`, `baseline_inconclusive` | idea |
| RM-013 | Judge calibration canary | judges returned zero findings on 34 judged nodes while costing 24–45% of the bill | measured |
| RM-014 | Acceptance suite external to the writer, run against the sealed artefact | — | idea |

`RM-011` and `RM-013` are built in parallel — see decision D3. The consequence is
explicit: until the canary reports, an intent eval's confidence number is an
exploratory signal, not assurance, and must be read as one.

---

## P3 — Dataset

Start recording systematically now, not when the system is "ready".

**Already recorded** per invocation in `usage.jsonl`: `attempt`, `inputTokens`,
`outputTokens`, `cacheReadInputTokens`, `costUsd`, `costProvenance`, `model`,
`nodeId`, `role`, `runId`, `runtimeId`, `session`, `startedAt`, `finishedAt`,
`invocationId`. So this priority is mostly *aggregate and expose*, not *record
from scratch*.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-015 | Add the missing per-node dimensions: taskKind, vendor, harness, retries, judge used and judge outcome, tests run, human intervention | 15 of ~25 desired fields already exist | measured |
| RM-016 | Per-campaign roll-up: intent, complexity, nodes, duration, cost, retries, human interventions, success rate, replans, final eval outcome | `faberun metrics` exists and reads runs; this extends it | idea |
| RM-017 | Per-request metering for codex | zcode has no stream, so the measure differs per harness | idea |
| RM-018 | Classify `blocked_context` refusals into four kinds: correct refusal, false refusal, harness incompatibility, implementation failure — without auto-escalating to a more expensive model | — | idea |

---

## P4 — Empirical routing

Routing stops being opinion and becomes accumulated evidence: for this
repository and this class of task, pick on cost-adjusted success rate.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-019 | Cheap writer as the per-class default (taskKind × acceptance kind; high risk excluded), as a static policy first | a cheap writer moved cost 16–50x in `orchestration-arms` | measured |
| RM-020 | Ledger scorecard in "recommend" mode, promoted to auto-select only above a floor | proposed floor: ≥60 distinct nodes, ≥5 campaigns, 60 days, ≥20 random, pass@1 ≥95% with lower bound ≥90%, 10% exploration | idea |
| RM-021 | `DEFAULT_ROUTING_TABLE` is empty; routing is taskKind + riskTier only | verified in `src/plan/pipeline.mjs` | measured |
| RM-022 | Price every invocation from tokens × the vendored `models.dev` rate rather than recording `unknown` | owner decision 2026-09-18: vendor the seed, do not chase exactness | landed |

**See open question Q6.** The floor in `RM-020` is what separates evidence from
anecdote, and it is not yet agreed.

---

## P5 — Make faberun invisible

The user states what they want and how they will know it worked; the factory
decides whether to research, how to plan, which workers and models, how to split
the graph, when to parallelise, when to judge, when to retry, and when to
escalate to a human.

Three verbs stand between here and there. None exists today (verified).

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-023 | `faberun spec author` — notes to a structured spec, with an adversarial spec review | the `spec-author` and `spec-review` templates already exist in `src/plan/template.mjs`; no verb invokes them | measured |
| RM-024 | `faberun plan` freezes one contract **per phase** and stitches the campaign manifest itself | today it freezes one contract and never calls `add-contract`; a human sequences the phases | measured |
| RM-025 | `reauthor` — a discovery node that takes a frozen packet plus its `blocked_context` and returns a new validated packet, with a round budget | `context_missing` is terminal by construction; the only exit is `resume --answer` or a human re-authoring | measured |
| RM-026 | Adversarial research/discovery before planning, with findings that cite verifiable evidence | `repo-facts` already gives measured facts; architectural understanding is what the draft lacks | idea |

`RM-025` is the bottleneck in practice: the information needed to fix the packet
usually arrives *inside* the refusal. `RM-026` lowers how often `RM-025` is
needed; instrument the `context_missing` rate before and after to know whether it
paid.

---

## P6 — Real sandboxing

A worktree is not a sandbox, and the repository already says so: a packet is an
instruction and a detector, not a container. Only a `claude` worker is stopped
mechanically, and only on `Write`/`Edit`/`NotebookEdit`; a write through `Bash`
is never inspected, and no other harness is prevented at all.

If the promise becomes *start the campaign and go do something else*, isolation
stops being optional.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-027 | Level 1: isolated container | — | idea |
| RM-028 | Level 2: container + restricted filesystem + controlled secrets | — | idea |
| RM-029 | Levels 3–4: ephemeral microVM; policy-based capabilities (network allowlist, filesystem scope, docker/cloud denied, no secrets) | — | idea |

This stays at P6, after autonomy — see decision D2. The levels above are a sketch
to be argued properly when the work starts, not a settled design. Until then the
honest statement of the risk is the one at the top of this section: a worker runs
arbitrary commands with the operator's own credentials, and nothing but the
worker's own restraint keeps it in the repository.

---

## P7 — Human judgment, not a human proxy

Not a system where the human presses Approve five times — that turns a person
into a Jira. Intervention belongs at irreversible decisions, relevant
architectural changes, product trade-offs, risk, high cost, genuine ambiguity,
conflicts between requirements, and the final result. The human exercises
judgment; they do not transport information.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-030 | `campaign close` preserves `proposals/` in the ledger | 16 proposals lived only in gitignored `.runs/`; the close copies journal, record and usage, not these | measured |
| RM-031 | Emit `judgment` proofs only where no `command`/`path` proof covers the item, and support `gate.skipWhen` | `judgeRequired` already skips the judge when no `judgment` item exists, so the saving is available today | idea |
| RM-032 | Detect unproductive loops and stop them | 23 turns with no result accounted for 25% of one campaign's spend; `process.mjs` restarts the stall clock on any event | measured |
| RM-033 | Ask the owner asynchronously (WhatsApp → `campaign resolve`) instead of keeping a session alive to be present when a question appears | — | idea |

---

## P8 — Positioning

Faberun is not "a better way to use Claude" or "a tool for Codex". It is an
independent layer between human intent and computational intelligence.

| id | item | evidence | state |
| --- | --- | --- | --- |
| RM-034 | State vendor neutrality explicitly in the README and public docs | — | idea |
| RM-035 | Permanent paired benchmark: versioned corpus, same writer/base/acceptance, randomised order, 5 reps, CI95 resampled by task | `evals --repeat/--band` already exists | idea |
| RM-036 | External validation with 3–5 developers who already use agents | the signal is spontaneous reuse, not "nice" | idea |

### North Star

> **Intent → verified outcome**: the elapsed time from stating an intent to a
> proven result.

Chosen over "validated work produced without human intervention" — see decision
D4. The rejected metric rewards removing the human, which at the limit erodes
precisely the judgment P7 exists to protect; this one does not, and it also
rewards cutting rework and waiting, which are where the time actually goes.

`human interventions per campaign` stays worth watching as a diagnostic, but it
is not the target: a campaign that asks about a destructive migration is behaving
correctly, and a number that punishes it would be measuring the wrong thing.

---

## P9 — Sovereign cross-harness memory

Last in the queue on purpose. The reasoning is sequencing, not doubt about the
value — see decision D6.

The incoherence it closes is real: execution is vendor-neutral while operator
knowledge sits in one harness's memory directory. Everything learned about this
repository lives under `~/.claude/projects/…/memory/`, which a `codex`, `dsh`,
`agy` or `zcode` worker cannot read. The same applies to the prose half of what
the factory has learned — 16 proposals, 21 campaign ledgers, every journal —
none of it indexed, all of it reachable only by manual grep.

Two gains are expected, and both are claims to be measured rather than assumed:
**learning sovereignty across harnesses**, and **token economy**, because recall
of something already established is cheaper than re-establishing it. Adopting a
mature tool rather than building one is deliberate — this repository prefers
established libraries over reimplementation.

`akitaonrails/ai-memory` is the candidate: git-backed markdown as the source of
truth, a derived SQLite index (FTS5, entities, optional vectors), zero-LLM by
default, one Rust binary, and a stated philosophy of owning the files rather
than renting an API — which is this roadmap's own thesis applied to memory.

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
  `src/plan/repo-facts.mjs` is the natural seam — it already collects measured
  facts the draft reads.
- **Worker and judge must not share a memory they both write.**
  `src/plan/template.mjs` enforces that a reviewer's packet carries the spec, the
  repository facts and the artefact under review — never the author's packet,
  transcript or summary. A shared write surface would let the judge see the
  author's reasoning, which does not weaken adversarial review, it dissolves it.

It also stays optional, the way `FABERUN_NOTIFY_BIN` is: `dependencies` is `{}`
today and that is a deliberate, tested property of the install.

---

## Not now

Deliberately out of scope: realtime collaboration, a complex visual editor, an
in-house comment system, a large dashboard, a marketplace, SaaS, billing,
sophisticated observability, many new agent types, and covering every possible
vendor. Prove the core first.

---

## Landed

| id | item | where | when |
| --- | --- | --- | --- |
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

Owner decisions, 2026-09-21. Recorded here because each one closed a real
conflict between the stated direction and the repository, and a decision without
its reason gets relitigated.

**D1 — "Campaigns in progress" means the running campaign, not the parked runs.**
The eight parked runs of earlier campaigns are historical record, not a backlog;
nothing is resumed on their account. `RM-001` is dropped.

**D2 — Sandboxing stays at P6, after autonomy.** The level sketch is not a design
and will be argued when the work starts. The risk is recorded rather than
mitigated: today a worker runs arbitrary commands with the operator's own
credentials.

**D3 — Intent evals and judge calibration are built in parallel.** The cost is
accepted and named: until the canary reports, an intent eval's confidence figure
is exploratory signal, not assurance.

**D4 — The North Star is intent → verified outcome.** "Validated work without
human intervention" was rejected because, optimised literally, it erodes the
human judgment P7 exists to protect.

**D5 — The brief renders with `mdhtml`, themed from Faberun's own design
system.** `DESIGN.md` is the source of truth for the identity and already
specifies the palette, the glyphs and the documentation rules, so the theme is
derived from it rather than invented. No third-party or employer design system
is used here, for the reason the repository already states: nothing from a
private or employer repository lands in this one.

**D6 — Cross-harness memory goes last, and must prove itself against a
baseline.** The value is not in doubt — learning sovereignty across harnesses and
token economy, without reimplementing what already exists. The sequencing is the
point: stabilise faberun first and measure it well enough that it demonstrates
its own worth unaided, so there is a baseline. Only then adopt the memory layer,
and quantify it with a before/after paired benchmark. A layer adopted before the
baseline exists can never be shown to have helped.

## Open questions for the owner

Still open. Each changes what gets built, so none is decided here.

**Q2 — Two artefacts are both called a brief.** `operator-brief.md` exists and is
a continuity capsule: 4 KiB, no model, rebuilt from the journal, for a fresh
seat taking over a *running* campaign. The Campaign Brief in P1 is a
*pre-execution* approval surface, richer, and probably model-written. Rename one,
or make the approval surface a different artefact entirely? *Recommendation: two
names for two artefacts — merging them would spoil the continuity capsule, which
is deliberately small and model-free so it can be rebuilt after the seat that
would have written it died.*

**Q6 — When may empirical routing decide on its own?** The proposed floor is
deliberately conservative (≥60 nodes, ≥5 campaigns, 60 days, pass@1 ≥95%). A
lower floor starts saving sooner and risks learning from noise. Where is the
line?
