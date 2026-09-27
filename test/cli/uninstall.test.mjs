import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { applyUninstall, planUninstall, removalHome, uninstallCommand } from "../../src/cli/uninstall.mjs";
import { installSettingsEntry } from "../../src/host/install-registry.mjs";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { packageName } from "../../src/host/package.mjs";

/**
 * A throwaway effective home and its own `$FABERUN_HOME`, kept as separate
 * trees so removing the faberun home never becomes removing the home.
 *
 * @param {string} prefix
 * @returns {{root: string, home: string, faberun: string, env: NodeJS.ProcessEnv}}
 */
function scopedHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const faberun = join(home, ".faberun");
  return { root, home, faberun, env: { ...process.env, HOME: home, FABERUN_HOME: faberun, FORCE_COLOR: "0" } };
}

/** @returns {{write: (text: string) => void, text: () => string}} */
function capture() {
  /** @type {string[]} */
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

/** @param {string} home @param {string} relative @returns {string} */
function under(home, relative) {
  return join(home, ...relative.split("/"));
}

/**
 * The faberun skills a `skills register` / `setup` lays down under the known
 * sites, each with the `SKILL.md` that marks the tree as the tool's.
 *
 * @param {string} home
 * @returns {string[]}
 */
function installSkills(home) {
  const relatives = [".claude/skills/faberun", ".codex/skills/faberun", ".agents/skills/faberun"];
  for (const relative of relatives) {
    const dir = under(home, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# faberun skill\n");
  }
  return relatives.map((relative) => under(home, relative));
}

test("uninstall removes everything faberun wrote outside the repository", async () => {
  const { home, faberun, env } = scopedHome("uninstall-all-");
  const repo = join(home, "target-repo");
  // A repository's own `.claude/skills/faberun` is not a known install site and
  // must survive: removal is never derived from a target tree.
  mkdirSync(under(repo, ".claude/skills/faberun"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# keep me\n");
  writeFileSync(join(under(repo, ".claude/skills/faberun"), "SKILL.md"), "repo-local skill must stay\n");

  const skills = installSkills(home);
  const settingsPath = under(home, ".claude/settings.json");
  const statusline = { type: "command", command: "sh ~/.faberun/current/integrations/claude-code/statusline.sh" };
  // A recorded status-line install: the registry knows the exact pointer/value.
  installSettingsEntry(env, {
    kind: "statusline",
    path: settingsPath,
    root: join(home, ".claude"),
    harness: "claude",
    pointer: "/statusLine",
    value: statusline,
  });
  // A pre-registry hook, recognized only by the known site plus ownership.
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.permissions = { allow: ["Bash(git status)"] };
  settings.hooks = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/neighbour.mjs" }] },
      { matcher: "Write", hooks: [{ type: "command", command: "node ~/.faberun/current/src/host/tool-policy-hook.mjs" }] },
    ],
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`);

  mkdirSync(faberun, { recursive: true });
  writeFileSync(join(faberun, "config.json"), "{}\n");

  const out = capture();
  const err = capture();
  const code = await uninstallCommand({ env, yes: true, stdout: out.write, stderr: err.write });
  assert.equal(code, 0, err.text());

  for (const skill of skills) assert.equal(existsSync(skill), false, `${skill} removed`);
  const cleaned = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(Object.hasOwn(cleaned, "statusLine"), false, "the recorded status-line entry is removed");
  assert.deepEqual(cleaned.permissions, { allow: ["Bash(git status)"] }, "a neighbouring settings key survives");
  assert.deepEqual(
    cleaned.hooks.PreToolUse,
    [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/neighbour.mjs" }] }],
    "the operator's hook survives and faberun's is removed",
  );
  assert.equal(existsSync(faberun), false, "$FABERUN_HOME is removed");
  assert.equal(existsSync(join(repo, "README.md")), true, "the repository survives");
  assert.equal(existsSync(under(repo, ".claude/skills/faberun")), true, "a repository's own file is never touched");
  assert.ok(out.text().includes(`npm uninstall -g ${packageName()}`), "the published-package removal is named");
});

test("uninstall dry run lists and removes nothing", async () => {
  const { home, faberun, env } = scopedHome("uninstall-dry-");
  const skills = installSkills(home);
  mkdirSync(faberun, { recursive: true });
  writeFileSync(join(faberun, "config.json"), "{}\n");

  const out = capture();
  const code = await uninstallCommand({ env, dryRun: true, stdout: out.write, stderr: () => {} });
  assert.equal(code, 0);
  assert.match(out.text(), /dry run/u);
  for (const skill of skills) assert.equal(existsSync(skill), true, "dry run leaves every artifact in place");
  assert.equal(existsSync(faberun), true, "dry run leaves the home in place");
});

test("uninstall refuses an unpreserved ledger without force", async () => {
  const { faberun, env } = scopedHome("uninstall-ledger-");
  const runsDir = join(faberun, "projects", "p1", "runs");
  const created = initializeCampaign(runsDir, { campaignId: "unpreserved", goal: "Keep the evidence" });

  const err = capture();
  const refused = await uninstallCommand({ env, yes: true, stdout: () => {}, stderr: err.write });
  assert.equal(refused, 1);
  assert.match(err.text(), /unpreserved/u);
  assert.match(err.text(), /--force/u);
  assert.equal(existsSync(join(created.path, "campaign.json")), true, "the only copy of the evidence survives the refusal");

  const forced = await uninstallCommand({ env, yes: true, force: true, stdout: () => {}, stderr: () => {} });
  assert.equal(forced, 0);
  assert.equal(existsSync(faberun), false, "--force removes the home and its unpreserved ledger");
});

test("uninstall refuses without confirmation when no terminal can answer", async () => {
  const { home, env } = scopedHome("uninstall-refuse-");
  const [skill] = installSkills(home);
  const err = capture();
  const code = await uninstallCommand({ env, isTTY: false, stdout: () => {}, stderr: err.write });
  assert.equal(code, 1);
  assert.match(err.text(), /confirmation required/u);
  assert.equal(existsSync(skill), true, "an unconfirmed removal changes nothing");
});

test("uninstall keeps the effective home whole when FABERUN_HOME points at it", async () => {
  const root = mkdtempSync(join(tmpdir(), "uninstall-home-guard-"));
  const skill = under(root, ".claude/skills/faberun");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# faberun skill\n");
  const env = { ...process.env, HOME: root, FABERUN_HOME: root, FORCE_COLOR: "0" };
  const err = capture();
  const code = await uninstallCommand({ env, yes: true, stdout: () => {}, stderr: err.write });
  assert.equal(code, 0, err.text());
  assert.match(err.text(), /effective home/u);
  assert.equal(existsSync(root), true, "the home itself is never removed");
  assert.equal(existsSync(skill), false, "the owned artifact is still removed");
});

test("uninstall removes artifacts that predate the registry", async () => {
  // No install-registry.json at all: every artifact below is older than the
  // registry and is found only by walking the published known install sites and
  // testing ownership, so nothing here may depend on a recorded entry.
  const { home, faberun, env } = scopedHome("uninstall-preregistry-");
  const skills = installSkills(home);
  const settingsPath = under(home, ".claude/settings.json");
  mkdirSync(under(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({
    statusLine: { type: "command", command: "sh ~/.faberun/current/integrations/claude-code/statusline.sh" },
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/neighbour.mjs" }] },
        { matcher: "Write", hooks: [{ type: "command", command: "node ~/.faberun/current/src/host/tool-policy-hook.mjs" }] },
      ],
    },
  })}\n`);
  const hooksDir = under(home, ".claude/hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "faberun-tool-policy.mjs"), "// faberun pre-registry hook\n");
  writeFileSync(join(hooksDir, "neighbour.mjs"), "// the operator's own hook\n");
  mkdirSync(faberun, { recursive: true });
  writeFileSync(join(faberun, "config.json"), "{}\n");
  assert.equal(existsSync(join(faberun, "install-registry.json")), false, "the registry is absent");

  const err = capture();
  const code = await uninstallCommand({ env, yes: true, stdout: () => {}, stderr: err.write });
  assert.equal(code, 0, err.text());

  for (const skill of skills) assert.equal(existsSync(skill), false, `${skill} removed`);
  const cleaned = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(Object.hasOwn(cleaned, "statusLine"), false, "the pre-registry status line is removed");
  assert.deepEqual(cleaned.permissions, { allow: ["Bash(git status)"] }, "a neighbouring settings key survives");
  assert.deepEqual(
    cleaned.hooks.PreToolUse,
    [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/neighbour.mjs" }] }],
    "the pre-registry hook is removed and the operator's survives",
  );
  assert.equal(existsSync(join(hooksDir, "faberun-tool-policy.mjs")), false, "the pre-registry hook script is removed");
  assert.equal(existsSync(join(hooksDir, "neighbour.mjs")), true, "a neighbouring hook script survives");
  assert.equal(existsSync(faberun), false, "$FABERUN_HOME is removed");
});

test("uninstall leaves a repository-like file under home untouched", async () => {
  const { home, faberun, env } = scopedHome("uninstall-repo-file-");
  // A target repository checked out under the effective home. Its own `.claude`
  // tree is repository content, not a known install site, so every file in it
  // must survive the removal -- status line, hook, skill and all.
  const repo = join(home, "target-repo");
  const repoSettings = under(repo, ".claude/settings.json");
  mkdirSync(dirname(repoSettings), { recursive: true });
  writeFileSync(repoSettings, `${JSON.stringify({
    statusLine: { type: "command", command: "sh ~/.faberun/current/integrations/claude-code/statusline.sh" },
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "node ~/.faberun/current/src/host/tool-policy-hook.mjs" }] }] },
  })}\n`);
  const repoSettingsBefore = readFileSync(repoSettings, "utf8");
  mkdirSync(under(repo, ".claude/skills/faberun"), { recursive: true });
  writeFileSync(under(repo, ".claude/skills/faberun/SKILL.md"), "# repo-local skill\n");
  mkdirSync(under(repo, ".claude/hooks"), { recursive: true });
  writeFileSync(under(repo, ".claude/hooks/faberun-tool-policy.mjs"), "// repo-local hook\n");
  writeFileSync(join(repo, "README.md"), "# repository\n");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/config"), "[core]\n");

  // A real home-level install site proves the command ran and removed its own
  // artifacts alongside the untouched repository.
  const [homeSkill] = installSkills(home);
  mkdirSync(faberun, { recursive: true });
  writeFileSync(join(faberun, "config.json"), "{}\n");

  const err = capture();
  const code = await uninstallCommand({ env, yes: true, stdout: () => {}, stderr: err.write });
  assert.equal(code, 0, err.text());

  assert.equal(existsSync(homeSkill), false, "the home-level install site is removed");
  assert.equal(existsSync(faberun), false, "$FABERUN_HOME is removed");
  assert.equal(existsSync(join(repo, "README.md")), true, "the repository survives");
  assert.equal(existsSync(join(repo, ".git/config")), true, "the repository's git metadata survives");
  assert.equal(existsSync(under(repo, ".claude/skills/faberun/SKILL.md")), true, "the repository's own skill stays");
  assert.equal(existsSync(under(repo, ".claude/hooks/faberun-tool-policy.mjs")), true, "the repository's own hook stays");
  assert.equal(readFileSync(repoSettings, "utf8"), repoSettingsBefore, "the repository's settings file is byte-for-byte untouched");
});

test("force skips confirmation and a non-interactive run refuses without it", async () => {
  const { home, env } = scopedHome("uninstall-force-");
  const [skill] = installSkills(home);

  const err = capture();
  const refused = await uninstallCommand({ env, isTTY: false, stdout: () => {}, stderr: err.write });
  assert.equal(refused, 1, "a non-interactive run with no consent refuses");
  assert.match(err.text(), /confirmation required/u);
  assert.equal(existsSync(skill), true, "an unconfirmed removal changes nothing");

  const out = capture();
  const forced = await uninstallCommand({ env, force: true, isTTY: false, stdout: out.write, stderr: () => {} });
  assert.equal(forced, 0, "--force is explicit consent and needs no terminal");
  assert.equal(existsSync(skill), false, "--force removes the owned artifact");
  assert.ok(out.text().includes(`npm uninstall -g ${packageName()}`), "the published-package removal is named");
});

test("the plan never proposes a removal outside the removal roots", () => {
  const { home, faberun, env } = scopedHome("uninstall-plan-");
  installSkills(home);
  writeFileSync(join(home, "outside-marker"), "keep\n");
  const plan = planUninstall(env);
  assert.equal(removalHome(env), faberun);
  for (const artifact of plan.artifacts) {
    assert.ok(artifact.path.startsWith(home), `${artifact.path} is under the effective home`);
  }
  const failures = applyUninstall(plan, env);
  assert.deepEqual(failures, []);
  assert.equal(existsSync(join(home, "outside-marker")), true, "an unrelated home file is untouched");
});
