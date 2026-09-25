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
| Closed packet | the throwaway HOME withholds `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` and `~/.config/opencode`, where fx looks for global skills; the fx flavor closes the rest, see [Skill leak](#skill-leak) | fx has no flag that skips skill discovery |

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

What closes it is the fix at the origin, in [the fx flavor](https://github.com/feliperun/fx/tree/flavor)
(`install.sh` installs it, see below): when HOME is not above the workspace, the
walk now ends at the repository root, which for a worker is its worktree. It is
proposed upstream as [vercel-labs/fx#1045](https://github.com/vercel-labs/fx/pull/1045).
Measured 2026-09-25 on one Faberun run of the parseDuration contract through a
request-logging proxy: with the official 0.0.11, `ci-merge-loop` and
`micromed-feedback-analyzer` from `~/.codex/skills` reached DeepSeek 10 times
each over 6 requests; with the flavor, never over 9. On a direct `fx ask`, the
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

## The fx flavor

The flavor is the official fx plus a short patch queue on the `flavor` branch of
`feliperun/fx`: the cache counters of #1043, the skill walk of #1045, and a patch
that keeps a flavor build from auto-upgrading itself to the official channel. A
watcher workflow in that fork rebases the queue onto upstream every six hours,
builds and tests it, and drops a patch once its pull request merges. Releases
are versioned `X.Y.Z-flavor.N` and only ever created as drafts; publishing is
the owner's call. `install.sh` runs the flavor installer into the same bin
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
The discovery entry is `fx-deepseek`, declared after `dsh-deepseek` so dsh keeps
the tier-1 tie-break until a parallel campaign measures the two.

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

GLM is not routed through fx: Z.ai's Coding Plan lists its supported tools and
fx is not one of them.
