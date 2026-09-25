/**
 * The HOME an fx worker runs under. fx reads provider connections only from
 * `$HOME/.fx/settings.json` and has no flag or variable that names another
 * settings file, so pointing a worker at its own usage relay means giving it
 * its own HOME. The same boundary closes the packet: fx loads every skill it
 * finds under `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` and
 * `~/.config/opencode` (fx 0.0.11 `skill_runtime.zig`), none of which a closed
 * task packet asked for.
 *
 * Everything else in the operator's HOME is linked in, because the worker's
 * shell inherits this HOME: git identity, npm and toolchain caches, and
 * version managers keep resolving to the real files.
 */

import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Top-level HOME entries fx scans for skills or reads as its own profile. */
const WITHHELD = new Set([".fx", ".claude", ".codex", ".agents"]);
/** Entries under `~/.config` fx scans for skills. */
const WITHHELD_CONFIG = new Set(["opencode"]);

/**
 * @param {string} realHome
 * @param {string} home an empty directory the caller owns and removes
 * @param {Record<string, unknown>} settings the complete fx settings document
 */
export function prepareFxHome(realHome, home, settings) {
  linkEntries(realHome, home, WITHHELD, ".config");
  const config = join(home, ".config");
  mkdirSync(config, { recursive: true });
  linkEntries(join(realHome, ".config"), config, WITHHELD_CONFIG, null);
  // fx on Linux refuses a profile directory others can read
  // (`private_state_permissions_unsupported`); macOS did not check.
  mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".fx", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param {string} from
 * @param {string} to
 * @param {Set<string>} withheld
 * @param {string|null} rebuilt an entry the caller recreates as a real directory
 */
function linkEntries(from, to, withheld, rebuilt) {
  let entries;
  try {
    entries = readdirSync(from);
  } catch {
    // An operator without `~/.config` has nothing to link from it.
    return;
  }
  for (const entry of entries) {
    if (withheld.has(entry) || entry === rebuilt) continue;
    symlinkSync(join(from, entry), join(to, entry));
  }
}
