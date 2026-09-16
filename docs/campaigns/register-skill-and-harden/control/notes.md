
## 2026-09-16 15:57Z — unpriced-usage-visible attempt 1: verification runner SIGKILLed again

`node --test test/engine/` (verification 5 of 10, cwd unpriced-usage-visible.1, which already
contains never-signal-self 9d42573) died by SIGKILL at 93 s, timedOut=false. macOS unified log
shows no memorystatus/jetsam kill. Found seven leftover process groups from 2026-09-15 test runs
of the become-faberun-2c `stale-group-signal-guard` worktrees and the 2-cli-product
`install-script.2` worktree: three hung `node --test` runners (test/run/process.test.mjs ×2,
test/run/lock.test.mjs) and four `gate.mjs` processes with fake zcode providers, deadlocked
because the gate waits for its parent (the test process) to die while the test waits for the
gate. Snapshot in leftovers-2026-09-16.txt; all killed by pgid. Whether they were the sender is
not proven; kill-trace.cjs is the preload for a repro loop on the current tree.
