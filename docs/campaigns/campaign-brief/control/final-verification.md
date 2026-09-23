# Campaign Brief — Final Verification

- **Campaign:** `campaign-brief`
- **Revision verified:** `9df2a07` (`feat: add campaign brief sharing and server`)
- **Runtime:** Node.js `v26.8.1`, TypeScript `tsc` (repo config)
- **Scope:** integrated implementation — core brief (`src/campaign`), report/estimate and
  HTML render (`src/report`), CLI surface (`src/campaign/brief-cli.mjs`) and loopback
  server (`src/web/campaign-brief-server.mjs`).

## Measured gates

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test test/web` | **PASS** | 47 tests, 47 pass, 0 fail (`duration_ms` ≈ 6425). Includes the R8 `campaign-brief-server` suite: serves the HTML plus exact verified `/plan.json` and `/spec.md` bytes, refuses unrelated paths/directory listings, has no write route, fails startup with named errors on missing/changed sources, binds loopback only, and releases its port on close. |
| `node --test test/docs` | **PASS** | 15 tests, 15 pass, 0 fail (`duration_ms` ≈ 64). Manual headings, byte ceilings, reference links and docs read/write scope all hold. |
| `npm run check` | **PASS** | `311 files checked`; `node --check` completed for every `.mjs` under `bin/`, `.claude/hooks/`, `src/`, `evals/` and `test/`. |
| `npm run typecheck` | **PASS** | `tsc` exited 0 with no diagnostics. |
| `node --test test/cli` | **delegated** | Not run in this node's agent sandbox: the CLI suites spawn and terminate child `node` processes, which this engine cannot signal. The controller runs this exact command after the node reports; its recorded result is the authoritative proof for the R7 CLI gate (`test/cli/campaign-brief.test.mjs` drives the real CLI with a controlled `mdhtml` fixture for the success path and for absent/failing-renderer named errors). |

## Notes

- `test/web` and `test/docs` were run to completion here and are reproducible with the
  commands above.
- `npm run check` and `npm run typecheck` cover syntax and types across the tree, including
  the new campaign-brief modules and tests.
- No product file was modified by this verification; this document is the only write.
- The legacy full `npm test` suite was deliberately not run (its process-heavy plan tests
  exceed the engine's 120-second proof cap); the five gates above are the proof for this
  finalize node.
