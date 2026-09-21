# The brand ratchet reads what git was told to ignore

Found 2026-09-20 while running `5-the-planner-reaches-its-own-engine`'s
`sharedVerification` by hand before landing. It failed in the operator's own
checkout with 1871 offending lines, and every one of them sat in a directory
git ignores. The same command passed 36/0 in a clean worktree at the identical
commit, so the change was never implicated.

## What it is

`test/repo/brand.test.mjs` walks the repository from `REPO_DIR` and reads every
text file, skipping a hand-written set of directory *names*:

    const SKIPPED_NAMES = new Set([".git", ".runs", "node_modules", "assets"]);

The list is a snapshot of what was "not source" the day it was written. Two
directories that exist today are missing from it:

- **`.faberun-plan/`** -- created by this product's own plan pipeline, on the
  operator's repository, holding `repo-facts.json` and the round findings. It
  is gitignored (`.gitignore:9`). One leftover from yesterday's planner spike
  contributed most of the 1871 lines, because repo facts quote campaign and run
  ids that still carry the previous brand.
- **`.claude/worktrees/`** -- harness scratch, excluded through
  `.git/info/exclude`, holding a full second checkout of the repository. Note
  that `.claude/hooks/` and `.claude/skills/` *are* source and must stay
  scanned, so a blanket `.claude` skip would be wrong.

The irony is worth recording: `.faberun-plan` exists *only because* `.runs`
could not be used for it -- `PLAN_SCRATCH_DIR_NAME` in `src/plan/pipeline.mjs`
explains that a present `.runs` makes a repository read as an unmigrated legacy
layout. The exclusion list was never updated to match the directory that
decision created.

## Why it matters

The product ships a command (`faberun plan`) that writes a directory which
makes the product's own test suite red on the machine that ran it. CI never
sees it, because a fresh checkout has no scratch, so the failure only ever
reaches an operator -- and it reaches them as 1871 lines of noise that look
like a brand regression and are not.

## The candidate fix, and the one to avoid

**Avoid** simply appending `.faberun-plan` to `SKIPPED_NAMES`. That repeats the
mistake: the next scratch directory this product invents will be forgotten the
same way, and the list will keep drifting behind reality.

**Prefer** skipping what git itself says is ignored -- `git ls-files --others
--ignored --exclude-standard`, or `git check-ignore`. It covers `.faberun-plan`,
`.claude/worktrees`, and anything an operator has lying around, with no list to
maintain.

One thing the fix must *not* do: skip everything git does not track. A brand-new
file an author just created is untracked, and the ratchet exists precisely to
catch the old name arriving in one. Ignored is the right predicate; untracked
is not.

`SKIPPED_PATHS` (`docs/history`, `docs/campaigns`, `evals/golden`,
`evals/planner`, `CHANGELOG.md`) stays as it is -- those are tracked records,
deliberately excluded for a different reason, and the file's own header explains
it well.

## Size

Small: one walk predicate in one test file, plus a test that proves an ignored
path is skipped and an untracked-but-not-ignored path is still read. No source
change, no persisted shape, no contract version.
