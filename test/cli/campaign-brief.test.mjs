import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeCampaign } from "../../src/campaign/index.mjs";
import { contractDigest } from "../../src/contract/index.mjs";
import { contentDigest, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

// R7: the sharing surface. These tests drive the real CLI in a throwaway
// FABERUN_HOME, with a controlled mdhtml fixture for the success path and an
// absent or failing fixture for the named rendering failures. The pinned
// spec, plan and contract are byte-compared before and after so a generate can
// never edit them.

process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "campaign-brief-cli-home-"));

const CLI = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

const SPEC = `---
id: campaign-brief
title: "Campaign Brief before execution"
version: 1.5.0
status: draft
baseline: d9eae18a917d328326a3a07bdd80d34c379901cc
---

# Campaign Brief before execution

## Intent

An operator should be able to decide in a few minutes whether a frozen plan is worth executing.

## Requirements

### R1. Share the brief

- **statement:** The operator generates the brief explicitly.
- **proof:** command: node --test test/cli/campaign-brief.test.mjs

### R2. Open it in a browser

- **statement:** A local server opens the rendered copy.
- **proof:** command: node --test test/web/campaign-brief-server.test.mjs

## Success criteria

| Measure | Baseline | Target | Evidence |
| --- | --- | --- | --- |
| Pre-execution approval artefact | none | Markdown for one frozen plan | R1 |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A stale copy is mistaken for the current brief | wrong review | remove the HTML on a render failure |

## Human decisions

- Review the generated brief before executing the contract.

## Delegable decisions

- Pick the exact artifact paths.

## Planned evals

- A failing renderer removes the prior HTML copy.
`;

/**
 * @param {string} campaignId
 * @returns {Record<string, any>}
 */
function contract(campaignId) {
  return {
    schemaVersion: 1,
    contractVersion: "0.3.0",
    id: "brief-cli-run",
    campaignId,
    goal: "Generate the Campaign Brief",
    cwd: ".",
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5", vendor: "openai", maxConcurrent: 2 } },
    runtimeDefaults: { worker: "codex", judge: "codex" },
    nodes: [
      {
        id: "n1",
        type: "implement",
        phase: "brief",
        requirementIds: ["R1"],
        runtime: "codex",
        dependsOn: [],
        taskPacket: { verification: [{ argv: ["node", "--test", "test/cli/campaign-brief.test.mjs"] }] },
        definitionOfDone: [{ id: "dod1", proof: { kind: "command", ref: "npm run typecheck" } }],
      },
    ],
  };
}

/**
 * A campaign with one frozen phase plan, ready for `brief generate`.
 *
 * @param {{phase?: string}} [options]
 * @returns {{cwd: string, campaignId: string, campaignPath: string, planDir: string, phase: string}}
 */
function fixture(options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "campaign-brief-cli-"));
  const campaignId = "brief-cli";
  const phase = options.phase ?? "brief";
  const runsDir = runsRoot(cwd);
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId, goal: "Generate an explicit brief" });
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
    phases: [{ id: phase, requirementIds: ["R1"], nodeIds: ["n1"], deliverable: "The explicit brief." }],
    provenance: {
      packageVersion: "0.15.0",
      schemaVersion: 1,
      contractVersion: "0.3.0",
      targetGitHead: "abc123",
      planner: { runtimeId: "codex", model: "gpt-5" },
      reviewer: { runtimeId: "codex", model: "gpt-5" },
      sizing: {},
      findings: [],
    },
    status: "frozen",
    approved: true,
  }));
  return { cwd, campaignId, campaignPath, planDir, phase };
}

/** The controlled mdhtml fixture, steered by FIXTURE_* env vars. */
const FIXTURE_SOURCE = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const fail = process.env.FIXTURE_FAIL ?? "";

function failIf(name) {
  if (fail === name) {
    process.stderr.write("mdhtml: E-TEST-01: " + name + " failed by fixture\n");
    process.exit(1);
  }
}

function option(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (command === "--version" || command === "version") {
  failIf("version");
  process.stdout.write((process.env.FIXTURE_VERSION ?? "mdhtml 1.1.3") + "\n");
  process.exit(0);
}

if (command === "build") {
  failIf("build");
  const input = args[1];
  const output = option("-o");
  if (!input || !output) {
    process.stderr.write("mdhtml: E-CLI-05: build requires <in.md> and -o\n");
    process.exit(2);
  }
  const source = readFileSync(input, "utf8");
  let theme = "";
  const themeLine = /^theme:\s*(.+)$/m.exec(source);
  if (themeLine) {
    const themeName = themeLine[1].trim().replace(/^"|"$/g, "");
    const themePath = join(dirname(resolve(input)), themeName);
    if (existsSync(themePath)) theme = readFileSync(themePath, "utf8");
  }
  const visible = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = "<!doctype html>\n<html lang=\"en\" data-mdhtml-preset=\"faberun\">\n<head><meta charset=\"utf-8\"><title>fixture</title>\n<style id=\"mdhtml-user\">" + theme + "</style>\n</head>\n<body><main>" + visible + "</main>\n<script type=\"application/octet-stream\" id=\"mdhtml-source\">" + Buffer.from(source, "utf8").toString("base64") + "</script>\n</body>\n</html>\n";
  writeFileSync(output, html);
  process.exit(0);
}

if (command === "check") {
  failIf("check");
  process.stdout.write("mdhtml: I-CLI-02: portable: true; requests: 0; content: 1 bytes\n");
  process.exit(0);
}

if (command === "audit") {
  failIf("audit");
  process.stdout.write("SAFE\n");
  process.exit(0);
}

if (command === "extract") {
  failIf("extract");
  const input = args[1];
  const output = option("-o");
  const html = readFileSync(input, "utf8");
  const match = /<script[^>]*id="mdhtml-source"[^>]*>([^<]*)<\/script>/.exec(html);
  if (!match) {
    process.stderr.write("mdhtml: E-CLI-03: source missing\n");
    process.exit(1);
  }
  const source = Buffer.from(match[1].trim(), "base64").toString("utf8");
  if (output) writeFileSync(output, source);
  else process.stdout.write(source);
  process.exit(0);
}

process.stderr.write("mdhtml: E-CLI-05: unknown command " + command + "\n");
process.exit(2);
`;

/** @returns {string} */
function fixtureBin() {
  const dir = mkdtempSync(join(tmpdir(), "campaign-brief-cli-mdhtml-"));
  const script = join(dir, "mdhtml-fixture.mjs");
  writeFileSync(script, `#!${process.execPath}\n${FIXTURE_SOURCE}`);
  if (process.platform === "win32") {
    const shim = join(dir, "mdhtml-fixture.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  chmodSync(script, 0o755);
  return script;
}

/**
 * @param {string} cwd
 * @param {string[]} extra
 * @param {Record<string, string>} [env]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runCli(cwd, extra, env = {}) {
  return spawnSync(process.execPath, [CLI, "campaign", "brief", ...extra, "--cwd", cwd], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("generate writes the Markdown, renders its HTML sibling and prints both absolute paths", () => {
  const { cwd, campaignId, planDir, phase } = fixture();
  const markdownPath = join(planDir, "campaign-brief.md");
  const htmlPath = join(planDir, "campaign-brief.md.html");
  assert.equal(existsSync(markdownPath), false, "freezing writes no brief");

  const result = runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: fixtureBin() });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(markdownPath), "markdown written");
  assert.ok(existsSync(htmlPath), "html written after a successful render");
  assert.match(result.stdout, new RegExp(`\\[brief\\] markdown · ${escapeRegExp(markdownPath)}`, "u"));
  assert.match(result.stdout, new RegExp(`\\[brief\\] html · ${escapeRegExp(htmlPath)}`, "u"));
  const markdown = readFileSync(markdownPath, "utf8");
  assert.match(markdown, /^# Campaign brief — brief-cli$/mu);
  assert.match(markdown, /`R1`/u);
});

test("regenerating from the same snapshots produces the same Markdown bytes", () => {
  const { cwd, campaignId, planDir, phase } = fixture();
  const bin = fixtureBin();
  assert.equal(runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: bin }).status, 0);
  const first = readFileSync(join(planDir, "campaign-brief.md"), "utf8");
  assert.equal(runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: bin }).status, 0);
  assert.equal(readFileSync(join(planDir, "campaign-brief.md"), "utf8"), first);
  assert.ok(existsSync(join(planDir, "campaign-brief.md.html")));
});

test("an absent renderer is a named error that keeps Markdown and removes prior HTML", () => {
  const { cwd, campaignId, planDir, phase } = fixture();
  const markdownPath = join(planDir, "campaign-brief.md");
  const htmlPath = join(planDir, "campaign-brief.md.html");
  writeFileSync(htmlPath, "<!doctype html><html>stale</html>\n", "utf8");

  const result = runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: join(planDir, "absent-mdhtml") });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[fail\] MDHTML_UNAVAILABLE ·/u);
  assert.ok(existsSync(markdownPath), "the Markdown stays usable");
  assert.equal(existsSync(htmlPath), false, "the prior HTML copy is gone");
  assert.match(result.stdout, new RegExp(`\\[brief\\] markdown · ${escapeRegExp(markdownPath)}`, "u"));
});

test("a failing render is a named error that removes prior HTML and never edits the pinned inputs", () => {
  const { cwd, campaignId, campaignPath, planDir, phase } = fixture();
  const bin = fixtureBin();
  const pinned = [
    join(planDir, "contract.json"),
    join(planDir, "plan.json"),
    join(planDir, "plan.json.sha256"),
    join(cwd, "SPEC.md"),
  ];
  const operatorBrief = join(campaignPath, "operator-brief.md");
  writeFileSync(operatorBrief, "continuity capsule\n", "utf8");
  const before = new Map([...pinned, operatorBrief].map((path) => [path, readFileSync(path, "utf8")]));

  // A first successful generate leaves the current HTML in place, so the next
  // failure has a stale copy to remove.
  assert.equal(runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: bin }).status, 0);
  const htmlPath = join(planDir, "campaign-brief.md.html");
  assert.ok(existsSync(htmlPath));

  const result = runCli(cwd, ["generate", campaignId, "--phase", phase], { FABERUN_MDHTML_BIN: bin, FIXTURE_FAIL: "build" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[fail\] MDHTML_BUILD_FAILED ·/u);
  assert.equal(existsSync(htmlPath), false, "the stale HTML copy is removed");
  assert.ok(existsSync(join(planDir, "campaign-brief.md")), "the refreshed Markdown remains");
  for (const [path, text] of before) assert.equal(readFileSync(path, "utf8"), text, `${path} is untouched`);
});

test("a missing phase plan is refused before any artifact is written", () => {
  const { cwd, campaignId } = fixture();
  const result = runCli(cwd, ["generate", campaignId, "--phase", "nope"], { FABERUN_MDHTML_BIN: fixtureBin() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brief frozen plan is missing/u);
  assert.equal(existsSync(join(cwd, "nope")), false);
});

test("a missing --phase is refused and an unknown action is a usage error", () => {
  const { cwd, campaignId, planDir } = fixture();
  const missing = runCli(cwd, ["generate", campaignId], { FABERUN_MDHTML_BIN: fixtureBin() });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --phase/u);

  const action = runCli(cwd, ["render", campaignId, "--phase", "brief"]);
  assert.equal(action.status, 2);
  assert.match(action.stderr, /usage: faberun campaign </u);
  assert.equal(existsSync(join(planDir, "campaign-brief.md")), false);
});

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
