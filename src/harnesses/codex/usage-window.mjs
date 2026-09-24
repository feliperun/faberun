/**
 * The usage windows a Codex account reports, read from the session file the
 * CLI writes for every thread. It is separate from the adapter because it is
 * not part of an invocation's result: `codex exec --json` streams no limits,
 * while `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` carries a
 * `rate_limits` record on every turn (measured 2026-09-24: `primary` is the
 * 300-minute window, `secondary` the 10080-minute week, each with
 * `used_percent` and `resets_at` in epoch seconds).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @typedef {{window: string, usedPercent: number, resetsAt: string}} UsageWindow */

/** @param {Record<string, string|undefined>} [env] @returns {string} the account's Codex home */
export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * The account's windows as the thread's session file last reported them, or
 * an empty list when the file or the record cannot be found.
 *
 * @param {string} threadId
 * @param {{env?: Record<string, string|undefined>, now?: number}} [options]
 * @returns {UsageWindow[]}
 */
export function codexUsageWindows(threadId, options = {}) {
  const now = options.now ?? Date.now();
  const sessions = join(codexHome(options.env), "sessions");
  for (const day of [0, 1]) {
    const date = new Date(now - day * 86_400_000);
    const dir = join(sessions, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((name) => name.endsWith(`-${threadId}.jsonl`));
    if (file) return lastWindows(readFileSync(join(dir, file), "utf8"));
  }
  return [];
}

/** @param {string} text @returns {UsageWindow[]} */
function lastWindows(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes("\"rate_limits\"")) continue;
    let limits;
    try {
      limits = findRateLimits(JSON.parse(lines[index]));
    } catch {
      // A line cut by a writer still flushing is skipped; an earlier one answers.
      continue;
    }
    if (!limits) continue;
    return [["primary", limits.primary], ["secondary", limits.secondary]]
      .filter(([, entry]) => entry && typeof entry.used_percent === "number" && typeof entry.resets_at === "number")
      .map(([name, entry]) => ({
        window: entry.window_minutes === 10080 ? "seven_day" : entry.window_minutes === 300 ? "five_hour" : String(name),
        usedPercent: entry.used_percent,
        resetsAt: new Date(entry.resets_at * 1000).toISOString(),
      }));
  }
  return [];
}

/** @param {unknown} value @returns {any} the first `rate_limits` object anywhere in a record */
function findRateLimits(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.rate_limits && typeof record.rate_limits === "object") return record.rate_limits;
  for (const child of Object.values(record)) {
    const found = findRateLimits(child);
    if (found) return found;
  }
  return null;
}
