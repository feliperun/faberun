import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertInlineScriptProofsParse,
  inlineScriptBody,
  inlineScriptParseError,
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
