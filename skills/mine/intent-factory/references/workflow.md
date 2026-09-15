# Workflow: worktrees, commits, scope

**Detach and resume.** `run --detach <contract.json>` forks a controller that
outlives this session; if it dies before the run is terminal, the next
`resume --detach <run-dir>` takes over its stale lock and adopts or restarts
whatever it left running. `maxParallel` above one dispatches every ready node
concurrently, each in its own attempt worktree; integration stays serialized.
The target repo must ignore `.runs/`.

**Resume, do not restart.** A node marked `running` with no runner process is
an orphan. `resume --detach <run-dir>` re-judges finished work instead of
re-implementing it; take a new run id only when routing or the graph changes.

Never overwrite an existing run directory; choose a new run id. One controller
lock per run directory. Treat `STATUS.md` and node JSON as state; logs are
diagnostics. Attempt worktrees, sealing commits, integration, and the lock
mechanics: [operations.md](operations.md).

**Name things for what they do.** A campaign, run, phase or node id says
what the work is (`become-faberun-2-cli-product`, `brand-and-banner`), never
only when it ran; a date is a tie-break suffix, not the meaning. An operator
reading `.runs/`, a branch list or a `HANDOFF.md` must understand the campaign
without opening it.
