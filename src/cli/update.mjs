/**
 * `faberun update [--check] [--json]`: fetch the latest GitHub release and
 * install it into the versioned home layout.
 *
 * The only command that reaches the network. The release is the channel (tags
 * `vX.Y.Z`), and the tarball is the release's `tarball_url`. A new version
 * proves it runs by printing its own `--version` *before* `current` moves, so a
 * broken release can never take the working install down with it: any failure
 * removes the partial directory and leaves `current` untouched.
 *
 * Version comparison is numeric on the three parts only. Prereleases are out of
 * scope here: `v1.2.3-rc.1` does not parse, and an unparseable tag is an error
 * rather than something to compare as if it were a release.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, currentLink, faberunHome, installedVersionDir, tmpDir, versionsDir, writeUpdateCheck } from "../host/home.mjs";
import { linkDirectory, tarExecutable } from "../host/platform.mjs";
import { packageVersion } from "../host/package.mjs";
import { errorMessage } from "../util.mjs";

/** @typedef {{tag: string, version: string, tarballUrl: string}} Release */
/** @typedef {(text: string) => void} Writer */
/**
 * @typedef {object} UpdateOptions
 * @property {boolean} [check]
 * @property {boolean} [json]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [entryPath]
 * @property {Writer} [stdout]
 * @property {Writer} [stderr]
 */

const RELEASES_URL = "https://api.github.com/repos/feliperun/faberun/releases/latest";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @param {UpdateOptions} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function updateCommand(options = {}) {
  const check = options.check === true;
  const json = options.json === true;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const entryPath = options.entryPath ?? process.argv[1];
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const home = faberunHome(env);
  const current = packageVersion();
  const installed = installedVersionDir(entryPath, home);

  if (!check && !installed) {
    stderr(`faberun is not installed under ${home}; update it the way it was installed (git pull, or re-run install.sh)\n`);
    return 1;
  }

  /** @type {Release} */
  let release;
  try {
    release = await fetchLatestRelease(fetchImpl, env);
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return 1;
  }

  if (check) {
    writeUpdateCheck(home, { checkedAt: new Date().toISOString(), current, latest: release.version });
    if (json) {
      stdout(`${JSON.stringify({ current, latest: release.version, updated: false, installedUnderHome: installed !== null, home })}\n`);
    } else {
      stdout(`faberun ${current} · latest ${release.version}\n`);
      stdout(compareVersions(release.version, current) > 0 ? "update available · run faberun update\n" : "up to date\n");
    }
    return 0;
  }

  if (compareVersions(release.version, current) <= 0) {
    if (json) stdout(`${JSON.stringify({ current, latest: release.version, updated: false, installedUnderHome: true, home })}\n`);
    else stdout("up to date\n");
    return 0;
  }

  try {
    await installRelease(fetchImpl, home, release);
    writeUpdateCheck(home, { checkedAt: new Date().toISOString(), current: release.version, latest: release.version });
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return 1;
  }

  if (json) stdout(`${JSON.stringify({ current: release.version, latest: release.version, updated: true, installedUnderHome: true, home })}\n`);
  else stdout(`updated · ${current} to ${release.version}\n`);
  return 0;
}

/**
 * The latest release's tag, version and tarball URL. A non-2xx response or a
 * tag that is not `vX.Y.Z` is an error, reported as one line by the caller.
 *
 * @param {typeof fetch} fetchImpl
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Release>}
 */
async function fetchLatestRelease(fetchImpl, env) {
  const url = typeof env.FABERUN_RELEASES_URL === "string" && env.FABERUN_RELEASES_URL ? env.FABERUN_RELEASES_URL : RELEASES_URL;
  const response = await fetchImpl(url, { headers: releaseHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`release lookup failed: HTTP ${response.status}`);
  const body = /** @type {Record<string, unknown>} */ (await response.json());
  const parsed = parseTag(body.tag_name);
  if (typeof body.tarball_url !== "string" || !body.tarball_url) throw new Error(`release ${parsed.tag} has no tarball_url`);
  return { tag: parsed.tag, version: parsed.version, tarballUrl: body.tarball_url };
}

/**
 * Parse `vX.Y.Z`. Prerelease and build metadata are deliberately not accepted;
 * the caller reports the tag as an error.
 *
 * @param {unknown} tagName
 * @returns {{tag: string, version: string}}
 */
function parseTag(tagName) {
  if (typeof tagName !== "string") throw new Error("release has no tag_name");
  if (!/^v\d+\.\d+\.\d+$/u.test(tagName)) throw new Error(`release tag is not vX.Y.Z: ${tagName}`);
  return { tag: tagName, version: tagName.slice(1) };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} home
 * @param {Release} release
 * @returns {Promise<void>}
 */
async function installRelease(fetchImpl, home, release) {
  const partial = join(versionsDir(home), `${release.tag}.partial`);
  const destination = join(versionsDir(home), release.version);
  const tarball = join(tmpDir(home), `${release.tag}.tgz`);
  try {
    mkdirSync(tmpDir(home), { recursive: true });
    mkdirSync(partial, { recursive: true });
    await downloadTarball(fetchImpl, release.tarballUrl, tarball);
    extractTarball(tarball, partial);
    verifyVersion(partial, release.version);
    rmSync(destination, { recursive: true, force: true });
    renameSync(partial, destination);
    repointCurrent(home, release.version);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    rmSync(tarball, { force: true });
    throw error;
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function downloadTarball(fetchImpl, url, destination) {
  const response = await fetchImpl(url, { headers: releaseHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`tarball download failed: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * @param {string} tarball
 * @param {string} destination
 * @returns {void}
 */
function extractTarball(tarball, destination) {
  const result = spawnSync(tarExecutable(), ["-xzf", tarball, "--strip-components=1", "-C", destination], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr ?? "").trim() || `exit ${result.status}`}`);
}

/**
 * Run the candidate before it can become `current`: it must exit 0 and print
 * exactly `faberun <version>`.
 *
 * @param {string} partial
 * @param {string} version
 * @returns {void}
 */
function verifyVersion(partial, version) {
  const binary = join(partial, "bin", "faberun.mjs");
  const result = spawnSync(process.execPath, [binary, "--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const printed = String(result.stdout ?? "").trim();
  if (result.status !== 0) throw new Error(`new version failed to run: ${printed || `exit ${result.status}`}`);
  if (printed !== `faberun ${version}`) throw new Error(`new version printed ${printed || "nothing"}; expected faberun ${version}`);
}

/**
 * Point `current` at the new version. `linkDirectory` owns how: a rename over
 * a sibling temporary link where the platform makes that atomic, a remove and
 * remake on Windows where it does not.
 *
 * @param {string} home
 * @param {string} version
 * @returns {void}
 */
function repointCurrent(home, version) {
  // SPEC.md's layout: `current -> versions/<v>`, relative to the home.
  linkDirectory(currentLink(home), join("versions", version));
}

/** @returns {Record<string, string>} */
function releaseHeaders() {
  return { Accept: "application/vnd.github+json", "User-Agent": `faberun/${packageVersion()}` };
}
