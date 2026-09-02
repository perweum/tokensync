# Migration patterns

What a large multi-brand token system actually looks like, and what the code side
needs from it. Drawn from migrating a 14-brand retail design system in 2026.

Useful for shaping defaults, templates and migration tooling.

---

## The layer model that emerged

Three layers, each with one responsibility:

```
primitives     raw values — palettes, scales. No brand or mode meaning.
    ↓
theme          per brand: which palette and step each role uses, in light and dark
    ↓
semantic       the only layer exported to code
```

Sizes are the numbers in a real system:

| Layer | Tokens |
|---|---|
| `primitives/color` | 204 (17 palettes × 12 steps) |
| `primitives/size`, `primitives/global` | 75 |
| `primitives/typography/*` | 42 files, one per brand per type |
| `theme/{brand}` | 274 × 14 brands |
| `semantic/*` | 491 across 5 files |

The semantic layer is what components consume. Everything below it is
implementation detail.

---

## Multi-dimensional theming

Three independent axes, and they compose:

| Axis | Values | Affects |
|---|---|---|
| brand | 14 | colours, font family, radius |
| colour mode | light, dark | colours only |
| size | mobile, desktop | typography scale, spacing |

The critical observation for CSS generation: **colour mode and size are
orthogonal.** Dark mode changes 184 colour variables and nothing else. Desktop
changes 59 typography and dimension variables and nothing else. No token is
affected by both.

That means three CSS blocks suffice, not four:

```css
[data-theme="extra"]                             /* base: mobile, light */
[data-theme="extra"][data-color-scheme="dark"]   /* colours only */
@media (min-width: 768px) { [data-theme="extra"] }  /* sizes only */
```

Tools should detect orthogonality rather than emitting the full cartesian product.

---

## Global versus brand-specific

The single highest-value structural split. Some semantic tokens depend on the
active brand; others reference the palette directly and are identical across all
brands.

| | Tokens | Example |
|---|---|---|
| brand-dependent | 150 | `color/dominant/base-default` → `{color.light.dominant.*}` |
| global | 145 | `color/danger/base-default` → `{red.500}` |
| neither brand nor mode | 51 | `dimension/8`, `shadow/xs`, `border-width/default` |

Splitting them changed the output substantially:

| | Before | After |
|---|---|---|
| `common.css` | 153 variables | 196 |
| per-brand file | 861 variables | 274 |
| overlap | 570 | 0 |

Roughly 8000 duplicated variable declarations removed across 14 brand files.

**The classification rule is mechanical.** A token is brand-dependent if its value
references the theme layer:

```
{color.light.*}  {color.dark.*}  {font-family.*}  {font-weight.*}  {border-radius.N}
```

Everything else is global. In the migration this rule classified all 295 semantic
colour tokens correctly with no manual review, and the split fell neatly along
role boundaries — brand roles on one side, severity and system roles on the other.

A migration tool can compute this split automatically and offer it.

---

## Token categories behave differently

Not everything varies along every axis. A tool that assumes uniformity will
duplicate needlessly.

| Category | Brand | Mode | Size |
|---|---|---|---|
| brand colours | yes | **yes** | no |
| system colours (danger, success…) | no | **yes** | no |
| typography | yes | no | **yes** |
| border-radius | yes | no | no |
| dimension, shadow, opacity, border-width | no | no | **yes** / no |

This drove the file structure: five semantic files rather than two, so each file
maps cleanly onto one combination of axes.

---

## Canonical slot structure

Every colour role uses the same 16 slots:

```
background-default   surface-hover    border-strong   base-hover
background-tinted    surface-active   text-subtle     base-active
surface-default      border-subtle    text-default    base-contrast-subtle
surface-tinted       border-default   base-default    base-contrast-default
```

Found in the wild with the slots present but in arbitrary order per role — `info`
started at `surface-active`, `warning` at `text-default`. Purely cosmetic, but it
made the files hard to scan and diff.

Normalising order is safe (values unchanged, only key order) and worth offering as
a lint or formatter.

Roles with their own structure existed too — `focus` (2 slots), `logo` (7),
`illustration` (6), `overlay` (1). A tool should not assume 16.

---

## CSS output shapes seen in practice

Two conventions, both valid:

**Attribute-based**
```css
[data-theme="extra"] { … }
[data-theme="extra"][data-color-scheme="dark"] { … }
```

**Class-based with dual pattern**
```css
.extra.light, .light .extra { … }
.extra.dark,  .dark .extra  { … }
.extra .size-mobile { … }
```

The dual pattern lets the theme sit on the element itself or on an ancestor. The
existing generator emitted both plus a media query for size.

Whatever the shape, the requirement is the same and worth stating plainly:

> Component code uses one variable name. It never references brand, colour mode
> or breakpoint.

The token files being split by mode is irrelevant to this. `semantic/theme-light.json`
and `semantic/theme-dark.json` define **the same 248 token names** — only the
reference differs. Source organisation and output contract are separate concerns,
and conflating them caused a long detour in the migration.

---

## Migration friction worth tooling for

Ranked by time cost observed:

1. **Silent config loss after import** — `source` sets disappearing. Needs a
   post-import validation that compares against expected topology.
2. **Renames** — folder or collection renames break `$themes.json` and
   `$metadata.json`. Needs an atomic rename command that updates all three.
3. **Stale plugin cache** — no signal that the plugin's view differs from the
   repo. Needs a visible sync state.
4. **Value formats** — math expressions, shadow arrays, composite typography.
   Needs transforms out of the box, not as a configuration exercise.
5. **Leaked reference layers** — primitives appearing in output. Needs the
   `enabled`/`source` distinction to be enforced, not advisory.
