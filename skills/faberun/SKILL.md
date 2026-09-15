---
name: faberun
description: Faberun: a harness- and model-agnostic development orchestrator that turns plans into verified software changes.
---

# Faberun

Run a plan outside the main context, this session as the control plane.
Read [rules](references/rules.md) first.

| Action | Read |
| --- | --- |
| Author a contract (fallback) | [contract](references/contract.md), [engineering](references/engineering.md) |
| Launch, resume, integrate | [workflow](references/workflow.md), [operations](references/operations.md) |
| Dispatch a node | [handoffs](references/handoffs.md) |
| Supervise, answer attention | [operations](references/operations.md), [handoffs](references/handoffs.md) |
| Verify, judge, settle | [engineering](references/engineering.md), [handoffs](references/handoffs.md) |

Watchdog re-invocations:

    node src/cli.mjs supervise <run-dir>
    node src/cli.mjs supervise campaign <id> [--allow-main]

launchd: `StartInterval 300`; `launchctl load -w ~/Library/LaunchAgents/faberun.plist`.
