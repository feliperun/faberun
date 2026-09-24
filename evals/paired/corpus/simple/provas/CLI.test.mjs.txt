/**
 * Proof for the CLI requirement: `renderUsage()` in `src/cli/brand.mjs` must
 * name the surface the CLI actually dispatches — every flag a top-level
 * command declares in `COMMAND_OPTIONS` (`src/cli.mjs`), and every operation
 * each multi-operation verb declares in its own option table (`seat`, `skills`,
 * `spec`, `contract`, `campaign`).
 *
 * The proof imports those tables instead of retyping the surface, so it fails
 * when the usage omits something the CLI accepts, not when a copy drifts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_OPTIONS } from "../../../src/cli.mjs";
import { renderUsage } from "../../../src/cli/brand.mjs";
import seatOptions from "../../../src/cli/seat.mjs";
import skillsOptions from "../../../src/cli/skills.mjs";
import specOptions from "../../../src/cli/spec.mjs";
import contractOptions from "../../../src/cli/contract.mjs";
import campaignOptions from "../../../src/cli/campaign.mjs";

/** The verbs dispatched through a per-operation option table, and that table. */
const VERB_OPTIONS = {
  seat: seatOptions,
  skills: skillsOptions,
  spec: specOptions,
  contract: contractOptions,
  campaign: campaignOptions,
};

test("the usage has a line naming every top-level command with all of its declared flags", () => {
  const lines = renderUsage().split("\n");
  /** @type {string[]} */
  const missing = [];
  for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
    const flags = Object.keys(options);
    const named = lines.some((line) => line.includes(command) && flags.every((flag) => line.includes(`--${flag}`)));
    if (!named) missing.push(`${command} (${flags.length ? flags.map((flag) => `--${flag}`).join(", ") : "no flags"})`);
  }
  assert.deepEqual(missing, [], `the usage has no line naming: ${missing.join("; ")}`);
});

test("the usage names every operation each verb's own option table declares", () => {
  const lines = renderUsage().split("\n");
  /** @type {string[]} */
  const missing = [];
  for (const [verb, options] of Object.entries(VERB_OPTIONS)) {
    for (const operation of Object.keys(options)) {
      if (!lines.some((line) => line.includes(verb) && line.includes(operation))) missing.push(`${verb} ${operation}`);
    }
  }
  assert.deepEqual(missing, [], `the usage does not name: ${missing.join(", ")}`);
});
