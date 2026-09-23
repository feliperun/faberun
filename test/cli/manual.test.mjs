import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectSurface, renderManual } from "../../src/cli/manual.mjs";

/** @typedef {import("../../src/cli/manual.mjs").Surface} Surface */

/** @param {Surface} surface @returns {Surface} */
const surfaceOf = (surface) => surface;

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * Every `| ... | ... | ... | ... |` row in a manual, split into cells, except
 * the `— | — | text | —` placeholder a flag-less section carries.
 *
 * @param {string} manual
 * @returns {string[][]}
 */
function flagRows(manual) {
  return manual
    .split("\n")
    .filter((line) => line.startsWith("| `--"))
    .map((line) => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim()));
}

test("manual regenerates today's file without a diff", () => {
  const current = read("../../docs/COMMANDS.md");
  assert.equal(renderManual(current, collectSurface()), current);
});

test("manual covers every flag", () => {
  const current = [
    "## faberun widget",
    "```text",
    "faberun widget",
    "```",
    "Do the widget thing.",
    "",
    "| Flag | Value | Effect | Default |",
    "| --- | --- | --- | --- |",
    "| — | — | No flags. | — |",
    "Reads nothing; writes nothing.",
    "```bash",
    "node src/cli.mjs widget",
    "```",
  ].join("\n");
  const surface = surfaceOf({ verbs: { widget: { flags: { spin: { type: "boolean" } } } } });
  const rendered = renderManual(current, surface);
  const rows = flagRows(rendered);
  assert.deepEqual(rows, [["`--spin`", "<value>", "", "—"]]);

  // The completeness check this test exists to protect: nothing in the real,
  // regenerated manual may carry an empty Effect cell — that is what an
  // undocumented flag looks like.
  const realManual = read("../../docs/COMMANDS.md");
  const undocumented = flagRows(realManual).filter(([, , effect]) => effect === "");
  assert.deepEqual(undocumented, []);
});

test("manual drops removed verbs", () => {
  const current = [
    "## faberun alpha",
    "```text",
    "faberun alpha",
    "```",
    "Alpha does the alpha thing.",
    "",
    "| Flag | Value | Effect | Default |",
    "| --- | --- | --- | --- |",
    "| — | — | No flags. | — |",
    "Reads nothing; writes nothing.",
    "",
    "## faberun beta",
    "```text",
    "faberun beta",
    "```",
    "Beta does the beta thing.",
    "",
    "| Flag | Value | Effect | Default |",
    "| --- | --- | --- | --- |",
    "| — | — | No flags. | — |",
    "Reads nothing; writes nothing.",
  ].join("\n");
  const surface = surfaceOf({ verbs: { beta: { flags: {} } } });
  const rendered = renderManual(current, surface);
  assert.ok(!rendered.includes("## faberun alpha"));
  assert.ok(rendered.includes("## faberun beta"));
});

test("manual preserves authored blocks", () => {
  const current = [
    "## faberun widget",
    "```text",
    "faberun widget <target> [--spin]",
    "```",
    "Spin the named widget until it stops wobbling, a property nobody has ever",
    "measured directly.",
    "",
    "| Flag | Value | Effect | Default |",
    "| --- | --- | --- | --- |",
    "| `--spin` | none | Spin once before reporting. | off |",
    "Reads `<target>`'s state file; writes nothing.",
    "```bash",
    "node src/cli.mjs widget gizmo --spin",
    "```",
    "Related: `faberun doctor`.",
  ].join("\n");
  const surface = surfaceOf({ verbs: { widget: { flags: { spin: { type: "boolean" } } } } });
  const rendered = renderManual(current, surface);
  assert.ok(rendered.includes("Spin the named widget until it stops wobbling, a property nobody has ever\nmeasured directly."));
  assert.ok(rendered.includes("Reads `<target>`'s state file; writes nothing."));
  assert.ok(rendered.includes("node src/cli.mjs widget gizmo --spin"));
  assert.ok(rendered.includes("Related: `faberun doctor`."));
  assert.ok(rendered.includes("| `--spin` | none | Spin once before reporting. | off |"));
});
