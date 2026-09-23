---
id: rec-audit-remediation
title: "Remediation of every rec audit finding (SYNTH-01..19 + A.6.1..A.6.3)"
version: 1.0.0
status: approved
date: 2026-09-22
owner: feliperun
target: feliperun/rec
baseline: 1a21cf271f98690ef93e09306e7ed9169a444f0f
derived_from: rec-bug-and-security-audit
---

## Intent

The `rec-bug-and-security-audit` campaign produced 19 consolidated findings
(`FINDING-SYNTH-01` … `FINDING-SYNTH-19`) plus three late findings the Opus 5
review added (`A.6.1` `llm.configDirPath` / `llm.joinPath` unbounded copy,
`A.6.2` `rec transcribe --out` destroying the source recording, `A.6.3`
`library.appendRow` fixed 512-byte line). This campaign fixes all of them in the
`rec` repository: four critical, ten major, five minor, and the three late ones.

Every fix is a behaviour change and therefore lands with a regression test
(AGENTS.md: "Bug fixes start with a failing regression test"), a bounded diff,
and the repository gates green. No correction is accepted on prose alone: each
node proves its work mechanically before the judge sees it.

The work is bounded by what can be verified on this host. There is no macOS
machine and no Windows machine, so the macOS-only AudioToolbox path (`src/m4a.zig`)
and the Windows-only branches in `src/update.zig` are corrected by reading, never
executed; a node that cannot exercise a path says so instead of claiming a pass.

## Requirements

### R1. Unbounded copies into fixed stack buffers are rejected at the source

- **statement:** `record.appendStr`, `playback.transcriptPath`,
  `transcribecmd`'s `--out` handling and `llm.configDirPath`/`llm.joinPath`
  reject or safely truncate input that does not fit their destination buffer;
  no input derived from a CLI argument, an environment variable, or a filename
  can write past a caller's buffer.
- **proof:** command: zig build test -Dtarget=x86_64-linux-gnu --summary all

### R2. Writing a transcript never destroys the recording it was made from

- **statement:** `rec transcribe --out <path>` refuses to overwrite the source
  recording (any spelling of the same path) and reports the refusal as a usage
  error; the source file is byte-identical afterwards.
- **proof:** judgment: true

### R3. Recording files cannot silently collide, leak, or be world-readable

- **statement:** two recorders starting in the same wall-clock second cannot
  truncate or replace each other's file, a failed `wav.Encoder.finish()` always
  releases its descriptor, and POSIX WAV files are created `0600`.
- **proof:** command: zig build test -Dtarget=x86_64-linux-gnu --summary all

### R4. The Deepgram request cannot leak the key, be steered, hang, or flood memory

- **statement:** the API key never appears on a child-process argv, `--language`
  cannot inject query parameters, the request has a wall-clock bound, and the
  response body is capped.
- **proof:** judgment: true

### R5. Path guards compare paths, and interactive reads cannot desynchronise

- **statement:** `rec format --out` compares resolved paths rather than raw
  strings, and `setupcmd.readLine` discards the remainder of an over-length line
  instead of feeding it to the next prompt.
- **proof:** judgment: true

### R6. Downloaded release artifacts are verified before they are trusted

- **statement:** the self-updater and both installers verify a published checksum
  and fail closed on mismatch, the update temp file is created exclusively, and
  the download URL is validated against the releases host.
- **proof:** judgment: true

### R7. CI and release workflows minimise their blast radius

- **statement:** every third-party action is pinned to a commit SHA, the
  `build` job no longer carries `pull-requests: write`, the Sentrux binary is
  checksum-verified before execution, and `release.yml` publishes a checksum
  file next to every release asset.
- **proof:** judgment: true

### R8. Filesystem-derived text reaches the terminal filtered

- **statement:** recording filenames and rendered documents are stripped of
  control bytes (including DEL) on every non-interactive path — `rec list`,
  `rec transcribe`, `rec format`, `rec view` — using the same filter the
  interactive deck already applies.
- **proof:** judgment: true

### R9. Every correction is traceable from finding to code to proof

- **statement:** `docs/campaigns/rec-audit-remediation/REMEDIATION.md` maps each
  of the 22 findings to the file and line that changed and to the verification
  that proves it, and `docs/audits/AUDIT-REPORT-ADDENDUM.md` records the three
  factual corrections and the three late findings without editing the original
  report.
- **proof:** path: docs/campaigns/rec-audit-remediation/REMEDIATION.md

### R10. The residuals the first contract left open are closed

- **statement:** the non-interactive `rec play` document is filtered like every
  other non-tty path, and `rec transcribe --refine` handles a null template
  directory instead of unwrapping it with `.?`.
- **proof:** judgment: true

### R11. The unit suite stops writing artifacts into the repository

- **statement:** running the suite leaves no untracked `rec-wav-test-*` path in
  the worktree, the artifacts already committed by the first contract's seal are
  removed, and `openNew`'s owner-only mode has its own assertion. The repository's
  ignore files stay untouched: a worker that edits them fails with
  `snapshot_ignore_changed`, so the defect is closed at its source rather than
  hidden behind a pattern.
- **proof:** command: zig build test -Dtarget=x86_64-linux-gnu --summary all

### R12. The remediation record matches the final tree

- **statement:** `REMEDIATION.md` states which residuals the follow-up contract
  closed, with the file and the proof, and which one (the Windows-only rename
  dance) stays open.
- **proof:** path: docs/campaigns/rec-audit-remediation/REMEDIATION.md

## Non-goals

- Merging the campaign branch into `main`: that is a destructive action and stays
  with the human operator (rec `AGENTS.md`).
- Re-running the audit or re-litigating a finding's severity; the findings are
  taken as given, including the review's severity corrections.
- macOS-only or Windows-only runtime verification: no such host exists here.
- Publishing a new `rec` release, bumping the version, or tagging.
- Fixing the report-process defects of A.6.4 (judging "checked, clean" sections,
  the `-Dtest-listen-base` seam) — those are process changes to a closed
  campaign, not code defects in `rec`.
- Opportunistic refactors, style sweeps, or dependency upgrades.

## Constraints

- All fixes land on `campaign/rec-audit-remediation`, cut from the audit branch
  `campaign/rec-bug-and-security-audit` (`3c7f5cb`), so the finding reports and
  the code they describe are in the same tree.
- The worker runtime is `dsh` + `deepseek-flash` and the judge runtime is
  `dsh` + `glm-5.3-flash` (Z.ai provider). The judge is cross-vendor to the
  worker, as faberun requires for a gated node.
- The worker sandbox is `danger-full-access` on purpose: measured on this host,
  a `dsh` worker under `workspace-write` cannot run the Zig toolchain
  (`ReadOnlyFileSystem` creating the compiler cache), so no worker could compile
  its own fix. Verification still runs outside the harness.
- Canonical local gate: `zig build test -Dtarget=x86_64-linux-gnu --summary all`.
  A bare `zig build test` fails to link on this host (Zig 0.16.0 cannot resolve
  the `R_X86_64_PC64` relocations in glibc's `.sframe` section); naming the gnu
  target uses Zig's bundled crt1.o and passes. This is an environment
  adaptation, not a repository change.
- `sentrux check .` runs on every node; `sentrux gate .` runs once on the
  terminal node (baseline `.sentrux/baseline.json`, sentrux 0.5.7).
- Each node's write set is disjoint from every node allowed to run beside it; a
  node that must touch a file another node owns declares `dependsOn` on it.

## Success criteria

| Metric | Baseline | Target |
|---|---|---|
| Findings fixed | 0 of 22 | 22 of 22 |
| Regression tests added | 0 | one per behaviour-changing fix |
| `zig build test` (gnu target) | 138 pass | passes, count >= 138 |
| `sentrux check .` | pass | pass |
| `sentrux gate .` | no degradation | no degradation |
| Out-of-scope files touched | 0 | 0 |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Worker cannot compile under the harness sandbox | every node fails verification | measured; worker runtime declares `danger-full-access` |
| Flash worker writes a Zig fix that does not compile | attempt fails, revision burned | per-node `verification` runs the full suite; `maxRevisions` 1–2 |
| Two parallel nodes edit one file | integration conflict, node `attention` | disjoint `writeFiles`; `record.zig` overlap serialised with `dependsOn` |
| Supply-chain fixes touch YAML/pwsh that nothing here can execute | fix looks green but is wrong | judge reviews captured diffs; node explicitly told to keep the change minimal and syntax-valid |
| Judge rejects a correct fix | extra attempt, cost | `review` blocking with `failOn` major+critical, `maxRevisions` 2 on the risky nodes |
