import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPrivateBind, loadBearerToken, resolveBindAddress } from "../../src/web/boundary.mjs";
import { startServer } from "../../src/web/server.mjs";

const TOKEN = "boundary-test-bearer-7f3d9c2e5a8146b0";
const AUTH = { authorization: `Bearer ${TOKEN}` };

test("web refuses public bind", async () => {
  const world = makeWorld();
  try {
    await assert.rejects(startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, host: "0.0.0.0" }), /IPv4 wildcard/u);
    await assert.rejects(startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, host: "203.0.113.10" }), /not a private address/u);
    assert.throws(() => assertPrivateBind("::"), /IPv6 wildcard/u);
    assert.throws(() => assertPrivateBind("::ffff:203.0.113.10"), /not a private address/u);
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("web requires token", async () => {
  const world = makeWorld();
  try {
    await assert.rejects(startServer({ runsDir: world.runsDir, tokenFile: join(world.directory, "absent.token"), port: 0 }), /missing or unreadable/u);
    const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
    const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    try {
      assert.equal((await fetch(`${base}/`)).status, 401);
      assert.equal((await fetch(`${base}/`, { headers: { authorization: "Bearer not-the-token" } })).status, 401);
      assert.equal((await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`)).status, 400);
      assert.equal((await fetch(`${base}/`, { headers: AUTH })).status, 200);
    } finally {
      server.close();
    }
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

test("web token never logged", async () => {
  const world = makeWorld();
  const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0 });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  /** @type {string[]} */
  const captured = [];
  const restore = captureProcessOutput(captured);
  try {
    for (const [label, path, headers] of /** @type {[string, string, Record<string, string>|undefined][]} */ ([
      ["no header", "/", undefined],
      ["wrong header", "/", { authorization: "Bearer not-the-token" }],
      ["token as query param", `/?token=${encodeURIComponent(TOKEN)}`, undefined],
      ["token as a disguised param", `/?campaign=${encodeURIComponent(TOKEN)}`, undefined],
      ["authorized page", "/", AUTH],
      ["authorized 404", "/nope", AUTH],
    ])) {
      const response = await fetch(`${base}${path}`, headers ? { headers } : {});
      captured.push(`${label} → ${response.status}`);
      for (const [, value] of response.headers) captured.push(value);
      captured.push(await response.text());
    }
  } finally {
    restore();
    server.close();
    rmSync(world.directory, { recursive: true, force: true });
  }
  assert.ok(captured.some((chunk) => chunk.includes("Faberun")), "the capture must include real output, not just refusals");
  for (const chunk of captured) {
    assert.equal(chunk.includes(TOKEN), false, "the token value must not appear in any captured output");
  }
});

test("web binds the private interface", async () => {
  const world = makeWorld();
  try {
    for (const admissible of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.254", "192.168.1.4", "100.126.74.93", "100.127.255.1", "::1"]) {
      assert.equal(assertPrivateBind(admissible), admissible);
    }
    assert.equal(await resolveBindAddress("100.126.74.93"), "100.126.74.93");
    assert.ok(["127.0.0.1", "::1"].includes(await resolveBindAddress("localhost")), "localhost resolves through the local resolver");
    assert.equal(loadBearerToken(world.tokenFile), TOKEN);
    const server = await startServer({ runsDir: world.runsDir, tokenFile: world.tokenFile, port: 0, host: "127.0.0.1" });
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    try {
      assert.equal(address.address, "127.0.0.1");
      const page = await fetch(`http://127.0.0.1:${address.port}/`, { headers: AUTH });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Faberun/u);
    } finally {
      server.close();
    }
  } finally {
    rmSync(world.directory, { recursive: true, force: true });
  }
});

/** @returns {{directory: string, runsDir: string, tokenFile: string}} */
function makeWorld() {
  const directory = mkdtempSync(join(tmpdir(), "faberun-boundary-"));
  const tokenFile = join(directory, "dashboard.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  return { directory, runsDir: join(directory, ".runs"), tokenFile };
}

/**
 * Forwards every stdout/stderr write unchanged while copying it into `sink`, so
 * a test can assert that a secret never reached process output. Console output
 * lands here too: the console writes through these streams.
 *
 * @param {string[]} sink
 * @returns {() => void} restore, which must run in the test's `finally`
 */
function captureProcessOutput(sink) {
  const patched = [process.stdout, process.stderr].map((stream) => {
    const original = /** @type {SimpleWrite} */ (stream.write.bind(stream));
    /**
     * @param {string | Uint8Array} chunk
     * @param {BufferEncoding} [encoding]
     * @param {(error?: Error | null) => void} [callback]
     * @returns {boolean}
     */
    const wrapper = (chunk, encoding, callback) => {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return original(chunk, encoding, callback);
    };
    stream.write = /** @type {typeof stream.write} */ (wrapper);
    return { stream, original };
  });
  return () => {
    for (const { stream, original } of patched) stream.write = /** @type {typeof stream.write} */ (original);
  };
}

/**
 * @typedef {(chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => boolean} SimpleWrite
 */
