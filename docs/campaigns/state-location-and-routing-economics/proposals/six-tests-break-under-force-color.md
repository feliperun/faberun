# Six tests match CLI output with the colour still in it

Found 2026-09-20 while running `5-the-planner-reaches-its-own-engine`'s
`finalVerification` by hand. Six tests failed; all six passed on the same
commit once `NO_COLOR=1` was exported. They cost one full verification cycle
before the cause was clear.

## The mechanism, verified rather than guessed

`colorLevel(env, isTTY)` in `src/cli/brand.mjs`:

    NO_COLOR set        -> 0
    FORCE_COLOR set     -> 1..3
    not a TTY           -> 0
    otherwise           -> 2, or 3 under COLORTERM=truecolor

The tests assert on CLI output with regexes like
`/\[warn\] agy · no skills directory/u`, but the CLI emits
`\x1B[1m\x1B[33m[warn]\x1B[0m agy · …`. The reset sequence lands between
`[warn]` and the rest, so the match fails on text that is, in substance,
exactly right.

**This is narrower than it first looks, and the narrowing matters.** A plain
`npm test` from a terminal does *not* hit it: the CLI's own stdout inside a
test is captured, not a TTY, so `colorLevel` returns 0 and nothing is coloured.
Only an environment that exports `FORCE_COLOR` reaches the failure.

It is still worth fixing, because of *which* environments do that. Claude Code
exports `FORCE_COLOR=3`. This repository is a tool for driving agent harnesses,
and being developed from inside one is its normal case, not an exotic one. So
the six failures land on precisely the audience the product is written for --
and they land looking like six real regressions.

## The six

- `test/cli/cli.test.mjs` — "run warns when a node id is already done in
  another run"
- `test/cli/init.test.mjs` — "init --yes ignores .runs, installs the skill, and
  skips the agent kit", "a non-git directory exits 1"
- `test/cli/skills-register.test.mjs` — "a second register reports unchanged",
  "a missing skills directory is a warn line, not an error"
- `test/notify/inbox.test.mjs` — "done-when 6: unset transport warns and
  resolves to noTransport; --wake reports canWake false"

## The fix

Run the CLI with colour off where the test asserts on its text. The engine
already does exactly this for verification commands -- `SIDE_EFFECT_ENV_KEYS`
in `src/host/preflight.mjs` subtracts the environment that would change what a
measured command does -- so the precedent and the reasoning both exist in the
tree. A test that asserts on rendered text is measuring the text, and the
operator's terminal preferences are not part of what it measures.

Stripping ANSI before matching is the other option and is worse: it would let a
test pass while the CLI emitted something genuinely malformed, and it spreads a
helper across every assertion site instead of fixing the input once.

Whichever is chosen, one test should pin the rule itself, so the seventh
instance does not arrive the same way.

## Size

Small: six assertion sites in four files, plus one test pinning the convention.
No source change.
