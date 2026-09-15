---
name: intent-factory
description: A harness- and model-agnostic development factory that turns plans into verified software changes.
---

# Intent Factory

Run a plan outside the main context, with this session as the control plane.
Read [rules](references/rules.md) first.

| Action | Read |
| --- | --- |
| Author a contract (runtimes, fallback, gates) | [contract](references/contract.md), [engineering](references/engineering.md) |
| Launch, resume, integrate runs | [workflow](references/workflow.md), [operations](references/operations.md) |
| Dispatch a node to a worker | [handoffs](references/handoffs.md) |
| Supervise a run, answer attention | [operations](references/operations.md), [handoffs](references/handoffs.md) |
| Verify, judge, settle results | [engineering](references/engineering.md), [handoffs](references/handoffs.md) |

Watchdog re-invocations, armed from launchd/cron (`StartInterval 300`):

    node src/cli.mjs supervise <run-dir>
    node src/cli.mjs supervise campaign <id> [--allow-main]
