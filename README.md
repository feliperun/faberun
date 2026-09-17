<p align="center"><img src="assets/faberun-icon.png" width="160" alt="The hornero on its clay nest, the Faberun mark"></p>

<h1 align="center">faberun</h1>

<p align="center"><strong>From intent to running software.</strong></p>

<p align="center">Graph engineering for coding agents.</p>

<p align="center">
  <a href="https://github.com/feliperun/faberun/actions/workflows/ci.yml"><img src="https://github.com/feliperun/faberun/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/feliperun/faberun/releases/latest"><img src="https://img.shields.io/github/v/release/feliperun/faberun" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/faberun"><img src="https://img.shields.io/npm/v/faberun" alt="npm version"></a>
</p>

Faberun is a graph-engineering runtime for building software with coding agents.
It sits above the models and the harnesses and turns an implementation plan into
a durable graph of tasks, dependencies, workers, proofs, reviews, retries and
integration gates.

Harnesses are execution environments: Claude Code, Codex, the Gemini, DeepSeek
and GLM shells, and a generic `exec-jsonl` door for whatever comes next. Models
are the engines inside them. Faberun owns the graph, the state and the
definition of done around both.

The goal is not to make a group of agents talk to each other. It is to use the
right model for each kind of work, keep the process independent of any single
model or harness, and require evidence before software counts as done.

## Why Faberun

Coding agents are already very good at changing repositories. The remaining
problem is everything around that execution.

A frontier model earns its cost when it reasons about architecture, challenges a
design, writes a specification or reviews a difficult decision. The same model
is usually unnecessary for a small, well-defined implementation task a much
cheaper one performs well. Without an orchestration layer, though, the model
driving the current session becomes the model doing everything.

Faberun separates those concerns. One campaign can use a frontier model to
reason about the problem and author a plan, a second strong model to attack that
plan, lower-cost models to execute well-defined implementation nodes, a model
from another vendor to judge the work that genuinely needs judgment, and plain
deterministic commands wherever no model is needed at all. The expensive
intelligence goes where it matters, and the rest becomes an execution problem.

It also takes the campaign out of the lifetime of one chat. The work has durable
state on disk, so Claude Code can start a campaign and Codex, DeepSeek, GLM or
any other adapted harness can continue it later without reconstructing the
process from a conversation history.

## Graph engineering

Faberun treats development as an executable graph rather than a long
conversation.

```text
intent
  └─ campaign
       └─ contract
            ├─ node A ── proof ── review ──┐
            ├─ node B ── proof ── review ──┼── integration ── promotion
            └─ node C ── proof ── review ──┘
```

A campaign carries the durable intent. A contract turns part of that intent into
a schema-versioned DAG. Each node carries a closed packet: what the worker may
read, what it may change, what done means, and how that claim has to be proven.
The graph decides what can run, what must wait, what may retry, what needs a
human and what is allowed to advance. The models are replaceable participants
inside it. The graph remains.

## What is different

### Use the right model for the job

A runtime is one harness running one model. Workers, judges and planning
sessions need not share a provider or a capability tier, so high-cost reasoning
and low-cost execution live in the same campaign instead of one model owning the
whole process. Changing providers is a routing decision, not a rewrite of the
workflow.

### Proof before opinion

A worker saying "done" is not evidence that it is. Every definition-of-done item
declares how it can be proven: a command that must succeed, a path that must
exist, or — only when the criterion cannot be mechanised — the judgment of a
judge. Mechanical verification always runs first, and a node whose proofs are
all mechanical settles without spending a token on review. A gate may also
declare `skipWhen`, so a change that is green and small enough skips the judge
by policy rather than by accident.

### Independent review

When judgment is required, the worker does not grade itself. Validation refuses
a gated node whose worker and judge resolve to the same vendor. The judge reads
the recorded result and its evidence, never the reasoning that produced it, and
never re-runs the work. The point is not to make two agents agree; it is to keep
implementation and acceptance as separate responsibilities.

### Isolated execution

Each attempt runs in its own git worktree, so independent nodes run at the same
time without sharing a mutable working tree, and accepted work reaches the
repository through controlled refs instead of being copied into the operator's
checkout. The operator keeps working while the campaign runs.

### Durable campaigns

A run is not tied to the terminal that launched it. The controller runs
detached, state is persisted under `.runs/`, `supervise` resumes a controller
that died, and a campaign carries its intent across many runs and sessions. If a
provider goes down or a harness session ends, the work does not have to be
re-authored.

### Safe integration

Passing a worker's own checks is not the end of the process. An accepted attempt
is sealed, integrated onto the run ref and verified again in the candidate
state, and the phase-terminal node runs the contract's final verification. If
combining individually valid changes breaks the system, the campaign does not
promote them.

### Measurable model economics

Every invocation records its usage, routing and outcome, and a closed campaign
keeps that ledger in its own record under `docs/campaigns/<id>/ledger/`. It makes
questions like these measurable instead of anecdotal: which model handles this
class of task reliably, where a frontier model is actually worth its price,
which nodes close mechanically with no judge at all, how many revisions a worker
needs before acceptance, what one closed checkpoint costs, and how often a
fallback saves a campaign. The objective is not to spend less. It is to know
where expensive intelligence creates value.

## Campaigns, not synthetic teams

Faberun does not model an agent process as a human organisation. It needs no "AI
architect", "AI developer", "AI QA engineer" and "AI product manager" merely
because human teams carry those titles: models are general enough that those
boundaries are mostly artificial. The roles it does define are the ones that
stay useful for agents.

| role | responsibility |
| --- | --- |
| worker | produces a result inside its packet. |
| judge | decides independently whether a result that needs judgment satisfies its contract. |
| controller | advances the graph deterministically. |
| operator | supplies the intent and intervenes when a decision genuinely needs a human. |

Everything else belongs in the contract.

## From spec to contract

Planning is part of the product, and it is adversarial on purpose. `faberun spec
validate` checks a specification's front matter, its `R<n>` requirements and the
proof each one declares, and invokes no model to do it. `faberun plan` then runs
the debate in budgeted, isolated runs: an author drafts, a reviewer from another
vendor attacks the draft holding only the spec, the repository facts and the
plan under review, and a revision round follows while a critical finding
remains. A converged draft is sized, routed and frozen into a contract. Freezing
never launches, and a plan that never converges ends `contested`, with its open
findings recorded as a campaign question instead of a contract.

None of it is mandatory. The traceability rules are advisory unless you ask for
`--strict-traceability`, a document with no front matter validates as `legacy`
rather than being rejected, and you can skip planning altogether and author the
contract by hand. What Faberun needs is the executable part of the plan:
objective, nodes, dependencies, read and write scope, definitions of done,
verification, runtime policy and integration behaviour. Your specification
process stays yours.

## Install

The installer resolves the newest release, checks the requirements and runs
`faberun setup`:

```bash
curl -fsSL https://raw.githubusercontent.com/feliperun/faberun/main/install.sh | sh
```

`faberun setup` runs at the end of the installer and registers the `faberun`
skill for the harnesses it finds (Claude Code, Codex and the shared
`~/.agents/skills`, plus any measured convention); `faberun skills register`
redoes it.

It needs Node 22 or newer, git, and one harness CLI on `PATH`. The npm and
source installs need Node and git alone.

From the npm registry:

```bash
npm install -g faberun
```

Or run the package without installing it:

```bash
npx faberun --help
```

From a checkout, as a contributor:

```bash
git clone https://github.com/feliperun/faberun.git
cd faberun
node src/cli.mjs --help
```

An installed copy updates itself from the newest GitHub release:

```bash
faberun update
```

## Quickstart

The full walkthrough, from a fresh machine to a first verified node, is in
[Getting started](docs/GETTING-STARTED.md).

| Step | Command | What it does |
| --- | --- | --- |
| 1 | `faberun setup` | Onboards the machine: checks node and git, discovers the harnesses, and writes the default worker and judge. |
| 2 | `faberun init` | Prepares a repository: confirms a git work tree, ignores `.runs/`, and installs the `faberun` skill. |
| 3 | `faberun campaign init <id> --goal "..."` | Opens the durable campaign that carries the intent across runs. |
| 4 | write a contract | Fixes `contract.json`: the node DAG, each packet's read and write scope, and each definition of done. |
| 5 | `faberun validate contract.json` | Parses the contract and prints the report the authoring turn reads. |
| 6 | `faberun preflight contract.json` | Checks the host, the runtime binaries and their credentials without dispatching a worker. |
| 7 | `faberun run --detach contract.json` | Starts the run in its own process and returns with the run directory. |
| 8 | `faberun status <run-dir>` / `faberun next` | Renders one run, or names the most urgent action across the active campaigns. |
| 9 | `faberun supervise --detach <run-dir>` | Watches the run and resumes it when the controller dies. |

## How it works

The operator writes the intent into a campaign and an authored contract, a
schema-versioned DAG whose nodes each carry a closed task packet. The controller
schedules every dependency-ready node and dispatches its packet to a worker
inside an attempt worktree, where the worker sees only the files the packet
names. Faberun then judges the result in stages, and a free slot dispatches the
next node while another one is still being verified.

```text
packet
  └─ worker attempt in its own worktree
       └─ mechanical proof ── failure ─→ retry · route · attention
            └─ judge, when required ── rejection ─→ revision
                 └─ seal ─→ integration ref ─→ candidate verification
                      └─ promotion onto the campaign's landing branch
```

A judge reviews recorded evidence rather than re-running arbitrary work. A
passing attempt is sealed and integrated onto the run ref, a campaign promotes
each finished run onto its landing branch, and the orchestrator lands that
branch. Campaigns, handoffs and the `supervise` watchdog carry the work across
sessions, so an interrupted run is continued in place instead of being
re-authored.

The vocabulary is in [Concepts](docs/CONCEPTS.md), and the layers, process model
and gates are in [Architecture](docs/ARCHITECTURE.md).

## Harnesses and models

Faberun keeps three things apart. A **model** is the reasoning engine, a
**harness** is the environment that gives a model access to code and tools, and
a **runtime** is one configured harness-and-model pair Faberun can dispatch. Any
runtime can act as a worker or as a judge, according to the contract and the
routing policy.

| Harness | Default vendor | Example model |
| --- | --- | --- |
| `claude` | Anthropic | `claude-sonnet` |
| `codex` | OpenAI | `codex-gpt` |
| `agy` | Google | `agy-gemini` |
| `dsh` | declared per runtime; DeepSeek in the discovery entry | `dsh-deepseek` |
| `zcode` | Zhipu | `zcode-glm` |
| `exec-jsonl` | declared per runtime | the model its command names |
| `replay` | declared per runtime | the recorded model |

Harness and model support are adapter concerns. The orchestration above them
depends on no single vendor.

## Philosophy

Software should be built, not merely generated. Generating plausible code is
becoming cheap; the valuable part is the system around the generation —
preserving intent, decomposing work, choosing the appropriate intelligence,
isolating effects, proving outcomes, recovering from failure, and recording why a
change was accepted. A craftsman does not depend on one hammer, and Faberun does
not depend on one model. Models change, harnesses change, providers change. The
intent, the graph, the evidence and the finished work remain.

## Documentation

- [Documentation map](docs/README.md): every document and the question it answers.
- [Vision](docs/VISION.md): why Faberun exists and what it refuses to become.
- [Concepts](docs/CONCEPTS.md): each term, where it lives, and its invariant.
- [Getting started](docs/GETTING-STARTED.md): install to a first verified node.
- [Commands](docs/COMMANDS.md): every verb's synopsis, flags, exit codes and one example.
- [Architecture](docs/ARCHITECTURE.md): the layers, the process model and the quality gates.
- [Decisions](docs/adr/README.md): the active ADRs and the format they use.
- [Design system](DESIGN.md): the identity, the palette and the documentation grammar.
- [History](docs/history/README.md): the dated records and the path mapping from before the move.
- [Agent playbook](AGENTS.md): the contributor and agent rules for this repository.

## Development

- `npm run check` runs `node --check` over every `.mjs` under `bin/`, `src/`,
  `test/`, `evals/` and `.claude/hooks/`.
- `npm run typecheck` runs `tsc` over the whole tree in `checkJs` mode and must
  be clean.
- `npm test` runs the test suite.
- `node evals/run.mjs --class deterministic --assert-no-model` runs every
  deterministic case with zero model calls.
- `node evals/run.mjs --class deterministic --verify-discriminating` requires
  each case's declared mutation to make the case fail.

[AGENTS.md](AGENTS.md) is the playbook. The skills shipped in `skills/` are
[faberun](skills/faberun/SKILL.md), for orchestrating agents, and
[init-agentkit](skills/init-agentkit/SKILL.md), an optional kit that bootstraps
`AGENTS.md`, `docs/`, ADRs and githooks into another repository. Install either
into a repository with:

```bash
faberun skills install faberun
faberun skills install init-agentkit
```

`faberun skills install` copies a skill into a repository; `faberun skills
register` links the `faberun` skill into every installed harness's own skills
directory instead, so the harness has it in every repository.

Never run `npm install` inside an attempt worktree: husky's `prepare` script
dirties the ignore snapshot the controller compares against.

## History

Faberun began as an internal orchestration tool under an earlier name, and this
repository began as a personal library of agent skills. Neither record is
rewritten: the dated history is under `docs/history/`, and the campaign specs
and journals are under `docs/campaigns/`. The
[documentation map](docs/README.md) and the
[history index](docs/history/README.md) point to both.

## Licence

[MIT](LICENSE).
