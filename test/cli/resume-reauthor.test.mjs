import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { COMMAND_OPTIONS, discoverReauthorAdditions, resumeOptionsOf } from "../../src/cli.mjs";
import { reauthorApproved } from "../../src/contract/scope-findings.mjs";

/**
 * R10's CLI half: `faberun resume` exposes the reauthor mode as `--reauthor
 * <node-id>`, forwards it to the resume engine with the CLI's discovery pass,
 * and gates the applied widening on the same `--approve-below` vocabulary the
 * planning pipeline uses. The engine's own widening, validation and resume
 * behavior is proved by `test/engine/resume-reauthor.test.mjs`.
 */

test("resume declares --reauthor and its approval flag", () => {
  const resume = COMMAND_OPTIONS.resume;
  assert.ok(resume.reauthor, "resume must declare --reauthor");
  assert.equal(resume.reauthor.type, "string");
  assert.ok(resume["approve-below"], "resume must reuse the plan approval-level spelling");
  assert.equal(resume["approve-below"].type, "string");
});

test("the resume parser accepts --reauthor <node-id> and --approve-below", () => {
  const { values } = parseArgs({
    args: ["--reauthor", "build", "--approve-below", "high"],
    options: COMMAND_OPTIONS.resume,
    allowPositionals: true,
    strict: true,
  });
  assert.equal(values.reauthor, "build");
  assert.equal(values["approve-below"], "high");
});

test("resumeOptionsOf forwards the reauthor node and the CLI discovery pass", () => {
  const options = resumeOptionsOf({ reauthor: "build" });
  const reauthor = options.reauthor;
  assert.ok(reauthor, "resumeOptionsOf must return the reauthor option");
  assert.equal(reauthor.node, "build");
  assert.equal(typeof reauthor.discover, "function");
  assert.equal(reauthor.approveBelow, undefined, "the default approval threshold stays the engine's standard");

  const additions = discoverReauthorAdditions({ missingContext: ["src/extra.mjs"] });
  assert.deepEqual(additions.readFiles, ["src/extra.mjs"]);
  assert.deepEqual(additions.writeFiles, ["src/extra.mjs"]);
});

test("resumeOptionsOf carries the explicit approval level", () => {
  const options = resumeOptionsOf({ reauthor: "build", "approve-below": "high" });
  const reauthor = options.reauthor;
  assert.ok(reauthor);
  assert.equal(reauthor.approveBelow, "high");
  // The CLI passes the threshold through to the engine's own decision, which
  // is the same gate the planner applies: a blocking-review node is withheld
  // below `high` and applied at `high`.
  const blocking = /** @type {any} */ ({ gate: { enabled: true, review: "blocking" } });
  assert.equal(reauthorApproved(blocking, { approveBelow: reauthor.approveBelow }), true);
  assert.equal(reauthorApproved(blocking), false);
});

test("resume refuses a --reauthor target that conflicts with --node", () => {
  assert.throws(
    () => resumeOptionsOf({ reauthor: "b", node: "a" }),
    /--reauthor b conflicts with --node a/u,
  );
});

test("resume refuses --reauthor combined with --answer", () => {
  assert.throws(
    () => resumeOptionsOf({ reauthor: "b", answer: "a=/tmp/a.md" }),
    /--reauthor b cannot be combined with --answer a/u,
  );
});

test("resume refuses an approval level outside the plan vocabulary", () => {
  assert.throws(
    () => resumeOptionsOf({ reauthor: "build", "approve-below": "wide" }),
    /--approve-below must be one of standard, high, none/u,
  );
  assert.throws(
    () => resumeOptionsOf({ "approve-below": "high" }),
    /--approve-below requires --reauthor/u,
  );
});

test("the generated manual names --reauthor on the resume entry point", () => {
  const manual = readFileSync(fileURLToPath(new URL("../../docs/COMMANDS.md", import.meta.url)), "utf8");
  const start = manual.indexOf("## faberun resume");
  const end = manual.indexOf("## faberun cancel");
  assert.ok(start >= 0 && end > start, "docs/COMMANDS.md must carry the resume section");
  const resume = manual.slice(start, end);
  assert.match(resume, /--reauthor <value>/u);
  assert.match(resume, /\| `--reauthor` \| node id \|/u);
});
