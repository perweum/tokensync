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

### Developer-First Toolchain: Core Extraction + CLI + CI (direction, not yet built)
* **Decision**: Extract everything in `plugin/src/shared/` (token-merger, token-format, token-diff, all transformers — pure TypeScript, zero Figma API dependencies) into a `@tokensync/core` package consumed by both the plugin and a new CLI (`tokensync build | validate | diff | watch`). Platform outputs (CSS/JS/TS/Dart/Swift) move out of plugin-created PRs entirely: a GitHub Action runs `tokensync build` on merge and publishes the artifacts (npm package or release branch). The plugin shrinks to the Figma-side boundary only — designers pull/push variables; developers never need Figma or the plugin.
* **Rationale**: The Figma Variables REST API is Enterprise-gated and plugins cannot run headless, so terminal-driven Figma sync is impossible on standard plans. But developers only need the token repo, which is already the source of truth. Moving compilation to CLI/CI also means PRs contain only token JSON (smaller diffs, no generated-file conflicts) and structurally prevents broken artifacts from being committed (a `dist/{colorScheme}.js` containing TypeScript syntax once shipped via a plugin PR).
* **Considered and rejected — localhost relay bridge**: a plugin window polling a local server so a CLI could drive it. Rejected: Figma must still be open with the plugin running, local-network `networkAccess` rules are fragile across desktop/browser, and it simulates headless without being headless. The core extraction removes the need.
* **Future provider — Enterprise REST**: shape `@tokensync/core` around a provider interface so an Enterprise-plan REST provider can later offer true headless two-way sync (`tokensync pull --from-figma`, scheduled CI backups of Figma state). Not built until there is demand; verify current Figma plan gating at that time.
* **Accepted limitation**: on non-Enterprise plans, Figma → GitHub always requires a designer to click Push in the plugin. Best mitigation: keep push one-click, and optionally a Figma file-update webhook that nudges designers to sync (webhook availability is plan-dependent — verify).

### Token Studio Off-Ramp: Canonical Model + Adapter Architecture (direction decided, mechanics under analysis)
* **Decision**: Learn from Token Studio's format — the three-layer model, the global/brand split, composite typography — without inheriting its shape. Token Sync's core will own a neutral canonical model (DTCG-based, with `$extensions` for the properties DTCG doesn't cover), and Token Studio becomes **one adapter** that translates into it, not something the core is built around. No adapter's concepts (`$themes.json`, `enabled`/`source`, `group` dimensions) may leak past the adapter boundary into diff, resolution, or transformers. Full reasoning, the axis model, the Figma API findings, and the open questions are in `docs/design/canonical-model.md` — treat that document, not this entry, as the source of truth for mechanics.
* **Rationale**: A reader built directly around Token Studio's concepts just relocates the lock-in. Building against the open DTCG standard instead means a Token Sync repo stays readable by any DTCG-aware tool with zero adapter — the literal opposite of `$themes.json`'s unreadability — while still letting Token Studio repos convert in.
* **Migrate-once, not interoperate-forever**: the importer is a one-time reader; after conversion the repo is a native Token Sync repo and none of Token Studio's plugin-cache/drift failure modes (`docs/interop/token-studio.md`) have anywhere to live. Continuous bidirectional sync against `$themes.json` is explicitly not the design center; a thin evaluation bridge is a possible future add-on only if real demand appears.
* **Axes are not peers**: composing axes (brand, colour-mode — together select the resolved value, realistically ≤3) are a different kind from modifier axes (size, density — each declares which token categories it affects, layered on top, never touching what composing axes touch). This replaces an earlier "N independent axes" framing that didn't match observed reality.
* **Composite tokens surfaced two concrete, previously-unscoped gaps**: (1) DTCG's `typography` type has 5 properties, Token Studio's has 9 — the 4 extras need `$extensions`, and `shadow`/`gradient`/`border` need the same audit (open, see canonical-model.md §6/§8); (2) Figma has no composite variable type at all — composite typography/shadow tokens need Figma **Text Styles** / **Effect Styles** support, a Plugin API surface Token Sync doesn't touch yet. "Figma Styles export" moves from Not Planned to Planned (see §4 below and the README status table).
* **Default is faithful conversion, not improvement**: the importer transcribes structure as-is; any "here's how this could be better organised" analysis is a separate, optional, non-blocking report — most teams migrating in want it to work, not to be restructured.
* **Token Studio exporter** (round-trip out) is committed as a direction for later — the strongest concrete proof of no-lock-in — but not scoped or timed yet.
* **Not yet resolved** — see `docs/design/canonical-model.md` §8: shadow/gradient/border DTCG coverage; how composing axes map onto Figma's 40-mode-per-collection ceiling; the actual mechanics of provenance tagging for merge-not-replace; exporter scope and timing. Do not start implementing the adapter architecture from this entry alone.

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
* **Unknown collections no longer silently dropped**: `figmaToCollections` now excludes Figma collections matching none of the four configured layers and returns their names separately (`unknownCollectionNames`), instead of letting them appear in the push diff only to vanish with zero files at PR-build time (`figmaToTokenFiles` had no branch for `kind === "unknown"`). `PushDiff` shows a warning banner naming the skipped collections and pointing at `metadata.json`'s `figma.collections`. See `figma-to-tokens.ts` and the new test in `transformer.test.ts`.
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

Deliberately not done yet. If you pick one of these up, update this section and the README status table. Ordered by priority toward publishing the plugin to Figma Community.

### Priority 1 — Developer-first toolchain (see decision above)
* **Extract `@tokensync/core`** from `plugin/src/shared/` as a workspace package; plugin imports it unchanged.
* **CLI** (`tokensync build | validate | diff | watch`) on top of core, for terminal-native developer workflow.
* **CI build**: GitHub Action runs `tokensync build` on merge and publishes platform outputs; remove `runTransformers` from the plugin's PR flow so PRs contain token JSON only.

### Priority 1b — Migration & interop foundations (see decision above; design accepted, not yet built)
* **Firm up the canonical model / IR.** `ResolvedCollection`/`TokenValue` becomes a documented, versioned interface; today's `parseRepository` is reframed as "the native DTCG adapter," one of several. Natural to do alongside the `@tokensync/core` extraction in Priority 1 — same boundary.
* **Figma Text Styles + Effect Styles support** (moved out of "Not planned" — see README status table). Required for composite typography/shadow tokens to round-trip at all, for native Token Sync users as well as Token Studio migrants. New Plugin API surface: `getLocalTextStylesAsync`/`createTextStyle`/`TextStyle.setBoundVariable` and the Effect Style equivalents.
* **`figmaTypeFromTokenType` never returns `"FLOAT"` (found, not yet fixed).** In `figma-variables.ts`, `dimension`, `number`, and `fontWeight` token types all map to Figma `STRING`, so applying a spacing/radius/font-size/line-height/font-weight token to Figma creates a `STRING` variable containing literal text (`"16px"`, `"700"`) instead of a numeric `FLOAT` variable. `toFigmaValue`'s `FLOAT` branch and `parseDimension` are consequently dead code. This means dimension/fontWeight tokens can never be bound to real Figma numeric properties (auto-layout gap, corner radius, stroke weight, or the FLOAT side of a Typography Variable binding) — see the typography discussion below. `dimension`/`number` → `FLOAT` is an unambiguous fix; `fontWeight`'s correct Figma type needs verification (Figma may expect `STRING` for a named font style vs `FLOAT` for a numeric weight axis, depending on the font).
* **Merge-not-replace for Clean Apply.** Concrete data-loss mechanism identified: composite typography tokens have no Figma Variable representation, only a Text Style — a wholesale Figma-driven rebuild (today's `handleCleanApplyAll`) would delete them, mirroring Token Studio's observed failure (`docs/interop/token-studio.md` §"failure modes #2"). Needs provenance tracking (mechanics not yet designed, see canonical-model.md §8) before Clean Apply is safe on a repo with file-only composite tokens.
* **Token Studio adapter (importer).** Reads `$themes.json`/`$metadata.json`/token sets, respects `enabled`/`source`, composes across groups rather than validating themes in isolation, converts value formats (math expressions, `%` units, composite typography/shadow) — see `docs/interop/token-studio.md` for the full contract. Faithful conversion only; no auto-restructuring (see decision above).
* **Three-corpus round-trip test** (canonical-model.md §9) before trusting the model generally: this repo's native tokens, the real 14-brand `@kilden/design-tokens` Token Studio repo, and a plain vanilla DTCG repo.
* **Later, lower priority**: Token Studio exporter (round-trip out); shadow/gradient/border DTCG `$extensions` audit; axis-to-Figma-collection mapping under the 40-mode ceiling.

### Priority 2 — Publish blockers (stranger-installs-it experience)
* ~~Unknown collections are diffed but never written.~~ **Fixed July 2026** — see changelog above.
* **First-run experience.** No `metadata.json` → silent empty parse. Offer to scaffold a starter token structure via the PR flow.
* **PAT hardening.** Mask the PAT in Settings, document fine-grained single-repo tokens, add a "test connection" scope check. Manifest also needs a real plugin id, icons, and Community listing copy.

### Priority 3 — Description sync v2
* **Description-only changes are invisible in diffs.** The diff compares `$type`/`$value` only. Needs: include `$description` in `buildCollectionDiff` plus diff UI rendering.
* **Pull does not apply `$description` to Figma.** `APPLY_TOKENS` ignores descriptions; `figma-variables.ts` only *reads* `variable.description`. Needs: pass descriptions through the apply message and set them on create/update.

### Priority 4 — Robustness
* **GitHub API limits**: `fetchBranches` caps at `per_page=100` (no pagination loop); Contents API truncates files > 1 MB; no readable message on 403 rate limits.
* **Apply-flow error accounting**: multi-collection apply shows only the first error (`msg.errors[0]`); Clean Apply (destructive) deserves a per-collection result summary and an explicit confirmation.
* **Sync flow tests**: `Sync.tsx` logic (ignore filtering, apply sequencing, PR building) is untested; extract pure parts into a testable module.

### Later / on demand
* **Enterprise REST provider** for true headless two-way sync and scheduled Figma-state backups (see decision above).
* **`{theme}` output placeholder** — per-theme split files; combined mode is the current answer for multi-theme JS/Dart/Swift.
* **Rename detection** — renames currently diff as remove + add; Figma variable IDs could track true renames.
* **Dogfooding** — plugin UI hardcodes hex values; use its own generated tokens.
* **Not planned** (see README status table): GitLab / Azure DevOps providers. (Figma Styles export moved to Priority 1b above — no longer "not planned".)
