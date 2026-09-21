# Planner-vs-session-authoring spike: the verdict

Run `state-location-and-routing-economics-plan-requirement-traceability-draft-1`,
launched 2026-09-19 against `PHASE-3-REQUIREMENT-TRACEABILITY.md` at `be260aa`.
Both attempts failed. The spike still answered its question, and the answer is
sharper than a success would have been.

**The planner's judgment is good. Its plumbing is broken.**

## What the drafter produced

GLM-5.3-Flash (attempt 1) drafted a three-node plan, one node per requirement,
chained in the order the identifier actually travels: frozen plan (R9) ->
contract and snapshot and sealed result (R10) -> campaign close (R11). Judged
against what this session would have authored by hand:

- **25 of 25 file paths it named exist.** Zero hallucinated paths, across
  `src/plan`, `src/contract`, `src/engine`, `src/campaign`, `src/run`, `docs/`
  and five test files. This is what the repo-facts relay is for, and it worked.
- **It applied a repository rule the spec never stated.** Both persisted-field
  nodes list `docs/FIELD-OWNERSHIP.md` and its enforcing test in `writeFiles`.
  The spec's Constraints section says only "validator and typedef in the same
  change"; naming the field registry as well is the rule this repository has
  paid for twice, and the drafter found it from repo facts, not from prose.
- **It caught a bootstrap paradox this session had not written down:** this
  phase's own plan cannot declare `requirementIds`, because the mechanism only
  exists once node 1 lands -- and R9's finding-not-refusal path is precisely
  what lets this plan freeze honestly. That is a better observation than the
  spec it was drafting from.
- It cited a measurement from repo facts (typecheck at 3.4s) when justifying
  verification scope, and kept every node's `verification` to two commands,
  respecting the 64 KiB packet guard without being told.

Two things this session would change, neither fatal:

- **Node 2 is oversized**: 12 `writeFiles` spanning three layers (`plan`,
  `contract`, `engine`). The sizing stage exists to split exactly this, and the
  draft runs before sizing, so this may be correct division of labour rather
  than a defect -- untested, because the plan never reached sizing.
- **Definition-of-done leans on `judgment: true`** (4-5 judgment items per node
  against 2 command proofs). Defensible for greenfield work, but thinner than
  this session's own standard.

## Why it never arrived: two independent, fatal defects

### A. No planning node can pass the engine's discovery protocol

`buildPlanningContract` gives all five planning kinds (`draft`, `revise`,
`review`, `spec-author`, `spec-review`) `mode: "discovery"`, and each delivers
through `output.plan` / `output.findings` / `output.spec`. But
`lifecycle.mjs:524` applies `parseDiscoveryResult` to *every* discovery node
that finishes `done`, and that function demands `artifacts.length === 1` with
`artifacts[0]` parsing as a valid **execution** task packet.

Proven by running the real validator against a well-formed draft result:

    zero artifacts     => REJECTED: discovery result must contain exactly one task packet artifact
    the plan as artifact => REJECTED: nodes[0].taskPacket has unexpected field nodes

A planning worker that follows its own instructions ("put the plan in
output.plan and nothing else in output") emits no artifact and is rejected. One
that attaches its plan -- what GLM did -- is rejected. The only accepted shape
is a dummy execution packet no planning prompt ever asks for. **The out-of-session
planner, the deliverable of the fourth campaign, cannot complete a single stage
through the engine.**

It reads green because `test/cli/plan.test.mjs` injects a
`PLACEHOLDER_EXECUTION_PACKET` whose own comment documents the mismatch as a
fact to work around: "regardless of what the planning pipeline itself reads
(`output`)". The test encoded the workaround instead of reporting the defect.
The gate itself predates the planner -- it came from the original
intent-factory runner (`dd0a251`) -- so this is a reconciliation that was never
done, not a regression.

Worth noting while fixing: nothing consumes `parseDiscoveryResult`'s return
value. Both call sites discard it; the `discoveryPacket` property it attaches
has no reader in the tree. The function is a pure gate that validates a packet
and throws it away.

### B. The repo-facts relay is invisible from the attempt worktree

`runPlanningPipeline` stages `repo-facts.json` at
`<cwd>/.faberun-plan/<campaign>/<phase>/`, gitignored on purpose
(`pipeline.mjs:59`), and declares it in every planning node's `readFiles`. Each
node then runs in a fresh `git worktree`, which carries no ignored or untracked
file. The planner's single most important grounding input never reaches the
worker.

Both providers hit it, and their responses are worth keeping:

- GLM diagnosed it unprompted -- "worktrees don't carry untracked files, and
  `.faberun-plan/` is untracked" -- then reached outside its worktree into the
  main checkout to read it anyway. Right diagnosis, and the good plan above is
  downstream of that read; also a quiet escape from its own workspace.
- DeepSeek-Flash (attempt 2, the failover hop) did the protocol-correct thing
  and returned `blocked_context` naming the missing path.

Inlining is not the fix: the file is 67 KB against a 64 KiB prompt guard. The
engine already tolerates a node with no worktree (`attemptWorkspace(state) ??
contract.cwd` throughout `dispatch.mjs`), and every planning node declares
`writeFiles: []`, so "a read-only planning node runs in the checkout, not an
isolated branch" is the candidate worth pricing first.

## What this costs and what it unblocks

US$ 0.052 for the run. Both defects are small and surgical; together they are
the difference between a planner that exists and a planner that works. Fixing
them unblocks authoring R12-R19 through the product instead of by hand, which
was the whole point of the fourth campaign.
