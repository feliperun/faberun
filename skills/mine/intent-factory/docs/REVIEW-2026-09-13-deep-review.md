# Deep review, 2026-09-13

A review of the whole skill, by reading it and by running it. Four campaigns
against a purpose-built target repository exercised every harness as worker and
as judge, the four failure paths, parallel dispatch, five-branch integration,
and a controller killed mid-run. Eight defects were found, each reproduced
before being changed and each pinned by a test that fails without the fix.

The second half is the part that matters more: what this product still needs to
be the best orchestrator of its kind.

## Method

- Full read of `src/`, weighted toward `engine/`, `harnesses/`, `repo/` and
  `host/`, with four adversarial probes run against real artefacts: the HTTP
  surface (server started, curled, injection attempted), the write-scope hook
  (invoked as a process, escapes attempted against the real provider), the git
  layer (throwaway repositories, every edge reproduced), and the campaign
  layers.
- Baseline before touching anything: 646 tests green, typecheck clean, evals
  17/17 passing and 17/17 discriminating, 27 golden tasks validated.
- Four live campaigns, 13 nodes, real models throughout. No fixture stood in
  for a provider anywhere in them.

| Campaign | Shape | Outcome |
| --- | --- | --- |
| C1 multi-harness | 6 nodes, `maxParallel` 5, one worker per harness, judges crossed | 6/6 done, five branches integrated, `finalVerification` green |
| C2 failure paths | 4 nodes: missing context, contradictory spec, blocked dependant, autonomous scope | all four behaved as documented |
| C3 judge cost | 2 unordered same-phase nodes, codex judge on both | 2/2 done, one judge invocation each |
| C4 supervisor | 1 node, controller SIGKILLed mid-judge | relaunched and finished with nobody watching |

Worth recording from C2: given a spec asserting `clamp(10, 0, 10) === 10` and
`=== 9` in the same test, the GLM worker implemented the honest clamp, ran the
verification, identified the exact contradicting lines, and returned
`blocked_context` with a precise question rather than a stateful hack. The
closed-packet protocol earns its keep.

## What was found

Every row was reproduced first. The measurement is what the tree recorded, not
an estimate.

| Defect | Measured | Fix |
| --- | --- | --- |
| A codex judge narrates its plan through the enforced output schema, so the preamble is verdict-shaped and counted as a second verdict | 17 of 22 codex judge rounds in this repository's history (77%) spent a bounded re-ask on it; every codex round of C1 paid two invocations | Count candidates only after the judge's last action. Replayed over all 88 recorded codex judge logs: 43 rounds stop paying, the 2 genuine double-verdicts stay caught |
| The `RUNTIME` column named the judge | A six-node campaign whose workers were five different harnesses rendered as though three never ran | Derive the label from the invocation ledger; `status --json` gains `workerRuntime` |
| Validation refused two same-phase nodes with no edge between them | `maxParallel > 1` unusable for its own motivating case; the workaround, a phase per node, silently disables phase continuation | Refuse the real hazard instead: a continuation a live invocation already claims is not offered to a second node |
| A declared `writeRoot` that is a symlink escapes the workspace | Reproduced end to end against Claude Code, which does not catch it either: its own refusal lstats the exact target, and a symlinked intermediate directory never trips it | Resolve targets through the filesystem; refuse what does not land inside |
| Sealing an attempt ran the target repository's commit hooks | A plain failing `.git/hooks/pre-commit` failed every seal, and since the message never varies, every node of every run failed identically with no way out | Seal with `--no-verify`, the same argument as the identity and signing overrides |
| `findings` answered only gate exhaustion | Three of four C2 nodes were blocked with a precise question and the command printed one line saying there was nothing to act on | Render a blocked node's own question and the paths it asked for |
| `supervise` did not exist | Advertised in the README's feature paragraph, quickstart and command table, and written into every target repository's `AGENTS.md` by the factory itself | Implemented; proved against a SIGKILLed controller |
| One retry spent two attempt numbers | A node that ran twice reported attempt 3, no logs under attempt 2, `worktree.previousAttempt` naming an attempt that never existed | The dispatching path owns the increment |

Smaller ones fixed alongside: the dashboard token compared with `===` rather
than `timingSafeEqual`; two write routes handed an unknown campaign id to the
CLI, whose refusal quoted the server's absolute directory layout; a declared
write root with a trailing slash denied every write under it; NFC and NFD
spellings of one filename did not match; `node_modules` was excluded from the
snapshot only as a root segment, so one per-package install in a monorepo
became thousands of unexpected writes; and `references/contract.md` promised a
`priced` cost provenance nothing has ever produced.

Two gates were added so these classes cannot return silently: every command the
README advertises must exist in the CLI and every command the CLI dispatches
must appear in its usage string, and the tool list offered to workers must stay
covered by the write-scope map.

## What the review says about the product

Three of the eight defects were invisible to 660 unit tests and appeared within
minutes of running the thing for real. Two more were pure documentation drift,
including a command the factory instructs future agents to use. That is the
shape of the gap: the mechanics are unusually well proven, and the product as
experienced by an operator is not proven at all.

The strengths are real and worth protecting. The operations ledger, the
discriminating eval requirement, comments that carry measurements, the
structural gates in `test/repo/source-shape.test.mjs`, the integration
transaction replayed from its own journal: this is a more rigorous codebase
than most funded products. The adapter layer genuinely spans five provider CLIs,
which today's campaigns demonstrated rather than asserted.

## What I would build next

Ranked by what each buys.

### 1. A live eval class

`evals/run.mjs` accepts exactly one class, `deterministic`, and every runtime in
it is `replay`. That is the right default and it is not enough: everything found
today by running the factory was invisible to it.

Add `--class live`: a fixture target repository, one small contract per harness
in both roles, opt-in and never in CI, run before a release. It costs a few
cents and answers the question no replay can: does this still work against the
CLIs as they shipped this week? Provider CLIs move under this project
constantly, and nothing currently notices a flag change until a campaign
fails.

### 2. Answer a blocking question without re-authoring

`blocked_context` is the most common non-`done` terminal state in this
repository's history, and it is a dead end: the worker names exactly what it
needs, and the operator's only route forward is a new run id and a re-authored
contract. The information is already structured.

`resume --answer <node-id>=<path>` should append the answer to the node's
context, extend the packet's `readFiles` with the paths the worker asked for,
and re-dispatch that node alone. This turns the most frequent stop from twenty
minutes of contract authoring into one command. It is the single largest
operator time sink in the system.

### 3. Cost from a price table

Four of five vendors report no cost. `costPerClosedCheckpoint` divides by the
subset that reported, so every economic comparison silently over-weights the one
provider that answers, and the campaign that concluded "the Claude worker cost
twelve times the cheap worker" was reading a number only Claude contributed to.

The catalogue already carries per-model facts including context windows. Add
input, cached-input and output prices, compute cost when the harness reports
none, and tag it `priced`, the provenance the documentation already described
and the code never produced. Then routing decisions rest on measurement rather
than on which vendor happens to be talkative.

### 4. Routing that reads its own evidence

`metrics` already computes `blockingJudgeFirstPassRate` per runtime, and nothing
consumes it. Routing is a static declaration plus a tier ordering, so the
factory relearns nothing across campaigns.

Feed the campaign's own indicators back into `composeAssignments`: a runtime
that has failed first pass on this repository's last several nodes is demoted
for the next one, and a judge whose verdicts are consistently overturned on
re-ask loses the role. Persist the adjustment in the campaign, never in the
contract, so a run stays reproducible from its own record. This is the
compounding advantage no competitor with a single model can copy, and it is
already three quarters built: the measurements exist and are unread.

### 5. Run the golden set

Twenty-seven golden tasks were mined from this repository's own history, each
with the statement a worker was actually given and the verification its commit
declared. Nothing executes them. `verify.json` is, in the module's own words,
"schema-checked and never executed".

A `golden run --sample <n>` that restores each task's parent commit, dispatches
the real statement through current routing, and scores pass rate, cost and wall
clock, gives the project the one thing it lacks: a quality regression measure.
Today a change can be proven not to break the mechanics and cannot be shown to
make the factory better at writing software. That is the difference between a
well-engineered harness and a product that improves.

### 6. A real sandbox

The write-scope hook prevents `Write`, `Edit` and `NotebookEdit` outside the
declared scope, on Claude only. `Bash` is unenforced by design, and the four
other harnesses have no prevention at all: `engine/scope.mjs` detects after the
fact, and the module's own header says an unexpected write is advisory. A worker
that cleans up after itself leaves the final diff clean.

The honest short-term move is to say this plainly wherever the packet's
`writeFiles` is described, because "closed scope" reads stronger than what it
delivers. The right long-term move is a filesystem boundary that does not
depend on the provider's cooperation: run each attempt in a container or a
sandbox profile whose mount is the worktree. The worktree isolation is already
there; only the enforcement is missing.

### 7. Authoring help

Two contracts in this review were refused before a single token was spent, and
neither refusal was wrong exactly. `readFiles` must exist at validation time,
which forbids naming the file a dependency node is about to create; the
workaround loses the closed-context listing that made the packet worth writing.
And the scope-closure detector exists because one author repeated the same class
of error three times across recorded campaigns.

Two concrete steps. Accept a `readFiles` entry that a transitive dependency
declares in `writeFiles`, which is statically knowable from the contract alone.
And extend `contract validate` with an `--explain` that names the fix rather
than the violation, since the violations are already precise enough to repair
mechanically.

### 8. One command that says what to do

Finding the next action today means `campaign list`, then `status`, then
`findings`, across however many campaigns are open. The dashboard has a "Needs
you" section and the CLI has the same information scattered across three verbs.

A single `next [--cwd <dir>]` that scans every campaign and prints the one
action, with the command to run, would make the operator seat worth sitting in.

### Deliberately not changed

- **The stale attempt branch trap.** Reusing a run id whose branches survive
  from a torn-down run checks out unrelated history while reporting the current
  run ref as its base. It needs an abnormal precondition (a run ref deleted
  externally), but the loaded gun is real: nothing in this tree ever deletes an
  attempt branch. It wants a branch lifecycle, not a patch.
- **Bash write enforcement.** Static command sniffing is a race, and the header
  saying so is right. It belongs in the sandbox work above.
- **A price table.** Prices change and inventing them is worse than reporting
  `unknown`. The documentation was corrected to match the code instead.
