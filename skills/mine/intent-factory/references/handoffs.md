# Handoffs: capsule, brief, settlement

**Campaign first.** Establish or discover the durable campaign before
launching work; stop instead of guessing when several are active. Attach this
session, read `HANDOFF.md`, and record every material intent, decision, and
open question as a campaign event — handoff state, not documentation.

**Closed packets.** Each node lists exact `readFiles`, `writeFiles`, and
`verification`. Workers and judges inspect only those paths and return the
structured `blocked_context` result instead of exploring.

**A packet is an instruction and a detector, not a sandbox.** Only a `claude`
worker is stopped mechanically, and only on `Write`/`Edit`/`NotebookEdit`: a
write through `Bash` is never inspected, and no other harness is prevented at
all. Everything else is caught after the attempt by the scope comparison in
`engine/scope.mjs`, which is advisory when verification passes. Scope keeps an
honest worker inside its lane and records what left it. It does not contain an
adversarial one, so give a worker no credential or write access you would not
give the packet's whole repository.

**Settlement.** Store raw worker output under `.runs/`; bring only status and
actionable verdicts into the session.

The packet shape and the worker-result object live in
[contract.md](contract.md); the `HANDOFF.md` capsule and the campaign journal
live in [operations.md](operations.md).
