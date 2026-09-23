import "../scoped-home.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const campaignDir = join(rootDir, 'docs/campaigns/orchestration-arms');

/** @param {string} directory @returns {string[]} files below the directory */
function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

test('the measurement the roadmap thesis cites is versioned', () => {
  for (const relativePath of [
    'STATE.md',
    'spec/SPEC.md',
    'results/runs.jsonl',
    'results/analysis-complex.md',
    'results/analysis-full.md',
    'results/analysis-pilot.md',
    'results/analysis-smoke.md',
  ]) {
    assert.ok(existsSync(join(campaignDir, relativePath)), `${relativePath} is missing`);
  }

  assert.deepEqual(
    filesBelow(campaignDir).filter((file) => file.endsWith('.mjs')),
    [],
    'the versioned record must not contain driver code',
  );
  assert.match(
    readFileSync(join(rootDir, 'docs/ROADMAP.md'), 'utf8'),
    /Its record\s+is versioned at `docs\/campaigns\/orchestration-arms\//,
  );
  assert.match(
    readFileSync(join(rootDir, 'src/engine/settle.mjs'), 'utf8'),
    /Measured 2026-09-20 in the\s+\* `docs\/campaigns\/orchestration-arms\//,
  );
});
