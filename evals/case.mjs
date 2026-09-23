/**
 * Turning a deterministic eval case on disk into a repository it can run in.
 *
 * A case declares a contract, recordings and a git history; this materialises
 * all three into a throwaway directory. `withModelBinsUnavailable` then removes
 * every provider binary from the environment, which is what makes
 * `--assert-no-model` a proof rather than a promise: a case that secretly
 * reaches a real provider fails to spawn instead of quietly costing money.
 */
import { EVALS_ROOT } from "./paths.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { initializeCampaign } from "../src/campaign/index.mjs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { runDirectory, runsRoot } from "../src/run/paths.mjs";

const DETERMINISTIC_ROOT = join(EVALS_ROOT, "deterministic");
const MODEL_BIN_VARS = [
  "FABERUN_CODEX_BIN",
  "FABERUN_CLAUDE_BIN",
  "FABERUN_AGY_BIN",
  "FABERUN_GLM_BIN",
];
/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
export function safeJoin(root, relativePath) {
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`path escapes the case workspace: ${relativePath}`);
  }
  return resolved;
}
/**
 * @param {string} caseId
 * @returns {string}
 */
export function caseDirFor(caseId) {
  return join(DETERMINISTIC_ROOT, caseId);
}
/** @returns {string[]} */
export function discoverCaseIds() {
  if (!existsSync(DETERMINISTIC_ROOT)) return [];
  return readdirSync(DETERMINISTIC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(DETERMINISTIC_ROOT, entry.name, "case.json")))
    .map((entry) => entry.name)
    .sort();
}
/**
 * @param {string} caseId
 * @returns {{caseDir: string, spec: Record<string, unknown>, expected: Record<string, unknown>}}
 */
export function loadCase(caseId) {
  const caseDir = caseDirFor(caseId);
  const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8"));
  if (spec.id !== caseId) throw new Error(`case.json id "${spec.id}" does not match its directory ${caseId}`);
  return { caseDir, spec, expected };
}
/**
 * @template T
 * @param {Record<string, unknown>|undefined} overlay
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withEnvOverlay(overlay, fn) {
  const keys = Object.keys(overlay ?? {});
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = /** @type {Record<string, unknown>} */ (overlay)[key];
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/**
 * Run `fn` with `FABERUN_HOME` pointed at a fresh, case-scoped temp
 * directory for its whole duration, restored after. Every case's fixture
 * repository resolves its runs root through the same resolver the product
 * itself uses (`materializeCase`/`materializePlanCase` both call `runsRoot`),
 * and a spawned step's child process inherits `process.env` — so without
 * this, every deterministic-eval invocation on a developer's own machine
 * would register its throwaway fixture as a real project and write real
 * state under that operator's actual `~/.faberun`, one eval run at a time.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withScopedFaberunHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "faberun-eval-home-"));
  return withEnvOverlay({ FABERUN_HOME: home }, fn);
}
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withModelBinsUnavailable(fn) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const key of MODEL_BIN_VARS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of MODEL_BIN_VARS) {
      if (previous[key] !== undefined) process.env[key] = previous[key];
    }
  }
}
/**
 * @param {string} workDir
 * @returns {void}
 */
export function initializeGitRepo(workDir) {
  // `.eval-recordings/` is ignored, not merely uncommitted: the replay
  // harness writes a `.cursor` and an `.invocations.jsonl` sidecar next to
  // each recording on every invocation, and a command-kind case's own
  // `faberun plan` drives more than one `run` invocation against this same
  // tree — a second one refuses to launch against a HEAD its own tree has
  // drifted from (`assertLaunchBaseClean`) unless those sidecars are exempt
  // from "dirty" the same way `.runs/` already is.
  writeFileSync(join(workDir, ".gitignore"), "node_modules/\n.runs/\n.eval-recordings/\n");
  writeFileSync(join(workDir, "README.md"), "faberun eval case workspace\n");
  execFileSync("git", ["init", "-q", workDir], { stdio: "ignore" });
  execFileSync("git", ["-C", workDir, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workDir,
    "-c", "user.email=evals@example.test",
    "-c", "user.name=faberun-evals",
    "-c", "commit.gpgSign=false",
    "commit", "-qm", "eval case baseline",
  ], { stdio: "ignore" });
}
/**
 * Set or remove one field inside a contract, addressed by a path of object
 * keys and array indices, in place.
 *
 * @param {Record<string, unknown>} contract
 * @param {{path: (string|number)[], value?: unknown, remove?: boolean}} contractPatch
 * @returns {void}
 */
function applyContractPatch(contract, { path, value, remove }) {
  let target = /** @type {Record<string, unknown>} */ (contract);
  for (const key of path.slice(0, -1)) {
    target = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (target)[key]);
    if (!target || typeof target !== "object") {
      throw new Error(`discriminator "patchContractField" path ${JSON.stringify(path)} does not resolve inside the contract`);
    }
  }
  const lastKey = /** @type {string|number} */ (path[path.length - 1]);
  if (remove) delete target[lastKey];
  else target[lastKey] = value;
}
/**
 * Rewrite one recorded envelope's `error.code` inside a jsonl recording,
 * leaving every other line untouched.
 *
 * @param {string} content
 * @param {{index: number, code: string}} recordingPatch
 * @returns {string}
 */
function patchRecordingErrorCode(content, { index, code }) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`discriminator "patchRecordingErrorCode" index ${index} is out of range for ${lines.length} recorded envelope(s)`);
  }
  const patched = lines.map((line, lineIndex) => {
    if (lineIndex !== index) return line;
    const record = JSON.parse(line);
    if (!record.envelope?.error) throw new Error(`discriminator "patchRecordingErrorCode" line ${index} has no envelope.error to patch`);
    record.envelope = { ...record.envelope, error: { ...record.envelope.error, code } };
    return JSON.stringify(record);
  });
  return `${patched.join("\n")}\n`;
}
/**
 * Set or remove one field inside a single recorded envelope, addressed by a
 * path relative to that envelope (e.g. `["error", "resetAt"]`).
 *
 * @param {string} content
 * @param {{index: number, path: (string|number)[], value?: unknown, remove?: boolean}} recordingPatch
 * @returns {string}
 */
function patchRecordingEnvelopeField(content, { index, path, value, remove }) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`discriminator "patchRecordingEnvelopeField" index ${index} is out of range for ${lines.length} recorded envelope(s)`);
  }
  const patched = lines.map((line, lineIndex) => {
    if (lineIndex !== index) return line;
    const record = JSON.parse(line);
    let target = record.envelope;
    if (!target || typeof target !== "object") throw new Error(`discriminator "patchRecordingEnvelopeField" line ${index} has no envelope to patch`);
    for (const key of path.slice(0, -1)) {
      target = /** @type {Record<string, unknown>} */ (target)[key];
      if (!target || typeof target !== "object") {
        throw new Error(`discriminator "patchRecordingEnvelopeField" path ${JSON.stringify(path)} does not resolve inside line ${index}'s envelope`);
      }
    }
    const lastKey = /** @type {string|number} */ (path[path.length - 1]);
    if (remove) delete /** @type {Record<string, unknown>} */ (target)[lastKey];
    else /** @type {Record<string, unknown>} */ (target)[lastKey] = value;
    return JSON.stringify(record);
  });
  return `${patched.join("\n")}\n`;
}
/**
 * Copy one declared recording into a fresh case-local recordings directory,
 * applying a discriminator's recording patch when it targets this runtime.
 * A relative `error.resetAt` (`"+3000"`) is copied as written: the replay
 * binary resolves it when it emits the envelope. Resolving it here started the
 * window before git init, campaign init and the controller's own startup, and
 * on a Windows runner those outlasted the three seconds -- D04's reset landed
 * in the past and the node failed over. Shared by `materializeCase` (a
 * contract-kind case) and `materializePlanCase` (a command-kind case), which
 * otherwise build two different things around the copied file.
 *
 * @param {string} caseId
 * @param {string} caseDir
 * @param {string} recordingsDir
 * @param {string} runtimeId
 * @param {string} filename
 * @param {({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null|undefined} recordingPatch
 * @returns {string}
 */
function copyRecording(caseId, caseDir, recordingsDir, runtimeId, filename, recordingPatch) {
  const source = join(caseDir, filename);
  if (!existsSync(source)) throw new Error(`case ${caseId} declares recording ${filename} for runtime ${runtimeId}, but the file does not exist`);
  const dest = join(recordingsDir, filename);
  let content = readFileSync(source, "utf8");
  if (recordingPatch && recordingPatch.runtime === runtimeId) {
    content = "code" in recordingPatch
      ? patchRecordingErrorCode(content, recordingPatch)
      : patchRecordingEnvelopeField(content, recordingPatch);
  }
  writeFileSync(dest, content);
  return dest;
}

/**
 * Materialize one case's contract into a fresh temporary git repository, with
 * every recording copied in and every declared runtime's
 * `config["replay.recording"]` pointed at that copy.
 *
 * @param {string} caseDir
 * @param {Record<string, unknown>} spec
 * @param {{contractPatch?: {path: (string|number)[], value?: unknown, remove?: boolean}|null, recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}} [patch]
 * @returns {{workDir: string, contractPath: string, runDir: string, contract: Record<string, unknown>}}
 */
export function materializeCase(caseDir, spec, patch = {}) {
  const workDir = mkdtempSync(join(tmpdir(), `faberun-eval-${spec.id}-`));
  initializeGitRepo(workDir);

  const recordings = /** @type {Record<string, string>} */ (spec.recordings ?? {});
  const recordingsDir = join(workDir, ".eval-recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const contract = JSON.parse(JSON.stringify(spec.contract));
  delete contract.cwd;
  if (patch.contractPatch) applyContractPatch(contract, patch.contractPatch);
  for (const [runtimeId, filename] of Object.entries(recordings)) {
    const dest = copyRecording(/** @type {string} */ (spec.id), caseDir, recordingsDir, runtimeId, filename, patch.recordingPatch);
    const runtime = contract.runtimes?.[runtimeId];
    if (!runtime) throw new Error(`case ${spec.id} declares a recording for unknown runtime ${runtimeId}`);
    contract.runtimes[runtimeId] = { ...runtime, config: { ...(runtime.config ?? {}), "replay.recording": dest } };
  }

  const contractPath = join(workDir, "contract.json");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  initializeCampaign(runsRoot(workDir), { campaignId: contract.campaignId, goal: contract.goal });

  const runDir = runDirectory(workDir, contract.id);
  return { workDir, contractPath, runDir, contract };
}

/**
 * Materialize a command-kind case: a `case.json` carrying `command` instead
 * of `contract`. Same temp git repository and recording-copy machinery as
 * `materializeCase`, but the thing under test is `faberun plan` itself, so
 * there is no single contract to write — instead, every fixture file the
 * planning pipeline reads (the spec, the taskKind catalogue, and anything
 * `--runtimes` names) is written from the case's own `files` map, and a
 * runtime catalogue built from `spec.runtimes` (with recordings substituted
 * in exactly the same way a contract's `runtimes` field gets them) is written
 * to `runtimes.json` at the workspace root — the path `command.argv` names
 * after `--runtimes`.
 *
 * @param {string} caseDir
 * @param {Record<string, unknown>} spec
 * @param {{recordingPatch?: ({runtime: string, index: number, code: string}|{runtime: string, index: number, path: (string|number)[], value?: unknown, remove?: boolean})|null}} [patch]
 * @returns {{workDir: string, runtimesPath: string, campaignId: string}}
 */
export function materializePlanCase(caseDir, spec, patch = {}) {
  const workDir = mkdtempSync(join(tmpdir(), `faberun-eval-${spec.id}-`));

  const files = /** @type {Record<string, string>} */ (spec.files ?? {});
  for (const [relativePath, content] of Object.entries(files)) {
    const target = safeJoin(workDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const recordings = /** @type {Record<string, string>} */ (spec.recordings ?? {});
  const recordingsDir = join(workDir, ".eval-recordings");
  mkdirSync(recordingsDir, { recursive: true });
  const runtimes = JSON.parse(JSON.stringify(spec.runtimes ?? {}));
  for (const [runtimeId, filename] of Object.entries(recordings)) {
    const dest = copyRecording(/** @type {string} */ (spec.id), caseDir, recordingsDir, runtimeId, filename, patch.recordingPatch);
    const runtime = runtimes[runtimeId];
    if (!runtime) throw new Error(`case ${spec.id} declares a recording for unknown runtime ${runtimeId}`);
    runtimes[runtimeId] = { ...runtime, config: { ...(runtime.config ?? {}), "replay.recording": dest } };
  }
  const runtimesPath = join(workDir, "runtimes.json");
  writeFileSync(runtimesPath, `${JSON.stringify(runtimes, null, 2)}\n`);

  initializeGitRepo(workDir);

  const campaign = /** @type {{id?: string, goal?: string}} */ (spec.campaign ?? {});
  if (!campaign.id) throw new Error(`case ${spec.id} needs a "campaign" object with an "id"`);
  initializeCampaign(runsRoot(workDir), { campaignId: campaign.id, goal: campaign.goal ?? "" });

  return { workDir, runtimesPath, campaignId: campaign.id };
}
