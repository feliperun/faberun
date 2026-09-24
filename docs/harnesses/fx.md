---
title: "fx: the ACP-driven DeepSeek harness"
version: 1.0.0
status: reference
date: 2026-09-24
owner: Felipe Broering
source: "fx 0.0.11 (vercel-labs/fx, macOS arm64) against api.deepseek.com, measured 2026-09-24."
---

# fx: the ACP-driven DeepSeek harness

[fx](https://github.com/vercel-labs/fx) is a native coding agent written in
Zig. Faberun drives it for DeepSeek workers because it is small: on the
parseDuration fixture, `fx ask` peaked at 18-20 MB resident over three runs
against 310-370 MB for `dsh --profile headless`, with the same model and a
passing suite. In a parallel campaign that difference is the worker count one
machine can hold (see [Measured](#measured) for the runner's share).

## How a turn runs

The adapter spawns `src/harnesses/fx/runner.mjs`, not `fx`. The runner:

1. starts a loopback relay (`usage-proxy.mjs`) in front of the provider;
2. builds a throwaway HOME (`home.mjs`) whose `.fx/settings.json` points a
   `faberun` connection at the relay, with every other HOME entry linked in;
3. runs `fx acp` in the worktree and speaks ACP over stdio: `initialize`,
   `session/new`, one `session/prompt`;
4. answers each `session/request_permission` from the contract's `sandbox`
   (`permissions.mjs`);
5. writes the `fx.*` transcript that `runner-transcript.mjs` folds into the
   envelope, and deletes the HOME.

| Need | How the runner meets it | Why not fx alone |
| --- | --- | --- |
| Live progress for the stall detector | `tool_call` updates become `fx.tool` as they happen | `fx ask --json` prints once, at exit |
| Cache accounting | the relay reads `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` from each response | fx 0.0.11 keeps only prompt and completion totals |
| Quota and rate-limit failover | the relay sees the HTTP status (402, 429) and `Retry-After` | fx reports provider errors as prose |
| File-effect boundary | `workspace-write` rejects mutations whose `path` leaves the worktree; `read-only` rejects all | `fx ask` offers only full access or model review |
| Closed packet | the throwaway HOME withholds `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` and `~/.config/opencode`, where fx looks for skills | fx has no flag that skips skill discovery |

Shell commands run in every sandbox mode, as under dsh's `workspace-write`: the
worktree bounds them, not a shell parser. The repository's own `AGENTS.md` still
reaches the worker; fx has no switch for it.

## Runtime

```json
{
  "harness": "fx",
  "model": "deepseek-flash",
  "vendor": "deepseek",
  "sandbox": "workspace-write",
  "config": { "api_key.env_key": "DEEPSEEK_API_KEY" }
}
```

Optional `config` keys: `base_url` (default `https://api.deepseek.com`) and
`context_window` (default 1,000,000). `FABERUN_FX_BIN` overrides the binary.
The discovery entry is `fx-deepseek`, declared after `dsh-deepseek` so dsh keeps
the tier-1 tie-break until a parallel campaign measures the two.

## Measured

One parseDuration turn through the runner, 2026-09-24: 33 s, suite passing,
12 tool calls streamed, 12 provider requests, 11,599 uncached and 156,544 cached
input tokens (93.1% hit), 2,854 output tokens.

Memory per worker, measured the same day on the same fixture: the runner's
Node process (ACP client plus relay) peaked at 83 MB resident and `fx acp` at
9 MB, about 92 MB for the pair. `dsh --profile headless` alone peaked at
310-370 MB, before the Node runner Faberun puts in front of it. The runner, not
fx, is now most of an fx worker's footprint.

GLM is not routed through fx: Z.ai's Coding Plan lists its supported tools and
fx is not one of them.
