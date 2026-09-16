<p align="center"><img src="assets/faberun-icon.png" width="160" alt="The hornero on its clay nest, the Faberun mark"></p>

<h1 align="center">faberun</h1>

<p align="center">From intent to running software.</p>

<p align="center">
  <a href="https://github.com/feliperun/faberun/actions/workflows/ci.yml"><img src="https://github.com/feliperun/faberun/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/feliperun/faberun/releases/latest"><img src="https://img.shields.io/github/v/release/feliperun/faberun" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/faberun"><img src="https://img.shields.io/npm/v/faberun" alt="npm version"></a>
</p>

Faberun is a development orchestration system that turns intent into verified
software. It manages the process around software creation: plans, tasks,
dependencies, execution, validation, evidence, retries and progress toward a
defined outcome. It is not another coding agent, and it does not generate code
without a definition of done.

Faberun is model- and harness-agnostic. Claude Code, Codex, OpenCode and
whatever comes next are workers; Claude, GPT, Gemini, DeepSeek, GLM and other
models are engines; Faberun sits above them. It keeps the intent, coordinates
the work, tracks what was actually completed, validates the result and decides
what should happen next.

Software should be built, not merely generated. A craftsman does not depend on
one hammer, so Faberun does not depend on one model or one agent: tools,
models and harnesses can change, and the work remains.

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
names. The controller then runs the deterministic verification once, and a
judge from a different vendor reviews the recorded result without re-running it.
A passing attempt is sealed and integrated onto the run ref, a campaign promotes
each run onto its landing branch, and the orchestrator lands that branch.
Campaigns, handoffs and the `supervise` watchdog carry the work across sessions,
so an interrupted run is continued in place instead of being re-authored.

```text
intent
  └─ contract: validate · preflight
       └─ controller
            ├─ worker attempt in an attempt worktree
            │     └─ deterministic verification · cross-vendor judge
            └─ integration ref · promotion · landing branch
```

The vocabulary is in [Concepts](docs/CONCEPTS.md), and the layers, process
model and gates are in [Architecture](docs/ARCHITECTURE.md).

## Harnesses

A runtime is one harness running one model. Any runtime can be a worker, and a
judge of another vendor reviews what it produced.

| Harness | Default vendor | Example model |
| --- | --- | --- |
| `claude` | Anthropic | `claude-sonnet` |
| `codex` | OpenAI | `codex-gpt` |
| `agy` | Google | `agy-gemini` |
| `dsh` | declared per runtime; DeepSeek in the discovery entry | `dsh-deepseek` |
| `zcode` | Zhipu | `zcode-glm` |
| `exec-jsonl` | declared per runtime | the model its command names |
| `replay` | declared per runtime | the recorded model |

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
