---
type: ADR
id: "0003"
title: "Harness- and model-agnostic orchestration"
status: active
date: 2026-09-15
---

## Context

Faberun must not depend on one model or one agent; the owner's pitch is
explicit that tools can change while the work remains. Three things were being
conflated: the *harness* is the CLI that runs a turn (`claude`, `codex`, `agy`,
`dsh`, `zcode`), the *model* is what the harness asks (`deepseek-flash`,
`gpt-5.6`, `glm-5.3`), and the *vendor* is who answers (DeepSeek, OpenAI,
Google, Zhipu, Anthropic). The same model can be reachable through different
harnesses, and a harness may be pointed at a provider other than its default
one. A branch or a catalogue keyed on the vendor name would mislabel a
DeepSeek turn answered through `codex`.

## Decision

**Split the three concepts and route by runtime id, never by vendor or harness
name.** `src/harnesses/` holds one adapter per provider harness; every adapter
exports `harness`, and that uniform export *is* the registry interface (it is
exempt from the "no name exported from two modules" rule for exactly this
reason). A runtime id is `<harness>-<model>`, so a recorded run says which
harness produced it. Vendor is *resolved*, not named after the adapter: an
explicit `vendor`, else a provider-config override (a codex runtime with
`config.model_provider: "deepseek"` is vendor `deepseek`), else the harness
default (`claude`→anthropic, `codex`→openai, `agy`→google, `zcode`→zhipu);
harnesses with no default (`dsh`, `exec-jsonl`, `replay`) must declare one.
Models are data: the catalogue `faberun models` prints. No model-specific
branch appears in code or in prose.

## Options considered

- **Name the vendor after the adapter and key routing on it** (rejected): the
  codex default is one provider, but the adapter can be pointed at another, and
  a recorded run would then lie about who answered.
- **Runtime ids that name only a model or only a harness** (rejected): they
  hide which harness ran the turn, which is what makes a run reproducible.
- **Split harness, model and vendor, with a registry and `<harness>-<model>`
  ids** (chosen).

## Consequences

- Adding a harness is one adapter directory plus a registry entry; adding a
  model is a catalogue entry.
- Validation derives each runtime's vendor statically, which is what lets the
  cross-vendor judge rule of [ADR 0004](0004-closed-task-packets-and-cross-vendor-judges.md)
  be checked before a run starts.
- Failover and re-tiering operate on runtime ids, so a provider hop is recorded
  as a change of runtime, not of model family.
- `faberun models` is the one place a user reads what each harness accepts.

## References

- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md) — *Appendix —
  positioning* (harness-agnostic and model-agnostic) and *Decisions already
  made*.
- [contract.md](../../skills/faberun/references/contract.md) — *Runtimes and
  routing*, *Failover*.
- [AGENTS.md](../../AGENTS.md) — *Source tree rules* (the `harnesses/` layer
  and the `harness` export exemption).
- `src/engine/runtime-discovery.mjs` (`DISCOVERY_RUNTIME_DEFINITIONS`,
  `resolveVendor` callers) and `src/harnesses/index.mjs`.
