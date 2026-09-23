/**
 * The mechanism proof for the runner-scoped suite home: package.json's test
 * script preloads test/scoped-home.mjs with node's `--import`, so an ordinary
 * test process — this one — runs with FABERUN_HOME pointed at a throwaway
 * directory, never at the operator's home. Under the ordinary test script the
 * preload has already run when this file is evaluated, and the import below
 * is a cached no-op, so the assertions observe exactly the home the runner
 * set; the import and the static check exist so the proof stays honest when
 * the file is run without the runner (`node --test test/repo/`) and so a
 * regression that drops the preload from the script still fails here.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import "../scoped-home.mjs";

test("the runner scopes FABERUN_HOME for every test process", () => {
  const script = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts.test;
  assert.match(script, /--import\s+\S*test\/scoped-home\.mjs/u, "the test script preloads the scope into every test process");

  const home = process.env.FABERUN_HOME;
  assert.ok(home, "the test process runs with FABERUN_HOME set");
  const resolved = resolve(home);
  assert.ok(resolved.startsWith(tmpdir() + sep), `${resolved} must resolve inside the OS temp directory`);
  assert.notEqual(resolved, resolve(homedir()), "the suite never runs against the operator's real home");
});
