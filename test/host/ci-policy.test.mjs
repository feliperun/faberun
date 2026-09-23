import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnInvocation } from "../../src/host/platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMMITLINT = join(ROOT, "node_modules", ".bin", "commitlint");
const COMMIT_MSG_HOOK = join(ROOT, ".husky", "commit-msg");

/** @param {string} rel */
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** @param {string} yaml @param {string} key */
function matrixList(yaml, key) {
  const found = yaml.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]+)\\]`, "m"));
  assert.ok(found, `missing matrix key "${key}"`);
  return found[1].split(",").map((v) => v.trim().replace(/"/g, ""));
}

/** @param {string} yaml */
const runSteps = (yaml) =>
  [...yaml.matchAll(/- run:\s*(.+)$/gm)].map((m) => m[1].trim());

/** Return the lines of one job, from its name to the next job at the same indent.
 * @param {string} yaml @param {string} name */
function block(yaml, name) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}:`);
  assert.ok(start !== -1, `job "${name}" missing`);
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join("\n");
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  // Through the product's own resolution: what npm installs beside a `.cmd`
  // and what husky writes into `.husky/` are POSIX scripts, and a bare spawn
  // of either is EFTYPE on a host whose kernel has no shebang.
  const invocation = spawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd: ROOT, encoding: "utf8", ...invocation.options });
  return {
    status: /** @type {number | null} */ (result.status),
    stderr: /** @type {string} */ (result.stderr),
  };
}

/** @param {string} message */
function messageFile(message) {
  const file = join(mkdtempSync(join(tmpdir(), "ci-policy-")), "MESSAGE");
  writeFileSync(file, message);
  return file;
}

const VALID_MESSAGE = "feat(ci): add policy gates\n\nBody line.\n";
const INVALID_MESSAGE = "bad message\n";

test("ci.yml runs the required matrix on push to main and pull_request", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(ci, /pull_request:/);
  // Read from the `ci` job alone: a second job must not be able to widen or
  // narrow the required matrix by adding steps elsewhere in the file.
  const required = block(ci, "ci");
  assert.deepEqual(matrixList(required, "os"), ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(matrixList(required, "node"), ["22", "24"]);
  // The deterministic eval class and its discriminator check are part of the
  // required matrix: a suite that only proves the cases pass, without proving
  // they can fail, is half a proof (TECH-SPEC-2026-09-09 C1.1, c1.7). Both
  // eval steps name the deterministic class — the expensive planner class ran
  // inside the unscoped calls until the nightly schedule took it.
  assert.deepEqual(runSteps(required), [
    "npm ci",
    "npm run check",
    "npm run typecheck",
    "npm test",
    "node evals/run.mjs --class deterministic --assert-no-model",
    "node evals/run.mjs --class deterministic --verify-discriminating",
  ]);
});

test("ci.yml carries a Windows job running the same commands as the required matrix", () => {
  // Windows runs the whole suite, the same steps in the same order as the
  // matrix above, because it is green there (docs/adr/0010). A job that
  // narrowed back to a subset would quietly stop proving the thing ADR 0010
  // claims, so the step list is pinned rather than merely present.
  const windows = block(read(".github/workflows/ci.yml"), "windows");
  assert.match(windows, /runs-on:\s*windows-latest/);
  assert.deepEqual(matrixList(windows, "node"), ["22", "24"]);
  // The same six steps as the required matrix, including the home-leak
  // postcondition folded into `npm test`: a suite that escaped its scoped
  // home would escape it on either platform.
  assert.deepEqual(runSteps(windows), runSteps(block(read(".github/workflows/ci.yml"), "ci")));
  // The suite resolves each spec's baseline commit, which a shallow checkout
  // does not carry — the same reason the matrix above asks for full history.
  assert.match(windows, /fetch-depth:\s*0/);
});

test("ci.yml keeps the deterministic class as the only eval suite on the merge path", () => {
  const ci = read(".github/workflows/ci.yml");
  // No nightly trigger on the merge-path workflow: the deterministic class
  // blocks pull requests, and a scheduled run here would execute it twice.
  assert.doesNotMatch(ci, /schedule:|cron:/);
  // Both eval steps name the deterministic class: an unscoped eval run would
  // silently pull the expensive planner class back onto every pull request.
  const evalSteps = runSteps(block(ci, "ci")).filter((step) => step.startsWith("node evals/run.mjs"));
  assert.ok(evalSteps.length >= 2, `expected the two eval steps, got ${evalSteps.length}`);
  for (const step of evalSteps) assert.match(step, /--class deterministic/);
});

test("nightly.yml runs the expensive classes on a schedule and nothing else triggers it", () => {
  const nightly = read(".github/workflows/nightly.yml");
  assert.match(nightly, /schedule:/);
  assert.match(nightly, /cron:/);
  // Only schedule and manual dispatch: a nightly workflow that also ran on
  // push or PR events would put the expensive classes right back on the merge
  // path, which is exactly what the schedule exists to keep them off.
  assert.doesNotMatch(nightly, /push:|pull_request:|merge_group:/);
  const evalSteps = runSteps(nightly).filter((step) => step.startsWith("node evals/run.mjs"));
  assert.ok(evalSteps.length >= 3, `expected the three eval steps, got ${evalSteps.length}`);
  for (const step of evalSteps) {
    assert.doesNotMatch(step, /--class deterministic/);
    assert.match(step, /--class (planner|resilience)/);
  }
  // Both expensive classes are named on the schedule: naming them is what
  // keeps an expensive class from drifting back onto the merge path inside
  // an unscoped call.
  for (const className of ["planner", "resilience"]) {
    assert.ok(
      evalSteps.some((step) => step.includes(`--class ${className}`)),
      `no nightly eval step runs --class ${className}`,
    );
  }
  // The resilience class's whole point is that no recovery path reaches a
  // provider, so its scheduled step carries the runner's assertion.
  for (const step of evalSteps.filter((step) => step.includes("--class resilience"))) {
    assert.match(step, /--assert-no-model/);
  }
});

test("nightly.yml answers a regression with an issue owned by name, blocking nothing", () => {
  const nightly = read(".github/workflows/nightly.yml");
  // An alert nobody owns is the failure mode, not a missing alert: the issue
  // step declares its assignee in the workflow file itself.
  assert.match(nightly, /issues:\s*write/);
  assert.match(nightly, /if:\s*failure\(\)/);
  assert.match(nightly, /gh issue create/);
  assert.match(nightly, /--assignee feliperun/);
});

test("pr-policy.yml is scoped to main pull requests and merge groups", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /pull_request:\s*\n\s*branches:\s*\[main\]/);
  assert.match(policy, /merge_group:\s*\n\s*branches:\s*\[main\]/);
  assert.doesNotMatch(policy, /push:/);
});

test("pr-policy.yml revalidates when the body it reads changes", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  // The squash-message job reads github.event.pull_request.body, and that body
  // becomes the squash commit message. The default pull_request types --
  // opened, synchronize, reopened -- omit `edited`, so a body approved once
  // could be rewritten afterwards and the check stayed green on the old
  // verdict: a gate reading a mutable value once is a photograph, not a gate.
  // Measured 2026-09-21: the assertion above this one matches with or without
  // the fix, which is exactly why it did not catch the defect.
  const trigger = policy.slice(policy.indexOf("pull_request:"), policy.indexOf("merge_group:"));
  assert.match(trigger, /types:\s*\[[^\]]*\bedited\b/u, "the pull_request trigger must list `edited`");
});

test("pr-policy.yml rejects a blank PR body", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /PR body is blank/);
  assert.match(policy, /tr -d '\[:space:\]'/);
});

test("pr-policy.yml validates title plus body as the squash commit message", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(policy, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(policy, /printf '%s\\n\\n%s\\n' "\$PR_TITLE" "\$PR_BODY"/);
  assert.match(policy, /commitlint --edit/);
});

test("pr-policy.yml validates every non-merge candidate commit", () => {
  const policy = read(".github/workflows/pr-policy.yml");
  assert.match(policy, /--no-merges[^\n]*origin\/main\.\.HEAD/);
  assert.match(policy, /commitlint --edit "\$f"/);
});

test("commitlint extends the conventional config and enforces it offline", async () => {
  const config = await import(new URL("../../commitlint.config.mjs", import.meta.url).href);
  assert.deepEqual(config.default.extends, ["@commitlint/config-conventional"]);
  const good = run(COMMITLINT, ["--edit", messageFile(VALID_MESSAGE)]);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(COMMITLINT, ["--edit", messageFile(INVALID_MESSAGE)]);
  assert.notEqual(bad.status, 0);
});

test("package.json wires husky and keeps runtime dependencies at zero", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.prepare, "husky");
  for (const dep of ["@commitlint/cli", "@commitlint/config-conventional", "husky"]) {
    assert.ok(pkg.devDependencies[dep], `devDependency ${dep} missing`);
  }
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test("hooks are wired, executable, and enforce Conventional Commits", () => {
  for (const hook of [".husky/pre-commit", ".husky/commit-msg"]) {
    accessSync(join(ROOT, hook), constants.X_OK);
  }
  assert.match(read(".husky/pre-commit"), /set -eu\b/);
  assert.match(read(".husky/pre-commit"), /npm run check/);
  assert.match(read(".husky/commit-msg"), /commitlint --edit "\$1"/);
  const good = run(COMMIT_MSG_HOOK, [messageFile(VALID_MESSAGE)]);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(COMMIT_MSG_HOOK, [messageFile(INVALID_MESSAGE)]);
  assert.notEqual(bad.status, 0);
});

test("release-please.yml triggers only on push to main with exactly the write permissions", () => {
  const workflow = read(".github/workflows/release-please.yml");
  assert.match(workflow, /^name: release-please$/m);
  assert.match(workflow, /^on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/m);
  assert.doesNotMatch(workflow, /pull_request:/);
  const permissions = workflow.slice(workflow.indexOf("\npermissions:"), workflow.indexOf("jobs:"));
  assert.deepEqual(
    [...permissions.matchAll(/^\s{2}(\S+):/gm)].map((m) => m[1]),
    ["contents", "pull-requests"],
  );
});

test("release-please.yml uses the v4 action with the repo config and manifest", () => {
  const workflow = read(".github/workflows/release-please.yml");
  const release = block(workflow, "release-please");
  assert.match(release, /uses: googleapis\/release-please-action@v4/);
  assert.match(release, /id: release/);
  assert.match(release, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(release, /config-file: release-please-config\.json/);
  assert.match(release, /manifest-file: \.release-please-manifest\.json/);
  assert.match(release, /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/);
  assert.match(release, /tag_name: \$\{\{ steps\.release\.outputs\.tag_name \}\}/);
});

test("release-please.yml publishes the release to npm through trusted publishing", () => {
  const workflow = read(".github/workflows/release-please.yml");
  const publish = block(workflow, "publish-npm");
  assert.match(publish, /needs: release-please/);
  assert.match(publish, /if: needs\.release-please\.outputs\.release_created == 'true'/);
  const permissions = publish.match(/^ {4}permissions:\n((?: {6}\S.*\n?)+)/m);
  assert.ok(permissions, "publish-npm must scope its own permissions");
  assert.deepEqual(
    [...permissions[1].matchAll(/^\s{6}(\S+): (.+)$/gm)].map((m) => [m[1], m[2]]),
    [
      ["contents", "read"],
      ["id-token", "write"],
    ],
  );
  assert.match(publish, /uses: actions\/checkout@v4/);
  assert.match(publish, /ref: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/);
  assert.match(publish, /uses: actions\/setup-node@v4/);
  assert.match(publish, /node-version: 22/);
  assert.match(publish, /registry-url: https:\/\/registry\.npmjs\.org/);
  // OIDC trusted publishing needs npm >= 11.5.1, but Node 22 ships npm 10.9.x,
  // so the job upgrades npm before it relies on the token-free auth path.
  assert.match(publish, /- run: npm install -g npm@latest/);
  // The `prepare` hook (husky) is a devDependency absent on this clean runner;
  // skipping scripts keeps publish from aborting before the upload.
  assert.match(publish, /npm publish --provenance --access public --ignore-scripts/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("release-please config names faberun as a node package tagged without a component", () => {
  const config = JSON.parse(read("release-please-config.json"));
  assert.equal(config["release-type"], "node");
  assert.equal(config["include-component-in-tag"], false);
  assert.equal(config.packages["."]["package-name"], "faberun");
});

test("the release-please manifest stays the same version as package.json", () => {
  const manifest = JSON.parse(read(".release-please-manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(manifest["."], pkg.version);
});

test("CHANGELOG.md exists and starts with the release-please heading", () => {
  assert.equal(read("CHANGELOG.md").split("\n")[0], "# Changelog");
});

test("package.json publishes publicly and packs the shipped trees", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.deepEqual(pkg.files, ["bin", "src", "skills", "integrations"]);
  mkdirSync(join(tmpdir(), "ci-policy-npm-cache"), { recursive: true });
  // npm writes the file listing to stderr, and the `prepare` hook would touch
  // the shared git config, so isolate the cache and skip lifecycle scripts.
  const packInvocation = spawnInvocation("npm", ["pack", "--dry-run"]);
  const result = spawnSync(packInvocation.command, packInvocation.args, {
    cwd: ROOT,
    encoding: "utf8",
    ...packInvocation.options,
    env: {
      ...process.env,
      npm_config_cache: join(tmpdir(), "ci-policy-npm-cache"),
      npm_config_ignore_scripts: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  for (const path of [
    "bin/faberun.mjs",
    "package.json",
    "README.md",
    "src/",
    "skills/",
    "integrations/",
  ]) {
    assert.ok(output.includes(path), `npm pack --dry-run did not list ${path}`);
  }
});

test("AGENT.md, CLAUDE.md, CURSOR.md and GEMINI.md stay symlinks to AGENTS.md", () => {
  const names = ["AGENT.md", "CLAUDE.md", "CURSOR.md", "GEMINI.md"];
  const result = spawnSync("git", ["ls-files", "-s", ...names], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 4, `expected 4 symlink entries, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^120000 /);
  }
  for (const name of names) {
    // On a checkout with `core.symlinks=false` -- the Windows default
    // without Developer Mode -- git writes the target path into a regular
    // file instead. Same pointer, the only form that platform can hold.
    const path = join(ROOT, name);
    if (lstatSync(path).isSymbolicLink()) assert.equal(readlinkSync(path), "AGENTS.md");
    else assert.equal(readFileSync(path, "utf8"), "AGENTS.md");
  }
});

