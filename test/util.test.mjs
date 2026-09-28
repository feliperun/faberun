import "./scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellWords } from "../src/util.mjs";

test("shellWords reads an escaped quote inside double quotes as part of the word", () => {
  // Measured 2026-09-27: the `node -e "<script>"` shape JSON.stringify writes
  // split at the first escaped quote, and R34 refused a script that parses.
  assert.deepEqual(shellWords('node -e "const fs=require(\\"fs\\");"'), ["node", "-e", 'const fs=require("fs");']);
  assert.deepEqual(shellWords('echo "a\\\\b"'), ["echo", "a\\b"]);
});

test("shellWords keeps every other backslash, so a Windows path survives quoted or not", () => {
  assert.deepEqual(shellWords("dir C:\\Users\\x"), ["dir", "C:\\Users\\x"]);
  assert.deepEqual(shellWords('dir "C:\\Program Files\\x"'), ["dir", "C:\\Program Files\\x"]);
  assert.deepEqual(shellWords("echo 'a\\\"b'"), ["echo", 'a\\"b'], "single quotes take no escape");
});
