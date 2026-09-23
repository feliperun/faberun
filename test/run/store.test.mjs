import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../src/run/store.mjs";

test("an atomic write replaces a file another process is reading", async () => {
  // Windows refuses to rename onto a file any process holds open; this is the
  // shape that killed controllers on CI -- a test polling a node file while the
  // controller rewrote it. Measured 2026-09-23: without the retry, over a third
  // of these writes failed with EPERM.
  const directory = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const path = join(directory, "node.json");
  const stop = join(directory, "stop");
  writeJsonAtomic(path, { write: 0 });
  const reader = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    process.stdout.write("ready\\n");
    while (!fs.existsSync(${JSON.stringify(stop)})) { try { fs.readFileSync(${JSON.stringify(path)}); } catch {} }
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await once(reader.stdout, "data");
  const exited = once(reader, "exit");
  const writes = 500;
  try {
    for (let write = 1; write <= writes; write += 1) writeJsonAtomic(path, { write, pad: "x".repeat(2000) });
  } finally {
    writeFileSync(stop, "");
    await exited;
  }
  assert.equal(readJson(path).write, writes);
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
});
