/**
 * The suite must never notify a person or wake a session. Every controller a
 * fixture runs would otherwise deliver its terminal events through whatever
 * transport the operator's shell happens to carry: `FABERUN_NOTIFY_BIN`
 * flooded a phone with fixture nodes once (2026-09-16), and
 * `FABERUN_NOTIFY_SESSION` -- which a seat window sets to `auto` -- woke a
 * live Claude Code session seven times in a few minutes (2026-09-21) before
 * this file existed. Both variables are neutralised here unconditionally: the
 * variable *being* set is the dangerous case, so "only when unset" is the
 * wrong guard. A test that exercises a transport sets its own value inside
 * the test and restores it afterward.
 *
 * Loaded two ways so no path escapes it: `npm test` preloads it into every
 * test process with `node --import`, and `test/helpers.mjs` imports it for a
 * file run on its own. `test/notify/env-guard.test.mjs` pins both, and pins
 * that every `FABERUN_NOTIFY_*` name `src/notify` exports is named here.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.FABERUN_NOTIFY_SESSION;
// The event filter and the language override shape what a receipt records
// and how a message reads; a test asserts both from the defaults.
delete process.env.FABERUN_NOTIFY_EVENTS;
delete process.env.FABERUN_NOTIFY_LANG;

// A no-op transport rather than none: with the variable unset the outbox
// records `no_transport`, and tests that assert a `delivered` receipt need a
// transport that exists and exits 0 without doing anything.
const noop = join(mkdtempSync(join(tmpdir(), "runner-noop-notify-")), "noop-notify.mjs");
writeFileSync(noop, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n`);
chmodSync(noop, 0o755);
process.env.FABERUN_NOTIFY_BIN = noop;
