# Phase 1 — environment-probe judgment (R4)

- **Campaign:** `safe-to-hand-to-a-friend`
- **Phase:** phase-1 (“O worker recebe só o ambiente permitido”)
- **Node:** `env-probe-judgment`
- **Requirement judged:** R4 — *na máquina do operador, `faberun models --probe`
  responde disponível para todo runtime que respondia em `748d7ba`, agora
  rodando sob a lista de R1.*
- **Operator machine:** `MacBook-Pro-3.local` · Darwin arm64 · macOS 26.0.1
- **Date of judgment:** 2026-09-26
- **Verdict:** **PASS** — every runtime that reported available before the phase
  still reports available after it.

## What is compared

The availability probe is the live ask that `probeRuntime`
(`src/harnesses/index.mjs`) and `livePreflight`
(`src/engine/live-preflight.mjs`) make on the operator machine: a trivial
prompt (`FABERUN_PREFLIGHT_OK`), with the runtime clamped to its read-only
mode, which proves the binary spawns, the credential authenticates, and the
model answers. Every launch records that probe in the run's
`env-preflight.json`, so the file is the operator machine's raw before/after
evidence.

The runtimes compared are exactly those that answered at the baseline, i.e.
the reachable worker/judge runtimes the run's contract declares. In this
campaign they are `dsh-deepseek` (worker) and `zcode-glm` (judge). The other
catalogue entries (`claude-sonnet`, `claude-opus`, `claude-fable`,
`codex-sol`) are not node-reachable and have no baseline availability record,
so they are outside R4's "todo runtime que respondia".

## Before — baseline (phase-1 run, pre-change)

- **Source:** `runs/safe-to-hand-to-a-friend-phase-1/env-preflight.json`
  (operator machine)
- **Captured:** `2026-09-26T16:05:52.889Z`
- **Run:** `safe-to-hand-to-a-friend-phase-1` · `gitHead`
  `6a3d18e22fdb11e763001a0b9c1f1399300328f6` (the phase-1 baseline; spec
  baseline `6ecb804`, R4 wording `748d7ba`)
- **sha256:** `b96e41a4f29e3d0cfc7eeb59a95b5717404226f035dca937839ff60246dacc77`

| runtime | harness | version | available | exhaustedUntil | reason | liveStatus |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-deepseek` | dsh | 0.1.5-rc.1 | `true` | `null` | `ready` | `done` |
| `zcode-glm` | zcode | 0.16.5 | `true` | `null` | `ready` | `done` |

Raw availability records (verbatim from the before file):

```json
[
  { "id": "dsh-deepseek", "version": "0.1.5-rc.1", "live": true, "liveStatus": "done",
    "availability": { "available": true, "exhaustedUntil": null, "reason": "ready" },
    "usage": { "inputTokens": 2491, "outputTokens": 121, "cacheReadInputTokens": 128 } },
  { "id": "zcode-glm", "version": "0.16.5", "live": true, "liveStatus": "done",
    "availability": { "available": true, "exhaustedUntil": null, "reason": "ready" },
    "usage": { "inputTokens": 5834, "outputTokens": 74, "cacheReadInputTokens": 9536 } }
]
```

## After — phase end (phase-1b run, post-change)

- **Source:** `runs/safe-to-hand-to-a-friend-phase-1b/env-preflight.json`
  (operator machine)
- **Captured:** `2026-09-26T17:53:37.896Z`
- **Run:** `safe-to-hand-to-a-friend-phase-1b` · `gitHead`
  `4f7338bf7527b68613e11b5cd8322e2f2043d2c5` · `baseRef`
  `refs/faberun/safe-to-hand-to-a-friend-phase-1/run` (the run carries the
  phase-1 integration)
- **sha256:** `7311bd3806881f3a32846676d9aa36e84ec54e26ac20f6800061df4056d8ac26`

| runtime | harness | version | available | exhaustedUntil | reason | liveStatus |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-deepseek` | dsh | 0.1.5-rc.1 | `true` | `null` | `ready` | `done` |
| `zcode-glm` | zcode | 0.16.5 | `true` | `null` | `ready` | `done` |

Raw availability records (verbatim from the after file):

```json
[
  { "id": "dsh-deepseek", "version": "0.1.5-rc.1", "live": true, "liveStatus": "done",
    "availability": { "available": true, "exhaustedUntil": null, "reason": "ready" },
    "usage": { "inputTokens": 2489, "outputTokens": 10, "cacheReadInputTokens": 128 } },
  { "id": "zcode-glm", "version": "0.16.5", "live": true, "liveStatus": "done",
    "availability": { "available": true, "exhaustedUntil": null, "reason": "ready" },
    "usage": { "inputTokens": 5830, "outputTokens": 81, "cacheReadInputTokens": 9536 } }
]
```

## Comparison

| runtime | before | after | still available? |
| --- | --- | --- | --- |
| `dsh-deepseek` | `available: true`, `reason: ready`, `liveStatus: done` | `available: true`, `reason: ready`, `liveStatus: done` | **yes** |
| `zcode-glm` | `available: true`, `reason: ready`, `liveStatus: done` | `available: true`, `reason: ready`, `liveStatus: done` | **yes** |

No runtime that was available at the baseline reports unavailable after the
phase. The only field that moved is the live-probe token usage (each ask is a
real generation), which is expected and does not affect availability. The
installed harness versions are unchanged (`dsh` 0.1.5-rc.1, `zcode` 0.16.5).

## Verdict

**PASS.** For every runtime available at the baseline (`dsh-deepseek`,
`zcode-glm`), the phase-end probe still reports `available: true` with
`reason: ready` and a completed live ask. R4 is satisfied and phase-1 can
close.

### Evidence provenance

| snapshot | file | captured (UTC) | sha256 |
| --- | --- | --- | --- |
| before | `runs/safe-to-hand-to-a-friend-phase-1/env-preflight.json` | 2026-09-26T16:05:52.889Z | `b96e41a4f29e3d0cfc7eeb59a95b5717404226f035dca937839ff60246dacc77` |
| after | `runs/safe-to-hand-to-a-friend-phase-1b/env-preflight.json` | 2026-09-26T17:53:37.896Z | `7311bd3806881f3a32846676d9aa36e84ec54e26ac20f6800061df4056d8ac26` |

Both files live on the operator machine under the faberun project state
(`/Users/frb/.faberun/projects/9fc1d8c7-d994-44ec-9af5-817a649cbe73/runs/…`).
