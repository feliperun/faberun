import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const docsDir = join(rootDir, 'docs');
const mapPath = join(docsDir, 'README.md');

const LINK_PATTERN = /\]\(([^)]+)\)/g;

/** @param {string} directory @returns {string[]} the *.md file names directly inside it */
function markdownFilesIn(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.md'));
}

/** @returns {string[]} sorted repo-relative paths docs/README.md must list */
function requiredPaths() {
  return [
    ...markdownFilesIn(docsDir).map((name) => join('docs', name)),
    join('docs', 'adr', 'README.md'),
    ...markdownFilesIn(join(docsDir, 'harnesses')).map((name) => join('docs', 'harnesses', name)),
    join('docs', 'history', 'README.md'),
  ].sort();
}

/** @param {string} filePath @returns {Set<string>} repo-relative paths the file links */
function linkedPaths(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const linked = new Set();
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // scheme URL (http:, mailto:, …)
    if (target.startsWith('#')) continue; // in-page anchor
    const withoutFragment = target.split('#')[0];
    if (!withoutFragment) continue;
    linked.add(relative(rootDir, join(docsDir, withoutFragment)));
  }
  return linked;
}

test('docs/README.md lists every document under docs/', () => {
  const linked = linkedPaths(mapPath);
  const missing = requiredPaths().filter((path) => !linked.has(path));
  assert.deepEqual(missing, [], `docs/README.md does not list: ${missing.join(', ')}`);
});
