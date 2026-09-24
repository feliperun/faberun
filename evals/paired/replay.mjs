/**
 * The replay arm: a deterministic stand-in for a provider-backed arm, used by
 * the proof tests so the whole paired class runs with no provider and no
 * checkpoint. It materializes a temporary tree from the corpus's own
 * `baseFiles`, applies the arm's declared writes, audits the scope, and runs
 * the same acceptance the real arms run. Why separate: the real arms measure a
 * provider's tree through git; this one never spawns a provider, so it must
 * not share their checkout logic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deliveredOf } from "./corpus.mjs";
import { runAcceptance } from "./fork.mjs";

/** @typedef {import("./corpus.mjs").CorpusSet} CorpusSet */
/** @typedef {import("./contract.mjs").PairedArm} PairedArm */

/**
 * One repetition's declared shape. `writes` is what the arm leaves in the
 * tree; cost, requests and wall clock are the numbers the report bands.
 *
 * @typedef {{costUsd?: number|null, requests?: number|null, wallMs?: number, toolCalls?: number, writes?: {path: string, content?: string}[]|Record<string, string>}} ReplayRun
 */

/**
 * @param {{arm: PairedArm, repetition: number, corpus: CorpusSet, root?: string}} input
 * @returns {Record<string, unknown>}
 */
export function runReplayArm({ arm, repetition, corpus, root = tmpdir() }) {
  const config = /** @type {any} */ (arm.config ?? {});
  const declared = config.runs ?? {
    costUsd: config.costUsd,
    requests: config.requests,
    wallMs: config.wallMs,
    toolCalls: config.toolCalls,
    writes: config.writes,
  };
  const shape = /** @type {ReplayRun} */ (Array.isArray(declared) ? declared[(repetition - 1) % declared.length] : declared) ?? {};
  const dir = mkdtempSync(join(root, `paired-${String(arm.name).toLowerCase()}-r${repetition}-`));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    for (const [path, content] of Object.entries(corpus.baseFiles ?? {})) writeTreeFile(dir, path, content);
    const writes = normalizeWrites(shape.writes);
    for (const write of writes) writeTreeFile(dir, write.path, write.content ?? "");
    const scope = replayScope({ corpus, writes, baseFiles: corpus.baseFiles ?? {} });
    const acceptance = runAcceptance({ dir, corpus });
    const delivery = deliveredOf(acceptance);
    const wallMs = typeof shape.wallMs === "number" ? shape.wallMs : Date.now() - started;
    return {
      arm: arm.name,
      runner: "replay",
      repetition,
      exitCode: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      wallMs,
      costUsd: typeof shape.costUsd === "number" ? shape.costUsd : null,
      requests: typeof shape.requests === "number" ? shape.requests : null,
      toolCalls: typeof shape.toolCalls === "number" ? shape.toolCalls : null,
      acceptance,
      proofsTotal: delivery.proofs,
      proofsPassed: delivery.delivered,
      guardsPassed: delivery.guardsPassed,
      scope,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} dir @param {string} path @param {string} content @returns {void} */
function writeTreeFile(dir, path, content) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * @param {{path: string, content?: string}[]|Record<string, string>|undefined} writes
 * @returns {{path: string, content: string}[]}
 */
function normalizeWrites(writes) {
  if (writes === undefined) return [];
  if (Array.isArray(writes)) return writes.map((write) => ({ path: write.path, content: write.content ?? "" }));
  return Object.entries(writes).map(([path, content]) => ({ path, content: String(content) }));
}

/**
 * What the replay arm changed against the corpus's base text, and whether any
 * of it lies outside the union of the write scopes. The base is the corpus's
 * own `baseFiles`, so no git history is needed.
 *
 * @param {{corpus: CorpusSet, writes: {path: string, content: string}[], baseFiles: Record<string, string>}} input
 * @returns {{changed: string[], outOfScope: string[], proofsEdited: string[]}}
 */
function replayScope({ corpus, writes, baseFiles }) {
  const changed = writes
    .filter((write) => baseFiles[write.path] !== write.content)
    .map((write) => write.path);
  const scope = new Set(corpus.requirements.flatMap((requirement) => requirement.writeFiles));
  const restored = new Set(corpus.restore.map((item) => item.path));
  const proofsEdited = corpus.visibleProofs ? changed.filter((path) => restored.has(path)) : [];
  const outOfScope = changed.filter((path) => !scope.has(path) && !restored.has(path) && path !== "AGENTS.md");
  return { changed, outOfScope, proofsEdited };
}
