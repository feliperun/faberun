# Faberun design system

The visual and verbal identity of the `faberun` command line, its dashboard
and its documentation. This file is the source of truth: a renderer that
disagrees with it is a defect, and a change to the identity lands here first.

## Identity

**Faberun** joins *faber* (Latin: maker, craftsman, builder) and *run* (what
software does). The name marks the transition from making to running: the
tool holds an intent, coordinates the work, verifies what was actually built,
and decides what happens next.

**Mark.** The nest of the rufous hornero (*Furnarius rufus*, the Brazilian
*joão-de-barro*). The bird builds a clay dome in layers, each layer laid on a
structure that already stands, and the finished nest outlives the season it
was built in. That is the way this tool grows software: every step on top of
a product that already works, with evidence that it does. The bird is the
builder; the nest is the running system.

**Tagline.** *From intent to running software.*

**Voice.** Plain, factual, measured. State what happened and what is needed,
with counts and identifiers instead of adjectives. No exclamation marks, no
emojis in product output, no ALL-CAPS words. Command names, node states and
error codes stay lowercase. The operator is addressed as *you*; models,
harnesses and workers are named by their identifiers, never blamed.

## Palette

Five colors, named in Portuguese after their material. Each has one meaning
and one job; a color is never used for a second meaning.

| Name | Hex | Meaning | Job |
| --- | --- | --- | --- |
| Terra | `#B5522A` | energy, construction, action | brand, headings, the failed/blocked state |
| Argila | `#D97B4F` | creativity, process, transformation | work in progress, warnings, advisories |
| Areia | `#F4E9D8` | clarity, balance, simplicity | light surfaces and panels |
| Folha | `#556B3F` | growth, evolution, continuity | done, verified, promoted |
| Carvão | `#1F1F1F` | focus, reliability, contrast | text on light surfaces, dark surfaces |

### Text tints for dark surfaces

The base colors were chosen for Areia. On Carvão, Terra (3.3:1) and Folha
(2.8:1) fall below the 4.5:1 body-text contrast. Text on a dark surface uses
these derived tints; the base colors stay for fills, borders and marks.

| Tint | Hex | Contrast on Carvão |
| --- | --- | --- |
| Terra 300 | `#E0875F` | 6.1:1 |
| Argila 300 | `#ECAB86` | 8.4:1 |
| Folha 300 | `#93AA70` | 6.5:1 |

Contrast ratios above are WCAG 2.x relative-luminance ratios computed from the
hex values. Terra on Areia is 4.2:1 and Folha on Areia is 4.9:1; Argila on
Areia is 2.5:1 and is therefore never used for text on a light surface.

### Semantic roles

Every rendered state maps to exactly one role. New states pick a row here;
they do not pick a color.

| Role | Color | Glyph | ASCII fallback | Used for |
| --- | --- | --- | --- | --- |
| brand | Terra, bold | — | — | the word `faberun`, section headings |
| ok | Folha | `✓` | `+` | `done`, `verified`, `promoted`, `[ok]` checks |
| progress | Argila | `·` | `.` | `running`, `pending`, `waiting`, `recovering` |
| warn | Argila, bold | `!` | `!` | `[warn]` checks, advisories, `attention` |
| fail | Terra, bold | `✗` | `x` | `failed`, `blocked`, `exhausted`, `stalled`, `[fail]` checks |
| muted | terminal dim attribute | — | — | paths, timestamps, secondary detail |
| text | terminal default foreground | — | — | everything else |

In a terminal the background color is unknown, so palette colors are applied
only to short tokens: the brand word, glyphs and the bracketed check words.
Body text keeps the terminal's default foreground, and secondary detail uses
the dim attribute rather than Areia or Carvão.

## Terminal rendering

### Color capability

Resolved once per process, in this order:

1. `NO_COLOR` set to any value → no color, no bold, no dim.
2. `FORCE_COLOR` set → color on, level from the value (`1` 16 colors, `2`
   256, `3` truecolor; empty means truecolor).
3. stdout not a TTY, or `TERM=dumb` → no color.
4. `COLORTERM` is `truecolor` or `24bit` → 24-bit palette colors.
5. otherwise → 256-color approximations.

`--json` output is never colored, whatever the capability. Colors are never
written into files, logs, `STATUS.md` or `HANDOFF.md`.

| Color | 24-bit | 256-color index | 16-color |
| --- | --- | --- | --- |
| Terra | `38;2;181;82;42` | 166 | red (31) |
| Argila | `38;2;217;123;79` | 173 | yellow (33) |
| Folha | `38;2;85;107;63` | 65 | green (32) |

### Glyphs

Unicode glyphs (`✓ · ! ✗`) are used when the locale advertises UTF-8
(`LANG`, `LC_ALL` or `LC_CTYPE` containing `UTF-8`) and the terminal is not
`dumb`; otherwise the ASCII fallback column applies. The check-line tokens
`[ok]`, `[warn]` and `[fail]` are text, not glyphs: scripts and tests match
them, so they keep their spelling and only gain color.

### The banner

Shown by `faberun` with no arguments, `faberun --help` and `faberun setup`,
and only when stdout is a TTY. Piped output and `--json` never receive it.
ASCII only, so it survives every monospace font; five lines, at most 72
columns.

```
       .-~~~-.
    .-'  .-.  '-.       faberun
   /    (   )    \      from intent to running software
   \     '-'     /
    '-.._____..-'       v0.4.0 · node 26.8.1 · 5 harnesses detected
```

The dome lines are Terra; the opening (`.-.`, `(   )`, `'-'`) is muted; the
word `faberun` is brand; the tagline is text; the last line is muted and is
filled from the running process (package version, `process.version`, the
number of harness binaries on `PATH`). `faberun --version` prints one line
without the mark: `faberun 0.4.0`.

### Line grammar

The existing check-line grammar is the house style and does not change:

```
[ok] git repository · /path/to/repo
[warn] no human notification transport is configured
[fail] binary codex · required by contract but not found on PATH
```

- One fact per line. The token, a space, the subject, ` · `, the detail.
- `·` (U+00B7) is the only inline separator. No `|`, `->`, `=>` or `—` in
  product output.
- Errors go to stderr; results and reports go to stdout.
- Exit codes: `0` success, `1` a check or command failed, `2` usage error.
- A usage error prints one `usage:` line per verb, no banner.
- Tables (status, report) keep their current fixed-width layout; only the
  state column gains the role color.
- Prompts in `setup` and `init` are one question per line, ending in `?`,
  with the default in brackets: `Default worker runtime? [dsh-deepseek]`.

## Web dashboard

The dashboard (`src/web/index.html`) takes its colors from CSS custom
properties named after the palette, so the terminal and the page share one
vocabulary:

```css
--fr-terra: #B5522A;  --fr-terra-300: #E0875F;
--fr-argila: #D97B4F; --fr-argila-300: #ECAB86;
--fr-areia: #F4E9D8;
--fr-folha: #556B3F;  --fr-folha-300: #93AA70;
--fr-carvao: #1F1F1F;
```

- Light scheme: Areia surface, Carvão text, base colors for chips and
  borders. Dark scheme (`prefers-color-scheme: dark`): Carvão surface, Areia
  text, the 300 tints for colored text.
- Shapes are matte clay: flat fills, no gradients, no shadows, 8 px corner
  radius on panels and 4 px on chips.
- Type: the system sans-serif stack
  (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`) for
  prose and the system monospace stack
  (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`) for
  identifiers, paths, commands and counts. No web fonts: the page makes zero
  external requests, like the CLI has zero runtime dependencies.
- State chips use the semantic roles above, one role per state.

Restyling the dashboard to this section is a planned follow-up, not part of
the first Faberun release.

## Assets

| File | Content | Use |
| --- | --- | --- |
| `assets/faberun-icon.png` | the hornero on its nest, 438 × 434, RGB | README hero, GitHub social preview, app icons |

Rules: never recolor, stretch or crop the icon; keep clear space equal to a
quarter of its width; on dark surfaces place it on an Areia tile. There is no
horizontal logo: the icon and the wordmark `faberun` in the system sans-serif,
Terra, lowercase, set side by side.

## Documentation

- English throughout the repository: code, comments, identifiers, docs.
- `faberun` is lowercase when it names the command or the package, and
  `Faberun` when it names the project in prose.
- Files are plain Markdown; headings in sentence case; one idea per
  paragraph; tables for parallel facts.
- Reference material is written in the present tense and states what the
  code does now. History (retrospectives, specs, campaign records) is never
  rewritten to match the present; see `docs/history/README.md`.
