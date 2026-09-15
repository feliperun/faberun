import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_BYTE_CEILING = 1024;
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
const CONTRACT_BYTE_CEILING = 21504;
// Raised from 10240 on 2026-09-13, deliberately and only once: `supervise`
// became a real command and an operator cannot run an undocumented one. The
// ceiling is a ratchet against prose creep, not against surface the product
// actually grew, and the way to honour it is to spend the increase on the new
// command and pay for part of it — roughly 200 bytes here — by cutting
// redundancy that was already there. Raising it again needs the same argument.
const OPERATIONS_BYTE_CEILING = 10496;
const RULES_BYTE_CEILING = 2048;
const ENGINEERING_BYTE_CEILING = 2048;
const WORKFLOW_BYTE_CEILING = 2048;
const HANDOFFS_BYTE_CEILING = 2048;

const skillPath = fileURLToPath(new URL('../../skills/faberun/SKILL.md', import.meta.url));
const referencesDir = fileURLToPath(new URL('../../skills/faberun/references', import.meta.url));

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

test('references/ holds the two foundation documents and the four reserved articles', () => {
  const entries = readdirSync(referencesDir).sort();
  assert.deepEqual(
    entries,
    ['contract.md', 'engineering.md', 'handoffs.md', 'operations.md', 'rules.md', 'workflow.md'],
    'references/ is contract.md, operations.md, and the four reserved constitution articles',
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

