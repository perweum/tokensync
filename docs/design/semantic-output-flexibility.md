# Flexible semantic output groups (Global-light / Global-dark / Theme-light / Theme-dark)

Status: **explored, no code decision made.** Mostly turns out to be a
documentation gap rather than a missing mechanism — one narrow, genuinely new
capability is identified in §4 and left for a real need to justify, not built
speculatively.

---

## 1. The actual ask

Raised directly (September 2026): existing design systems already have a CSS
extractor (their own build tool, not Token Spark's) that expects semantic
output organized into named groups — the example given was **Global-light,
Global-dark, Global, Theme-light, Theme-dark**. The goal is more flexibility
for teams whose pipeline already expects this shape, without costing this
project reliability or adding speculative complexity to the sync core.

## 2. What each of those five names already maps to

Checked directly against the current model rather than assumed:

- **Global** → the existing Global role (`semantic/global/*.json`) — a value
  that's identical regardless of theme or color scheme. **Already built.**
- **Theme-light / Theme-dark** → the existing Themes role's `light.*`/`dark.*`
  halves. **Already built** — and already smarter than a naive split: `css.ts`
  compares resolved *values*, not file structure, so a token that happens to
  be identical across schemes gets hoisted to `:root` automatically instead of
  duplicated into both a light and dark block (see the *CSS Deduplication Is
  Value-Based, Not File- or Metadata-Based* decision in `DECISIONS.md`). A
  team asking for "Theme-light" and "Theme-dark" as distinct outputs already
  gets exactly that whenever the values genuinely differ, with no
  configuration required.
- **Global-light / Global-dark** → the real gap, and worth naming precisely:
  this is a **mode-varies, theme-invariant** token — different in light vs.
  dark, but identical across every brand/theme. `docs/interop/
  migration-patterns.md`'s own classification table calls this out as a real,
  distinct category ("system colours — danger, success, warning, info" — mode:
  yes, brand: no). **Token Spark already has a working instance of exactly
  this pattern** — severity tokens, which reference a primitive directly in
  `semantic/light.json`/`semantic/dark.json` rather than aliasing into a
  theme — but it isn't formalized as part of the Global role, isn't
  documented as an intentional, reusable pattern, and isn't something Map
  Collections lets a team assign a collection to explicitly. It falls out
  implicitly from whether a token's raw `$value` happens to reference a
  theme alias or a primitive directly.

## 3. Why this reads as a documentation gap more than a missing mechanism

`docs/design/transformer-configurability.md` already did the hard thinking
here for the output-*shape* side of this exact question (Coop's own
class-based, custom-named CSS output vs. Token Spark's attribute-based one)
and landed on a conclusion worth reusing rather than re-deriving: **don't
build a generic, arbitrary-naming config surface.** Style Dictionary — the
most mature, widely-adopted tool in this space, and what Coop's own extractor
is built on — doesn't offer selector/naming configurability through options
either; teams with divergent needs write real adapter code against its plugin
API instead. The token JSON being clean, standard, and documented is the
actual interop surface; a team's own extractor is already capable of doing
its own classification against it — `migration-patterns.md` records this
literally happening, mechanically, with zero manual review, across 295 real
semantic tokens.

The same lesson generalizes from *output naming* to *role naming*: adding a
configurable "call this bucket whatever your other tool calls it" surface
risks the identical complexity trap for a benefit that's mostly cosmetic. The
mechanism a team actually needs — mode-only tokens, theme-only tokens,
fully-invariant tokens — already exists; it's just filed under different
names than a specific external tool uses.

## 4. The one legitimate, narrow gap

The Global role today is locked to being invariant on *both* axes (README:
"Never changes between themes or color schemes"). A team that wants a formal
"Global, but split by light/dark" bucket has no first-class way to express
it — they'd have to fake it by duplicating a value into every theme, or rely
on the same implicit light.json/dark.json-direct-reference pattern severity
tokens already use, which Map Collections has no UI for and nothing
documents as intentional.

**Proposed extension, if a real need justifies it:** let `semantic/global/`
optionally split into per-scheme files — `semantic/global/light.json`,
`semantic/global/dark.json` — mirroring exactly how the top-level
`semantic/light.json`/`dark.json` already work. Same `metadata.colorSchemes`
merge loop, same value-based CSS dedup, same diff machinery. This adds zero
new axis and zero new role concept: Global simply gets to *optionally*
participate in the colorScheme axis that already exists everywhere else,
instead of being structurally locked out of it. Additive — a project that
never uses per-scheme Global files sees identical behavior to today.

## 5. Recommendation

- **Don't** build a generic "name your own semantic groups" config surface —
  same reasoning `transformer-configurability.md` already established for
  output shape, now shown to apply to role/axis naming too.
- **Do** write down, in README or a docs page, how to model each of the five
  categories a team like this might ask for in Token Spark's existing model —
  turns a perceived missing feature into a solved mapping exercise.
- **Consider** building §4's narrow Global-light/dark split if a real team
  hits the need in practice. Small, additive, reuses fully-tested machinery —
  but don't build it ahead of a confirmed case; this project has repeatedly
  learned that lesson the expensive way (see `DECISIONS.md`'s Core
  Priorities section on the Size-axis incident).

## 6. Open questions

- Has any real project (Coop, Spor, or a future one) actually hit the need
  for a Global-light/dark split, or is this anticipatory? Worth confirming
  against real data before building §4.
- If built, does Map Collections need a UI affordance for it, or is a
  `metadata.json` hand-edit enough for what's likely a rare need — consistent
  with this project's "config is hand-editable" principle
  (`docs/principles/no-lock-in.md`)?

## See also

- `docs/design/transformer-configurability.md` — the parallel reasoning this
  borrows, for output shape rather than role naming
- `docs/interop/migration-patterns.md` — "Global versus brand-specific",
  "Token categories behave differently"
- `README.md` — Global role description, Themes layer, CSS deduplication
