import "../scoped-home.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNS_DIR_NAME } from '../../src/run/paths.mjs';

// Raised from 1024 on 2026-09-17: SKILL.md gained one router row linking a
// seventh reference, references/spec-format.md, documenting the spec format
// the planner campaign needs. The row is the entire increase; nothing else in
// the router changed. Raising it again needs the same argument.
const SKILL_BYTE_CEILING = 1100;
// Raised from 20480 on 2026-09-13 for real capability growth: a readFiles
// entry may now name a file a transitive dependency declares in writeFiles or
// under a directory writeRoots, which contract loading defers to graph
// resolution instead of rejecting at packet load. The ceiling is a ratchet
// against prose creep, not against surface the product actually grew, so the
// increase is spent on the deferral rule and nothing else. Raising it again
// needs the same argument.
// Raised again from 20992 the same day: `resume --answer` is a second real
// command, documented after trimming the paragraph describing it once
// already.
// Raised from 21504 on 2026-09-16 by the one `signalsProcesses` sentence added
// to the `permissionExecution` paragraph: the sentence costs 317 bytes, and
// 168 bytes of redundant prose already there (a repeated `acceptEdits` denial
// rationale and a restated 600s-suite warning) pay part of it, so the ceiling
// moves by the net 149 bytes and nothing else. Raising it again needs the same
// argument.
// Raised from 21653 on 2026-09-17 by the one `sharedVerification` paragraph:
// the paragraph costs 565 bytes and 19 bytes of redundant "reporting only"
// prose already there pay part of it, so the ceiling moves by the net 420
// bytes to the file's exact size and nothing else. Raising it again needs the
// same argument.
// Raised from 22073 on 2026-09-16 by extending the deferred-path sentence to
// `scopeAcknowledged`: the extension costs 23 bytes and 21 bytes of redundant
// "one of that dependency's" prose already there pay part of it, so the
// ceiling moves by the net 2 bytes to the file's exact size and nothing else.
// Raising it again needs the same argument.
// Raised from 22075 on 2026-09-22 for three pieces of real surface, and
// nothing else. `maxTurns` is a field the product has had all along and this
// reference never named: it appeared once in the whole documentation set,
// outside references/, so the author of a long-running contract raised
// `timeoutSec` and `stallTimeoutSec` -- everything they knew existed -- and
// two attempts were then cut mid-turn at a ceiling they had never been shown.
// `requirementId` is a new field on a verification entry. And the Definition
// of Done `command` proof changed behaviour: it is bounded by the node's own
// `timeoutSec` rather than a smaller hardcoded ceiling, and its shell quoting
// now differs from `verification`'s argv in a way an author must be told
// about. Each was written twice and cut both times before landing here; there
// was no redundancy adjacent to them left to pay part of it with. Raising it
// again needs the same argument.
const CONTRACT_BYTE_CEILING = 22860;
// Raised from 10240 on 2026-09-13, deliberately and only once: `supervise`
// became a real command and an operator cannot run an undocumented one. The
// ceiling is a ratchet against prose creep, not against surface the product
// actually grew, and the way to honour it is to spend the increase on the new
// command and pay for part of it — roughly 200 bytes here — by cutting
// redundancy that was already there. Raising it again needs the same argument.
// Raised from 10496 on 2026-09-15 the same way: an orchestrator learns the five
// phase-2 verbs — `setup`, `init`, `update`, `skills install`,
// `campaign unpark` — from one new `## Install, set up, update` section in
// operations.md instead of leaving them to the manual. The section costs 611
// bytes; 190 bytes of redundant prose already there (a doctor-discovery
// parenthetical contract.md owns, the notify backoff meta-note, and a repeated
// "integration stays serialized") pay part of it, so the ceiling moves by the
// net 421 bytes and nothing else. Raising it again needs the same argument.
// Raised from 10917 on 2026-09-16 by the one `skills register` line the new
// operation needs in the `## Install, set up, update` section: the line costs
// 133 bytes, so the ceiling moves to the file's exact size and nothing else.
// Raising it again needs the same argument.
// Raised 2026-09-21 for the session-wake transport (`FABERUN_NOTIFY_SESSION`)
// and the shape of the message it delivers: the new notification paragraph
// costs 1,733 bytes (the three message shapes, the operator-language rule,
// the update line and how a session reacts to an inbound message) and
// replaces 895 bytes of the previous one (the same receipt, lossy-delivery
// and os-macos facts, restated once instead of twice), so the ceiling moves
// by the net 838 bytes to the file's exact size and nothing else. Raising it
// again needs the same argument.
// Raised again 2026-09-22 for `claude:<socket>` in the notify paragraph and
// the rule that a session repeats an inbound message to the operator verbatim
// (the message exists to inform the person, and reaches them only through the
// session's reply): 258 bytes net, to the file's exact size and nothing else.
// Raising it again needs the same argument.
// Raised again 2026-09-22 for the default event filter (a phase settling and a
// person being needed leave; a node settling is a `filtered` receipt) and the
// language override: 241 bytes net, to the file's exact size and nothing else.
// Raising it again needs the same argument.
const OPERATIONS_BYTE_CEILING = 12280;
const RULES_BYTE_CEILING = 2048;
const ENGINEERING_BYTE_CEILING = 2048;
const WORKFLOW_BYTE_CEILING = 2048;
const HANDOFFS_BYTE_CEILING = 2048;
// Set on 2026-09-17 when references/spec-format.md was added: a generous
// ratchet for a new reference documenting the spec format, sized like the
// other reserved articles' ceilings rather than the file's exact size, since
// this one is expected to grow with the format itself across the campaign.
const SPEC_FORMAT_BYTE_CEILING = 6144;
// Set on 2026-09-25 when references/local-env.md was added for `doctor --env`:
// a generous ratchet for the article documenting the environment a worker
// receives, sized like the other reference ceilings rather than the file's
// exact size.
const LOCAL_ENV_BYTE_CEILING = 1024;
// Measured 2026-09-23: SKILL.md plus every references/*.md is 46852 bytes.
// The aggregate ceiling is fixed at the campaign baseline of 46855 bytes.
// references/local-env.md and its router row were added 2026-09-25 and paid
// for by trimming repetition from operations.md, so the balance is 46833.
// Raising it requires a new ADR cited here as docs/adr/NNNN-*.md; the proof
// below checks the cited concrete path and its number against ADR 0010.
const TOTAL_BYTE_BUDGET = 46855;
const BASELINE_TOTAL_BYTE_BUDGET = 46855;

const skillPath = fileURLToPath(new URL('../../skills/faberun/SKILL.md', import.meta.url));
const referencesDir = fileURLToPath(new URL('../../skills/faberun/references', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('SKILL.md stays within the router byte ceiling', () => {
  const bytes = statSync(skillPath).size;
  assert.ok(bytes > 0, 'SKILL.md must not be empty');
  assert.ok(
    bytes <= SKILL_BYTE_CEILING,
    `SKILL.md is ${bytes} bytes; the router ceiling is ${SKILL_BYTE_CEILING} bytes. ` +
      'Move detail into skills/faberun/references/ and link it from the router.',
  );
});

test('references/contract.md and references/operations.md stay within their byte ceilings', () => {
  const contractBytes = statSync(fileURLToPath(new URL('../../skills/faberun/references/contract.md', import.meta.url))).size;
  const operationsBytes = statSync(fileURLToPath(new URL('../../skills/faberun/references/operations.md', import.meta.url))).size;
  assert.ok(contractBytes > 0, 'references/contract.md must not be empty');
  assert.ok(
    contractBytes <= CONTRACT_BYTE_CEILING,
    `references/contract.md is ${contractBytes} bytes; the ceiling is ${CONTRACT_BYTE_CEILING} bytes.`,
  );
  assert.ok(operationsBytes > 0, 'references/operations.md must not be empty');
  assert.ok(
    operationsBytes <= OPERATIONS_BYTE_CEILING,
    `references/operations.md is ${operationsBytes} bytes; the ceiling is ${OPERATIONS_BYTE_CEILING} bytes.`,
  );
});

test('the four reserved articles stay within their byte ceilings', () => {
  /** @type {[string, number][]} */
  const ceilings = [
    ['rules.md', RULES_BYTE_CEILING],
    ['engineering.md', ENGINEERING_BYTE_CEILING],
    ['workflow.md', WORKFLOW_BYTE_CEILING],
    ['handoffs.md', HANDOFFS_BYTE_CEILING],
  ];
  for (const [name, ceiling] of ceilings) {
    const bytes = statSync(fileURLToPath(new URL(`../../skills/faberun/references/${name}`, import.meta.url))).size;
    assert.ok(bytes > 0, `references/${name} must not be empty`);
    assert.ok(
      bytes <= ceiling,
      `references/${name} is ${bytes} bytes; the ceiling is ${ceiling} bytes.`,
    );
  }
});

test('references/spec-format.md stays within its byte ceiling', () => {
  const bytes = statSync(fileURLToPath(new URL('../../skills/faberun/references/spec-format.md', import.meta.url))).size;
  assert.ok(bytes > 0, 'references/spec-format.md must not be empty');
  assert.ok(
    bytes <= SPEC_FORMAT_BYTE_CEILING,
    `references/spec-format.md is ${bytes} bytes; the ceiling is ${SPEC_FORMAT_BYTE_CEILING} bytes.`,
  );
});

test('references/local-env.md stays within its byte ceiling', () => {
  const bytes = statSync(fileURLToPath(new URL('../../skills/faberun/references/local-env.md', import.meta.url))).size;
  assert.ok(bytes > 0, 'references/local-env.md must not be empty');
  assert.ok(
    bytes <= LOCAL_ENV_BYTE_CEILING,
    `references/local-env.md is ${bytes} bytes; the ceiling is ${LOCAL_ENV_BYTE_CEILING} bytes.`,
  );
});

test("the skill and its references share one byte budget", () => {
  const referencePaths = readdirSync(referencesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(referencesDir, name));
  const totalBytes = [skillPath, ...referencePaths]
    .reduce((sum, path) => sum + statSync(path).size, 0);

  assert.ok(
    totalBytes <= TOTAL_BYTE_BUDGET,
    `SKILL.md and references/*.md total ${totalBytes} bytes; the shared budget is ${TOTAL_BYTE_BUDGET} bytes. ` +
      'Cut one document before growing another.',
  );

  if (TOTAL_BYTE_BUDGET <= BASELINE_TOTAL_BYTE_BUDGET) return;

  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const citedAdr = source.match(/docs\/adr\/(\d{4}-[a-z0-9-]+\.md)/u)?.[0];
  assert.ok(
    citedAdr,
    'an aggregate budget above 46855 must cite a concrete newer ADR path in its comment',
  );
  const adrNumber = Number(citedAdr.match(/docs\/adr\/(\d{4})-/u)?.[1]);
  assert.ok(adrNumber > 10, `${citedAdr} must be newer than docs/adr/0010-the-suite-runs-on-windows.md`);
  assert.ok(
    statSync(join(repositoryRoot, citedAdr)).isFile(),
    `${citedAdr} cited for the aggregate budget must exist`,
  );
});

test('references/ holds the two foundation documents, the four reserved articles, spec-format.md and local-env.md', () => {
  const entries = readdirSync(referencesDir).sort();
  assert.deepEqual(
    entries,
    ['contract.md', 'engineering.md', 'handoffs.md', 'local-env.md', 'operations.md', 'rules.md', 'spec-format.md', 'workflow.md'],
    'references/ is contract.md, operations.md, spec-format.md, local-env.md, and the four reserved constitution articles',
  );
});

test('every reference the router links to exists', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const links = [...skill.matchAll(/\]\((references\/[A-Za-z0-9._-]+\.md)\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length > 0, 'the router must link at least one reference');
  for (const link of new Set(links)) {
    const target = fileURLToPath(new URL(`../../skills/faberun/${link}`, import.meta.url));
    assert.ok(statSync(target).isFile(), `${link} is linked by SKILL.md but missing`);
  }
});

test('the router documents runtimes[].fallback and no longer runtimeRules', () => {
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /fallback/);
  assert.doesNotMatch(skill, /runtimeRules/);
});

test('done-when 8: the notify docs match notify/index.mjs and SKILL.md arms the watchdog', () => {
  const operations = readFileSync(join(referencesDir, 'operations.md'), 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

  // The false three-retry promise is gone; the lossy one-attempt contract is
  // the documented one.
  assert.doesNotMatch(operations, /three attempts with backoff/u);
  assert.match(operations, /exactly one[\s\S]{0,40}attempt/u);
  assert.match(operations, /no retry/u);
  assert.match(operations, /no_transport/u);

  // FABERUN_NOTIFY_BACKOFF_MS appears nowhere under src/.
  for (const relativePath of readdirSync(srcDir, { recursive: true })) {
    const file = join(srcDir, String(relativePath));
    if (!file.endsWith('.mjs')) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), /FABERUN_NOTIFY_BACKOFF_MS/u, `${relative(srcDir, file)} mentions a backoff variable the code never reads`);
  }

  // SKILL.md carries the arming command and the launchd line.
  assert.match(skill, /supervise campaign/u);
  assert.match(skill, /launchd/u);
  assert.match(skill, /StartInterval 300/u);
  assert.match(skill, /launchctl load/u);
});

// R6: no current document describes the legacy in-tree run layout as current.
//
// The runs root moved out of the target repository into the operator's home
// (`$FABERUN_HOME`, default `~/.faberun`), so a current doc that still names
// the old in-tree `.runs/` directory — or a path under it — as where run state
// lives is stale. This ratchet fails until such a mention is removed, or the
// passage that keeps it is labelled as the legacy layout.
//
// Scope is README.md and the top-level docs. `docs/history/`,
// `docs/campaigns/` and `docs/adr/` are dated records and out of scope by
// design. `docs/COMMANDS.md` is excluded because it is the generated command
// manual: `src/cli/manual.mjs` regenerates its command surface, so a docs
// sweep does not own its reads/writes prose. `docs/GETTING-STARTED.md` is
// scanned; its one unlabelled mention is the line `init` prints when it
// ignores a legacy in-tree runs directory, quoted verbatim, so it stays until
// the CLI stops printing it.

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const docsDir = join(rootDir, 'docs');

/** Files under `docs/` that are generated rather than hand-authored. */
const GENERATED_DOCS = new Set(['COMMANDS.md']);

/**
 * A line that labels its passage as legacy is allowed to name the old layout,
 * so a migration note can say exactly what moved.
 */
const LEGACY_LABEL = /\b(?:legacy|pre-?migration|before the move|migrat(?:e|es|ed|ion)|historical)\b/iu;

/** CLI output the executed walkthrough quotes verbatim. */
const ALLOWED_GETTING_STARTED = [/\[ok\] \.runs ignored/u];

/** @returns {string[]} absolute paths of README.md and the current top-level docs */
function currentDocs() {
  const generated = new Set([...GENERATED_DOCS].map((name) => join(docsDir, name)));
  return [
    join(rootDir, 'README.md'),
    ...readdirSync(docsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(docsDir, name))
      .filter((path) => !generated.has(path)),
  ];
}

test('no current doc describes the legacy run layout as current', () => {
  const gettingStarted = relative(rootDir, join(docsDir, 'GETTING-STARTED.md'));
  const offenders = [];
  for (const file of currentDocs()) {
    const name = relative(rootDir, file);
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.includes(RUNS_DIR_NAME)) continue;
      if (LEGACY_LABEL.test(line)) continue;
      if (name === gettingStarted && ALLOWED_GETTING_STARTED.some((pattern) => pattern.test(line))) continue;
      offenders.push(`${name}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `current docs present the legacy .runs run layout as current:\n${offenders.join('\n')}`,
  );
});
