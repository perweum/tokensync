# Design Decisions & Progress Log

This document records the core architectural decisions, design guidelines, and changelog updates for the **Token Sync** project.

---

## 1. Core Architectural Decisions

### Native Figma Collection Mapping (Why not Token Studio?)
* **Decision**: We map Figma variable collections directly to W3C Design Token Community Group (DTCG) standard JSON structures.
* **Rationale**: Token Studio relies on proprietary internal token sets and requires the plugin layer to resolve aliases. Token Sync eliminates the plugin dependency for runtime compilation by mapping collections directly to standard file scopes, empowering developers to compile tokens natively.

### Dynamic Metadata-driven Collections
* **Decision**: Avoid hardcoding collection names (like "Primitives", "Semantic"). Instead, collection names are dynamically read from `metadata.json` under `figma.collections`.
* **Rationale**: Enables users to start from scratch with their own named collections without breaking the synchronization engine.

### Wiping Legacy N×M Modes
* **Decision**: Removed legacy `Legacy N×M brand×theme modes` rendering selector blocks and nested directories in `semantic/`.
* **Rationale**: Standardizes compilations to a flat theme structure (`semantic/{theme}.json`), simplifying file structures and preventing bloated CSS/JS selector outputs.

### Selective Syncing / Ignored Collections
* **Decision**: Added `ignoredCollections?: string[]` configuration in `metadata.json`. Entries are **layer keys** (`"primitives"`, `"global"`, `"themes"`, `"semantic"`), not Figma collection display names — they are matched against `figma.collections` at runtime.
* **Rationale**: Allows teams to mark certain collections (e.g., read-only core primitives) to be ignored during Pull/Push sync diff actions. Crucially, the platform compilers (CSS, JS, Dart, Swift) still receive the complete collection dataset to successfully resolve references.
* **Scope**: Applies to the pull diff, the push diff, **and Clean Apply** — an ignored collection is never written to or deleted from, in either direction. Only platform output includes it.

### Separate `js` and `ts` Platforms, One Generator
* **Decision**: `metadata.json` has distinct `platforms.js` and `platforms.ts` entries. Both are compiled by the same generator (`transformer/js.ts`), gated by a `typescript: boolean` option. TypeScript-only syntax (`as const`, `export type`) is emitted **only** when `typescript: true`.
* **Rationale**: A `.js` file containing `as const` is a syntax error at runtime (this shipped once — see PR #3's `dist/{colorScheme}.js`). Sharing the generator keeps the two outputs structurally identical.

### Combined vs Split Output Modes
* **Decision**: JS, TS, Dart, and Swift support two output modes, selected by the output path template. `{colorScheme}` in the path → **split mode**: one file per color scheme (semantic + global merged into `tokens`, primitives separate), resolved through the **default (first) theme only**. No placeholder → **combined mode**: a single file with primitives, global, per-theme constants (`themes` export in JS/TS, `DesignTokensTheme{Name}` classes/structs in Dart/Swift), and per-scheme constants. All platforms share one `compileSplit` helper in `transformer/index.ts`.
* **Rationale**: Split mode serves the common "import light/dark constants" case; combined mode is the only way to do runtime multi-theme on platforms without CSS custom properties. Theme classes are prefixed `Theme` so a theme named "Light" can never collide with the color-scheme class of the same name.

### Description Sync Is Export-Only
* **Decision**: Figma variable descriptions are exported to W3C `$description` on push. They are **not** compared in diffs and **not** applied back to Figma on pull.
* **Rationale**: Descriptions ride along whenever a value changes (push writes complete files). Making them diffable/applyable needs a UI decision about how description changes are reviewed — deferred (see Planned below).

---

## 2. Code Invariants (read before editing)

Non-obvious constraints that must hold; each was the source of a real bug.

* **Sync flows must not read metadata from React state.** The `usePluginMessage` handler in `Sync.tsx` is registered once with a frozen closure; collection names and `ignoredCollections` must be read from the parsed repository held in refs (`pendingGitHub` / `pendingParsed`), never from component state.
* **Swift hex ordering**: token hex is CSS-ordered (`#RRGGBBAA`), but the generated `Color(hex:)` helper parses 8-digit hex as `AARRGGBB`. The transformer must move the alpha byte to the front. The Dart transformer does the equivalent (`Color(0xAARRGGBB)`).
* **Output-path templates must always be substituted.** No `{colorScheme}` (or future placeholder) may survive into a written file path — a literal `dist/{colorScheme}.js` was once committed to GitHub. There is a test asserting this for Dart; extend it for any new placeholder.
* **Default output paths resolve sibling to the tokens folder** (`resolvePath` receives the *raw* `cfg.output`, which may be undefined — never a pre-defaulted value, or the sibling fallback silently stops applying).
* **Figma mode names must be sanitised before becoming file names** (`sanitizeFileName`: lowercase, spaces/slashes → `-`). The parser (`buildLayers`) only reads `primitives/*`, `semantic/global/*`, `semantic/themes/*`, and `semantic/{scheme}.json` — a path outside that shape is silently dropped on the next pull.
* **`parseMetadata` must return fresh objects** (via `defaultMetadata()`), never a shared singleton — callers may mutate nested objects.
* **The mode-removal loop in `figma-variables.ts` iterates a snapshot** (`[...collection.modes]`) because `removeMode` mutates the live array; the lint suppression there is intentional.

---

## 3. Changelog & Implementation Progress

### July 2026
* **Selective Syncing**: Added filtering in `Sync.tsx` (pull/push flows) to ignore collections listed in `ignoredCollections`.
* **Tests**: Verified metadata parsing of `ignoredCollections` in `token-merger.test.ts`.
* **Bug fixes (post-review)**:
  * JS platform output no longer contains TypeScript syntax (`as const`, `export type`) — the `js` and `ts` platforms now share one generator gated by a `typescript` flag.
  * Fixed a stale React closure in `Sync.tsx`: collection names are now read from the parsed repository metadata (refs) instead of component state, so custom collection names work in pull/push flows and in `ignoredCollections` matching.
  * "Clean apply" now respects `ignoredCollections` (previously it applied — and could delete — variables in ignored collections despite the filtered diff).
  * Swift: 8-digit hex colors are reordered from CSS `#RRGGBBAA` to `#AARRGGBB` before being passed to the generated `Color(hex:)` helper, matching its ARGB parsing.
  * Dart: added split-mode (`{colorScheme}` in output path) support; the default `metadata.json` dart template previously produced a literal `{colorScheme}` filename.
  * Combined JS/Dart/Swift output includes the Themes collection again (`themes` export / `DesignTokensTheme{Name}` classes), restoring multi-theme support outside CSS.
  * Default output paths for js/ts/swift now resolve sibling to the tokens folder, consistent with css/dart.
  * Semantic and theme file names from Figma mode names are sanitised (spaces/slashes → `-`) so round-trips can't write paths the parser ignores.
  * `parseMetadata` returns fresh default objects instead of a shared mutable singleton.

### June 2026
* **Swift Platform Transformer**: Developed a native Swift generator compiling primitives, globals, and semantic color schemes into native SwiftUI compatible static structs with a self-contained hex resolver.
* **iOS Integration Documentation**: Documented compiler targets and added an iOS/SwiftUI usage guide to the project README.
* **Legacy Cleanup**: Cleaned up the `figma-to-tokens` mapping rules and deleted deprecated directory parsing code.
* **Description Syncing**: Mapped variable description metadata to W3C `$description` properties on export.

---

## 4. Planned / Known Gaps

Deliberately not done yet. If you pick one of these up, update this section and the README status table.

* **Description-only changes are invisible in diffs.** The diff compares `$type`/`$value` only. A Figma variable whose *description* changed (but not its value) produces "GitHub is already up to date" and cannot be pushed on its own. Needs: include `$description` in `buildCollectionDiff` comparison plus a way to render it in the diff UI.
* **Pull does not apply `$description` to Figma.** `APPLY_TOKENS` ignores descriptions; `figma-variables.ts` only *reads* `variable.description`. Needs: pass descriptions through the apply message and set `variable.description` on create/update.
* **Split-mode output is default-theme only.** `dist/{colorScheme}.js` resolves through the first theme in `metadata.themes`. There is no `{theme}` path placeholder for per-theme split files — combined mode is the current answer for multi-theme JS/Dart/Swift.
* **Old artefacts on GitHub remotes.** Historic plugin-generated branches (e.g. `tokens/sync-2026-04-20T10-15-18`, merged into `Token_test` via PR #3) contain a literal `dist/{colorScheme}.js` file with invalid JS (`as const`) and legacy `semantic/{brand}/{scheme}.json` files the current parser ignores. Safe to delete those branches; do not treat their file layout as a format reference.
* **Not planned** (see README status table): Figma Styles export, GitLab / Azure DevOps providers.
