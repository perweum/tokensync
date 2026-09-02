# Token Studio interop

Reference for reading, writing and migrating from Token Studio repositories.
Everything here was observed during a real migration of a 14-brand design system
(Coop, ~2800 tokens) in 2026, not inferred from documentation.

---

## Repository contract

A Token Studio repo in multi-file mode has three moving parts.

### Token set files

One JSON file per token set. The file path minus `.json` **is** the set name.
`design-tokens/semantic/light.json` is the set `semantic/light`.

This coupling is the source of most migration pain: renaming a folder renames
every set inside it, and every reference to those sets breaks.

### `$themes.json`

An array of theme objects. The important fields:

```jsonc
{
  "id": "…",
  "name": "light",
  "group": "Semantic",
  "selectedTokenSets": {
    "semantic/theme-light": "enabled",
    "semantic/global": "enabled",
    "primitives/color": "source"
  }
}
```

`group` turns themes into **dimensions**. Selecting one theme from each group
composes the active token set. A real four-dimension setup:

| Group | Themes | Role |
|---|---|---|
| `Size` | mobile, desktop | typography scale, spacing base |
| `Theme` | 14 brands | brand colours, font families, radius |
| `Semantic` | light, dark | the layer that gets exported |
| `primitives` | color | single-mode dimension, palette |

`selectedTokenSets` values:

| Value | Meaning |
|---|---|
| `enabled` | exported — becomes CSS variables and Figma variables |
| `source` | reference only — resolves aliases, never exported |
| *(absent)* | not part of this theme |

**The `enabled`/`source` distinction is the single most important thing to get
right.** Marking a reference layer `enabled` leaks primitives and intermediate
tokens into output. In the migration this produced `--color-light-dominant-base-default`
alongside the intended `--color-dominant-base-default`, tripling the variable count.

### `$metadata.json`

```jsonc
{ "tokenSetOrder": ["primitives/global", "primitives/color", "…"] }
```

Determines override precedence. Must stay in sync with `$themes.json` — a set
present in one and absent from the other is a silent failure.

---

## Reference resolution

References are `{dot.separated.token.path}` and resolve against the **merged tree
of all active sets**, regardless of which file a token lives in. File location is
irrelevant to resolution.

This matters for migration: you can reorganise files freely without touching a
single token value, as long as the set names in `$themes.json` and
`$metadata.json` are updated in the same commit.

### Composition, not self-sufficiency

A theme does not need to resolve on its own. In the observed setup the two
`Semantic` themes had 183 unresolved references each when evaluated alone —
`primitive.*` came from the `Size` group and `typography.*` from the active
brand's sets. Composed, everything resolved.

A tool that validates each theme in isolation will report false failures. Validate
the **composed permutations**, not the themes.

---

## Observed failure modes

These are the concrete ways Token Studio repos break. Each cost real debugging
time during the migration.

### 1. Figma variable import drops `source` sets

After a variable import, the 14 brand themes went from five sets to one:

```
before:  theme/extra (enabled)
         primitives/color (source)
         primitives/typography/{display,interface,campaign}/extra (source)

after:   theme/extra (enabled)
```

The import rebuilds themes from Figma collections and keeps only sets with a
matching collection. Everything else is silently dropped. Result: 25–48
unresolved references per theme, build fails.

**`enabled` sets survive an import. `source` sets do not.**

### 2. Plugin-only token sets get wiped

Composite typography tokens cannot exist as Figma variables — Figma has no
composite variable type. So typography lives only in the plugin's token sets.

A variable import rebuilt everything under the `primitive` root key and deleted
the typography sets, because no Figma collection produced them. The fix was to
move them to a root key (`typography`) that no collection would ever match.

Any tool that rebuilds from Figma must **merge, not replace**, or it will destroy
tokens that have no Figma representation.

### 3. Renaming a Figma collection silently relocates files

Figma collections are named `Theme`, `Palette`, `Semantic`. Token Studio names
imported sets after the collection. So an import recreates capitalised paths even
if the repo had settled on lowercase — and moves files as a side effect.

Observed: `primitives/color.json` reappeared as `Palette/color.json` after an
import, with no user action.

**Corollary:** repo folder naming is not stable unless it matches Figma collection
naming. Fighting this costs more than accepting it.

### 4. Plugin local state overwrites the repo

Editing `$themes.json` directly in Git works until the next push from the plugin,
which writes its cached copy over it. The plugin must be pulled immediately after
any out-of-band edit.

### 5. Stale references after a rename

After renaming sets, the plugin kept pointing at the old names and showed every
token as broken — even though the files, `$themes.json` and `$metadata.json` were
all correct. A fresh pull fixed it. There is no in-UI signal that the cache is
stale.

### 6. Figma's 40-mode ceiling

A collection cannot exceed 40 modes. A 14-brand system that wants brand × mode
as separate modes needs 28 and fits; adding a third dimension does not. This
constrains how much of the theming model can live in one collection.

---

## Value formats that are not valid CSS

Token Studio stores several types in formats that need transformation. Plain
Style Dictionary does not handle them.

| Type | Stored as | Needs to become |
|---|---|---|
| `dimension` | `floor(4 / 18 * 16 * 8)` | `28px` |
| `boxShadow` | array of layer objects | `0 0 1px 0 #00000024, …` |
| `typography` | composite object | `700 34px/1.3 'Extra Round'` |
| `fontWeights` | `"Bold"` | `700` |
| `opacity` | `"30%"` | `0.3` |
| `lineHeights` | `"130%"` | `1.3` |
| `letterSpacing` | `"-1%"` | `-0.01em` |

`@tokens-studio/sd-transforms` handles most of it. Two gaps observed:

- **Multi-layer shadows** — the built-in `shadow/css/shorthand` handles single
  objects and emits `[object Object]` for arrays.
- **`borderRadius` and `borderWidth`** — stored as bare numbers because Figma
  variables are numeric. `ts/size/px` does not cover these types.

Also note: CSS `font` shorthand cannot express `letterSpacing` or `textCase`.
Using `typography/css/shorthand` silently drops them. Expanding composite
typography into individual properties preserves everything.

---

## What this means for a tool that wants to interoperate

1. **Read `$themes.json` as the configuration.** Do not hardcode set names or
   paths. Both change.
2. **Respect `enabled` vs `source`.** It is the export contract.
3. **Compose across groups.** Validate permutations, not individual themes.
4. **Merge on import, never replace.** Tokens without a Figma representation must
   survive.
5. **Treat renames as atomic.** Files, `$themes.json` and `$metadata.json` change
   together or the repo is broken between commits.
