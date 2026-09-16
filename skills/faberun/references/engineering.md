# Verification and tools

The session itself runs only these; everything else runs detached.

| You want | Run |
| --- | --- |
| Probe runtimes and host before spending tokens | `preflight <contract.json>`, `doctor [--cwd <dir>]` |
| Choose runtime and model, and see the effort each accepts | `models [--probe] [--json]` |
| Prove each verification command fits its own `timeoutSec` | `preflight <contract.json> --time-verification` |
| Pull unseen campaign events | `campaign sync <id> --cwd <repo> --session-id <s>` |
| Advance that cursor past an event | `campaign ack <id> --cwd <repo> --session-id <s> --event-id <e>` |
| Wake only on actionable change, poll every 30s | `campaign watch <id> --cwd <repo> --wake` |
| Read the campaign indicators | `metrics <campaign-id> [--cwd <dir>] [--json]` |
| Ask one question about many large files | `bulk-read --question <text> --paths <a,b,c>` -- bullets only, corpora under 1500 lines are refused |

**Foreground children.** Worker prompts run builds, watchers, and servers in
the foreground; only the runner is detached. Keep output bounded
(`| tail -n 200`). Never instruct a worker to run a command slower than its
own tool's foreground timeout, including the full test suite — that is what
`taskPacket.verification` is for, run by the controller after the worker
declares done. Measure a verification command's real duration before setting
its `timeoutSec`; a suite can silently outgrow the 600s per-entry cap as it
grows, and a worker forced to wait past its own timeout backgrounds the
command and returns prose instead of a result — a protocol failure, not a
`done`. A harness whose adapter declares `signalsProcesses: false` never
runs a test that terminates processes; the controller's verification is the
proof.

Keep secrets in env vars; contracts carry variable names only. Claude
`bypassPermissions` only in a repository-scoped, recoverable environment;
otherwise `acceptEdits`, letting denials become `blocked`.
