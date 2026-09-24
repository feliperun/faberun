/**
 * Provenance shared by the stochastic eval classes: the repository commit a
 * result was produced from, and the identity of every runtime that produced it.
 * Why separate: `paired` and `judge-canary` write separate result files but R8
 * requires the same fields in both, so the commit read and the harness version
 * probe have one home instead of a copy each that would drift.
 */
import { spawnSync } from "node:child_process";
import { gitHead } from "../../src/repo/worktree.mjs";
import { probeRuntime } from "../../src/harnesses/index.mjs";
import { PAIRED_REPO_ROOT } from "./lib.mjs";

/** @typedef {{id?: string|null, harness?: string|null, model?: string|null, cliVersion?: string|null, [key: string]: unknown}} ProvenanceRuntime */
/** @typedef {{id: string|null, harness: string|null, model: string|null, cliVersion: string|null}} RuntimeIdentity */

/**
 * The commit a stochastic result was produced from, or null when the tree is
 * not a git checkout. `gitHead` is the product's own bounded probe, so a held
 * index lock cannot hang the report.
 *
 * @param {string} [repo]
 * @returns {string|null}
 */
export function resultCommit(repo = PAIRED_REPO_ROOT) {
  try {
    return gitHead(repo, "HEAD");
  } catch {
    return null;
  }
}

/**
 * The version the harness reports for one runtime, or null when it reports
 * none. `probeRuntime` is the product's own `--version` probe, so a judge and a
 * worker are identified by the same call; a missing binary and an unparseable
 * version both degrade to null, because a result with no readable version is
 * still a result.
 *
 * @param {ProvenanceRuntime} runtime
 * @returns {Promise<string|null>}
 */
export async function probeHarnessVersion(runtime) {
  try {
    const probe = await probeRuntime(/** @type {import("../../src/harnesses/index.mjs").HarnessRuntime} */ (runtime), { timeoutSec: 30 });
    return probe.version ?? null;
  } catch {
    return null;
  }
}

/**
 * One provenance identity per runtime, deduplicated by id (or harness+model
 * when no id is declared) and kept in first-seen order.
 *
 * @param {ProvenanceRuntime[]} runtimes
 * @param {(runtime: ProvenanceRuntime) => Promise<string|null>} [probeVersion]
 * @returns {Promise<RuntimeIdentity[]>}
 */
export async function runtimeIdentities(runtimes, probeVersion = probeHarnessVersion) {
  /** @type {Map<string, RuntimeIdentity>} */
  const seen = new Map();
  for (const runtime of runtimes) {
    const id = typeof runtime.id === "string" ? runtime.id : null;
    const key = id ?? `${runtime.harness ?? "?"}:${runtime.model ?? "?"}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      id,
      harness: typeof runtime.harness === "string" ? runtime.harness : null,
      model: typeof runtime.model === "string" ? runtime.model : null,
      cliVersion: await probeVersion(runtime),
    });
  }
  return [...seen.values()];
}

/**
 * Whether the tree a stochastic result was measured on had uncommitted
 * changes, so its commit alone does not name the code that produced it.
 *
 * @param {string} [repo]
 * @returns {boolean}
 */
export function dirtyTree(repo = PAIRED_REPO_ROOT) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  return result.status !== 0 || String(result.stdout ?? "").trim().length > 0;
}
