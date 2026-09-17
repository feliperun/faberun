import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const skillDir = join(rootDir, 'skills', 'faberun');
const referencesDir = join(skillDir, 'references');

/**
 * The declared set of files a worker may load without writing them: the
 * router plus every reference file next to it. This is the one place that
 * set is named; nothing else should keep its own copy.
 *
 * @returns {string[]} paths relative to the repository root
 */
export function workerReferenceSet() {
  const skillPath = join('skills', 'faberun', 'SKILL.md');
  const referenceNames = readdirSync(referencesDir).filter((name) => name.endsWith('.md'));
  return [skillPath, ...referenceNames.map((name) => join('skills', 'faberun', 'references', name))];
}

/**
 * The subset of a taskPacket's readFiles that fall under docs/ without a
 * matching writeFiles entry for the same path — a worker may read operator
 * documentation only when it also edits it.
 *
 * @param {{readFiles?: string[], writeFiles?: string[]}} taskPacket
 * @returns {string[]}
 */
function docsReadScopeViolations(taskPacket) {
  const writeFiles = new Set(taskPacket.writeFiles ?? []);
  return (taskPacket.readFiles ?? []).filter(
    (path) => path.startsWith('docs/') && !writeFiles.has(path),
  );
}

/** @param {string} dir @returns {string[]} absolute paths of every *.json file under dir, recursively */
function jsonFilesUnder(dir) {
  /** @type {string[]} */
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full.includes(`${sep}evals${sep}golden`) || full.includes(`${sep}docs${sep}campaigns`)) continue;
      results.push(...jsonFilesUnder(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * A fixture contract lives either as `{contract: {nodes: [...]}}` (an eval
 * case.json) or as a bare `{nodes: [...]}` contract. Anything else (an
 * indicator report, a recording, expected.json) has neither shape and
 * contributes no contract.
 *
 * @param {unknown} parsed
 * @returns {{nodes?: {id?: string, taskPacket?: {readFiles?: string[], writeFiles?: string[]}}[]}[]}
 */
function contractsIn(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const record = /** @type {Record<string, unknown>} */ (parsed);
  if (record.contract && typeof record.contract === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (record.contract).nodes)) {
    return [/** @type {{nodes: {id?: string, taskPacket?: {readFiles?: string[], writeFiles?: string[]}}[]}} */ (record.contract)];
  }
  if (Array.isArray(record.nodes)) {
    return [/** @type {{nodes: {id?: string, taskPacket?: {readFiles?: string[], writeFiles?: string[]}}[]}} */ (record)];
  }
  return [];
}

test('workerReferenceSet is SKILL.md plus every reference linked from it, and nothing else lives in references/', () => {
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const linkedNames = new Set(
    [...skill.matchAll(/\]\(references\/([A-Za-z0-9._-]+\.md)\)/g)].map((match) => match[1]),
  );
  assert.ok(linkedNames.size > 0, 'SKILL.md must link at least one reference');

  const set = workerReferenceSet();
  assert.ok(set.includes(join('skills', 'faberun', 'SKILL.md')), 'workerReferenceSet must include SKILL.md');
  const referenceEntries = set.filter((entry) => entry !== join('skills', 'faberun', 'SKILL.md'));

  const setNames = new Set(referenceEntries.map((entry) => entry.split(sep).pop()));
  assert.deepEqual(setNames, linkedNames, 'workerReferenceSet must be exactly SKILL.md plus the references SKILL.md links to');

  const onDisk = new Set(readdirSync(referencesDir).filter((name) => name.endsWith('.md')));
  assert.deepEqual(onDisk, linkedNames, 'references/ must hold exactly the files SKILL.md links to, nothing more');
});

test('docsReadScopeViolations refuses a docs/ readFiles entry unless writeFiles carries the same path', () => {
  assert.deepEqual(
    docsReadScopeViolations({ readFiles: ['docs/COMMANDS.md'], writeFiles: [] }),
    ['docs/COMMANDS.md'],
  );
  assert.deepEqual(
    docsReadScopeViolations({ readFiles: ['docs/COMMANDS.md'], writeFiles: ['docs/COMMANDS.md'] }),
    [],
  );
  assert.deepEqual(
    docsReadScopeViolations({ readFiles: ['src/index.mjs'], writeFiles: [] }),
    [],
  );
  assert.deepEqual(
    docsReadScopeViolations({ readFiles: ['docs/a.md', 'docs/b.md'], writeFiles: ['docs/b.md'] }),
    ['docs/a.md'],
  );
});

test('no fixture contract taskPacket reads a docs/ path it does not also write', () => {
  /** @type {string[]} */
  const violations = [];
  for (const dir of [join(rootDir, 'evals', 'fixtures'), join(rootDir, 'evals', 'deterministic')]) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of jsonFilesUnder(dir)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      for (const contract of contractsIn(parsed)) {
        for (const node of contract.nodes ?? []) {
          if (!node.taskPacket) continue;
          const offending = docsReadScopeViolations(node.taskPacket);
          if (offending.length > 0) {
            violations.push(`${relative(rootDir, file)} node "${node.id}": readFiles has ${offending.join(', ')} under docs/ without a matching writeFiles entry`);
          }
        }
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
