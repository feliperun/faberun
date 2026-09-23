# Faberun documentation map

Every document in the repository and the question it answers. The documents
divide by purpose: the user-facing pages under `docs/*.md` explain how to
install, operate and understand the tool; the records under `docs/adr/` state
the decisions behind the code; the living internals — `docs/FIELD-OWNERSHIP.md`
and `docs/harnesses/` — describe what the code does today; and `docs/history/`
with `docs/campaigns/` preserve dated records that are never rewritten.

| Document | Question it answers | Reader |
| --- | --- | --- |
| [README.md](README.md) (this map) | Where is every document, and which question does it answer? | newcomer, operator, contributor, orchestrating agent |
| [VISION.md](VISION.md) | Why does Faberun exist, and what does it refuse to become? | newcomer |
| [ROADMAP.md](ROADMAP.md) | What is being built next, in what order, on what evidence — and which decisions and open questions shape it? | owner, contributor, orchestrating agent |
| [GETTING-STARTED.md](GETTING-STARTED.md) | How do I install `faberun` and take one campaign from install to a verified node? | newcomer |
| [CONCEPTS.md](CONCEPTS.md) | What does each Faberun term mean, where does it live, and what invariant holds? | newcomer, contributor |
| [COMMANDS.md](COMMANDS.md) | What is every verb's synopsis, flags, exit codes and one example? | operator |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How is `src/` layered, how does a run's process model work, and what gates the tree? | contributor |
| [FIELD-OWNERSHIP.md](FIELD-OWNERSHIP.md) | Which code writes each field of the append-only event records, and when? | contributor |
| [adr/README.md](adr/README.md) | How are decisions recorded, which ADRs are active, and what is the format? | contributor |
| [harnesses/zcode-cli.md](harnesses/zcode-cli.md) | How does the ZCode CLI work headless, and how does `faberun` drive it? | operator, contributor |
| [history/README.md](history/README.md) | What dated records exist, and where did the pre-2026-09-15 paths move? | orchestrating agent |
| `docs/campaigns/` | Where do campaign manifests, journals and specs live? | orchestrating agent |
| [campaigns/become-faberun/spec/SPEC.md](campaigns/become-faberun/spec/SPEC.md) | What did the `become-faberun` campaign set out to do, phase by phase? | orchestrating agent |
| [campaigns/register-skill-and-harden/spec/SPEC.md](campaigns/register-skill-and-harden/spec/SPEC.md) | What did the `register-skill-and-harden` campaign set out to do, and what did the first chain-driven campaign teach? | orchestrating agent |
| [campaigns/env-independence-and-generated-docs/spec/PROPOSAL.md](campaigns/env-independence-and-generated-docs/spec/PROPOSAL.md) | The owner's proposal that became the env-independence campaign: host-layout independence and a generated command manual. | orchestrating agent |
| [campaigns/adversarial-planner/spec/PROPOSAL.md](campaigns/adversarial-planner/spec/PROPOSAL.md) | The owner's proposal for planning outside the session: authoring and review as nodes, contested as a terminal state, a comparative arm. | orchestrating agent |
| [campaigns/adversarial-planner/spec/SPEC.md](campaigns/adversarial-planner/spec/SPEC.md) | Planning outside the session: the pipeline as one-node discovery runs, contested as a terminal state, freezing that never launches, a comparative arm. | orchestrating agent |
| [campaigns/spec-format-and-planning-stages/spec/SPEC.md](campaigns/spec-format-and-planning-stages/spec/SPEC.md) | A validated spec format, the planner's deterministic stages, and ledgers that outlive their campaign (first half of the owner's planner proposal). | orchestrating agent |
| [campaigns/harden-chain-and-verification/spec/SPEC.md](campaigns/harden-chain-and-verification/spec/SPEC.md) | What did the first retrospective-driven improvement campaign harden in the chain, resume and verification? | orchestrating agent |
| [campaigns/rec-audit-remediation/spec/SPEC.md](campaigns/rec-audit-remediation/spec/SPEC.md) | What did the first campaign against a repository faberun did not write set out to do — 22 audit findings across three contracts and twelve nodes? | orchestrating agent |
| [history/RETROSPECTIVE-2026-09-22-rec-audit-remediation.md](history/RETROSPECTIVE-2026-09-22-rec-audit-remediation.md) | What did a whole remediation campaign cost, what did the tool do well, and which six frictions did a real target expose? | owner, contributor, orchestrating agent |
| [../DESIGN.md](../DESIGN.md) | What are the visual and verbal identity, the palette and the documentation grammar? | contributor |
| `skills/faberun/references/` | How does the orchestrator skill document contracts, operations, rules, workflow, handoffs and engineering? | orchestrating agent |
