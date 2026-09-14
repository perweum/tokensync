# Token Spark — plugin

The Figma plugin itself. See the [repo root README](../README.md) for what Token Spark does and how it's used; this file is for working on the plugin's own code.

## Running it in Figma

1. `npm install`
2. `npm run build` — builds both halves (see below)
3. In Figma: **Plugins → Development → Import plugin from manifest…**, pick `plugin/manifest.json`
4. Re-run `npm run build` after a change and re-run the plugin in Figma to pick it up. `npm run dev` runs a Vite dev server for iterating on the UI in a browser instead, but the plugin sandbox code (anything under `src/plugin/`) only ever runs inside Figma, not in that dev server.

## Two runtimes, one codebase

A Figma plugin is really two separate JS environments that only talk to each other via `postMessage`:

- **`src/plugin/`** — the plugin sandbox. Has access to the `figma` global (Variables, Text Styles, the current file) but no DOM, no `fetch`-able network beyond what `manifest.json` allows.
- **`src/ui/`** — the React UI, rendered in an iframe. Has a normal DOM and does the actual GitHub API calls, but no access to `figma.*` at all.
- **`src/shared/`** — plain TypeScript, no Figma or browser APIs — the token-parsing, diffing, and transformer logic, directly unit-testable and used by both sides.

`npm run build:ui` builds the iframe half with Vite (inlined into a single `dist/index.html` — Figma plugins can't load external assets); `npm run build:plugin` bundles the sandbox half with esbuild into `dist/plugin/main.js`, since the sandbox runtime doesn't support ES modules the way Vite's own output assumes. `npm run build` runs both.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Full build — both runtimes, output in `dist/` |
| `npm run dev` | Vite dev server for the UI half only (browser, not Figma) |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | Type-checks both `tsconfig.app.json` (UI) and `tsconfig.plugin.json` (sandbox) in parallel |
| `npm run lint` | `oxlint` |
| `npm run format:check` | `oxfmt --check` |
| `npm run verify` | Runs lint, format check, typecheck, and test together |

`npm run build`/`npm run typecheck` are the ones that actually matter for correctness — always run both before considering a change done; see [`CLAUDE.md`](../CLAUDE.md) at the repo root for this project's fuller working conventions.

## Source layout

```
src/
  plugin/     Figma sandbox — reads/writes Variables and Text Styles
  shared/     pure logic: token parsing, diffing, transformers — no Figma or browser APIs, fully unit-tested
    transformer/   one file per output platform (css.ts, js.ts, dart.ts, swift.ts) plus shared naming/index helpers
  ui/         the React UI (iframe)
    components/   shared UI components (StatusBanner, DiffEntryList, …)
    hooks/        useGitHub (API calls), usePlugin (postMessage), useFigmaValues
    views/        one file per screen (Sync, Setup, CollectionMapping, PushDiff, PullDiff, …)
```

Tests live next to what they test (`foo.ts` → `foo.test.ts`), not in a separate directory.
