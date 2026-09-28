/**
 * The file-effect boundary for an fx worker, decided per ACP permission
 * request. fx in `ask` mode asks its client before every shell command and
 * file mutation, so the contract's `sandbox` value becomes a decision this
 * module makes, not a mode fx is trusted to enforce.
 */

import { isAbsolute, relative, resolve } from "node:path";

/**
 * The permission verdict for one ACP tool call. Shell commands run in every
 * mode, as they do under dsh's `workspace-write`: the worktree, not a shell
 * parser, is what bounds them. File mutations are decided by path.
 *
 * @param {string} sandbox
 * @param {string} workspace real path of the worker's cwd
 * @param {Record<string, any>} toolCall
 * @returns {{allow: boolean, reason: string|null}}
 */
export function permissionVerdict(sandbox, workspace, toolCall) {
  if (sandbox === "danger-full-access") return { allow: true, reason: null };
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "other";
  if (kind === "read" || kind === "search" || kind === "think" || kind === "execute") return { allow: true, reason: null };
  if (kind !== "edit" && kind !== "delete" && kind !== "move") {
    return { allow: false, reason: `${kind} tools need danger-full-access` };
  }
  if (sandbox === "read-only") return { allow: false, reason: "the sandbox is read-only" };
  const path = toolCall.rawInput?.path;
  if (typeof path !== "string" || !path) return { allow: false, reason: "a file mutation named no path" };
  const inside = relative(workspace, resolve(workspace, path));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return { allow: false, reason: `${path} is outside the workspace` };
  }
  return { allow: true, reason: null };
}
