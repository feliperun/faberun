/**
 * `faberun uninstall [--dry-run] [--force] [--yes]`: the inverse of every write
 * faberun makes outside a target repository.
 *
 * The command has three jobs and this module keeps them separate. Planning
 * turns the two independent sources of truth into one list:
 *
 * - the install registry, which records the exact path, install-site root and
 *   settings pointer/value of every artifact a registry-aware faberun wrote;
 * - `KNOWN_INSTALL_SITES`, the published manifest of where faberun writes, so
 *   an artifact an older faberun installed before the registry existed is still
 *   found by walking the well-known sites and testing ownership.
 *
 * Applying removes that list through `uninstall-roots.mjs`, which re-resolves
 * every path against the *injected* `HOME`/`FABERUN_HOME` immediately before
 * deletion. Nothing is ever derived from the current working directory, so a
 * target repository is never even a candidate.
 *
 * The one piece of state removal must protect is campaign evidence. A campaign
 * whose ledger was not preserved at its durable, versioned repository location
 * refuses the command unless `--force`, because deleting `$FABERUN_HOME` would
 * delete the only copy.
 *
 * Removal of `$FABERUN_HOME` is confirmed interactively (or by `--yes`; and
 * `--force`, being the operator's explicit consent, skips the prompt too). A
 * removal never touches the effective `HOME` itself: when `$FABERUN_HOME` is
 * the effective home, that would delete the operator's whole home and whatever
 * repositories live under it, so only the individually owned artifacts are
 * removed and the wholesale delete is skipped.
 *
 * The last line names the command that removes the *published package*, which
 * no local removal can undo.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { readInstallEntries, knownInstallSites, removeRecordedSettingsEntries } from "../host/install-registry.mjs";
import { assertWithinRemovalRoots, canonicalPath, removalRoots, removeWithinRemovalRoots } from "../host/uninstall-roots.mjs";
import { effectiveHome, faberunHome, projectsDir } from "../host/home.mjs";
import { unpreservedLedgerCampaigns } from "../campaign/ledger.mjs";
import { readJson, writeJsonAtomic } from "../run/store.mjs";
import { packageName } from "../host/package.mjs";
import { colorLevel, statusToken } from "./brand.mjs";
import { errorMessage } from "../util.mjs";

/** @typedef {import("../host/install-registry.mjs").SettingsEntry} SettingsEntry */
/** @typedef {import("../host/install-registry.mjs").InstallEntry} InstallEntry */
/** @typedef {(text: string) => void} Writer */
/** @typedef {(question: string) => Promise<string>} Asker */

/**
 * @typedef {object} PlannedArtifact
 * @property {"skill"|"statusline"|"hook"} kind
 * @property {string} path the absolute path faberun wrote
 * @property {string} root the install-site root that owns `path`
 * @property {string|null} harness the owning harness, when one applies
 * @property {"recorded"|"known"} source where the plan learned about it
 * @property {"tree"|"settings"} mode a whole tree/file versus one settings file
 * @property {"recordedEntries"|"ownedStatusline"|"ownedHooks"} [mutation] how a settings file is edited
 * @property {SettingsEntry[]} entries recorded settings entries, empty otherwise
 */

/**
 * @typedef {object} UninstallPlan
 * @property {string} home the `$FABERUN_HOME` this command removes
 * @property {string[]} roots the resolved removal roots the plan is confined to
 * @property {boolean} homeExists whether `$FABERUN_HOME` exists on disk
 * @property {boolean} homeRemovable whether the wholesale home delete may run
 * @property {boolean} homeIsEffective whether `$FABERUN_HOME` is the effective home
 * @property {PlannedArtifact[]} artifacts the owned artifacts outside the home
 * @property {string[]} unpreservedLedgers `<project>/<campaign>` ids without a durable ledger
 */

/**
 * @typedef {object} UninstallOptions
 * @property {boolean} [dryRun]
 * @property {boolean} [force]
 * @property {boolean} [yes]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean} [isTTY]
 * @property {Asker} [ask]
 * @property {Writer} [stdout]
 * @property {Writer} [stderr]
 */

/**
 * The `$FABERUN_HOME` uninstall targets, derived from the injected environment
 * the same way `removalRoots` derives it. `faberunHome` may fall back to
 * `os.homedir()`, which is exactly the fallback a removal scoped to a throwaway
 * home must not take, so the effective home is preferred and the fallback is
 * reached only when the environment names no home at all (and then removal
 * roots are empty, so nothing can be deleted).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function removalHome(env = process.env) {
  const configured = env.FABERUN_HOME;
  if (typeof configured === "string" && configured) return configured;
  const effective = effectiveHome(env);
  if (effective !== null) return join(effective, ".faberun");
  return faberunHome(env);
}

/**
 * Build the union of the recorded registry and the known install sites, plus
 * the ledger refusal and the home safety facts. Pure: it reads the registry,
 * the manifest-derived settings files and the campaign records, but changes
 * nothing.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UninstallPlan}
 */
export function planUninstall(env = process.env) {
  const home = removalHome(env);
  const roots = removalRoots(env);
  // Force every registry/manifest read at the same home the removal roots name,
  // so a thrown-away home never reads the operator's real registry.
  const scopedEnv = { ...env, FABERUN_HOME: home };
  const registry = readInstallEntries(scopedEnv);
  // Skill and settings sites hang off the *user* home (`skills.mjs`'s
  // `skillHome`), never off `$FABERUN_HOME`; the two are the same tree only
  // when an installation chose to point them at one directory.
  const userHome = effectiveHome(env) ?? homedir();
  const sites = knownInstallSites(userHome);
  /** @type {PlannedArtifact[]} */
  const artifacts = [];
  const seen = new Set();

  /** @param {PlannedArtifact} artifact */
  const add = (artifact) => {
    const key = `${artifact.kind}:${artifact.mode}:${canonicalPath(artifact.path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push(artifact);
  };

  const recordedSkills = new Set(registry.filter((entry) => entry.kind === "skill").map((entry) => canonicalPath(entry.path)));
  const recordedStatusFiles = new Set(registry.filter((entry) => entry.kind === "statusline").map((entry) => canonicalPath(entry.path)));
  const recordedHookFiles = new Set(
    registry.filter((entry) => entry.kind === "hook" && entry.entries.length > 0).map((entry) => canonicalPath(entry.path)),
  );
  const recordedHookTrees = new Set(
    registry.filter((entry) => entry.kind === "hook" && entry.entries.length === 0).map((entry) => canonicalPath(entry.path)),
  );

  for (const entry of registry) {
    if (entry.kind === "skill") {
      add({ kind: "skill", path: entry.path, root: entry.root, harness: entry.harness, source: "recorded", mode: "tree", entries: [] });
    } else if (entry.kind === "statusline") {
      add({
        kind: "statusline", path: entry.path, root: entry.root, harness: entry.harness,
        source: "recorded", mode: "settings", mutation: "recordedEntries", entries: entry.entries,
      });
    } else if (entry.kind === "hook") {
      if (entry.entries.length > 0) {
        add({
          kind: "hook", path: entry.path, root: entry.root, harness: entry.harness,
          source: "recorded", mode: "settings", mutation: "recordedEntries", entries: entry.entries,
        });
      } else {
        add({ kind: "hook", path: entry.path, root: entry.root, harness: entry.harness, source: "recorded", mode: "tree", entries: [] });
      }
    }
    // A recorded `config` lives inside `$FABERUN_HOME`, which is removed whole.
  }

  // A skill is the faberun-named directory inside a harness's skills site. The
  // manifest names the parent, so the owned leaf is derived, never guessed.
  for (const site of sites.skills) {
    const path = join(site.path, "faberun");
    if (recordedSkills.has(canonicalPath(path))) continue;
    if (!existsSync(path)) continue;
    add({ kind: "skill", path, root: site.path, harness: site.harness, source: "known", mode: "tree", entries: [] });
  }

  // The status line is one settings key. A pre-registry install is recognized
  // by the value still pointing at faberun, so an operator's own replacement is
  // left alone.
  for (const site of sites.settings) {
    if (recordedStatusFiles.has(canonicalPath(site.path))) continue;
    if (!existsSync(site.path)) continue;
    if (!settingsHasOwnedStatusline(site.path, site.key)) continue;
    add({
      kind: "statusline", path: site.path, root: dirname(site.path), harness: site.harness,
      source: "known", mode: "settings", mutation: "ownedStatusline", entries: [],
    });
  }

  // A hook may be registered as entries inside the settings file...
  for (const site of sites.hooks) {
    if (site.key === null) continue;
    if (recordedHookFiles.has(canonicalPath(site.path))) continue;
    if (!existsSync(site.path)) continue;
    if (!settingsHasOwnedHooks(site.path)) continue;
    add({
      kind: "hook", path: site.path, root: dirname(site.path), harness: site.harness,
      source: "known", mode: "settings", mutation: "ownedHooks", entries: [],
    });
  }

  // ...or as a script faberun dropped in a hooks directory. Only faberun-named
  // entries are candidates, so a neighbour's hook script survives.
  for (const site of sites.hooks) {
    if (site.key !== null) continue;
    if (!existsSync(site.path)) continue;
    for (const path of faberunNamedEntries(site.path)) {
      if (recordedHookTrees.has(canonicalPath(path))) continue;
      add({ kind: "hook", path, root: site.path, harness: site.harness, source: "known", mode: "tree", entries: [] });
    }
  }

  const effective = effectiveHome(env);
  const homeExists = existsSync(home);
  const homeIsEffective = effective !== null && canonicalPath(effective) === canonicalPath(home);
  return {
    home,
    roots,
    homeExists,
    homeRemovable: homeExists && !homeIsEffective,
    homeIsEffective,
    artifacts,
    unpreservedLedgers: unpreservedLedgers(home),
  };
}

/**
 * The campaigns under every project in `home` whose ledger is not preserved at
 * its durable, versioned repository location, as `<project>/<campaign>`. A
 * runs directory that does not exist is simply skipped.
 *
 * @param {string} home
 * @returns {string[]}
 */
function unpreservedLedgers(home) {
  /** @type {string[]} */
  const found = [];
  let projects;
  try {
    projects = readdirSync(projectsDir(home), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const runsDir = join(projectsDir(home), project.name, "runs");
    if (!existsSync(runsDir)) continue;
    for (const campaign of unpreservedLedgerCampaigns(runsDir)) found.push(`${project.name}/${campaign}`);
  }
  return [...new Set(found)].sort();
}

/**
 * The children of a hooks directory whose name marks them as faberun's, so the
 * operators's own hook scripts are never candidates.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function faberunNamedEntries(directory) {
  /** @type {string[]} */
  const paths = [];
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return paths;
  }
  for (const name of names) {
    if (/^faberun(?:[-._]|$)/iu.test(name)) paths.push(join(directory, name));
  }
  return paths;
}

/**
 * Whether the settings file carries a status-line entry still pointing at
 * faberun. A faberun-owned value is one whose serialization names the tool, so
 * `statusLine` alone is not proof: an operator who replaced it owns it now.
 *
 * @param {string} path
 * @param {string|null} key
 * @returns {boolean}
 */
function settingsHasOwnedStatusline(path, key) {
  if (key !== "statusLine") return false;
  const settings = readSettingsFile(path);
  return referencesFaberun(settings[key]);
}

/**
 * Whether the settings file carries at least one hook entry that references
 * faberun.
 *
 * @param {string} path
 * @returns {boolean}
 */
function settingsHasOwnedHooks(path) {
  const settings = readSettingsFile(path);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const record = /** @type {Record<string, unknown>} */ (hooks);
  return Object.values(record).some((entries) => Array.isArray(entries) && entries.some((entry) => referencesFaberun(entry)));
}

/**
 * A settings document's JSON value, or an empty object when it is absent,
 * unreadable or not an object. The settings file is the operator's; only the
 * entries faberun recorded or still owns are ever taken back.
 *
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function readSettingsFile(path) {
  try {
    const parsed = readJson(path);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether a JSON value mentions faberun anywhere, the ownership test a
 * pre-registry statusline or hook must pass.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function referencesFaberun(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && text.toLowerCase().includes("faberun");
  } catch {
    return false;
  }
}

/**
 * Remove the recorded settings entries and the known-site entries a settings
 * artifact names. The file is only rewritten when the edit changed it, so an
 * operator's later edit that no longer matches is left byte-for-byte alone.
 *
 * @param {PlannedArtifact} artifact
 * @returns {void}
 */
function applySettings(artifact) {
  const settings = readSettingsFile(artifact.path);
  const before = JSON.stringify(settings);
  /** @type {unknown} */
  let next = settings;
  if (artifact.mutation === "recordedEntries") {
    next = removeRecordedSettingsEntries(settings, artifact.entries);
  } else if (artifact.mutation === "ownedStatusline") {
    const copy = structuredClone(settings);
    if (referencesFaberun(copy.statusLine)) delete copy.statusLine;
    next = copy;
  } else {
    const copy = structuredClone(settings);
    stripOwnedHooks(copy);
    next = copy;
  }
  if (JSON.stringify(next) !== before) writeJsonAtomic(artifact.path, next);
}

/**
 * Remove every hook entry whose serialization references faberun, then any
 * event list and the `hooks` key left empty. The operator's own hook entries
 * keep their place. Returns whether anything changed.
 *
 * @param {Record<string, unknown>} settings
 * @returns {boolean}
 */
function stripOwnedHooks(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const record = /** @type {Record<string, unknown>} */ (hooks);
  let changed = false;
  for (const event of Object.keys(record)) {
    const entries = record[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !referencesFaberun(entry));
    if (kept.length !== entries.length) changed = true;
    if (kept.length === 0) {
      delete record[event];
      changed = true;
    } else {
      record[event] = kept;
    }
  }
  if (Object.keys(record).length === 0) {
    delete settings.hooks;
    changed = true;
  }
  return changed;
}

/**
 * Apply a plan: every artifact through the root-confined removal, then
 * `$FABERUN_HOME` itself. A failure is collected, not thrown, so one refused
 * link cannot strand the rest of the cleanup. Returns the failure messages.
 *
 * @param {UninstallPlan} plan
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function applyUninstall(plan, env = process.env) {
  /** @type {string[]} */
  const failures = [];
  for (const artifact of plan.artifacts) {
    try {
      // The registry is data, not a promise: a recorded path outside the
      // effective roots is refused exactly like a known-site one.
      assertWithinRemovalRoots(artifact.path, plan.roots);
      if (artifact.mode === "settings") applySettings(artifact);
      else removeWithinRemovalRoots(artifact.path, env);
    } catch (error) {
      failures.push(`${artifact.path} · ${errorMessage(error)}`);
    }
  }
  if (plan.homeRemovable) {
    try {
      removeWithinRemovalRoots(plan.home, env);
    } catch (error) {
      failures.push(`${plan.home} · ${errorMessage(error)}`);
    }
  }
  return failures;
}

/**
 * The whole command: plan, refuse an unsafe ledger, list, confirm, apply, and
 * close with the published-package removal.
 *
 * @param {UninstallOptions} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function uninstallCommand(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const level = colorLevel(env, isTTY);
  const plan = planUninstall(env);

  if (plan.unpreservedLedgers.length > 0 && options.force !== true) {
    stderr(`${statusToken("fail", level)} uninstall · unpreserved campaign ledger · ${plan.unpreservedLedgers.join(", ")}\n`);
    stderr("preserve each ledger under its repository (`faberun campaign close --ledger-in-repo`) or re-run with --force\n");
    return 1;
  }
  if (plan.unpreservedLedgers.length > 0) {
    stderr(`${statusToken("warn", level)} uninstall · removing an unpreserved campaign ledger under --force · ${plan.unpreservedLedgers.join(", ")}\n`);
  }
  if (plan.homeExists && plan.homeIsEffective) {
    stderr(`${statusToken("warn", level)} uninstall · $FABERUN_HOME is the effective home; removing the owned artifacts only\n`);
  }

  for (const artifact of plan.artifacts) {
    stdout(`uninstall · ${artifact.kind} · ${artifact.path}\n`);
  }
  if (plan.homeExists) {
    stdout(`uninstall · FABERUN_HOME${plan.homeRemovable ? "" : " (kept)"} · ${plan.home}\n`);
  }
  const total = plan.artifacts.length + (plan.homeRemovable ? 1 : 0);

  if (options.dryRun === true) {
    stdout(`${statusToken("ok", level)} uninstall · dry run · would remove ${total} artifact${total === 1 ? "" : "s"}\n`);
    printPackageHint(stdout, level);
    return 0;
  }
  if (total === 0) {
    stdout(`${statusToken("ok", level)} uninstall · nothing to remove\n`);
    return 0;
  }

  // `--force` and `--yes` are both explicit consent: the operator who asked to
  // remove an unpreserved ledger without being prompted has already decided not
  // to be prompted about the rest either.
  if (options.yes !== true && options.force !== true) {
    const confirmed = await confirmRemoval(options, plan, isTTY);
    if (confirmed === null) {
      stderr(`${statusToken("fail", level)} uninstall · confirmation required; re-run with --yes or --force\n`);
      return 1;
    }
    if (!confirmed) {
      stderr(`${statusToken("fail", level)} uninstall · aborted; nothing removed\n`);
      return 1;
    }
  }

  const failures = applyUninstall(plan, env);
  if (failures.length > 0) {
    for (const failure of failures) stderr(`${statusToken("fail", level)} uninstall · ${failure}\n`);
    return 1;
  }
  stdout(`${statusToken("ok", level)} uninstall · removed ${total} artifact${total === 1 ? "" : "s"}\n`);
  printPackageHint(stdout, level);
  return 0;
}

/**
 * Ask before the destructive part. `null` means no one could be asked (not a
 * terminal and no injected asker), which is a refusal, never a default yes.
 *
 * @param {UninstallOptions} options
 * @param {UninstallPlan} plan
 * @param {boolean} isTTY
 * @returns {Promise<boolean|null>}
 */
async function confirmRemoval(options, plan, isTTY) {
  if (options.ask === undefined && !isTTY) return null;
  const asker = options.ask === undefined
    ? makeAsker()
    : { ask: options.ask, close: () => {} };
  try {
    const target = plan.homeRemovable ? ` and FABERUN_HOME ${plan.home}` : "";
    const answer = (await asker.ask(`Remove ${plan.artifacts.length} faberun artifact(s)${target}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    asker.close();
  }
}

/**
 * @returns {{ask: Asker, close: () => void}}
 */
function makeAsker() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (question) => rl.question(question), close: () => rl.close() };
}

/**
 * The one thing a local removal cannot undo: the published package itself.
 *
 * @param {Writer} stdout
 * @param {number} level
 * @returns {void}
 */
function printPackageHint(stdout, level) {
  stdout(`${statusToken("ok", level)} uninstall · remove the published package · npm uninstall -g ${packageName()}\n`);
}
