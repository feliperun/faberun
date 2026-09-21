/**
 * The runner-level FABERUN_HOME scope, a side-effect module: package.json's
 * test script loads it with node's `--import`, so every per-file child
 * process of `node --test` starts with a throwaway home — including the
 * files that import neither test/helpers.mjs nor any module that does, which
 * used to resolve state straight into the operator's ~/.faberun. The helper's
 * per-file fallback stays as the second line of defence, but the runner owns
 * the scope. A caller that already set FABERUN_HOME wins: an operator
 * debugging against a specific home must still be able to.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.FABERUN_HOME) {
  process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-suite-home-"));
}
