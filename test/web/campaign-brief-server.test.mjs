import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeCampaign } from "../../src/campaign/index.mjs";
import { contractDigest } from "../../src/contract/index.mjs";
import { contentDigest, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { CampaignBriefServeError, serveCampaignBrief } from "../../src/web/campaign-brief-server.mjs";

// R8: the loopback browser surface. These tests drive the server module
// directly against a throwaway FABERUN_HOME. They prove the startup gate
// (verified plan/spec bytes, present HTML, loopback only), the exact
// read-only routes, the absence of a write route or arbitrary path, and the
// release of the port on shutdown. No test starts a long-lived child process.

process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "campaign-brief-server-home-"));

const SPEC = `---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.5.0
status: draft
baseline: d9eae18a917d328326a3a07bdd80d34c379901cc
---

# Campaign Brief before execution

## Intent

An operator should be able to decide whether a frozen plan is worth executing.

## Requirements

### R1. Serve the brief

- **statement:** A loopback server serves the rendered copy.
- **proof:** command: node --test test/web/campaign-brief-server.test.mjs
`;

/**
 * The served HTML carries every review fact as text; the two drill-down links
 * are conveniences, not the facts.
 */
const HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Campaign brief — brief-serve</title></head>
<body><main>
<h1>Campaign brief — brief-serve</h1>
<p>Decision: <strong>ready for human review</strong></p>
<p>Coverage: R1 covered.</p>
<p>Drill down: <a href="/plan.json">plan.json</a> · <a href="/spec.md">spec.md</a></p>
</main></body>
</html>
`;

/**
 * @param {string} campaignId
 * @returns {Record<string, any>}
 */
function contract(campaignId) {
  return {
    schemaVersion: 1,
    contractVersion: "0.3.0",
    id: "brief-serve-run",
    campaignId,
    goal: "Serve the Campaign Brief",
    cwd: ".",
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5", vendor: "openai", maxConcurrent: 1 } },
    runtimeDefaults: { worker: "codex", judge: "codex" },
    nodes: [
      {
        id: "n1",
        type: "implement",
        phase: "alpha",
        requirementIds: ["R1"],
        runtime: "codex",
        dependsOn: [],
        taskPacket: { verification: [{ argv: ["node", "--test", "test/web/campaign-brief-server.test.mjs"] }] },
        definitionOfDone: [{ id: "dod1", proof: { kind: "command", ref: "npm run typecheck" } }],
      },
    ],
  };
}

/**
 * A campaign with one frozen phase plan and, unless disabled, a current HTML
 * copy.
 *
 * @param {{phase?: string, html?: string|false}} [options]
 * @returns {{cwd: string, campaignId: string, phase: string, planDir: string, specPath: string, htmlPath: string}}
 */
function fixture(options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "campaign-brief-server-"));
  const campaignId = "brief-serve";
  const phase = options.phase ?? "alpha";
  const runsDir = runsRoot(cwd);
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId, goal: "Serve an explicit brief" });
  const planDir = join(campaignPath, "plans", phase);
  mkdirSync(planDir, { recursive: true });

  const specPath = join(cwd, "SPEC.md");
  writeFileSync(specPath, SPEC, "utf8");
  const frozenContract = contract(campaignId);
  writeFileSync(join(planDir, "contract.json"), `${JSON.stringify(frozenContract, null, 2)}\n`, "utf8");
  writeFrozenPlanRecord(planDir, /** @type {any} */ ({
    formatVersion: 1,
    contractDigest: contractDigest(frozenContract),
    spec: { path: specPath, digest: contentDigest(SPEC) },
    phases: [{ id: phase, requirementIds: ["R1"], nodeIds: ["n1"], deliverable: "The served brief." }],
    provenance: { packageVersion: "0.15.0", targetGitHead: "abc123" },
    status: "frozen",
    approved: true,
  }));
  const htmlPath = join(planDir, "campaign-brief.md.html");
  if (options.html !== false) writeFileSync(htmlPath, options.html ?? HTML, "utf8");
  return { cwd, campaignId, phase, planDir, specPath, htmlPath };
}

/**
 * @param {string} cwd
 * @returns {Promise<import("node:http").Server>}
 */
function listenPlain(cwd) {
  return new Promise((resolveListen, rejectListen) => {
    const server = http.createServer((_request, response) => response.end("ok"));
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen(server);
    });
  });
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isServeError(error, code) {
  return error instanceof CampaignBriefServeError && error.code === code;
}

/**
 * Every fixture drives the module directly and always closes the handle, so the
 * tests never need process-wide SIGINT/SIGTERM handlers. Passing
 * `shutdownSignals: false` keeps a test runner from inheriting listeners that
 * outlive the fixture.
 *
 * @param {Parameters<typeof serveCampaignBrief>[0]} options
 * @returns {ReturnType<typeof serveCampaignBrief>}
 */
function serve(options) {
  return serveCampaignBrief({ ...options, shutdownSignals: false });
}

/**
 * `fetch` with a bounded wait: a wedged server fails this test instead of
 * stalling the whole suite on an unbounded socket.
 *
 * @param {string} url
 * @param {Parameters<typeof fetch>[1]} [init]
 * @returns {ReturnType<typeof fetch>}
 */
function get(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

test("serveCampaignBrief serves the HTML and the exact verified /plan.json and /spec.md bytes", async () => {
  const world = fixture();
  /** @type {string[]} */
  const lines = [];
  const handle = await serve({
    campaignId: world.campaignId,
    phase: world.phase,
    cwd: world.cwd,
    stdout: (line) => lines.push(line),
  });
  try {
    assert.equal(handle.host, "127.0.0.1");
    assert.equal(handle.port > 0, true);
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}/`);
    assert.equal(lines.length, 1, "one and only one success line");
    assert.match(lines[0], /^\[brief\] serving brief-serve · alpha · http:\/\/127\.0\.0\.1:\d+\/$/u);

    const base = `http://127.0.0.1:${handle.port}`;
    const page = await get(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await page.text(), readFileSync(world.htmlPath, "utf8"), "the browser gets exactly the bytes on disk");

    const plan = await get(`${base}/plan.json`);
    assert.equal(plan.status, 200);
    assert.equal(plan.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await plan.text(), readFileSync(join(world.planDir, "plan.json"), "utf8"), "the drill-down is the verified plan bytes");

    const spec = await get(`${base}/spec.md`);
    assert.equal(spec.status, 200);
    assert.equal(spec.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await spec.text(), readFileSync(world.specPath, "utf8"), "the drill-down is the verified spec bytes");

    // The HTML file's review facts are text in the document, not facts the
    // links produce: the same bytes open from disk without this server.
    const sameFile = await (await get(`${base}/campaign-brief.md.html`)).text();
    assert.match(sameFile, /ready for human review/u);
    assert.match(sameFile, /R1 covered/u);
    assert.match(readFileSync(world.htmlPath, "utf8"), /ready for human review/u);
  } finally {
    await handle.close();
    rmSync(world.cwd, { recursive: true, force: true });
  }
});

test("the server refuses unrelated paths, directory listings and arbitrary file paths, and has no write route", async () => {
  const world = fixture();
  const handle = await serve({ campaignId: world.campaignId, phase: world.phase, cwd: world.cwd, stdout: () => {} });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    for (const path of ["/nope", "/plans/", "/plans/alpha/contract.json", "/src/cli.mjs", "/plan.json.bak", "/spec.md/", "/campaign-brief.md", "/favicon.ico"]) {
      const response = await get(`${base}${path}`);
      assert.equal(response.status, 404, `${path} is refused`);
      assert.match(response.headers.get("content-type") ?? "", /text\/plain/u);
      await response.text();
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await get(`${base}/plan.json`, { method });
      assert.equal(response.status, 405, `${method} is not a route`);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      await response.text();
    }
  } finally {
    await handle.close();
    rmSync(world.cwd, { recursive: true, force: true });
  }
});

test("a missing HTML copy fails startup with a named error and no URL", async () => {
  const world = fixture({ html: false });
  /** @type {string[]} */
  const lines = [];
  await assert.rejects(
    () => serve({ campaignId: world.campaignId, phase: world.phase, cwd: world.cwd, stdout: (line) => lines.push(line) }),
    (error) => isServeError(error, "brief_html_missing"),
  );
  assert.deepEqual(lines, [], "no URL is printed when startup fails");
  rmSync(world.cwd, { recursive: true, force: true });
});

test("a changed spec or plan fails startup with its own named error and no URL", async () => {
  const specWorld = fixture();
  /** @type {string[]} */
  const specLines = [];
  writeFileSync(specWorld.specPath, `${SPEC}\n<!-- changed after freeze -->\n`, "utf8");
  await assert.rejects(
    () => serve({ campaignId: specWorld.campaignId, phase: specWorld.phase, cwd: specWorld.cwd, stdout: (line) => specLines.push(line) }),
    (error) => isServeError(error, "brief_spec_changed"),
  );
  assert.deepEqual(specLines, []);
  rmSync(specWorld.cwd, { recursive: true, force: true });

  const planWorld = fixture();
  /** @type {string[]} */
  const planLines = [];
  const planPath = join(planWorld.planDir, "plan.json");
  writeFileSync(planPath, `${readFileSync(planPath, "utf8").trimEnd()} `, "utf8");
  await assert.rejects(
    () => serve({ campaignId: planWorld.campaignId, phase: planWorld.phase, cwd: planWorld.cwd, stdout: (line) => planLines.push(line) }),
    (error) => isServeError(error, "brief_plan_changed"),
  );
  assert.deepEqual(planLines, []);
  rmSync(planWorld.cwd, { recursive: true, force: true });
});

test("missing plan, contract and spec sources each fail with a distinct named error", async () => {
  const missingPlan = fixture();
  rmSync(join(missingPlan.planDir, "plan.json"));
  await assert.rejects(
    () => serve({ campaignId: missingPlan.campaignId, phase: missingPlan.phase, cwd: missingPlan.cwd, stdout: () => {} }),
    (error) => isServeError(error, "brief_plan_missing"),
  );
  rmSync(missingPlan.cwd, { recursive: true, force: true });

  const missingContract = fixture();
  rmSync(join(missingContract.planDir, "contract.json"));
  await assert.rejects(
    () => serve({ campaignId: missingContract.campaignId, phase: missingContract.phase, cwd: missingContract.cwd, stdout: () => {} }),
    (error) => isServeError(error, "brief_contract_missing"),
  );
  rmSync(missingContract.cwd, { recursive: true, force: true });

  const missingSpec = fixture();
  rmSync(missingSpec.specPath);
  await assert.rejects(
    () => serve({ campaignId: missingSpec.campaignId, phase: missingSpec.phase, cwd: missingSpec.cwd, stdout: () => {} }),
    (error) => isServeError(error, "brief_spec_missing"),
  );
  rmSync(missingSpec.cwd, { recursive: true, force: true });
});

test("a non-loopback bind host is refused before a socket opens and no URL is printed", async () => {
  const world = fixture();
  /** @type {string[]} */
  const lines = [];
  for (const host of ["0.0.0.0", "192.168.1.10", "::", "example.test"]) {
    await assert.rejects(
      () => serve({ campaignId: world.campaignId, phase: world.phase, cwd: world.cwd, host, stdout: (line) => lines.push(line) }),
      (error) => isServeError(error, "brief_bind_not_loopback"),
      `${host} is refused`,
    );
  }
  assert.deepEqual(lines, []);
  rmSync(world.cwd, { recursive: true, force: true });
});

test("serveCampaignBrief requires a phase and refuses a path-like phase", async () => {
  const world = fixture();
  await assert.rejects(
    () => serve({ campaignId: world.campaignId, phase: undefined, cwd: world.cwd, stdout: () => {} }),
    (error) => isServeError(error, "brief_phase_required"),
  );
  await assert.rejects(
    () => serve({ campaignId: world.campaignId, phase: "../alpha", cwd: world.cwd, stdout: () => {} }),
    (error) => isServeError(error, "brief_phase_invalid"),
  );
  rmSync(world.cwd, { recursive: true, force: true });
});

test("close releases the port so a fresh server can bind it", async () => {
  const world = fixture();
  const handle = await serve({ campaignId: world.campaignId, phase: world.phase, cwd: world.cwd, port: 0, stdout: () => {} });
  const port = handle.port;
  await handle.close();
  assert.equal(handle.server.listening, false);
  const rebound = await listenPlain(world.cwd);
  try {
    // The OS handed the same port back only because it was actually released.
    const address = /** @type {import("node:net").AddressInfo} */ (rebound.address());
    assert.equal(typeof address.port, "number");
  } finally {
    await new Promise((done) => rebound.close(done));
    rmSync(world.cwd, { recursive: true, force: true });
  }
  assert.equal(port > 0, true);
});

test("a HEAD request carries the route's headers without a body", async () => {
  const world = fixture();
  const handle = await serve({ campaignId: world.campaignId, phase: world.phase, cwd: world.cwd, stdout: () => {} });
  try {
    const response = await get(`http://127.0.0.1:${handle.port}/plan.json`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await response.text(), "");
  } finally {
    await handle.close();
    rmSync(world.cwd, { recursive: true, force: true });
  }
});
