/**
 * `contract validate`: validate an authored contract from the command line and
 * print the report the authoring turn reads (TECH-SPEC lean, rule 4: a
 * partly finished run is continued by `resume`, never re-authored, so this is
 * the only contract operation the CLI carries).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs as parseFlags } from "node:util";
import { loadPersistedContract, validateContract } from "../contract/index.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  validate: { "strict-traceability": { type: "boolean" } },
};

/**
 * @param {string[]} args
 * @returns {void}
 */
export function contractCli(args) {
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
  const values = /** @type {{"strict-traceability"?: boolean}} */ (parsed.values);
  if (operation === "validate") validateContractFile(resolve(target), { strictTraceability: values["strict-traceability"] === true });
}

/**
 * Validate an authored contract and print the same report the `validate`
 * command has always printed. A single-node contract is simply valid.
 *
 * A contract.json that sits beside a run.json is a persisted run's frozen copy,
 * not an authored contract: it takes the tree-free persisted path and must
 * match the digest recorded at launch. Every other target keeps today's
 * authoring validation, tree reads included.
 *
 * @param {string} path
 * @param {{strictTraceability?: boolean}} [options]
 * @returns {ValidatedContract}
 */
export function validateContractFile(path, { strictTraceability = false } = {}) {
  const runJsonPath = join(dirname(path), "run.json");
  const contract = existsSync(runJsonPath)
    ? loadPersistedContract(path, readRunDigest(runJsonPath))
    : validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const count = contract.warnings.length;
  const blockingTraceability = strictTraceability
    ? contract.warnings.filter((warning) => isTraceabilityFinding(warning))
    : [];
  process.stdout.write(`${blockingTraceability.length > 0 ? "invalid" : "valid"}${count ? ` (${count} warning${count === 1 ? "" : "s"})` : ""}\n`);
  for (const warning of contract.warnings) process.stdout.write(`[warn] ${warning}\n`);
  if (blockingTraceability.length > 0) process.exitCode = 1;
  return contract;
}

/** @param {string} warning @returns {boolean} */
function isTraceabilityFinding(warning) {
  return warning.includes("judgment_without_reason") || warning.includes("judgment_beside_mechanical_proof");
}

/**
 * @param {string} runJsonPath
 * @returns {string|undefined}
 */
function readRunDigest(runJsonPath) {
  const metadata = JSON.parse(readFileSync(runJsonPath, "utf8"));
  return typeof metadata.contractDigest === "string" ? metadata.contractDigest : undefined;
}

/** @returns {void} */
function usage() {
  process.stderr.write("usage: faberun contract validate <contract.json> [--strict-traceability]\n");
  process.exitCode = 2;
}

export default OPERATION_OPTIONS;
