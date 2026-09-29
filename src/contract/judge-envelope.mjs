/**
 * The judge envelope: the limits `parseJudge` enforces, the reasons it rejects
 * by, and the byte budget a judge prompt itself must fit.
 *
 * They live apart from the parser because the judge prompt must render the same
 * numbers. A judge that is never told the limit can only be discarded by it: a
 * thorough arbitration that overshoots the envelope is rejected unread, and the
 * bounded re-ask repeats the defect, because nothing in the prompt said what to
 * shorten. One source keeps the advertised envelope and the enforced one
 * unable to drift.
 */

/** The verdict envelope, in the units `parseJudge` measures: bytes, and a count. */
export const JUDGE_LIMITS = {
  summaryBytes: 4 * 1024,
  findings: 32,
  descriptionBytes: 2 * 1024,
  evidenceBytes: 4 * 1024,
};

/** The reason `parseJudge` throws when the verdict envelope itself overshoots. */
export const JUDGE_ENVELOPE_REASON = "judge result exceeds limits";

/** The reason `parseJudge` throws when a single finding overshoots the envelope. */
export const JUDGE_FINDING_ENVELOPE_REASON = "judge finding exceeds limits";

/**
 * The byte budget a judge prompt must fit.
 *
 * The prompt carries the Definition of Done, the evidence and the re-ask
 * instruction, so it is the one judge artefact that must never be cut to fit.
 * `dispatch.mjs` enforces this budget on the prompt it assembles, and the
 * rotation in `engine/phase-session.mjs` refuses with it rather than bounding
 * the caller's prompt down, which would send a judge to arbitrate less than the
 * node declared. One number, two call sites.
 */
export const JUDGE_PROMPT_BYTES = 64 * 1024;

/** The reason an oversized judge prompt is refused, byte-for-byte in both call sites. */
export const JUDGE_PROMPT_REASON = `judge prompt exceeds ${JUDGE_PROMPT_BYTES} bytes`;
