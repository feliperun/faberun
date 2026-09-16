# Getting Started

From a fresh machine to a first campaign: install `faberun`, onboard the
machine, prepare a repository, and run one node to a verified result.

## Prerequisites

- **Node.js 22 or newer.** `package.json#engines` requires `>=22`; check with
  `node --version`.
- **git.** A target repository must be a git work tree, and `faberun init`
  refuses one that is not.
- **At least one harness CLI, authenticated.** A *harness* is the program that
  runs a turn; a *model* is what the harness asks; a *vendor* is who answers.
  `faberun setup` enables the harnesses it finds and refuses a judge that shares
  the worker's vendor.
- **`curl`, `tar` and a POSIX `sh`** for the installer only. The npm and source
  installs need Node and git alone.

| Harness | Binary | Vendor | Credential |
| --- | --- | --- | --- |
| `claude` | `claude` | Anthropic | the CLI's own sign-in (`claude`); `ANTHROPIC_API_KEY` when the CLI is configured with one |
| `codex` | `codex` | OpenAI | the CLI's own sign-in (`codex`); `OPENAI_API_KEY` when the CLI is configured with one |
| `agy` | `agy` | Google | the CLI's own sign-in (`agy`) |
| `dsh` | `dsh` | declared per runtime (the discovery entry uses `deepseek`) | `DEEPSEEK_API_KEY` in the environment |
| `zcode` | `zcode` | Zhipu | `ZAI_API_KEY` in the environment |

`faberun setup` prints the exact environment variable a runtime is missing
(`set DEEPSEEK_API_KEY`). `faberun models` prints each harness's executable,
vendor, effort flag and the model ids it accepts; `faberun models --probe` adds
per-runtime reachability; `faberun doctor --discover --json` is the live
availability report. The adapter names, matching rules and judge constraints
live in the [contract reference](../skills/faberun/references/contract.md).

## Install

### Installer script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/feliperun/faberun/main/install.sh | sh
```

`install.sh` is POSIX `sh` and idempotent. It checks Node 22+, `tar` and `curl`,
resolves the newest GitHub release (falling back to `main` while no release
exists), extracts the release under `$FABERUN_HOME/versions/<version>/`, points
`$FABERUN_HOME/current` at it, links `$FABERUN_BIN_DIR/faberun`, verifies the
new binary with `--version`, warns when the bin directory is not on `PATH`, and
runs `faberun setup` on an interactive terminal. A re-run refreshes the
requested version exactly as `faberun update` would.

| Variable | Meaning |
| --- | --- |
| `FABERUN_HOME` | install root; default `~/.faberun` |
| `FABERUN_BIN_DIR` | where the `faberun` symlink goes; default `~/.local/bin` |
| `FABERUN_VERSION` | install this tag instead of the newest release |
| `FABERUN_INSTALL_SOURCE` | a local tarball or directory instead of the network |
| `FABERUN_NO_SETUP` | non-empty skips the final `faberun setup` |

### npm

```bash
npm install -g faberun
```

The package is `faberun` on the npm registry and its versions follow the GitHub
releases. `npx faberun` runs the same package without a global install:

```bash
npx faberun --help
```

### From source

```bash
git clone https://github.com/feliperun/faberun.git
cd faberun
node src/cli.mjs --help
```

`bin/faberun.mjs` is the entry point. The runtime is plain ESM `.mjs` with no
runtime dependencies, so the checkout needs no install step; TypeScript is a
development-only check.

## Set up the machine

```bash
faberun setup
```

On a terminal it prints the banner, checks node and git, lists every discovery
runtime with its availability, and asks three questions, one per line:

```text
Enable which harnesses? [agy, codex, claude] 
Default worker runtime? [agy-gemini] 
Default judge runtime? [codex-gpt] 
```

- An empty answer keeps the shown default: every available harness, the
  cheapest available runtime as worker, the strongest available runtime of a
  different vendor as judge. When `$FABERUN_HOME/config.json` already exists,
  the shown defaults are its recorded harnesses, worker and judge instead,
  narrowed to whatever discovery still reports available; a recorded choice
  discovery cannot find is dropped rather than kept.
- A judge that resolves to the worker's vendor is refused once and fails on the
  second answer.

`setup` writes `$FABERUN_HOME/config.json` (schema version, enabled harnesses,
default worker and judge), then asks one more question: whether to register the
`faberun` skill for every harness it found, with yes as the default. A yes
writes a `faberun` link into each discovered skills directory: `~/.claude/skills`
for Claude Code, `~/.codex/skills` for Codex, and the shared `~/.agents/skills`
or another measured convention. It then prints the next commands.
Non-interactive: `--yes` takes the defaults including registration, `--no-skill`
skips it, `--harnesses a,b`, `--worker <id>` and `--judge <id>` set values
directly, and `--json` reports the same facts as one object without asking. Run
`faberun doctor` afterwards to re-check the host and the enabled runtimes.

### Registering the skill later

`faberun setup` registers once; redo or repair it with:

```bash
faberun skills register
faberun skills register --harness claude,codex
```

`--harness` limits the run to the named harnesses and `--copy` writes a real
tree instead of a symlink, for a harness that does not follow links. To undo the
registration, remove the `faberun` entry from each listed skills directory
(`~/.claude/skills/faberun`, `~/.codex/skills/faberun`, or the shared
`~/.agents/skills/faberun`).

## Prepare a repository

In the repository that will receive the work:

```bash
cd /path/to/target-repository
faberun init
```

`faberun init`:

- refuses a directory that is not a git work tree;
- adds `.runs/` to `.gitignore` unless an equivalent line is already there;
- installs the `faberun` skill into `.claude/skills/faberun/` (skip with
  `--no-skill`);
- offers the agent kit (`AGENTS.md`, `docs/`, ADRs) and always asks its
  compatibility rule, `greenfield` (break freely) or `stable` (preserve
  published contracts). `--agentkit` installs it without asking;
  `--greenfield`/`--stable` answer the rule by flag.

```text
[ok] .runs ignored · /path/to/target-repository/.gitignore
installed faberun · /path/to/target-repository/.claude/skills
1 installed · 0 skipped
next · faberun doctor --cwd /path/to/target-repository · faberun campaign init <id> --cwd /path/to/target-repository --goal "..."
```

`--cwd <dir>` targets another directory and `--json` reports
`{cwd, runsIgnored, skillInstalled, agentkit}`.

## Your first campaign

A *campaign* is the durable layer above runs: it carries the intent, links the
runs that serve it, and records what happened. A *contract* is one phase of
work: a DAG of nodes, each with a closed task packet and a definition of done.
The walkthrough below runs one node.

**1. Open the campaign** from the target repository:

```bash
cd /path/to/target-repository
faberun campaign init hello --cwd . --goal "Create hello.txt with the greeting"
```

```text
[campaign] hello initialized · .runs/campaigns/hello · landBranch campaign/hello · 0 contract(s)
```

**2. Write the contract.** A complete, minimal one-node contract; save it as
`contract.json` at the repository root. It omits `runtimes` and
`runtimeDefaults`, so the controller composes them from discovery — the
cheapest available runtime works, the strongest available runtime of a
different vendor judges. Add a `runtimes` map and `runtimeDefaults` to pin a
specific harness pair.

```json
{
  "schemaVersion": 3,
  "contractVersion": "0.3.0",
  "id": "hello",
  "campaignId": "hello",
  "goal": "Create hello.txt with the greeting",
  "cwd": ".",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 600,
  "nodes": [
    {
      "id": "write-hello",
      "type": "task",
      "phase": "implementation",
      "dependsOn": [],
      "timeoutSec": 600,
      "taskPacket": {
        "mode": "execution",
        "objective": "Create hello.txt containing one line: hello",
        "instructions": [
          "Write hello.txt with exactly one line: hello",
          "Do not modify any other file"
        ],
        "readFiles": ["README.md"],
        "writeFiles": ["hello.txt"],
        "symbols": [],
        "decisions": ["The file is named hello.txt"],
        "nonGoals": ["No other file changes"],
        "verification": [{ "argv": ["grep", "-q", "^hello$", "hello.txt"] }]
      },
      "definitionOfDone": [
        { "id": "file-exists", "text": "hello.txt exists",
          "proof": { "kind": "path", "ref": "hello.txt" } },
        { "id": "greeting-exact", "text": "hello.txt contains hello on its own line",
          "proof": { "kind": "verification", "ref": 0 } },
        { "id": "objective-met", "text": "The change honors the objective",
          "judgment": true }
      ],
      "gate": { "failOn": ["major", "critical"], "maxRevisions": 1 }
    }
  ]
}
```

`readFiles` must exist at validation time, so name a file the repository
already has. Every definition-of-done item declares how it is proven: a `path`
must exist, a `verification` index reuses a recorded command result, `command`
re-runs its own command, and `judgment: true` hands the item to the
cross-vendor judge. The full schema is the
[contract reference](../skills/faberun/references/contract.md).

**3. Validate and preflight.** `validate` parses the contract; `preflight`
checks the host, the runtime binaries and their credentials without dispatching
a worker.

```bash
faberun validate contract.json
faberun preflight contract.json
```

```text
valid
[ok] git · git version 2.52.0 · HEAD a267d1e
[ok] runtime binaries · agy-gemini 1.2.3 · codex-gpt codex-cli 0.154.0
[ok] agy-gemini · agy · agy · gemini-3.8-flash-low · 1.2.3
[ok] codex-gpt · codex · codex · gpt-5.6 · codex-cli 0.154.0
```

**4. Commit the init changes.** `faberun init` edited `.gitignore` and added
`.claude/skills/faberun`; commit them before running, and keep the contract file
outside the tree or commit it too. `run` cuts every worktree from HEAD and
refuses to launch over uncommitted paths; `--base-ref <ref>` is the alternative
when the base is another ref.

```bash
git add -A && git commit -m "chore: prepare the repository for faberun"
```

**5. Run detached.** `run --detach` returns immediately with the run
directory; the controller keeps working in its own process group.

```bash
faberun run --detach contract.json
```

**6. Watch it.** `status` renders Needs you, Now, Nodes and Cost for one run;
`next` names the most urgent action across the active campaigns.

```bash
faberun status .runs/<run-id>
faberun next --cwd .
```

**7. Keep it finishing.** `supervise` resumes a run whose controller died,
without holding a lock. `supervise campaign hello` drives the whole campaign
chain instead.

```bash
faberun supervise --detach .runs/<run-id>
```

**8. Close the campaign.** A campaign refuses to close until a `retrospective`
note exists; that note is the record of what the campaign learned.

```bash
faberun campaign note hello --cwd . --session-id <session-id> --kind retrospective --text "First campaign complete"
faberun campaign close hello --cwd .
```

## Daily commands

For contributors to this repository:

```bash
npm run check        # node --check every .mjs under bin/, src/, test/, evals/ and .claude/hooks/
npm run typecheck    # tsc over the whole tree in checkJs mode; must be clean
npm test             # node --test over test/
node evals/run.mjs --class deterministic --assert-no-model
node evals/run.mjs --class deterministic --verify-discriminating
```

The two eval commands run every deterministic case with zero model calls
(`replay` stands in for the providers). `--assert-no-model` fails if a case
reaches for a real provider binary; `--verify-discriminating` requires each
case's declared mutation to make the case fail, so a case that proves nothing
is reported. See [evals/README.md](../evals/README.md).

Never run `npm install` inside an attempt worktree: husky's `prepare` script
dirties the ignore snapshot the controller compares against.

## Documentation map

- [VISION.md](VISION.md) — why Faberun exists.
- [CONCEPTS.md](CONCEPTS.md) — the vocabulary: intent, contract, campaign, run,
  node, packet, worker, judge, gate, harness, runtime, vendor, worktree,
  integration, promotion, seat, handoff, attention.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the layers, the `.runs/` layout, the
  process model, the quality gates, the security model.
- [COMMANDS.md](COMMANDS.md) — every verb and subcommand with signature, flags,
  exit codes and an example.
- [adr/README.md](adr/README.md) — the decisions that shape the code, and the
  format they are recorded in.
- [FIELD-OWNERSHIP.md](FIELD-OWNERSHIP.md) — who writes each field of the two
  append-only event records.
- [history/README.md](history/README.md) — dated records and the path mapping
  from before the move.
- [harnesses/zcode-cli.md](harnesses/zcode-cli.md) — the Z.ai Code harness.
- [AGENTS.md](../AGENTS.md) — the canonical contributor and agent playbook.

## First contribution checklist

- [ ] Read [AGENTS.md](../AGENTS.md), including the *Source tree rules* section.
- [ ] Check `.runs/` and the managed signal block at the bottom of `AGENTS.md`
  before starting: an active campaign or a non-terminal run is work to continue,
  not to redo.
- [ ] Run `npm run check`, `npm run typecheck` and `npm test`, and confirm green
  before and after the change.
- [ ] Keep a change inside one layer; `test/repo/source-shape.test.mjs` enforces
  the module limits, the import graph and the naming rules.
- [ ] A structural change updates [ARCHITECTURE.md](ARCHITECTURE.md) in the same
  commit and adds or supersedes an [ADR](adr/README.md).
- [ ] Run the eval class your change touches; leave the full suite to the
  controller.
