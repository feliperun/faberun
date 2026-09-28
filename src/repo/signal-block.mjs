export const SIGNAL_START = "<!-- faberun-active:start (managed by faberun — read, never edit) -->";
export const SIGNAL_END = "<!-- faberun-active:end -->";

/**
 * Remove a complete runner-managed block, markers included, and join the text
 * around it with the blank line the runner writes before it. A file whose
 * commit has no block and whose working copy gained one therefore normalizes
 * to the same text: measured 2026-09-25, keeping the markers made the block
 * the runner appends to a block-less AGENTS.md read as a human edit, and the
 * planner's review stage refused the tree its own draft stage had just
 * written. Guidance outside the block remains part of source identity.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeManagedSignalBlock(text) {
  const start = text.indexOf(SIGNAL_START);
  const end = text.indexOf(SIGNAL_END, start + SIGNAL_START.length);
  if (start < 0 || end < start) return text;
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + SIGNAL_END.length).replace(/^\s+/u, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

/**
 * Apply a freshly rendered managed block to `text`, but only when the start
 * marker is already present. A document without the marker is the operator's
 * file, not the runner's: it is returned byte-identical so no campaign
 * operation can quietly append a managed block to an `AGENTS.md` that never
 * opted in. The operator opts in by pasting the start marker once, and this
 * repository already carries it.
 *
 * `block` is the renderer's output, or `""` to remove a block that is present
 * once the run settled. The surrounding text is joined with the same blank
 * line the writer always used, so a rewrite of an existing block and its
 * removal both normalise to the file's committed shape.
 *
 * @param {string} text
 * @param {string} block
 * @returns {string}
 */
export function applyManagedSignalBlock(text, block) {
  const start = text.indexOf(SIGNAL_START);
  if (start < 0) return text;
  const end = text.indexOf(SIGNAL_END, start + SIGNAL_START.length);
  const before = text.slice(0, start).trimEnd();
  const after = end < 0 ? "" : text.slice(end + SIGNAL_END.length);
  return [before, block, after.trimStart()].filter((part) => part.length).join("\n\n") + "\n";
}
