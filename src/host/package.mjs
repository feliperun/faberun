/**
 * The installed package's own name and version, read once from `package.json`.
 *
 * It is separate from the contract protocol version: `CONTRACT_VERSION` is the
 * schema `src/` evolves on its own, while this is the release number
 * release-please moves. `--version` and the banner both need the latter from
 * one place, so no source file hard-codes a number the package can outgrow.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @type {{name: string, version: string}} */
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));

/** @returns {string} */
export function packageName() {
  return PACKAGE.name;
}

/** @returns {string} */
export function packageVersion() {
  return PACKAGE.version;
}
