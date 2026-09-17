Decision from the orchestrator (2026-09-17): do not modify .github/workflows/ci.yml.
test/host/ci-policy.test.mjs pins the workflow's run steps and is outside this
node's write scope, so the CI step named in instruction 4 is withdrawn. The
requirement behind it ("CI fails when the manual is out of sync with the code")
is met through the existing `npm test` step: make sure test/cli/manual.test.mjs
contains a test that renders the manual from the exported option tables and
asserts the result is byte-identical to the committed docs/COMMANDS.md, so any
drift fails the suite in CI. Keep `docs` and `docs:check` as npm scripts for
humans. Everything else you completed in attempt 2 stands (default exports per
verb module, header comment on src/cli/manual.mjs). Declare done when the
node's verification passes.
