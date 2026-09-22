/**
 * `spec` argv: validate and scaffold a spec document. Both operations are
 * deterministic — `src/plan/spec.mjs` invokes no model — so this file only
 * owns the wire, the same split every other verb module in this directory
 * uses.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";
import { validateSpec } from "../plan/spec.mjs";

/** @typedef {import("../plan/spec.mjs").SpecValidation} SpecValidation */

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  validate: { "strict-traceability": { type: "boolean" }, "run-proofs": { type: "boolean" }, json: { type: "boolean" } },
  scaffold: { id: { type: "string" } },
};

const SCAFFOLD_TEMPLATE = `---
id: <id>
title: "<title>"
version: 1.0.0
status: draft
date: <yyyy-mm-dd>
owner: <owner>
target: <org/repo>
baseline: <git sha>
---

# <title>

## Intent

<Why this work, what problem, what it unblocks.>

## Requirements

### R1. <title>

- **statement:** <the testable claim>
- **proof:** \`command: <shell command>\`

## Non-goals

- <what this spec explicitly excludes>
`;

/**
 * @param {string[]} args
 * @returns {void}
 */
export function specCli(args) {
  const operation = args[0];
  if (!operation || !Object.hasOwn(OPERATION_OPTIONS, operation)) return usage();
  let parsed;
  try {
    parsed = parseFlags({ args: args.slice(1), options: OPERATION_OPTIONS[operation], allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return usage();
  }
  const target = parsed.positionals[0];
  if (!target || parsed.positionals.length > 1) return usage();
  const values = /** @type {{"strict-traceability"?: boolean, "run-proofs"?: boolean, json?: boolean, id?: string}} */ (parsed.values);
  if (operation === "validate") {
    validateSpecFile(resolve(target), {
      strict: values["strict-traceability"] === true,
      runProofs: values["run-proofs"] === true,
      json: values.json === true,
    });
    return;
  }
  try {
    scaffoldSpec(resolve(target), typeof values.id === "string" ? values.id : undefined);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Validate a spec file and print its class, its overall verdict, and one
 * line per finding. Exits `1` when the verdict is not `ok`.
 *
 * `runProofs` is the only operation here that spawns anything: it runs each
 * requirement's declared proof instead of only checking that one is written
 * down. It is opt-in because running a repository's proofs costs real time,
 * and default-off keeps `spec validate` the deterministic, side-effect-free
 * read it has always been.
 *
 * @param {string} path
 * @param {{strict: boolean, json: boolean, runProofs?: boolean}} options
 * @returns {SpecValidation}
 */
export function validateSpecFile(path, { strict, json, runProofs = false }) {
  const result = validateSpec(readFileSync(path, "utf8"), { cwd: process.cwd(), strict, runProofs });
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.class} · ${result.class === "legacy" ? "accepted" : result.ok ? "ok" : "not ok"}\n`);
    for (const finding of result.findings) process.stdout.write(`[${finding.severity}] ${finding.rule}: ${finding.message}\n`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

/**
 * Write an empty document in the spec format at `path`. Refuses to overwrite
 * an existing file.
 *
 * @param {string} path
 * @param {string} [id]
 * @returns {void}
 */
export function scaffoldSpec(path, id) {
  if (existsSync(path)) throw new Error(`refusing to overwrite an existing file: ${path}`);
  writeFileSync(path, id ? SCAFFOLD_TEMPLATE.replace("<id>", id) : SCAFFOLD_TEMPLATE);
  process.stdout.write(`scaffolded ${path}\n`);
}

/** @returns {void} */
function usage() {
  process.stderr.write("usage: faberun spec <validate|scaffold> <path> [--strict-traceability] [--run-proofs] [--json] [--id <value>]\n");
  process.exitCode = 2;
}

export default OPERATION_OPTIONS;
