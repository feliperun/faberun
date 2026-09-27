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
