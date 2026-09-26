# Claude Code on another Anthropic-compatible endpoint

The `claude` harness drives Claude Code. By default it talks to Anthropic with
whatever login the operator's CLI already has. A runtime can instead point it
at another Anthropic-compatible endpoint. The case this exists for is GLM on
the Z.ai Coding Plan, where Claude Code is one of the supported tools:

```json
"claude-glm": {
  "harness": "claude",
  "model": "glm-5.3",
  "vendor": "zhipu",
  "permissionMode": "plan",
  "config": {
    "base_url": "https://api.z.ai/api/anthropic",
    "auth_token.env_key": "ZAI_API_KEY"
  }
}
```

The same entry ships in the discovery catalogue as `claude-glm`, declared
after `fx-glm` and before `zcode-glm`.

## What the runtime sets

`config` becomes an environment overlay on that runtime's invocations only
(`src/harnesses/claude/index.mjs`, `endpointEnv`):

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `config.base_url` |
| `ANTHROPIC_AUTH_TOKEN` | the value of the variable `config["auth_token.env_key"]` names, read at invocation time |
| `ANTHROPIC_API_KEY` | removed, because an ambient key outranks the bearer token in the CLI |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | the runtime's model, so the CLI's background requests do not ask the endpoint for a Claude model it does not serve |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |

Nothing is written to the controller's environment. A campaign can run a
Claude judge on Anthropic and a GLM judge on Z.ai side by side, each with its
own endpoint. The token's value never appears in the contract. Like every
harness overlay, it travels in the gate's per-invocation config file (mode
0600, deleted when the invocation closes).

A `base_url` without a resolvable token is refused with
`auth_token_unresolved` instead of run. Without a token the CLI would fall back
to the operator's own Anthropic login and send that credential to the declared
host.

## Cost

Claude Code reports `total_cost_usd` at Anthropic's rates whatever model
answered. On another endpoint that number is not what the turn cost: a GLM 5.3
review on the Z.ai Coding Plan reported $0.13. A runtime with a `base_url`
therefore drops the reported cost, and the turn is priced like any harness that
reports none, from the runtime's `pricing` or the models.dev seed.

## Why not zcode

Measured 2026-09-25 on one macOS machine, running the same read-only review
prompt with GLM 5.3:

| Harness | Peak memory per review | Wall time |
| --- | --- | --- |
| `zcode` 0.16.5 | 0.9-1.0 GB (985 MB physical footprint) | 21-50 s |
| `claude` 2.1.283 on Z.ai | 384-392 MB (243 MB physical footprint) | 29-70 s |

Of the Claude Code figure, about 300 MB is the CLI itself. The rest is the
login shell and the hooks the operator's profile starts. A clean
`ZCODE_HOME` and a 256 MB V8 heap cap did not bring zcode below 870 MB.

The tiny-text campaign, two DeepSeek workers on `fx` and two GLM judges in
parallel, ran end to end with each judge:

| Judge | Total peak | Wall time | Result |
| --- | --- | --- | --- |
| `zcode` | 1,575 MB | 83.5 s | 2 nodes done, no revisions |
| `claude` on Z.ai, endpoint in the controller's environment | 865 MB | 55.1 s | 2 nodes done, no revisions |
| `claude` on Z.ai, endpoint in the contract (`config` above) | 802 MB | 59.6 s, beside a running test suite | 2 nodes done, no revisions |

The last run had no `ANTHROPIC_*` variable in the controller's environment.
Its judge cost ($0.031 for both reviews) came from the models.dev seed's GLM
rates, where the CLI had reported $0.16 at Anthropic's.

## What the Coding Plan allows

Z.ai limits the Coding Plan to the tools on its supported list
(<https://docs.z.ai/devpack/tool/others>). ZCode and Claude Code are on it;
`fx` is not. The same key reaches both billing paths, and the endpoint decides
which one pays: `https://api.z.ai/api/paas/v4` bills the pay-as-you-go
balance, while `https://api.z.ai/api/coding/paas/v4` and
`https://api.z.ai/api/anthropic` draw on the plan.

An `fx` runtime pointed at the plan's OpenAI-compatible endpoint works with no
code change (`config.base_url`, as for DeepSeek). The operator ran this knowing
it is outside the plan's usage policy, which restricts the plan on detected
third-party use and bans an account on the third violation. On 2026-09-26 the
tiny-text campaign ran with a GLM 5.3 worker on `fx` over the plan and a
DeepSeek judge on `fx`: 2 nodes done at the first try with no revisions, 51.9 s,
283 MB total peak. The pay-as-you-go balance was empty throughout, so the plan
answered every request. The supported configuration remains GLM on the plan
through `claude-glm`, and GLM on `fx` through the pay-as-you-go endpoint. The
operator then made the plan endpoint the `fx-glm` discovery default anyway, so
`fx-glm` is declared ahead of `claude-glm`; see [fx.md](fx.md#runtime).

`glm-4.7-flash`, the one GLM model the pay-as-you-go endpoint serves without a
balance, cannot work as an `fx` worker: it sends the `shell` tool's nested
`request` object as a JSON string, `fx` answers with a correction instead of
running it, and after two refusals it ends the turn without a result. GLM 5.3
sends the object correctly.
