---
title: "fx: the ACP-driven harness for DeepSeek, GLM and GPT"
version: 1.0.0
status: reference
date: 2026-09-24
owner: Felipe Broering
source: "fx 0.0.11 (vercel-labs/fx, macOS arm64) against api.deepseek.com, measured 2026-09-24."
---

# fx: the ACP-driven harness for DeepSeek, GLM and GPT

[fx](https://github.com/vercel-labs/fx) is a native coding agent written in
Zig. Faberun drives it for DeepSeek, GLM and GPT because it is small: on the
parseDuration fixture, `fx ask` peaked at 18-20 MB resident over three runs
against 310-370 MB for `dsh --profile headless`, with the same model and a
passing suite. In a parallel campaign that difference is the worker count one
machine can hold (see [Measured](#measured) for the runner's share).

## How a turn runs

The adapter spawns Faberun's fx client, not `fx`. The client exists twice with
one transcript: `src/harnesses/fx/native/` in Zig, which the adapter runs once
`zig build` (Zig 0.16) has produced `native/zig-out/bin/faberun-fx-runner`, and
`src/harnesses/fx/runner.mjs`, which it runs otherwise. `test/harnesses/fx.test.mjs`
runs the same end-to-end cases against both. The client:

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
| Closed packet | the throwaway HOME withholds `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` and `~/.config/opencode`, where fx looks for global skills; fx-faberun closes the rest, see [Skill leak](#skill-leak) | fx has no flag that skips skill discovery |

Shell commands run in every sandbox mode, as under dsh's `workspace-write`: the
worktree bounds them, not a shell parser. The repository's own `AGENTS.md` still
reaches the worker; fx has no switch for it.

## Skill leak

The throwaway HOME does not close the packet on its own. fx also walks up from
the workspace looking for `skills/`, `.agents/skills`, `.claude/skills` and
`.codex/skills`, and stops only when it reaches HOME (fx 0.0.11
`appendWorkspaceRoots`). A worktree under the operator's HOME never meets the
throwaway HOME on that walk, so fx climbs to `/` and loads whatever skill
directories sit above the worktree. Measured 2026-09-24: on the operator's Mac,
36 entries under `~/skills` and `~/.codex/skills` reached every worker, and fx
wrote its warnings about the invalid ones into the agent's message text; on
Linux, a canary skill planted above a worktree appeared in the worker's skill
catalog. Linking the worktree into the throwaway HOME does not help: fx resolves
the link.

What closes it is the fix at the origin, in [fx-faberun](https://github.com/feliperun/fx/tree/fx-faberun)
(`install.sh` installs it, see below): when HOME is not above the workspace, the
walk now ends at the repository root, which for a worker is its worktree. It is
proposed upstream as [vercel-labs/fx#1045](https://github.com/vercel-labs/fx/pull/1045).
Measured 2026-09-25 on one Faberun run of the parseDuration contract through a
request-logging proxy: with the official 0.0.11, `ci-merge-loop` and
`micromed-feedback-analyzer` from `~/.codex/skills` reached DeepSeek 10 times
each over 6 requests; with fx-faberun, never over 9. On a direct `fx ask`, the
first request shrank from 40,066 to 25,014 bytes once 28 personal skills and a
canary left it.

A filesystem sandbox also closes it, measured before the fix. Under `ai-jail` 2.2.0 on Linux
(bubblewrap and Landlock), the same canary was absent from both fx's skill
discovery and a filesystem scan made from inside the jail, and the
parseDuration turn passed in a real git worktree (`--worktree`). The jail costs
about 3.7 MB resident. Two constraints: fx reads no proxy variable, so it needs
`--network` and gets no egress fence from `--allow-host`; and `ai-jail` saves a
project `.ai-jail` on every run unless given `--no-save-config`, which would
land in the worker's diff. On macOS the jail is not usable for fx: its
`sandbox-exec` backend blocks the `getpwuid` lookup fx uses to find the login
shell unless `--macos-host-ipc` is passed, and fx's file mutation tools still
failed inside it with the shell working.

## fx-faberun

fx-faberun is the official fx plus a short patch queue on the `fx-faberun` branch of
`feliperun/fx`: the cache counters of #1043, the skill walk of #1045, and a patch
that keeps an fx-faberun build from auto-upgrading itself to the official channel,
and `FX_AUTH_HOME`, which lets a worker under a throwaway HOME read and refresh
the ChatGPT login in the operator's real profile. A
watcher rebases the queue onto upstream every six hours, builds and tests it,
and drops a patch once its pull request merges; it runs as a workflow in that
fork, or as `fx-faberun/watch.sh` scheduled on the operator's machine by
`fx-faberun/watch-install.sh` when Actions are off. Releases
are versioned `X.Y.Z-faberun.N` and only ever created as drafts; publishing is
the owner's call. `install.sh` runs the fx-faberun installer into the same bin
directory as `faberun`; `FABERUN_NO_FX=1` skips it.

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

One runner, three providers, each a discovery entry declared ahead of the
older harness for the same models, so fx wins every tie-break:

| Entry | Model | How it authenticates |
| --- | --- | --- |
| `fx-deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY`, Chat Completions through the relay |
| `fx-glm` | `glm-5.3` | `ZAI_API_KEY` on `https://api.z.ai/api/coding/paas/v4`, `context_window` 200,000 |
| `fx-gpt` | `gpt-5.6-sol` | fx's own ChatGPT login, `config: {"provider": "codex"}` |

`fx-glm` uses the Z.ai Coding Plan endpoint by the operator's choice. The
plan's usage policy lists Claude Code and ZCode, not fx, and restricts or bans
an account for detected third-party use; `claude-glm`
([claude-endpoints.md](claude-endpoints.md)) is the supported route, and
`https://api.z.ai/api/paas/v4` is the pay-as-you-go one.

`fx-gpt` runs fx's built-in Codex provider. The runner writes `provider:
"codex"` into the throwaway settings, points `FX_AUTH_HOME` at the real HOME,
and sets `FX_E2E_OPENAI_CODEX_RESPONSES_URL` (fx accepts a loopback override of
that endpoint) to the relay, which meters it like the others. Two facts measured
2026-09-26 shaped this. fx refuses a symlinked or hard-linked credential file,
and a copy would diverge on the first token refresh, so the login cannot move
into the throwaway HOME; only fx-faberun has `FX_AUTH_HOME`, and official fx
answers "fx needs a Codex subscription login". And the Codex endpoint streams
SSE with no `content-type`, so the relay decides a headerless body by its first
bytes. `fx login codex` signs in once; `fx models` lists what the account can
use (seven models on the owner's account, `gpt-6-sol` among them).

## Measured

One parseDuration turn through the runner, 2026-09-24: 33 s, suite passing,
12 tool calls streamed, 12 provider requests, 11,599 uncached and 156,544 cached
input tokens (93.1% hit), 2,854 output tokens.

Memory per worker, measured the same day on the same fixture:

| Client | Client peak | `fx acp` peak | Worker total |
| --- | ---: | ---: | ---: |
| `native/` (Zig, ReleaseSafe, 1.3 MB binary), three turns | 15-16 MB | 9 MB | ~25 MB |
| `runner.mjs` (Node), one turn | 83 MB | 9 MB | ~92 MB |
| `dsh --profile headless`, three turns, no Faberun runner | — | — | 310-370 MB |

A Faberun run of the same contract through the native client peaked at 16.6 MB
for the client, 62k cached input tokens, and a passing Definition of Done.

Until commit `8fc8809`, GLM was not routed through fx, because Z.ai's Coding Plan
lists its supported tools and fx is not one of them. That caveat still holds:
`fx-glm` now runs GLM on fx over the plan endpoint by the operator's choice, and
`claude-glm` remains the route the plan supports (see [Runtime](#runtime)).

Memory per model, native CLI against fx, measured 2026-09-27 on the same
fixture: one parseDuration turn per run, three runs per route interleaved, the
exact command Faberun builds for each runtime, and the peak RSS of the whole
process tree sampled every 200 ms. "Agent" sums the harness processes (runner
and `fx acp`, or the CLI); "tree" adds what the agent ran (shells, `npm test`),
which follows the model's choices rather than the harness.

| Model | Route | Agent peak, min / median / max | Tree peak, min / median / max |
| --- | --- | ---: | ---: |
| `gpt-5.6-sol` | `codex` CLI 0.156.1 | 197 / 199 / 200 MB | 319 / 381 / 382 MB |
| `gpt-5.6-sol` | `fx-gpt` | 37 / 37 / 38 MB | 48 / 104 / 173 MB |
| `glm-5.3` | `claude-glm` (Claude Code 2.1.283) | 304 / 306 / 313 MB | 312 / 390 / 448 MB |
| `glm-5.3` | `fx-glm` | 22 / 22 / 23 MB | 84 / 100 / 165 MB |
| `glm-5.3` | `zcode-glm` (ZCode 0.16.5) | 1,045 / 1,054 / 1,066 MB | 1,045 / 1,066 / 1,126 MB |

All 15 runs exited 0 with the suite passing and only `src/parse-duration.mjs`
changed. The method, the machine and the raw results are in
[fx-integracao.md](../fx-integracao.md#5-o-que-foi-medido).
