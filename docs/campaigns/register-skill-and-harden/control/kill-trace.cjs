// Preload (NODE_OPTIONS=--require) that records every non-probe process.kill
// issued by any node process inheriting the environment. Measurement tool for
// the verification-runner SIGKILL investigation, 2026-09-16.
const fs = require("node:fs");
const orig = process.kill.bind(process);
const out = process.env.KILL_TRACE_LOG || "/tmp/kill-trace.log";
process.kill = function (pid, sig) {
  if (sig !== 0) {
    const stack = new Error().stack.split("\n").slice(2, 8).map((l) => l.trim());
    fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), from: process.pid, ppid: process.ppid, argv: process.argv.slice(1, 3), target: pid, sig: sig ?? "SIGTERM", stack }) + "\n");
  }
  return orig(pid, sig);
};
