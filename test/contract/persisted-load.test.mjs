/**
 * Done-when 2.1: a persisted load is pure.
 *
 * The eight cases here test the contract the phase fixes: a run's stored
 * contract.json loads without reading the tree it was authored against, so a
 * run whose working tree drifted after the work landed stays readable and
 * resumable. Case 5 is the structural guard against an exemption-list
 * implementation: with `node:fs` mocked to permit nothing but reading the
 * handed contract.json, a persisted load still succeeds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractDigest, loadPersistedContract, validateContract } from "../../src/contract/index.mjs";
import { serializableContract } from "../../src/engine/run-identity.mjs";
import { renderStatus } from "../../src/report/render.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { validateContractFile } from "../../src/cli/contract.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/harnesses/index.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";

const MODULE_URL = new URL("../../src/contract/index.mjs", import.meta.url).href;

/** A throwaway repository with the files every static fixture needs. @param {string} prefix @returns {string} */
function repoDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "README.md"), "read me\n");
  writeFileSync(join(directory, "src", "mod.mjs"), "export const mod = 1;\n");
  return directory;
}

/**
 * A two-node contract: `writer` produces a test that `producer`'s module
 * becomes bound to once it lands. Neither conflict exists at authoring time,
 * because the test file is not on disk yet.
 *
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
function staticContract(id) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    campaignId: "persisted-load-campaign",
    goal: "prove a persisted load is pure",
    cwd: ".",
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "test-model", executable: "/nonexistent/codex" },
      judge: { harness: "claude", model: "judge-model", executable: "/nonexistent/claude" },
    },
    nodes: [
      {
        id: "writer",
        type: "backend",
        phase: "p0",
        gate: false,
        taskPacket: packet({ objective: "write the test", readFiles: ["README.md"], writeFiles: ["test/thing.test.mjs"] }),
      },
      {
        id: "producer",
        type: "backend",
        phase: "p1",
        gate: false,
        taskPacket: packet({ objective: "write the module", readFiles: ["README.md"], writeFiles: ["src/mod.mjs"] }),
      },
    ],
  };
}

/**
 * Author and validate a contract against the live tree, store the serialized
 * validated contract as the run's frozen contract.json, and record the digest
 * a run creation would have persisted in run.json.
 *
 * @param {string} directory
 * @param {Record<string, unknown>} raw
 * @returns {{contractPath: string, digest: string, stored: Record<string, unknown>}}
 */
function persistStaticRun(directory, raw) {
  const contractPath = join(directory, "contract.json");
  writeFileSync(contractPath, `${JSON.stringify(raw, null, 2)}\n`);
  const authored = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  writeFileSync(contractPath, `${JSON.stringify(serializableContract(authored), null, 2)}\n`);
  const stored = JSON.parse(readFileSync(contractPath, "utf8"));
  const digest = contractDigest(stored);
  writeFileSync(join(directory, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: "2026-09-14T00:00:00.000Z",
    sourceIdentity: {
      kind: "run",
      contractId: raw.id,
      campaignId: raw.campaignId,
      cwd: directory,
      gitHead: null,
      dirtyTreeFingerprint: null,
      packetHashes: {},
      harnessVersions: {},
    },
    contractDigest: digest,
    scopeDecision: { at: "2026-09-14T00:00:00.000Z", base: null, dirtyTreeFingerprint: null },
  }, null, 2)}\n`);
  return { contractPath, digest, stored };
}

/** The landed file that makes the static contract's producer scope conflict. @param {string} directory */
function landDrift(directory) {
  mkdirSync(join(directory, "test"), { recursive: true });
  writeFileSync(join(directory, "test", "thing.test.mjs"), 'import { mod } from "../src/mod.mjs";\nvoid mod;\n');
}

test("done-when 1: landed cwd drift loads persisted where authoring refuses it", () => {
  const directory = repoDir("runner-persisted-drift-");
  const { contractPath, digest, stored } = persistStaticRun(directory, staticContract("persisted-drift-run"));
  landDrift(directory);
  const raw = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.throws(() => validateContract(raw, contractPath), /task packet scope does not close/u, "authoring reads the landed tree");
  const loaded = validateContract(raw, contractPath, { persisted: true });
  assert.equal(loaded.nodes.length, 2);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(contractDigest(stored), digest);
  assert.doesNotThrow(() => loadPersistedContract(contractPath, digest));
});

test("done-when 2: resume proceeds on a run whose cwd tree drifted after landing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-resume-"));
  const path = writeContract(directory, fixture({
    id: "persisted-resume-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      gate: false,
      taskPacket: packet({ objective: "produce the module", writeFiles: ["src/mod.mjs"], symbols: ["mod"] }),
    }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  mkdirSync(join(directory, "test"));
  writeFileSync(join(directory, "test", "drift.test.mjs"), 'import { mod } from "../src/mod.mjs";\nvoid mod;\n');
  const contractPath = join(runDir, "contract.json");
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath),
    /task packet scope does not close/u,
  );
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.states.get("build")?.status, "done");
});

test("done-when 3: status renders the node table on a drifted run with no STATUS.md", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-status-"));
  const path = writeContract(directory, fixture({
    id: "persisted-status-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      gate: false,
      taskPacket: packet({ objective: "produce the module", writeFiles: ["src/mod.mjs"], symbols: ["mod"] }),
    }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  mkdirSync(join(directory, "test"));
  writeFileSync(join(directory, "test", "drift.test.mjs"), 'import { mod } from "../src/mod.mjs";\nvoid mod;\n');
  rmSync(join(runDir, "STATUS.md"), { force: true });
  assert.equal(existsSync(join(runDir, "STATUS.md")), false, "no pre-rendered STATUS.md may mask the load");
  const rendered = renderStatus(runDir);
  assert.match(rendered, /## Nodes/u);
  assert.match(rendered, /build/u);
  assert.match(rendered, /done/u);
});

test("done-when 4: a deleted readFile, a symlinked writeRoot and a missing verification cwd still load", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-wider-"));
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "testdir"));
  mkdirSync(join(directory, "elsewhere"));
  // Git tracks no empty directory: the placeholder carries testdir into the
  // isolated attempt worktree the controller verification runs inside.
  writeFileSync(join(directory, "testdir", "keep.txt"), "");
  const path = writeContract(directory, fixture({
    id: "persisted-wider-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      gate: false,
      taskPacket: packet({
        mode: "autonomous",
        readFiles: ["README.md"],
        writeFiles: undefined,
        writeRoots: ["src"],
        verification: [{ argv: ["true"], cwd: "testdir" }],
      }),
    }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  unlinkSync(join(directory, "README.md"));
  rmSync(join(directory, "src"), { recursive: true, force: true });
  symlinkSync("elsewhere", join(directory, "src"), "dir");
  rmSync(join(directory, "testdir"), { recursive: true, force: true });
  const contractPath = join(runDir, "contract.json");
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath),
    /verification\[0\]\.cwd must name a directory inside cwd/u,
  );
  assert.match(renderStatus(runDir), /build/u);
  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(resumed.states.get("build")?.status, "done");
});

test("done-when 5: a persisted load succeeds with node:fs mocked to allow only its contract.json", () => {
  const directory = repoDir("runner-persisted-pure-");
  const { contractPath, digest } = persistStaticRun(directory, staticContract("persisted-pure-run"));
  const work = mkdtempSync(join(tmpdir(), "runner-persisted-pure-child-"));
  const loaderPath = join(work, "loader.mjs");
  const childPath = join(work, "child.mjs");
  writeFileSync(loaderPath, purityLoaderSource());
  writeFileSync(childPath, purityChildSource());
  const result = spawnSync(process.execPath, [childPath, contractPath, digest, MODULE_URL, loaderPath], { encoding: "utf8" });
  assert.equal(result.status, 0, `purity child failed: ${result.stderr}`);
  assert.match(result.stdout, /PURE_OK:2:blocked/u, "the load succeeded and an authoring validation in the same process was denied the tree");
});

test("done-when 6: a persisted contract whose frozen fields changed is rejected while every packetHash stays identical", () => {
  const directory = repoDir("runner-persisted-tamper-");
  const raw = staticContract("persisted-tamper-run");
  const { contractPath, digest } = persistStaticRun(directory, raw);
  const base = JSON.parse(readFileSync(contractPath, "utf8"));
  const packetHash = base.nodes[0].packetHash;
  /** @type {[string, (target: Record<string, any>) => void][]} */
  const mutations = [
    ["DAG", (target) => { target.nodes[1].dependsOn = ["writer"]; }],
    ["gate", (target) => { target.nodes[0].gate = { enabled: true, review: "advisory", failOn: ["critical"] }; }],
    ["runtime selection", (target) => { target.runtimeDefaults.judge = "worker"; }],
    ["timeouts", (target) => { target.nodes[0].timeoutSec = 1234; }],
    ["definition of done", (target) => { target.nodes[0].definitionOfDone = [{ id: "works", text: "It works", judgment: true }]; }],
    ["finalVerification", (target) => { target.finalVerification = [{ argv: ["true"] }]; }],
  ];
  for (const [label, mutate] of mutations) {
    const target = structuredClone(base);
    mutate(target);
    assert.equal(target.nodes[0].packetHash, packetHash, `${label}: packetHash must be untouched`);
    writeFileSync(contractPath, `${JSON.stringify(target, null, 2)}\n`);
    assert.doesNotThrow(
      () => validateContract(target, contractPath, { persisted: true }),
      `${label}: the mutated contract is still structurally valid, so only the digest can refuse it`,
    );
    assert.throws(() => loadPersistedContract(contractPath, digest), /does not match the contractDigest/u, `${label} must be rejected`);
    assert.throws(() => validateContractFile(contractPath), /does not match the contractDigest/u, `${label} must be rejected through the CLI path`);
  }
});

test("done-when 7: authoring still refuses a missing readFile and a working-tree-only cross-node conflict", () => {
  const missing = repoDir("runner-persisted-authoring-");
  const missingRaw = /** @type {any} */ (staticContract("persisted-authoring-run"));
  missingRaw.nodes[0].taskPacket.readFiles = ["missing.txt"];
  const missingPath = join(missing, "contract.json");
  writeFileSync(missingPath, `${JSON.stringify(missingRaw, null, 2)}\n`);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(missingPath, "utf8")), missingPath),
    /nodes\[0\]\.taskPacket\.readFiles\[0\] does not exist: missing\.txt/u,
  );

  const conflict = repoDir("runner-persisted-authoring-drift-");
  const { contractPath } = persistStaticRun(conflict, staticContract("persisted-authoring-drift-run"));
  landDrift(conflict);
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath),
    /task packet scope does not close.*test\/thing\.test\.mjs/u,
  );
});

test("done-when 8: contractDigest and scopeDecision survive creation, a resume and a relaunch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-persisted-records-"));
  const path = writeContract(directory, fixture({ id: "persisted-records-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const runJsonPath = join(runDir, "run.json");
  const created = JSON.parse(readFileSync(runJsonPath, "utf8"));
  assert.match(created.contractDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    created.contractDigest,
    contractDigest(JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"))),
    "the recorded digest is the stored contract's canonical digest",
  );
  assert.equal(created.scopeDecision.base, created.sourceIdentity.gitHead);
  assert.equal(typeof created.scopeDecision.at, "string");

  await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const resumed = JSON.parse(readFileSync(runJsonPath, "utf8"));
  assert.equal(resumed.contractDigest, created.contractDigest, "a resume preserves the contract digest");
  assert.deepEqual(resumed.scopeDecision, created.scopeDecision, "a resume preserves the launch scope decision");

  await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const relaunched = JSON.parse(readFileSync(runJsonPath, "utf8"));
  assert.equal(relaunched.contractDigest, created.contractDigest, "a metadata rewrite preserves the contract digest");
  assert.deepEqual(relaunched.scopeDecision, created.scopeDecision, "a metadata rewrite preserves the launch scope decision");
});

/**
 * The fs names the contract graph imports; every one but readFileSync throws.
 * The list must track the graph's imports, not its calls: a name missing here
 * breaks the import itself, before any call can be judged (measured
 * 2026-09-19: store.mjs grew an ftruncateSync import and the purity child
 * failed to load).
 */
const MOCK_FS_NAMES = [
  "accessSync", "appendFileSync", "chmodSync", "closeSync", "existsSync", "fstatSync", "fsyncSync",
  "ftruncateSync", "linkSync", "lstatSync", "mkdirSync", "mkdtempSync", "openSync", "readdirSync",
  "readFileSync", "readlinkSync", "readSync", "realpathSync", "renameSync", "rmSync", "statSync",
  "symlinkSync", "unlinkSync", "writeFileSync", "writeSync",
];

/** @returns {string} */
function purityLoaderSource() {
  const mockModule = [
    'import realFs from "node:fs";',
    "const allow = process.env.MOCK_FS_ALLOW;",
    "const thrower = (name) => (...args) => {",
    '  if (name === "readFileSync" && String(args[0]) === allow) return realFs.readFileSync(...args);',
    '  throw new Error("unexpected filesystem access: fs." + name);',
    "};",
    ...MOCK_FS_NAMES.map((name) => `export const ${name} = thrower(${JSON.stringify(name)});`),
    "export const constants = realFs.constants;",
    "export default realFs;",
  ].join("\n");
  return `const mockUrl = "mock-fs://core";
const mockSource = ${JSON.stringify(mockModule)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs" && context.parentURL !== mockUrl) return { url: mockUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === mockUrl) return { format: "module", shortCircuit: true, source: mockSource };
  return nextLoad(url, context);
}
`;
}

/** @returns {string} */
function purityChildSource() {
  return `import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [contractPath, expectedDigest, moduleUrl, loaderPath] = process.argv.slice(2);
process.env.MOCK_FS_ALLOW = contractPath;
register(pathToFileURL(loaderPath).href, import.meta.url);
const raw = JSON.parse(readFileSync(contractPath, "utf8"));
const mod = await import(moduleUrl);
const contract = mod.loadPersistedContract(contractPath, expectedDigest || undefined);
let authoringAccess = "none";
try {
  mod.validateContract(raw, contractPath);
  authoringAccess = "allowed";
} catch (error) {
  authoringAccess = /unexpected filesystem access/u.test(String(error.message)) ? "blocked" : "threw";
}
process.stdout.write("PURE_OK:" + contract.nodes.length + ":" + authoringAccess);
`;
}
