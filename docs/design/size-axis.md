# Size as a modifier axis

Status: **built.** Primitives is now genuinely multi-mode — one
`ResolvedCollection` per size mode, mirroring how Themes already works —
fed by a dedicated `sizes` role, both sync directions (`token-merger.ts`,
`figma-to-tokens.ts`) and CSS generation (`css.ts`). §4's open questions are
resolved inline below (superseded — kept for the reasoning, not as a live TODO
list). See `DECISIONS.md`'s "Primitives Is a Genuine Multi-Axis Layer" entry
for the concrete file-by-file shape and the real bug this replaced (folding
`size` into `primitives` produced silently inconsistent CSS vs. committed
JSON — found via a real push against Coop's data).

---

## 1. What "Size" actually is, in the real system

Evidence from Coop's real `coop-design-tokens` repo and `web-design-extractor`
build tool (not a screenshot guess):

- **It's an ordinary Token Studio theme group** — `Size`, two modes (`mobile`,
  `desktop`), same `enabled`/`source` contract as every other theme
  (`docs/interop/token-studio.md`). Nothing structurally special about it on the
  Token Studio side.
- **The primitive scale is formula-derived, not duplicated.** One shared formula
  (`floor(step / base * figma-font-size * N)`) computes ~40 dimension steps;
  mobile and desktop each only override 3 coefficients. Figma itself never sees
  the formula — Variables hold the already-computed number per mode, the same
  way any other multi-mode primitive does. No math evaluation needed on our side.
- **What actually varies by size is narrow**: only `fontSize`, `lineHeight`,
  `letterSpacing` inside typography. Border-radius, spacing, shadows, borders do
  not vary by size in this system (border-radius varies by theme instead).
- **Everything else still gets duplicated into every size block regardless**,
  even when it's identical across mobile/desktop — and Coop's own build code has
  a standing, unresolved comment about it wanting exactly the kind of
  value-based dedup `css.ts` already does for light/dark (see §2).
- **Output is mobile-first with an explicit-override escape hatch**: base
  (mobile) styles apply unconditionally; desktop styles apply both inside
  `@media (min-width: 768px)` *and* under an explicit `.size-desktop` class, so
  a component can force desktop sizing regardless of viewport.

## 2. Why this doesn't need a new concept

Size is a **modifier axis**, not a composing axis like theme or color scheme —
it doesn't replace a value, it layers on top of whichever theme/scheme is
already active, and it only ever touches the narrow set of tokens that actually
vary by it (see `DECISIONS.md` §1, "Colour mode and size are orthogonal").

The useful realization: **structurally, it's the same mechanism `css.ts`
already builds for light/dark**, just keyed on viewport width instead of OS
preference:

| Color scheme (built)                          | Size (proposed)                              |
|------------------------------------------------|-----------------------------------------------|
| `:root` = light (default)                       | `:root` = mobile (default/base)               |
| `[data-color-scheme="dark"]` = dark-only diff   | `[data-size="desktop"]` = desktop-only diff   |
| `[data-color-scheme="auto"]` = light diff       | `[data-size="auto"]` = mobile diff            |
| `@media (prefers-color-scheme: dark)` wrapping `[data-color-scheme="auto"]` | `@media (min-width: 768px)` wrapping `[data-size="auto"]` |

That means `diffTokens`, `semanticBlock`, and `semanticMediaBlock` in
[css.ts](../../plugin/src/shared/transformer/css.ts) are almost directly
reusable — Size becomes another axis fed through the same functions with a
different selector/media-query pair, not new machinery.

It also means Coop's own open TODO — dedupe values that don't actually vary by
size instead of duplicating them into every size block — is already solved by
`splitSharedSemanticTokens`'s value-based comparison, *if* Size piggybacks on
that same code path. We'd be handing them something their own build tool
explicitly wanted and hadn't gotten to.

**Scope is naturally self-limiting.** Rather than hardcoding "only
fontSize/lineHeight/letterSpacing vary by size," the mapped Size collection's
own contents define what varies — exactly how Themes/Semantic already scope
themselves today. If a design system's Size collection only contains typography
sub-fields, that's the entire size-varying set; nothing else needs excluding.

## 3. Proposed shape

```jsonc
// metadata.json — both additions optional; a project with neither gets no
// size-axis output at all, same backwards-compatible pattern as ignoredCollections.
{
  "figma": {
    "collections": {
      "primitives": "Primitives",
      "global": "Global",
      "themes": "Themes",
      "semantic": "Semantic",
      "sizes": "Size"               // NEW — optional
    }
  },
  "sizes": [                         // NEW — optional, mirrors colorSchemes' shape
    { "name": "mobile" },                       // default/base — no minWidth
    { "name": "desktop", "minWidth": 768 }
  ]
}
```

CSS generation gains a fourth axis alongside primitives/themes/semantic,
following the table in §2 exactly — default size merges into `:root` at the
same point `defaultTheme` does now, non-default sizes get a `diffTokens`
override block, and the `auto` + `@media (min-width: …)` pair reuses
`semanticMediaBlock` with the query parameterized instead of hardcoded.

Because each axis (theme, color scheme, size) only ever emits its own diff
against its own default, combinations like
`[data-theme="brandb"][data-color-scheme="dark"][data-size="desktop"]` fall out
of the ordinary CSS cascade for free — no cartesian product generation, which
is the principle already recorded in `DECISIONS.md`.

## 4. Open questions — resolved

- **Where do breakpoint pixel values live?** Decided: `metadata.json`, as
  `sizeBreakpoints: Record<string, number>` (non-base mode name → px),
  alongside a new `sizes: string[]` mode-order list — mirrors `themes`/
  `colorSchemes` exactly.
- **Two modes or N?** Decided: N. Primitives becoming genuinely multi-mode
  (like Themes already is) costs nothing extra for supporting more than two —
  `metadata.sizes` can list any number of modes.
- **Does `auto` default on, like color scheme does?** Decided: no wrapper
  needed at all. The non-default mode's override is wrapped in an
  *unconditional* `@media (min-width: …)` targeting `:root` directly — a
  viewport breakpoint applies automatically with zero markup, unlike OS
  dark-mode preference which color scheme deliberately gates behind an opt-in
  `[data-color-scheme="auto"]`. `[data-size="…"]` is the explicit *pin/override*
  on top of that, not something required to get responsive behavior at all.
- **Sequencing with the collection-mapping UI.** Built together — `sizes` is
  the mapping UI's fifth role, one mechanism, as planned.

## 5. What this deliberately does not require

- No math/formula evaluation — Figma Variables already hold each mode's
  computed value; the formula is invisible to us by construction of the
  live-Figma-sync approach (see `docs/design/canonical-model.md` §3).
- No change to reference resolution or push-diff logic beyond recognizing
  `sizes` as a fifth collection role name.
- No new CSS selector convention beyond `[data-size="…"]`, consistent with the
  existing attribute-based (not class-based) approach — Coop's real class-based
  output is a stylistic choice of their build tool, not something Token Sync
  needs to match.
