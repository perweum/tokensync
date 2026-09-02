# Design Decisions & Progress Log

This document records the core architectural decisions, design guidelines, and changelog updates for the **Token Sync** project.

---

## Status at a Glance

Updated whenever something below changes state. For *why* something was built the way it was, follow the section reference — every line here points at a fuller entry.

**Done, shipped**
* Core sync: pull, push, PR creation, apply-to-Figma, multi-project, branch switching — see README status table.
* Primitives → Themes → Semantic architecture; CSS/JS/TS/Dart/Swift transformers.
* Selective syncing via `ignoredCollections` (§1 *Selective Syncing*).
* Unknown Figma collections are surfaced with a warning instead of silently dropped from the push (§3 July 2026).
* Figma variable typing fixed: `dimension`/`number` create real `FLOAT` variables (previously inert `STRING`); `fontWeight` correctly stays `STRING` and gets numeric/enum platform output via `shared/font-weight.ts` (§1 *`fontWeight` Canonical Value…*).
* `npm run typecheck` actually checks the codebase now — it silently checked nothing before (§2 Code Invariants, §3 July 2026). Treat any pre-fix "typecheck passed" claim as unverified.

**In progress — Figma Text Styles (typography)**
* Canonical detection, Figma field research, read-from-Figma, write-to-Figma, and the pull-direction wiring are **all built** (§1 *Typography Style Groups…*, §4 Priority 1b).
* **Not done**: the push direction (a Text Style created by hand in Figma isn't written back into token files yet — deliberately deferred, needs its own decision about target file), and **no real Figma file has verified the full apply flow end-to-end yet** — only one isolated binding call has been confirmed live.
* A **"Sync type styles" toggle** exists (on by default) specifically so Variables sync can be verified independently of this while it's unverified (§4 Priority 1b).

**Not started**
* Priority 1 — developer-first toolchain: `@tokensync/core` extraction, CLI, CI build (§4).
* Priority 1b remainder — canonical-model IR firming, merge-not-replace safety for Clean Apply, Token Studio adapter, three-corpus round-trip test (§4).
* Priority 2 — publish blockers: first-run scaffolding, PAT hardening, manifest/listing (§4).
* Priority 3 — description sync v2 (diffable + applied on pull) (§4).
* Priority 4 — robustness: GitHub API pagination/limits, apply-error accounting, `Sync.tsx` tests (§4).
* Later/on demand — Enterprise REST provider, `{theme}` output placeholder, rename detection, dogfooding, Effect Styles/shadow (§4).

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

### `fontWeight` Canonical Value Is Figma's Named Style; Translation Happens Per-Platform
* **Decision**: A `fontWeight` token's `$value` is always the literal font style name as Figma/the font names it (`"SemiBold"`, `"Regular"`) — never a number. On the Figma side, `fontWeight` maps to a `STRING` variable, not `FLOAT` (confirmed against real usage: Figma font weight variables hold the installed style name verbatim; numeric OpenType weights are a web/CSS-side concept, not how Figma or most fonts express it). Each platform transformer that needs a real numeric/enum weight (CSS, Dart, Swift — not JS/TS, which just passes the string through as data) converts it locally via a shared resolver (`shared/font-weight.ts`) built on DTCG's own `fontWeight` alias table (`thin`/`hairline` → 100 … `extra-black`/`ultra-black` → 950), matched case/punctuation-insensitively so `"SemiBold"`, `"Semi Bold"`, and `"semi-bold"` all resolve the same way. A style name with no numeric equivalent (`"Text"`, a custom font-specific name) falls back to 400/`.regular`/`FontWeight.w400` with a non-fatal `console.warn`, never a crash or invalid output.
* **Rationale**: Figma requires the *exact* installed font style name to apply a variable or bind a Text Style field — rewriting the canonical value into DTCG's exact kebab-case spelling would silently break Figma round-tripping for any font whose style names don't match DTCG's vocabulary (most of them). Keeping translation per-platform (rather than storing a second numeric field on the token) avoids a second source of truth and matches how every other platform-specific concern already works in this codebase (hex reordering, dimension parsing, etc. are all local to their transformer). This also fixed a real bug: no transformer previously special-cased `fontWeight` at all, so a value like `"SemiBold"` was emitted verbatim into CSS (`font-weight: SemiBold`), which is invalid — `font-weight` only accepts `normal`/`bold` or a number.
* **Also fixed**: `figmaTypeFromTokenType` never returned `"FLOAT"` for *any* token type — `dimension` and `number` (spacing, radius, font size, line height…) were mapping to `STRING` too, so applying those tokens created inert Figma variables holding literal text instead of real numbers, unusable for auto-layout gap, corner radius, stroke weight, or Typography Variable bindings. Now `dimension`/`number` → `FLOAT` correctly; `fontWeight` stays `STRING` (see above, this was verified rather than assumed).

### Typography Style Groups: Opt-In Group-Level `$type: "typography"` Marker, Fields Stay Decomposed
* **Decision**: This repo already decomposes composite typography into sibling leaf tokens rather than a single DTCG composite `$value` object (see `tokens/semantic/global/typography.json`) — each sub-property (`fontFamily`, `fontWeight`, `fontSize`, …) is its own ordinary token and already round-trips as a Figma Variable via the existing pipeline. Figma Text Style support (see Planned below) does **not** change that shape. It adds one new, purely opt-in convention: a group may carry `"$type": "typography"` at the **group level** (DTCG's own type-inheritance rule makes this spec-legal) to mark it as something that should *also* be synced as a Figma Text Style, in addition to its children syncing as Variables as they already do. A group without the marker is completely unaffected — existing repos need zero restructuring, only an additive opt-in per style if they want it.
* **Canonical field vocabulary** (`shared/typography-styles.ts`, `TYPOGRAPHY_FIELDS`): `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent`, `textCase`, `textDecoration`. The first 7 correspond to Figma's `VariableBindableTextField` (bindable to a Variable — confirmed against Figma's plugin API docs directly: `'fontFamily' | 'fontSize' | 'fontStyle' | 'fontWeight' | 'letterSpacing' | 'lineHeight' | 'paragraphSpacing' | 'paragraphIndent'`); `textCase`/`textDecoration` are real `TextStyle` properties Figma does **not** support binding to a variable — they can only ever be literal.
* **Why not model this as a different token shape per source**: `docs/design/canonical-model.md` already established that source-specific shapes (e.g. Token Studio's single-object composite `$value`) get normalized by their own adapter into one canonical shape before anything downstream sees them. So this feature only ever needs to understand the one decomposed shape natively; a Token Studio-shaped composite typography token is the future Token Studio adapter's problem to expand into this shape on import, not this feature's.
* **Resolved (Stage 0 spike, real Figma file, July 2026): our `fontWeight` field must bind to Figma's `fontStyle`, not `fontWeight`.** A `STRING` variable holding a literal style name (`"Bold"`) bound via `setBoundVariable("fontWeight", …)` throws: *`"variable of resolved type 'STRING' cannot be bound to 'fontWeight'"`* — that Figma field expects a numeric weight axis (variable fonts only), which nothing in this repo's tokens ever produces (confirmed: designers don't observe numeric weights in Figma in practice). `setBoundVariable("fontStyle", …)` succeeded with no error, and — the real proof — the style's resolved `fontName.style` correctly updated to `"Bold"`. So the field-name mapping is **not** an identity map: `TypographyField.fontWeight` → Figma field `"fontStyle"`; every other field maps 1:1 (`fontFamily`→`fontFamily`, `fontSize`→`fontSize`, `lineHeight`→`lineHeight`, `letterSpacing`→`letterSpacing`, `paragraphSpacing`→`paragraphSpacing`, `paragraphIndent`→`paragraphIndent`). This mapping table lives in the Stage 3 write-path code, not in the token format — `$type: "fontWeight"` in token files is unaffected and stays correctly named.

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
* **`npm run typecheck` must check the real per-project configs, never the root `tsconfig.json`.** The root config is a solution file (`files: []`, only `references`) — `tsc`/`tsgo --noEmit` against it with no `--build` flag silently checks nothing and exits 0. Found in July 2026 after it had apparently been a no-op for an unknown period: real type errors (a missing import, a broken `tsconfig.plugin.json` option, a type-modeling gap in `TokenTree`) were sitting in the codebase undetected. The script now runs `-p tsconfig.app.json` and `-p tsconfig.plugin.json` explicitly (see `package.json`'s `typecheck:app`/`typecheck:plugin`). **Do not "simplify" this back to a bare `tsc --noEmit`/`tsgo --noEmit`** — it will silently stop checking anything again.
* **`tsconfig.app.json` must not include `src/plugin`.** That directory needs Figma's ambient sandbox types (`@figma/plugin-typings`, only in `tsconfig.plugin.json`'s `types`); including it under the app config produces a wall of false `Cannot find name 'figma'` errors that look real but aren't. `tsconfig.app.json` is scoped to `["src/ui", "src/shared"]` for this reason.
* **`TokenTree`'s index signature includes a bare `string` arm** (`TokenValue | TokenTree | string`) to legally model `$`-prefixed metadata (`$description`, and the group-level `$type: "typography"` marker) coexisting with nested children in the same object — this is real, valid data this codebase already produces and reads. Any code walking a `TokenTree` must explicitly skip `$`-prefixed keys before assuming a value is `TokenValue | TokenTree` (existing code already does via `key.startsWith("$")`); don't assume the value at any key is object-shaped without checking.

---

## 3. Changelog & Implementation Progress

### July 2026
* **`npm run typecheck` was checking nothing — now fixed.** The root `tsconfig.json` solution file was being passed to `tsc`/`tsgo --noEmit` directly, which silently no-ops without `--build`. Every "typecheck: clean" result reported earlier in this project's history should be treated as unverified. Fixing it surfaced real, pre-existing errors: a missing `TokenValue` import in `figma-variables.ts`, `tsconfig.plugin.json` using a removed `moduleResolution` option, and `tsconfig.app.json` incorrectly including `src/plugin` (causing masking false-positive `figma`-not-found noise on top of real errors). All fixed; see the new Code Invariants entries above. **Recommendation: don't trust a prior "typecheck passed" claim from before this fix without re-verifying.**
* **Typography style groups, Stage 1 (extraction only, no Figma yet)**: added `shared/typography-styles.ts` — pure, tested detection of `$type: "typography"`-marked groups and their recognized sub-fields — and wired it into `parseRepository`'s `ResolvedCollection.typographyStyles`. See the new decision above. Figma read/write (Text Styles) is not built yet; blocked on manually verifying the `fontWeight`/`fontStyle` binding-field question in a real Figma file (no Figma access this session).
* **Text Styles Stages 0, 2, 3, 4 — Figma read/write built, pull direction wired end-to-end.** Stage 0's spike ran in a real Figma file and confirmed `fontWeight` tokens must bind through Figma's `fontStyle` field (see the decision above). Added `plugin/src/plugin/figma-text-styles.ts` (`getLocalTypographyStyles`/`applyTypographyStyles`, mirroring `figma-variables.ts`'s patterns) and `shared/text-style-figma-fields.ts` (the field-name and textCase/textDecoration enum translation tables, unit-tested). Wired into the message protocol (`COLLECTIONS_LOADED` now carries `typographyStyles`; new `APPLY_TEXT_STYLES`/`TEXT_STYLES_APPLIED` pair) and `Sync.tsx`'s `handleApplyAll`/`handleCleanApplyAll`, sent last so the plugin's existing serial apply queue applies styles after their Variables exist. **The push direction (Figma-created styles → committed token files) is not built** — deliberately deferred, see Priority 1b above. **Not yet manually verified against a real Figma file end-to-end** — this is the concrete next step, now that the code exists.
* **"Sync type styles" toggle**: a checkbox on the Sync main screen (default on, persisted per-project in `clientStorage`) that skips applying typography styles to Figma entirely, independent of Variables sync — see the new decision above. Added ahead of the first real end-to-end test so it can be verified in isolation.
* **Selective Syncing**: Added filtering in `Sync.tsx` (pull/push flows) to ignore collections listed in `ignoredCollections`.
* **Tests**: Verified metadata parsing of `ignoredCollections` in `token-merger.test.ts`.
* **Unknown collections no longer silently dropped**: `figmaToCollections` now excludes Figma collections matching none of the four configured layers and returns their names separately (`unknownCollectionNames`), instead of letting them appear in the push diff only to vanish with zero files at PR-build time (`figmaToTokenFiles` had no branch for `kind === "unknown"`). `PushDiff` shows a warning banner naming the skipped collections and pointing at `metadata.json`'s `figma.collections`. See `figma-to-tokens.ts` and the new test in `transformer.test.ts`.
* **Dimension/number tokens create real Figma `FLOAT` variables**: `figmaTypeFromTokenType` previously mapped `dimension`/`number`/`fontWeight` all to `STRING`; `dimension`/`number` now correctly map to `FLOAT` (the `toFigmaValue`/`parseDimension` code path already handled this correctly — it was simply unreachable). `fontWeight` deliberately stays `STRING` — see the new decision above. Regression-tested directly against the exported `figmaTypeFromTokenType`/`toFigmaValue` in `figma-variables.test.ts`.
* **`fontWeight` platform output**: added `shared/font-weight.ts` (DTCG alias table, normalized matching, non-fatal fallback) and wired it into `css.ts` (→ numeric `font-weight`), `dart.ts` (→ `FontWeight.wXXX`), and `swift.ts` (→ `Font.Weight` case) — named weights like `"SemiBold"` no longer emit invalid CSS or an inert string in Dart/Swift. See the decision above and the new `fontWeight platform output` tests in `transformer.test.ts`.
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

Deliberately not done yet. If you pick one of these up, update this section, the **Status at a Glance** summary at the top of this file, and the README status table. Ordered by priority toward publishing the plugin to Figma Community.

### Priority 1 — Developer-first toolchain (see decision above)
* **Extract `@tokensync/core`** from `plugin/src/shared/` as a workspace package; plugin imports it unchanged.
* **CLI** (`tokensync build | validate | diff | watch`) on top of core, for terminal-native developer workflow.
* **CI build**: GitHub Action runs `tokensync build` on merge and publishes platform outputs; remove `runTransformers` from the plugin's PR flow so PRs contain token JSON only.

### Priority 1b — Migration & interop foundations (see decision above; design accepted, not yet built)
* **Firm up the canonical model / IR.** `ResolvedCollection`/`TokenValue` becomes a documented, versioned interface; today's `parseRepository` is reframed as "the native DTCG adapter," one of several. Natural to do alongside the `@tokensync/core` extraction in Priority 1 — same boundary.
* **Figma Text Styles support — staged, see the decision above for the shape.**
  * ~~Stage 1: canonical extraction~~ **Done July 2026** — `shared/typography-styles.ts` + `ResolvedCollection.typographyStyles`, fully tested, no Figma dependency.
  * ~~Stage 0: verify `fontWeight` vs `fontStyle` in a real Figma file~~ **Done July 2026** — `fontStyle` is correct, see the decision above.
  * ~~Stage 2: read `getLocalTextStylesAsync()` → tokens~~ **Done July 2026** — `plugin/src/plugin/figma-text-styles.ts`: `getLocalTypographyStyles()`. A bound field becomes a `{ref}`; unbound becomes a literal. Two documented, unverified-in-Figma assumptions: `lineHeight`/`letterSpacing` are always read/written as `PERCENT` (matches this repo's own convention; a repo using absolute pixel line-heights isn't distinguished yet), and `textCase`/`textDecoration` translate through a small CSS-familiar ↔ Figma-enum table (`shared/text-style-figma-fields.ts`, values confirmed against Figma's own type docs: `TextCase`/`TextDecoration`).
  * ~~Stage 3: write tokens → `createTextStyle`/`setBoundVariable`~~ **Done July 2026** — same file, `applyTypographyStyles()`. Binds via a ref when resolvable, falls back to a literal (or Figma's `setBoundVariable` rejection, e.g. wrong resolved type) otherwise. `fontFamily`/`fontWeight` combine into one `fontName` assignment only for whichever half didn't bind — Figma's `createTextStyle()` gives sane defaults, confirmed in the Stage 0 spike log. Deliberately does **not** delete styles removed from the source repo — no diff view exists yet to make that reviewable (see Stage 5 below); this mirrors why `handleCleanApplyAll`'s deletion behavior for Variables is itself flagged as unsafe above.
  * ~~Stage 4: wire into the message protocol and `Sync.tsx`~~ **Done July 2026** — `COLLECTIONS_LOADED` now also carries `typographyStyles` (read); a new `APPLY_TEXT_STYLES`/`TEXT_STYLES_APPLIED` pair applies them (write), sent last within `handleApplyAll`/`handleCleanApplyAll` so the plugin's existing serial apply queue guarantees styles bind after their Variables exist — same ordering rule as Primitives-before-Semantic. Only the **pull** direction (apply to Figma) is wired. **Not yet done: the push direction** — a Text Style created or edited directly in Figma is read (`COLLECTIONS_LOADED.typographyStyles`) but not yet written into the committed token files on push. Deferred because it raises its own question (which file a Figma-only-created style's group should be written into — this repo has no single obvious layer for it) that deserves its own decision rather than a rushed default.
  * Deliberately deferred: a new diff UI (the underlying leaf tokens already diff as today); Effect Styles/shadow (identical pattern, needs its own `VariableBindableEffectField` research, zero current usage in this repo's tokens); the push-direction file-write above.
  * Verification: a lightweight `figma` global mock for vitest still doesn't exist, so `figma-text-styles.ts` (like `figma-variables.ts`'s apply path) has no direct test — only the pure translation tables (`text-style-figma-fields.ts`) are unit-tested. **Not yet manually verified end-to-end in a real Figma file** — the Stage 0 spike proved the one specific binding call in isolation; it has not confirmed the full apply flow (create-or-find by name, the combined `fontName` merge, `lineHeight`/`letterSpacing` unit handling) produces a correct, usable Text Style. That verification is the natural next step.
  * **"Sync type styles" toggle**, added ahead of that manual verification so it can be tested independently of Variables sync. A checkbox on the Sync main screen, persisted per-project in `clientStorage` (`tokensync:syncTypeStyles:${project.id}`), defaulting on. Off simply skips building/sending the `APPLY_TEXT_STYLES` message from `handleApplyAll`/`handleCleanApplyAll` — Variables sync is entirely unaffected either way. This is coarser than per-collection control (see `ignoredCollections` above): it's all typography styles or none, no per-style or per-collection granularity yet, and it has no effect on the (unbuilt) push direction.
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
