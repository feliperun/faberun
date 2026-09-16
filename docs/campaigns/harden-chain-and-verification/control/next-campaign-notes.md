# Candidates for the next improvement campaign (collected 2026-09-16 during harden-chain-and-verification)

- Test fixtures resolve node through the asdf shim: 21 `#!/usr/bin/env node` fixture sites in
  test/ (harnesses 4, cli 1, update 1, run/process 3, engine/routing 2, engine/judge 8,
  engine/worker-result 1, seat 1). Under the parallel suite the shim's startup exceeded a
  1.36 s assertion (process.test.mjs:311) and the 5 s notifier timeout. One node: every
  fixture writes `#!${process.execPath}`; a ratchet in source-shape refuses new env-node
  fixtures under test/.
- Phase-terminal fairness beyond the candidate: a node's own attempt verification carries
  finalVerification too (every terminal node), so a load flake in an unrelated group still
  costs a revision. Consider running finalVerification once per phase (on the candidate
  only) or applying the divergence retry to the attempt stage as well.
- `campaign unpark` without --force refuses while the run is parked even when the operator
  has already landed the run's work by hand; the message should name --force and the
  coordinator should not need a relaunch to notice.
- Judge verdict "fail" with only minor findings passes the gate but status shows `(fail)`;
  the row should show the gate outcome (pass) and the verdict separately.
