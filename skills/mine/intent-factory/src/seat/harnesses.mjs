/**
 * The operator harness registry: how to launch an interactive harness, how to
 * recognize it from the environment, and whether it can render ambient state.
 *
 * The seat is where a human talks to a harness; it is not a second worker
 * engine. These five entries are the whole operator surface and each one
 * declares exactly three facts. The worker registry in `harnesses/` answers a
 * different question with a much larger interface, and keeping the two apart is
 * why this is one declarative file instead of a folder per harness.
 *
 * `canRenderAmbient` is true only for claude, the single harness with a
 * statusLine surface (TECH-SPEC 2026-09-12 §3.2). An `envMarker` is the
 * variable the harness leaves in the shell it starts, so the registry can name
 * the harness a seat is already inside without probing a process table.
 *
 * @typedef {Readonly<{argv: readonly string[], envMarker: string, canRenderAmbient: boolean}>} OperatorHarness
 */

/** @type {Readonly<Record<string, OperatorHarness>>} */
export const OPERATOR_HARNESSES = Object.freeze({
  claude: Object.freeze({ argv: Object.freeze(["claude"]), envMarker: "CLAUDECODE", canRenderAmbient: true }),
  codex: Object.freeze({ argv: Object.freeze(["codex"]), envMarker: "CODEX_SANDBOX", canRenderAmbient: false }),
  zcode: Object.freeze({ argv: Object.freeze(["zcode"]), envMarker: "ZCODE_MODEL", canRenderAmbient: false }),
  dsh: Object.freeze({ argv: Object.freeze(["dsh"]), envMarker: "DSH_PERMISSION_MODE", canRenderAmbient: false }),
  agy: Object.freeze({ argv: Object.freeze(["agy"]), envMarker: "AGY_MODEL", canRenderAmbient: false }),
});

/**
 * @param {string} name
 * @returns {boolean}
 */
export function canRenderAmbient(name) {
  const harness = /** @type {OperatorHarness|undefined} */ (OPERATOR_HARNESSES[name]);
  return harness?.canRenderAmbient === true;
}

/**
 * The operator harness this process is running inside, or null. Detection is
 * marker-based on purpose: the markers above are the only environment facts a
 * harness guarantees, and reading them costs nothing.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function detectOperatorHarness(env = process.env) {
  for (const [name, harness] of Object.entries(OPERATOR_HARNESSES)) {
    if (env[harness.envMarker] !== undefined) return name;
  }
  return null;
}

/**
 * The operator harness a pane's current command names, or null while the pane
 * is still a shell or has moved on to something the registry does not know.
 * The registry's launch argv is the contract: whatever `argv[0]` is, that is
 * the command a live seat of that harness shows.
 *
 * @param {string|null|undefined} command
 * @returns {string|null}
 */
export function detectOperatorHarnessByCommand(command) {
  const name = String(command ?? "").split(/[\\/]/u).at(-1) ?? "";
  for (const [harness, entry] of Object.entries(OPERATOR_HARNESSES)) {
    if (entry.argv[0] === name) return harness;
  }
  return null;
}
