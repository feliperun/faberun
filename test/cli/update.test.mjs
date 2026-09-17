import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderBanner } from "../../src/cli/brand.mjs";
import { updateCommand } from "../../src/cli/update.mjs";
import { readUpdateCheck, writeUpdateCheck } from "../../src/host/home.mjs";
import { packageVersion } from "../../src/host/package.mjs";

const CURRENT = packageVersion();
const NEXT = "99.0.0";
const NEXT_TAG = `v${NEXT}`;

/** @type {import("node:http").Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {Record<string, unknown>} */
let latestBody = {};
/** @type {number} */
let latestStatus = 200;
/** @type {string} */
let tarballPath = "";

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/latest") {
      response.statusCode = latestStatus;
      if (latestStatus !== 200) {
        response.end("server error");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(latestBody));
      return;
    }
    if (request.url === "/tarball" && tarballPath) {
      response.setHeader("content-type", "application/gzip");
      response.end(readFileSync(tarballPath));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

/**
 * Every test runs under a throwaway home and the local server; nothing reaches
 * the network.
 *
 * @returns {string}
 */
function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "faberun-update-"));
  process.env.FABERUN_HOME = home;
  process.env.FABERUN_RELEASES_URL = `${baseUrl}/latest`;
  return home;
}

/**
 * Build a release tarball whose top level is `faberun-x/`, matching what
 * `--strip-components=1` expects. The bin prints the version the updater must
 * verify; `printedVersion` lets a test lie.
 *
 * @param {{version: string, printedVersion?: string}} options
 * @returns {string}
 */
function buildTarball({ version, printedVersion = version }) {
  const root = mkdtempSync(join(tmpdir(), "faberun-release-"));
  const top = join(root, "faberun-x");
  mkdirSync(join(top, "bin"), { recursive: true });
  writeFileSync(join(top, "package.json"), `${JSON.stringify({ name: "faberun", version }, null, 2)}\n`);
  writeFileSync(join(top, "bin", "faberun.mjs"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`faberun ${printedVersion}\n`)});\n`);
  const tarball = join(root, "release.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "faberun-x"]);
  return tarball;
}

/** @param {string} tag @returns {void} */
function serveRelease(tag) {
  latestStatus = 200;
  latestBody = { tag_name: tag, tarball_url: `${baseUrl}/tarball` };
}

/**
 * @param {{check?: boolean, json?: boolean, entryPath?: string}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function run(options) {
  let stdout = "";
  let stderr = "";
  const code = await updateCommand({
    ...options,
    env: process.env,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

test("--check finds a newer release and writes the cache", async () => {
  const home = setupHome();
  tarballPath = buildTarball({ version: NEXT });
  serveRelease(NEXT_TAG);
  const result = await run({ check: true, entryPath: join(home, "versions", CURRENT, "bin", "faberun.mjs") });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`faberun ${CURRENT} · latest ${NEXT.replace(/\./gu, "\\.")}`, "u"));
  assert.match(result.stdout, /update available · run faberun update/u);
  assert.equal(readUpdateCheck(home)?.latest, NEXT);
});

test("--check reports up to date when the release is the running version", async () => {
  const home = setupHome();
  tarballPath = buildTarball({ version: CURRENT });
  serveRelease(`v${CURRENT}`);
  const result = await run({ check: true, entryPath: join(home, "versions", CURRENT, "bin", "faberun.mjs") });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /up to date/u);
  assert.doesNotMatch(result.stdout, /update available/u);
  assert.equal(readUpdateCheck(home)?.latest, CURRENT);
});

test("--check --json reports the machine-readable result", async () => {
  const home = setupHome();
  tarballPath = buildTarball({ version: NEXT });
  serveRelease(NEXT_TAG);
  const result = await run({ check: true, json: true, entryPath: join(home, "versions", CURRENT, "bin", "faberun.mjs") });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { current: CURRENT, latest: NEXT, updated: false, installedUnderHome: true, home });
});

test("update outside the home reports the not-installed line", async () => {
  const home = setupHome();
  const result = await run({ entryPath: join(home, "checkout", "bin", "faberun.mjs") });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /faberun is not installed under/u);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("update installs a newer release and moves current", async () => {
  const home = setupHome();
  const entry = join(home, "versions", CURRENT, "bin", "faberun.mjs");
  mkdirSync(join(home, "versions", CURRENT, "bin"), { recursive: true });
  writeFileSync(entry, "// installed\n");
  tarballPath = buildTarball({ version: NEXT });
  serveRelease(NEXT_TAG);
  const result = await run({ entryPath: entry });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`updated · ${CURRENT} to ${NEXT.replace(/\./gu, "\\.")}`, "u"));
  assert.ok(existsSync(join(home, "versions", NEXT, "bin", "faberun.mjs")), "the new version is installed");
  assert.equal(readlinkSync(join(home, "current")), join("versions", NEXT), "current points at the new version");
  assert.ok(!existsSync(join(home, "versions", `${NEXT_TAG}.partial`)), "the partial directory is gone");
});

test("a release that prints the wrong version leaves current untouched", async () => {
  const home = setupHome();
  const entry = join(home, "versions", CURRENT, "bin", "faberun.mjs");
  mkdirSync(join(home, "versions", CURRENT, "bin"), { recursive: true });
  writeFileSync(entry, "// installed\n");
  symlinkSync(join("versions", CURRENT), join(home, "current"));
  tarballPath = buildTarball({ version: NEXT, printedVersion: "1.2.3" });
  serveRelease(NEXT_TAG);
  const result = await run({ entryPath: entry });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim().split("\n").length, 1, "one line");
  assert.match(result.stderr, /expected faberun /u);
  assert.ok(!existsSync(join(home, "versions", `${NEXT_TAG}.partial`)), "the partial directory is removed");
  assert.equal(readlinkSync(join(home, "current")), join("versions", CURRENT), "current is untouched");
});

test("a failed release lookup exits 1 with one line and no stack trace", async () => {
  const home = setupHome();
  latestStatus = 500;
  const result = await run({ check: true, entryPath: join(home, "versions", CURRENT, "bin", "faberun.mjs") });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test("renderBanner shows the cached hint only when a newer version is known", () => {
  const home = setupHome();
  /** @param {string} latest @returns {string} */
  const banner = (latest) => {
    writeUpdateCheck(home, { checkedAt: new Date().toISOString(), current: "0.4.0", latest });
    return renderBanner({ version: "0.4.0", nodeVersion: "22.0.0", harnessCount: 0, level: 0, env: process.env });
  };
  assert.doesNotMatch(banner("0.4.0"), /update available/u);
  assert.match(banner("0.5.0"), /update available: 0\.5\.0/u);
});
