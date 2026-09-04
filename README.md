# Token Sync

Token Sync is a Figma plugin that keeps a design system's tokens in GitHub as
the source of truth, synced with Figma Variables through reviewable Pull
Requests. It can also compile those tokens into CSS, JavaScript/TypeScript,
Dart, and Swift — optionally, for teams that don't already have a build step
of their own.

---

## How it works

```
Figma Variables  ←→  Token Sync Plugin  ←→  GitHub (via Pull Request)
                           ↓
                    Platform output (optional)
                    (CSS, JS/TS, Dart, Swift)
```

The plugin runs inside Figma and has direct access to Variables. It talks to
GitHub using a Personal Access Token. Tokens are stored as JSON in a standard
folder structure in your repository. When tokens change, the plugin creates a
Pull Request — never a direct push. **The repository is the source of truth;
the plugin only holds a cache** — a team with the repo and no plugin can
still build, configure, and generate. See `docs/principles/no-lock-in.md`.

---

## Token format

Tokens are organised in three layers, plus an optional second axis for values
that vary by something other than theme or color scheme:

```
tokens/
  primitives/             Raw values — any naming, structure, or color model
    color.json            Whatever your design system calls its colors
    geometry.json         Spacing scale, radius, border width
    typography.json       Font families, sizes, weights
    sizes/                Optional — primitives that vary by breakpoint
      mobile.json           (see "A second axis: Size" below)
      desktop.json

  semantic/               Meaning. References primitives or themes.
    global/               Never changes between themes or color schemes
      typography.json     Heading, body, label composites
      spacing.json        Component and layout spacing
    themes/               Complete light + dark token sets — one file per named theme
      original.json       "Original" theme: light.* and dark.* sections
      {name}.json         Additional themes
    light.json             Semantic colour roles — light color scheme
    dark.json              Semantic colour roles — dark color scheme

  metadata.json           Project config: themes, Figma mapping, output
```

### Three-layer architecture

```
Primitives              Themes                  Semantic
color.blue.600   →   light.base.brand.default  →  base.brand.default (light)
color.blue.500   →   dark.base.brand.default   →  base.brand.default (dark)
```

The **Themes** layer is the key. Each named theme (`original.json`, `zero.json`, …) contains a complete set of brand and neutral colour mappings for both light and dark color schemes. The Semantic layer aliases into the active theme via `{light.*}` and `{dark.*}` references.

This means:
- One `light.json` and one `dark.json` serve all themes
- Runtime theme switching works without regenerating CSS — flip `[data-theme]` on any ancestor
- Severity colours (success/error/warning/info) reference primitives directly and are identical across all themes

### Any naming, any structure

Token Sync has no opinion on how primitives are named or organised — a
5-step ramp, a 20-step ramp, a hand-picked palette, whatever your team
already uses for color, spacing, or type. It reads whatever paths exist
under `primitives/` and reflects them through unchanged; nothing in the
sync, diff, or transform logic depends on a specific structure. What matters
is that Figma Variables are actually linked correctly — a semantic token
that should reference a primitive is bound to it as a real alias, not a
hand-typed duplicate value. Multiple physical Figma collections can back one
role, too (Figma allows only one mode-axis per collection) — the plugin's
**Map Collections** screen assigns each real collection to a role.

### A second axis: Size

Some primitive values — a type scale, a spacing step — legitimately differ
by breakpoint (mobile vs. desktop, e.g.), independent of theme or color
scheme. Map a Figma collection to the `sizes` role and Primitives becomes
multi-mode along that axis too: the base mode's values ship in `:root`,
other modes get an explicit `[data-size="…"]` override, and an optional
`@media (min-width)` wrapper switches automatically by viewport — no
breakpoint config required unless you want the automatic switch. See
`docs/design/size-axis.md`.

### Token syntax

Standard [W3C DTCG](https://www.designtokens.org/) format:

```json
{
  "base": {
    "$type": "color",
    "brand": {
      "default": { "$value": "{light.base.brand.default}", "$description": "Primary button background" },
      "hover":   { "$value": "{light.base.brand.hover}" },
      "active":  { "$value": "{light.base.brand.active}" }
    }
  }
}
```

References use `{dot.path.notation}` and resolve across all files in the token tree.

---

## For developers

When tokens are built, you get CSS, JS/TS, Dart, and Swift assets compiled sibling to your token repository — each one optional, chosen from the plugin's **Output Formats** screen:

```
dist/
  tokens.css       CSS custom properties (all themes + color schemes)
  light.ts         TypeScript constants (default theme, light)
  dark.ts          TypeScript constants (default theme, dark)
  light.js         JavaScript constants (default theme, light)
  dark.js          JavaScript constants (default theme, dark)
ios/
  light.swift      Swift constants (default theme, light)
  dark.swift       Swift constants (default theme, dark)
lib/src/
  design_tokens.dart Dart constants (all themes + color schemes)
```

The JS, TS, Dart, and Swift transformers support **combined mode** (a single file containing all collections, including per-theme constants) or **split mode** (separate files per color scheme, resolved through the default theme, by using `{colorScheme}` in the output path template).

### Web — theme and color scheme switching

**Step 1: Import the CSS**

```html
<link rel="stylesheet" href="node_modules/@your-org/tokens/dist/tokens.css">
```

Or in JavaScript:

```js
import '@your-org/tokens/dist/tokens.css'
```

**Step 2: Add data attributes to `<html>`**

```html
<html data-color-scheme="auto" data-theme="original">
```

- `data-color-scheme`: `"light"` | `"dark"` | `"auto"` (follows OS setting)
- `data-theme`: `"original"` | `"zero"` | `"vanilla"` | … (or omit — defaults to the first theme)

**Step 3: Use CSS custom properties in your code**

```css
.button {
  background-color: var(--base-brand-default);
  color:            var(--text-brand-contrast);
  border-radius:    var(--radius-md);
  padding:          var(--spacing-component-button-paddingY)
                    var(--spacing-component-button-paddingX);
}

.button:hover {
  background-color: var(--base-brand-hover);
}
```

**Step 4: Switching theme and color scheme (JavaScript)**

```js
function setTheme(theme) {
  // theme: 'original' | 'zero' | 'vanilla' | ...
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('theme', theme)
}

function setColorScheme(scheme) {
  // scheme: 'light' | 'dark' | 'auto'
  document.documentElement.setAttribute('data-color-scheme', scheme)
  localStorage.setItem('color-scheme', scheme)
}

// Restore on page load
const savedTheme  = localStorage.getItem('theme')
const savedScheme = localStorage.getItem('color-scheme')
if (savedTheme)  document.documentElement.setAttribute('data-theme', savedTheme)
if (savedScheme) document.documentElement.setAttribute('data-color-scheme', savedScheme)
```

The CSS handles the `auto` case for color scheme using `@media (prefers-color-scheme: dark)`. JavaScript only handles explicit user overrides.

**Scoped theme switching**

You can switch theme on a subset of the page by placing `data-theme` on any container element:

```html
<!-- Most of the page uses the original theme -->
<html data-color-scheme="auto" data-theme="original">
  <body>
    <!-- This section uses the zero theme -->
    <section data-theme="zero">
      <button class="button">Zero theme button</button>
    </section>
  </body>
</html>
```

All `var(--light-*)` and `var(--dark-*)` references inside the `[data-theme="zero"]` container automatically cascade to the Zero palette. No additional CSS is required.

---

### React

```tsx
// app/layout.tsx (Next.js) or index.tsx (Vite/CRA)
import '@your-org/tokens/dist/tokens.css'

// ThemeProvider.tsx
import { createContext, useContext, useEffect, useState } from 'react'

type ColorScheme = 'light' | 'dark' | 'auto'
type Theme = 'original' | 'zero' | 'vanilla'

const ThemeContext = createContext<{
  colorScheme: ColorScheme
  theme: Theme
  setColorScheme: (s: ColorScheme) => void
  setTheme: (t: Theme) => void
}>({ colorScheme: 'auto', theme: 'original', setColorScheme: () => {}, setTheme: () => {} })

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(
    () => (localStorage.getItem('color-scheme') as ColorScheme) ?? 'auto'
  )
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme) ?? 'original'
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-color-scheme', colorScheme)
    localStorage.setItem('color-scheme', colorScheme)
  }, [colorScheme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ colorScheme, theme, setColorScheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
```

```tsx
// Any component
import { useTheme } from './ThemeProvider'

function ThemeToggle() {
  const { colorScheme, theme, setColorScheme, setTheme } = useTheme()
  return (
    <>
      <button onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}>
        {colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
      </button>
      <button onClick={() => setTheme(theme === 'original' ? 'zero' : 'original')}>
        Switch theme
      </button>
    </>
  )
}
```

```css
/* Button.module.css — tokens available everywhere via CSS custom properties */
.button {
  background: var(--base-brand-default);
  color: var(--text-brand-contrast);
}
```

---

### React Native

React Native does not support CSS custom properties. Use the JavaScript token files and `useColorScheme` from React Native.

```ts
// useTokens.ts
import { useColorScheme } from 'react-native'
import lightTokens from '@your-org/tokens/dist/light'
import darkTokens  from '@your-org/tokens/dist/dark'

export function useTokens() {
  const scheme = useColorScheme() // 'light' | 'dark' | null
  return scheme === 'dark' ? darkTokens : lightTokens
}
```

```tsx
// Button.tsx
import { StyleSheet, Pressable, Text } from 'react-native'
import { useTokens } from './useTokens'

export function Button({ label }: { label: string }) {
  const t = useTokens()

  return (
    <Pressable
      style={[
        styles.button,
        {
          backgroundColor: t.color.base.brand.default,
          borderRadius: parseFloat(t.radius.md)
        }
      ]}
    >
      <Text style={{ color: t.color.text.brand.contrast }}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 16, paddingVertical: 8 }
})
```

JS/TS output resolves through the default theme. For React Native multi-theme, maintain separate JS/TS outputs per theme.

---

### Flutter

```dart
// tokens/light.dart (generated)
class TokensLight {
  static const colorBaseBrandDefault  = Color(0xFF1A52D8);
  static const colorBaseBrandHover    = Color(0xFF1240B0);
  static const colorBackgroundDefault = Color(0xFFFFFFFF);
  static const colorTextDefault       = Color(0xFF0D0D0D);
  static const radiusMd               = 8.0;
  static const spacingInline4         = 16.0;
}
```

```dart
// main.dart
import 'tokens/light.dart';
import 'tokens/dark.dart';

MaterialApp(
  themeMode: ThemeMode.system,
  theme:     _buildTheme(TokensLight()),
  darkTheme: _buildTheme(TokensDark()),
  home: const MyApp(),
)

ThemeData _buildTheme(dynamic t) => ThemeData(
  colorScheme: ColorScheme(
    brightness:  Brightness.light,
    primary:     t.colorBaseBrandDefault,
    onPrimary:   t.colorTextBrandContrast,
    background:  t.colorBackgroundDefault,
    onBackground: t.colorTextDefault,
    // ...
  ),
)
```

---

### iOS / SwiftUI

```swift
// ios/light.swift (generated)
import SwiftUI

public struct DesignTokensPrimitives {
    public static let colorBrand500: Color = Color(hex: "#1A52D8")
}

public struct DesignTokens {
    public static let backgroundDefault: Color = Color(hex: "#FFFFFF")
    public static let radiusMd: Double = 8.0
}
```

```swift
// SwiftUI Example
import SwiftUI

struct MyView: View {
    var body: some View {
        Text("Hello, World!")
            .padding()
            .background(DesignTokens.backgroundDefault)
            .cornerRadius(DesignTokens.radiusMd)
    }
}
```

---

### Web Components / Vanilla JS

Works the same as plain web — import CSS, use custom properties. No framework needed.

```html
<html data-color-scheme="auto" data-theme="original">
<head>
  <link rel="stylesheet" href="dist/tokens.css">
</head>
```

```css
my-button::part(root) {
  background: var(--base-brand-default);
  color: var(--text-brand-contrast);
}
```

---

## For the design system team

### Syncing from Figma to GitHub

1. Open the Token Sync plugin in Figma
2. Select the project to sync
3. Review the diff — what has changed in Figma since the last sync
4. Click **Create PR** — the plugin commits the changes and opens a Pull Request
5. A team member reviews and merges

### Syncing from GitHub to Figma

1. Open the Token Sync plugin in Figma
2. Select the project
3. Review the diff — what has changed in GitHub since the last pull
4. Click **Apply to Figma** — the plugin updates Variables in the current file

GitHub is always the source of truth. If Figma and GitHub conflict, GitHub wins.

### Mapping Figma collections to roles

Every Figma collection needs to be assigned a role — `primitives`, `global`, `themes`, `semantic`, or the optional `sizes` axis — or explicitly ignored. Open the plugin's **Map Collections** screen to assign each one; it writes the mapping to `metadata.json` via a PR. Several physical collections can share a role (useful when Figma's one-mode-axis-per-collection limit splits what's conceptually one role across more than one collection).

### Choosing output formats

CSS, JS, TS, Dart, and Swift are each independently optional. Use the plugin's **Output Formats** screen to choose which ones generate on push — writes to `metadata.json`'s `platforms` field via a PR. None selected is a valid, common choice; see "Already have a build step?" below.

### Adding a new theme

1. Create `tokens/semantic/themes/{name}.json` with `light` and `dark` sections, mapping all brand and neutral tokens to primitive values
2. Add the theme name to `metadata.json` under `themes`
3. Commit and push — the plugin picks up the new Themes mode on the next pull

No changes to `light.json` or `dark.json` are required. Severity tokens are not part of themes and never need to change.

### Ignoring collections during sync

Add `"ignoredCollections": ["primitives"]` to `metadata.json` to exclude layers from pull and push diffs. Entries are layer keys — `primitives`, `global`, `themes`, or `semantic`. Useful for read-only core collections managed elsewhere. Platform output (CSS, JS, Dart, Swift) still includes ignored collections so references resolve.

Separately, a **"Sync type styles"** checkbox on the plugin's main screen turns off applying typography groups (`"$type": "typography"`) to Figma as Text Styles, independent of Variables sync — on by default, remembered per project. This is coarser than `ignoredCollections`: it's all typography styles or none, not per-collection.

### Already have a build step?

Token Sync's CSS/JS/TS/Dart/Swift generators are a convenience for teams without one — not a requirement. Every platform is off unless explicitly enabled from the **Output Formats** screen; a project with none of them turned on still gets the token JSON, nothing else.

The token files themselves (`tokens/**/*.json`) are plain [DTCG](https://www.designtokens.org/) — `$value`/`$type`/`$description`, no Token Sync-specific structure a downstream tool needs to understand. If you already run [Style Dictionary](https://styledictionary.com/) (which has native DTCG support as of v4) or any other token build pipeline, point its `source`/`include` glob at `tokens/**/*.json` directly and leave every `platforms.*` entry off — your existing pipeline and its output stay exactly as they are, Token Sync just keeps the source files it reads in sync with Figma.

This is also the reasonable default for a team migrating from another tool that already has a build step consuming its export: swap what feeds the pipeline, not the pipeline itself.

### First-time project setup

1. Copy this repo as a template
2. Edit `metadata.json` — set `github.repo`, `github.branch`, and `figma.fileKey`
3. Run the plugin and use **Apply to Figma** to populate the Figma file for the first time
4. Commit the token files to the repo

---

## Technical decisions

### Why a Figma plugin and not a browser app?

The Figma Variables REST API requires an Enterprise or Organisation plan for write access. The Figma Plugin API has full read/write access to Variables on all plans. A plugin also runs directly inside Figma where designers already work — no context switching.

### Why always PR and not direct push?

Design tokens power every product built on the design system. A bad push can break colour contrast, spacing, or typography across all platforms simultaneously. A Pull Request gives the team a mandatory review step.

### Why a Themes collection and `{light.*}` / `{dark.*}` indirection?

The naive multi-theme approach is N×M: two semantic files per theme (`original/light.json`, `original/dark.json`, `zero/light.json`, …). This creates redundancy — the semantic structure of every theme is identical, only the colour mapping differs.

The Themes layer solves this: one `light.json` and one `dark.json` serve all themes. Each theme file defines `light.*` and `dark.*` vars; the Semantic collection aliases into whichever theme is active. In Figma, the Themes collection's active mode determines which values cascade through. In CSS, `[data-theme]` on any ancestor does the same.

Themes and color scheme are switched independently. `[data-theme]` controls which palette is used; `[data-color-scheme]` controls light vs. dark. Any combination works with zero extra CSS.

### Why severity tokens reference primitives directly?

Severity tokens (`success`, `error`, `warning`, `info`) are identical across all themes — a green success state is always green regardless of the brand palette. Putting them in theme files would require duplicating the same primitive references in every theme. Instead they reference a primitive directly in `light.json` and `dark.json`, making the theme files smaller and the invariant explicit.

### Why pre-computed values, not formulas in tokens?

Pre-computed values make token files readable by any tool without needing a matching transform step. Whatever computes a value — a script, a spreadsheet, hand authoring — writes the final result (`"16px"`, not `floor(4 * 4)`) into the JSON.

---

## Interop & migration

Most teams evaluating Token Sync are moving from something else — most often Token Studio. Reading a Token Studio repo natively (`$themes.json`, `enabled`/`source`, composite typography) so a team can adopt without restructuring by hand first is planned; see `docs/design/canonical-model.md` for the approach and `docs/interop/token-studio.md` for the concrete format contract this project has tested against, from a real large-scale migration.

The token files Token Sync produces are plain DTCG JSON — see "Already have a build step?" above for pairing it with an existing pipeline instead of Token Sync's own generators.

---

## Further reading

- `docs/principles/no-lock-in.md` — the design principle behind the repo-is-source-of-truth stance, and what it requires concretely
- `docs/interop/token-studio.md` — the Token Studio repository contract and the concrete failure modes worth defending against, from a real 14-brand migration
- `docs/interop/migration-patterns.md` — what a large multi-brand token system looks like in practice, and what CSS generators need from it
- `docs/design/canonical-model.md` — the direction for a neutral canonical model with Token Studio (and others) as adapters into it — status: direction decided, mechanics under analysis
- `docs/design/size-axis.md` — the Size/breakpoint axis on Primitives
- `docs/design/transformer-configurability.md` — why the platform transformers stay opinionated rather than becoming configurable, and what to do instead if your output needs don't match
- `DECISIONS.md` — the full changelog, code invariants, and priority-ordered backlog

---

## Project status

| Feature | Status |
|---|---|
| Token format spec | Done |
| GitHub integration (pull, push, PR) | Done |
| Pull diff view (GitHub → Figma) | Done |
| Push diff view (Figma → GitHub) | Done |
| Apply to Figma (pull) | Done |
| Multi-project support | Done |
| Primitives → Themes → Semantic three-layer architecture | Done |
| Multiple Figma collections per role (Map Collections) | Done |
| Size axis on Primitives (breakpoint-varying values) | Done |
| CSS / JS / TypeScript / Dart / Swift transformers | Done |
| Output format selection (which platforms generate) | Done |
| Branch switching per project | Done |
| Figma Text Styles — pull direction (apply to Figma) | Done |
| Figma Text Styles — push direction (Figma → GitHub) | Planned |
| Token Studio migration (one-time import) | Planned |
| GitLab / Azure DevOps provider | Not planned |
