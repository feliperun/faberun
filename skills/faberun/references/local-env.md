# Local environment

A worker or judge process gets only the environment it is allowed — the base
set (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`,
plus the Windows names), the names a harness adapter declares, its runtimes'
`env_key` names and any `envPassthrough` — while this phase's
definition-of-done commands and `finalVerification` keep today's environment.

`faberun doctor --env [<contract.json>]` lists, per runtime, the names that
would pass and the names excluded, never the values; a credential-shaped
exclusion is marked retained.
