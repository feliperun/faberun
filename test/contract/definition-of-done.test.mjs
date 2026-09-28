import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertInlineScriptProofsParse,
  assertProofCommandsParse,
  inlineScriptBody,
  inlineScriptParseError,
  unclosedQuote,
} from "../../src/contract/definition-of-done.mjs";

test("a proof command that cannot parse refuses the launch", () => {
  const nodes = [{
    id: "r9-named",
    definitionOfDone: [
      { id: "parseable", text: "The script runs", proof: { kind: "command", ref: "node -e 'console.log(1)'" } },
      { id: "apostrophe", text: "The script runs", proof: { kind: "command", ref: "node -e 'const value = ('" } },
    ],
  }];

  assert.throws(
    () => assertInlineScriptProofsParse(nodes),
    (error) => {
      assert.ok(error instanceof TypeError, "the refusal is a validation TypeError");
      assert.match(error.message, /node r9-named/u, "names the node");
      assert.match(error.message, /apostrophe/u, "names the definition-of-done item");
      assert.match(error.message, /does not parse/u);
      return true;
    },
  );
});

// Measured 2026-09-27 (AP13 of safe-to-hand-to-friend): the freeze accepted a
// proof whose unquoted --test-name-pattern held an apostrophe, `/bin/sh -c`
// refused it with "unexpected EOF while looking for matching `'`", the node's
// work passed its own test in 15 s, and both attempts were spent on a command
// the shell never ran.
test("a proof command the shell cannot parse refuses the launch", () => {
  const nodes = [{
    id: "r8-offline-first-campaign",
    definitionOfDone: [
      { id: "proof", text: "The first campaign completes offline", proof: { kind: "command", ref: "node --test --test-name-pattern=a stranger's first campaign completes offline test/evals/offline.test.mjs" } },
    ],
  }];

  assert.throws(
    () => assertProofCommandsParse(nodes),
    (error) => {
      assert.ok(error instanceof TypeError, "the refusal is a validation TypeError");
      assert.match(error.message, /node r8-offline-first-campaign/u, "names the node");
      assert.match(error.message, /item "proof"/u, "names the definition-of-done item");
      assert.match(error.message, /leaves a ' open/u);
      return true;
    },
  );

  assert.equal(unclosedQuote(`node --test --test-name-pattern="a stranger's first campaign" test/evals/offline.test.mjs`), null, "an apostrophe inside double quotes is literal");
  assert.equal(unclosedQuote(`grep -q "don't" file`), null);
  assert.equal(unclosedQuote("node -e 'const value = ('"), null, "a body that does not parse closes its own quotes");
  assert.equal(unclosedQuote('node -e "unterminated'), '"');
  assert.equal(unclosedQuote("echo don't"), "'");
  // A backslash inside single quotes is literal, so it does not escape the
  // closing quote; inside double quotes it does.
  assert.equal(unclosedQuote("node -e 'don\\'"), null, "a backslash inside single quotes does not escape the closing quote");
  assert.equal(unclosedQuote('echo "a\\"b"'), null, "a backslash inside double quotes escapes the quote after it");
});

test("an inline script body is read from node -e and checked by node's own parser", () => {
  assert.equal(inlineScriptBody("node -e 'const value = 1'"), "const value = 1");
  assert.equal(inlineScriptBody("node --eval \"const value = 1\""), "const value = 1");
  // `-e` on another command is not node's, so no body is found.
  assert.equal(inlineScriptBody("grep -e value src/file.mjs"), null);
  assert.equal(inlineScriptBody("node --test test/contract/definition-of-done.test.mjs"), null);

  assert.equal(inlineScriptParseError("node -e 'console.log(1)'"), null);
  assert.equal(inlineScriptParseError("node -e 'const value = ('"), "Unexpected end of input");
  // node's `-e` evaluates in a module wrapper, so top-level await parses there.
  assert.equal(inlineScriptParseError("node -e 'await Promise.resolve(1)'"), null);
  // A real error after the await still surfaces through the async re-try.
  assert.notEqual(inlineScriptParseError("node -e 'await value; const y = ('"), null);
  assert.equal(inlineScriptParseError("npm run test"), null);
});
