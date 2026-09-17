- Scheduler throughput (observed 2026-09-17 05:00-05:20Z, run spec-format-and-planning-stages-2): with
  maxParallel 2, repo-facts finished at ~05:08 but sizing-rules and plan-freeze stayed pending while
  routing-table sat in judge/candidate verification for 20+ minutes -- the drive loop awaits a node's
  verification inside the tick, so no dispatch happens meanwhile. Candidate: run verification and
  candidate checks off the tick (promise per node) so free slots dispatch immediately.
- Candidate verification still shows executionPhase 'judge' (status-during-verification covered the
  attempt stage only).
