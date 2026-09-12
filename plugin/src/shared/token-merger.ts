/**
 * Merges token files from GitHub into resolved flat maps per collection.
 *
 * Collection topology:
 *   Primitives  — raw colour/geometry/typography values, 1 mode "Value"
 *   Global      — theme-invariant semantic tokens (spacing, typography), 1 mode "Value"
 *   Themes      — complete semantic token set per named theme (Original, Christmas…)
 *                 Each mode contains light.* and dark.* vars referencing Primitives.
 *                 Theme and color scheme are switched independently.
 *   Semantic    — viewing-mode roles only: Light, Dark, Contrast…
 *                 References {light.*} and {dark.*} into the active Themes mode.
 *                 Severity tokens (success/error/warning/info) reference Primitives directly.
 *
 * File layout on GitHub:
 *   primitives/{name}.json
 *   primitives/sizes/{sizeMode}.json  ← size-varying primitives only, one file per mode
 *                                        (e.g. mobile.json, desktop.json) — optional,
 *                                        absent entirely on a repo with no Size axis
 *   semantic/global/{name}.json
 *   semantic/themes/{name}.json   ← light.* + dark.* for each named theme
 *   semantic/light.json           ← {light.*} aliases + direct severity refs
 *   semantic/dark.json            ← {dark.*} aliases + direct severity refs
 */

import type { GitHubFile, TokenTree, TokenValue } from "./messages";
import { flattenTokens, resolveAllReferences, isTokenValue, filterByPaths } from "./token-format";
import { extractTypographyStyles } from "./typography-styles";
import type { TypographyStyle } from "./typography-styles";

// ---------------------------------------------------------------------------
// Metadata type
// ---------------------------------------------------------------------------

/**
 * One logical role can be backed by several physical Figma collections —
 * Figma allows exactly one mode-axis per collection, so a real system (e.g.
 * separate "main color"/"support color" collections that together make up
 * the Themes role) is forced to split what's conceptually one role the
 * moment different subsets need different axes. Anything not listed under
 * any role is treated as intentionally unmapped ("Ignore" in the mapping UI).
 */
export interface CollectionNames {
  primitives: string[];
  global: string[];
  themes: string[];
  semantic: string[];
  /** Modifier axis (e.g. mobile/desktop breakpoints) — reserved, not yet consumed by any transformer. */
  sizes: string[];
}

/**
 * Which real Figma collection each top-level path segment (`black`, `blue`,
 * `primitive`, …) came from, per role — the same granularity
 * `figma-to-tokens.ts`'s `groupByFirstSegment` already uses to split a role's
 * tokens into separate files. Needed only when a role is backed by more than
 * one physical Figma collection: without it, applying a pull has no way to
 * know which of them a given token belongs to, and defaults every token in
 * the role to `collections[role][0]` — wrong (and, worse, duplicate-creating,
 * since Figma variable lookups on apply are scoped to one collection) for
 * anything that actually lives in a different one.
 *
 * Auto-computed by `buildCollectionSources` (figma-to-tokens.ts) and written
 * whenever "Map collections" is saved — never hand-edited. A segment with no
 * entry here (a fresh repo, or a token added by hand since the last save)
 * falls back to `collections[role][0]`, identical to today's behavior.
 */
export type CollectionSources = Partial<Record<keyof CollectionNames, Record<string, string>>>;

export interface Metadata {
  version: string;
  /** Named theme variants — each becomes a mode in the Themes collection. */
  themes: string[];
  /** Color scheme modes — each becomes a mode in the Semantic collection (light, dark, contrast…). */
  colorSchemes: string[];
  /**
   * Size/breakpoint mode names, base mode first (e.g. ["mobile", "desktop"]).
   * A genuine second axis on Primitives — mirrors `themes`/`colorSchemes`.
   * Empty (the default) means no Size axis is configured at all: Primitives
   * stays exactly the single-mode layer it's always been, zero behavior
   * change for any repo that doesn't use this.
   */
  sizes: string[];
  /** Non-base size mode name → CSS min-width breakpoint in px. The base
   * mode (sizes[0]) has none — its values simply are the unconditional
   * primitive values. */
  sizeBreakpoints?: Record<string, number>;
  figma: {
    fileKey: string;
    collections: CollectionNames;
    collectionSources?: CollectionSources;
  };
  ignoredCollections?: string[];
  /** Per-platform code output, run by `runTransformers` on push. All optional
   * and off unless explicitly enabled — a repo with no `platforms` at all
   * generates no output files, only the token JSON. */
  platforms?: Platforms;
}

export interface PlatformConfig {
  enabled: boolean;
  /** Output file path, relative to the repo root. Falls back to a per-platform
   * default (see runTransformers) when omitted. */
  output?: string;
}

export interface Platforms {
  css?: PlatformConfig;
  js?: PlatformConfig;
  ts?: PlatformConfig;
  dart?: PlatformConfig;
  swift?: PlatformConfig;
}

/** Fresh defaults per call — callers may mutate nested objects safely. */
function defaultMetadata(): Metadata {
  return {
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    sizes: [],
    sizeBreakpoints: {},
    figma: {
      fileKey: "",
      collections: {
        primitives: ["Primitives"],
        global: ["Global"],
        themes: ["Themes"],
        semantic: ["Semantic"],
        sizes: [],
      },
      collectionSources: {},
    },
    ignoredCollections: [],
  };
}

/** A role's value in a hand-edited or pre-migration metadata.json may still be
 * a bare string from before `figma.collections` became list-valued — coerce
 * it into a single-element list instead of letting it silently poison every
 * `.includes()` check downstream (a string does have an `.includes` method,
 * just the wrong one — substring match, not membership). Falls back to
 * `fallback` when nothing usable was provided (an empty array is a valid,
 * intentional "unmapped" value and must not fall back — only absence/an
 * unusable type does). */
function coerceToList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.length > 0) return [value];
  return fallback;
}

/** A hand-edited metadata.json could list the same Figma collection name under
 * two roles — nothing else validates this, and `collectionKind`'s first-match
 * lookup would silently pick one role over the other. Warn rather than throw:
 * a plugin sandbox shouldn't hard-fail on a config typo. */
function warnOnDuplicateCollectionNames(collections: CollectionNames): void {
  const seen = new Map<string, keyof CollectionNames>();
  for (const role of Object.keys(collections) as Array<keyof CollectionNames>) {
    for (const name of collections[role]) {
      const existingRole = seen.get(name);
      if (existingRole && existingRole !== role) {
        console.warn(
          `[TokenSpark] Figma collection "${name}" is listed under both "${existingRole}" and "${role}" in figma.collections — using "${existingRole}".`,
        );
      } else {
        seen.set(name, role);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parsed repository structure
// ---------------------------------------------------------------------------

export interface ResolvedCollection {
  /** Matches figma collection name from metadata */
  collectionName: string;
  /** e.g. "Value" for primitives/global, "Original" for themes, "Light" for semantic */
  modeName: string;
  /** Flat, fully-resolved token map: path → { $type, $value } — used for diff comparison */
  tokens: Record<string, TokenValue>;
  /** Flat, unresolved token map: $value may contain "{light.X}" or "{color.X.N}" refs — used for Figma alias creation */
  rawTokens: Record<string, TokenValue>;
  /** Groups marked `"$type": "typography"` found in this collection's source tree — see shared/typography-styles.ts */
  typographyStyles: TypographyStyle[];
}

export interface ParsedRepository {
  metadata: Metadata;
  collections: ResolvedCollection[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parses all token files from a GitHub repository into resolved collections
 * that can be diffed against Figma Variables.
 *
 * Emits collections in the order Figma needs to apply them:
 *   1. Primitives (no deps)
 *   2. Global (refs primitives)
 *   3. Themes (refs primitives) ← must exist before Semantic aliases can resolve
 *   4. Semantic (refs themes + primitives via cross-collection aliases)
 */
export function parseRepository(files: GitHubFile[], tokensPath: string): ParsedRepository {
  const stripped = stripTokensPath(files, tokensPath);

  const metadata = parseMetadata(stripped);
  const layers = buildLayers(stripped);

  // Several physical Figma collections can back one role (see CollectionNames);
  // the GitHub side has no way to know which one a given token file belongs to,
  // so the first configured name is the canonical write target — applying to
  // Figma creates/targets exactly this collection, the rest are read-only
  // alternate sources on the Figma → GitHub direction.
  const names = metadata.figma.collections;

  const collections: ResolvedCollection[] = [];

  // --- Primitives collection ---
  // Shared, size-invariant primitives (colours, borders, …) merge the same
  // way regardless of whether a Size axis exists. When it does (layers.sizes
  // non-empty), Primitives becomes genuinely multi-mode — one ResolvedCollection
  // per size mode, each the shared tree plus that mode's own size-varying
  // values — mirroring exactly how Themes already emits one collection per
  // theme. With no Size axis configured, this collapses to today's single
  // "Value" mode: zero behavior change for any repo not using it.
  const primitivesTree = deepMergeTrees(Object.values(layers.primitives));
  const sizeModeNames = Object.keys(layers.sizes);

  if (sizeModeNames.length === 0) {
    const primitivesFlatRaw = flattenTokens(primitivesTree);
    const primitivesFlat = resolveAllReferences(primitivesFlatRaw);
    collections.push({
      collectionName: names.primitives[0],
      modeName: "Value",
      tokens: primitivesFlat,
      rawTokens: primitivesFlatRaw,
      typographyStyles: extractTypographyStyles(primitivesTree),
    });
  } else {
    // Config order (metadata.sizes) wins when set — the repo's declared axis
    // order, not whatever order files happened to be read in — falling back
    // to file order for a repo that has size files but no metadata.sizes yet.
    const orderedSizeModes =
      metadata.sizes.length > 0
        ? metadata.sizes
            .map((name) => findCaseInsensitive(sizeModeNames, name))
            .filter((name): name is string => name !== undefined)
        : sizeModeNames;

    for (const sizeModeName of orderedSizeModes) {
      const sizeTree = layers.sizes[sizeModeName];
      const fullTree = deepMergeTokenTrees(primitivesTree, sizeTree);
      const fullFlatRaw = flattenTokens(fullTree);
      const fullFlatResolved = resolveAllReferences(fullFlatRaw);
      collections.push({
        collectionName: names.primitives[0],
        // Prefer metadata.sizes' own real name (e.g. "Mode 1") over the
        // filename-derived slug ("mode-1") — capitalising the slug directly
        // loses any space/slash the real Figma mode name had ("Mode-1", not
        // "Mode 1"). capitalise() still wraps whichever value wins, so a
        // legacy metadata entry that predates this fix (a plain lowercase
        // slug like "vy", from before CollectionMapping started storing the
        // real name) still displays capitalised, same as before.
        modeName: capitalise(findCaseInsensitive(metadata.sizes, sizeModeName) ?? sizeModeName),
        tokens: fullFlatResolved,
        rawTokens: fullFlatRaw,
        typographyStyles: extractTypographyStyles(fullTree),
      });
    }
  }

  // For everything downstream that needs *a* single primitives context
  // (Global/Themes/Semantic resolve their own refs against it, for display
  // and diffing) — the base size mode's primitives, or the plain primitives
  // tree when there's no Size axis at all.
  const defaultPrimitivesTree =
    sizeModeNames.length === 0
      ? primitivesTree
      : deepMergeTokenTrees(
          primitivesTree,
          layers.sizes[
            metadata.sizes
              .map((name) => findCaseInsensitive(sizeModeNames, name))
              .find((name): name is string => name !== undefined) ?? sizeModeNames[0]
          ],
        );

  // Resolved-display context for anything downstream of Theme — e.g. a
  // theme's own type-style choices (fontFamily/fontWeight (primitives) →
  // Theme (Masterbrand) → type styles), which is how Figma's real graph and
  // Token Studio's own repo shape both structure it. Substituting the first
  // theme mirrors exactly what Semantic already did below before this moved
  // up: resolved output shows one theme's choice for diff/display/CSS
  // purposes; rawTokens (used for Figma alias creation) never include this.
  const firstThemeName = findCaseInsensitive(
    Object.keys(layers.themes),
    metadata.themes[0] ?? "default",
  );
  const defaultThemeTree = firstThemeName ? layers.themes[firstThemeName] : {};

  // --- Global collection ---
  const globalTree = deepMergeTrees(Object.values(layers.global));
  // rawTokens: no theme tree in merge — a ref into a theme-scoped group (e.g.
  // {font-family.display}) remains a literal string, for Figma alias creation.
  const globalRawUnresolved = flattenTokens(deepMergeTrees([defaultPrimitivesTree, globalTree]));
  // resolved: include the default theme so a ref like {font-family.display}
  // (defined per-theme, not in Primitives) resolves instead of silently
  // staying as unresolved literal text on every diff/CSS read.
  const globalResolved = resolveAllReferences(
    flattenTokens(deepMergeTrees([defaultPrimitivesTree, defaultThemeTree, globalTree])),
  );
  const globalPaths = Object.keys(flattenTokens(globalTree));
  collections.push({
    // Falls back to a literal "Global" when nothing is mapped to that role
    // (names.global === []) — the expected shape for a Token Studio
    // migration, where composite typography lives only in token files, never
    // as a Figma variable (docs/interop/token-studio.md). Without this,
    // collectionName was `undefined`, which — via handleApplyAll's
    // `collectionId: diff.collectionName` — reached
    // `figma.variables.createVariableCollection(undefined)` on apply, not
    // just a blank diff tab label like the equivalent push-side bug.
    collectionName: names.global[0] ?? "Global",
    modeName: "Value",
    tokens: filterByPaths(globalResolved, globalPaths),
    rawTokens: filterByPaths(globalRawUnresolved, globalPaths),
    typographyStyles: extractTypographyStyles(globalTree),
  });

  // --- Themes collection (one mode per named theme) ---
  // Each theme file has light.* and dark.* groups referencing Primitives.
  // rawTokens keep {color.X.N} refs so the plugin creates Primitives→Themes cross-collection aliases.
  for (const [themeName, themeTree] of Object.entries(layers.themes)) {
    const fullFlatUnresolved = flattenTokens(deepMergeTrees([defaultPrimitivesTree, themeTree]));
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved);
    const themePaths = Object.keys(flattenTokens(themeTree));
    collections.push({
      collectionName: names.themes[0],
      // Same reasoning as the Size axis above — themeName here is always
      // the filename-derived slug (this loop iterates layers.themes'
      // keys directly, not metadata.themes), so recover metadata.themes'
      // own real name when this theme is listed there, before capitalising.
      modeName: capitalise(findCaseInsensitive(metadata.themes, themeName) ?? themeName),
      tokens: filterByPaths(fullFlatResolved, themePaths),
      rawTokens: filterByPaths(fullFlatUnresolved, themePaths),
      typographyStyles: extractTypographyStyles(themeTree),
    });
  }

  // --- Semantic collection (one mode per color scheme) ---
  // rawTokens keep {light.*} and {dark.*} refs unresolved so the plugin creates
  // Themes→Semantic cross-collection aliases. Severity tokens ref Primitives directly.
  // Resolved tokens substitute the first theme for diff comparison and display.
  for (const scheme of metadata.colorSchemes) {
    const schemeKey = findCaseInsensitive(Object.keys(layers.semantic), scheme);
    if (!schemeKey) continue;
    const schemeTree = layers.semantic[schemeKey];

    // rawTokens: no themes tree in merge — {light.*}/{dark.*} refs remain as literal strings
    const rawFlatUnresolved = flattenTokens(
      deepMergeTrees([defaultPrimitivesTree, globalTree, schemeTree]),
    );
    const schemePaths = Object.keys(flattenTokens(schemeTree));

    // resolved: include default theme so {light.background.brand} → {color.blue.25} → #hex
    const resolvedFlat = resolveAllReferences(
      flattenTokens(
        deepMergeTrees([defaultPrimitivesTree, defaultThemeTree, globalTree, schemeTree]),
      ),
    );

    collections.push({
      collectionName: names.semantic[0],
      // `scheme` is already metadata.colorSchemes' own real name (e.g.
      // "Mode 1") — no need to reconstruct anything from `schemeKey`,
      // which is only the filename-derived slug used to find the file.
      // capitalise() here is the same legacy-display safeguard as above.
      modeName: capitalise(scheme),
      tokens: filterByPaths(resolvedFlat, schemePaths),
      rawTokens: filterByPaths(rawFlatUnresolved, schemePaths),
      typographyStyles: extractTypographyStyles(schemeTree),
    });
  }

  return { metadata, collections };
}

// ---------------------------------------------------------------------------
// Layer organisation
// ---------------------------------------------------------------------------

interface Layers {
  primitives: Record<string, TokenTree>;
  global: Record<string, TokenTree>;
  /** themeName → tree (semantic/themes/{name}.json) */
  themes: Record<string, TokenTree>;
  /** colorScheme → tree (semantic/light.json, semantic/dark.json, …) */
  semantic: Record<string, TokenTree>;
  /** sizeModeName → tree (primitives/sizes/{name}.json) — a second, orthogonal
   * axis on Primitives. Deliberately separate from `primitives` (which stays
   * single-mode/shared-across-sizes) rather than nested inside it, mirroring
   * how `themes` is its own layer rather than folded into anything else. */
  sizes: Record<string, TokenTree>;
}

function buildLayers(files: Map<string, string>): Layers {
  const layers: Layers = { primitives: {}, global: {}, themes: {}, semantic: {}, sizes: {} };

  for (const [path, content] of files) {
    if (path === "metadata.json") continue;

    let tree: TokenTree;
    try {
      tree = JSON.parse(content) as TokenTree;
    } catch {
      console.warn(`[TokenSpark] Failed to parse ${path}`);
      continue;
    }

    const parts = path.replace(".json", "").split("/");

    if (parts[0] === "primitives" && parts[1] === "sizes") {
      // primitives/sizes/{sizeModeName}.json — one file per size mode
      layers.sizes[parts[2]] = tree;
    } else if (parts[0] === "primitives") {
      layers.primitives[parts[1]] = tree;
    } else if (parts[0] === "semantic" && parts[1] === "global") {
      layers.global[parts[2]] = tree;
    } else if (parts[0] === "semantic" && parts[1] === "themes") {
      // semantic/themes/{themeName}.json — one file per named theme
      layers.themes[parts[2]] = tree;
    } else if (parts[0] === "semantic" && parts.length === 2) {
      // semantic/{colorScheme}.json — light.json, dark.json, contrast.json, …
      layers.semantic[parts[1]] = tree;
    }
    // Any other path (e.g. unrecognised subdirectories) is silently ignored.
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Tree utilities
// ---------------------------------------------------------------------------

/** Deep-merge multiple TokenTree objects. */
function deepMergeTrees(trees: TokenTree[]): TokenTree {
  return trees.reduce<TokenTree>((acc, tree) => deepMergeTokenTrees(acc, tree), {});
}

/**
 * Deep-merge two token trees. When both sides have a leaf token ($value),
 * the override wins. Groups are merged recursively.
 */
function deepMergeTokenTrees(base: TokenTree, override: TokenTree): TokenTree {
  const result: TokenTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith("$")) continue;
    const baseValue = base[key];
    if (isGroup(baseValue) && isGroup(value)) {
      result[key] = deepMergeTokenTrees(baseValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** A non-leaf tree node: an object that isn't a TokenValue (i.e. has no `$value`). */
function isGroup(node: TokenValue | TokenTree | string | undefined): node is TokenTree {
  return typeof node === "object" && node !== null && !isTokenValue(node);
}


// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

function parseMetadata(files: Map<string, string>): Metadata {
  const defaults = defaultMetadata();
  const raw = files.get("metadata.json");
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<Metadata> & { brands?: string[] };

    // Support legacy 'brands' field (renamed to 'themes')
    const themes = parsed.themes ?? parsed.brands ?? defaults.themes;
    const colorSchemes = parsed.colorSchemes ?? defaults.colorSchemes;
    const sizes = parsed.sizes ?? defaults.sizes;
    const sizeBreakpoints = parsed.sizeBreakpoints ?? defaults.sizeBreakpoints;

    const merged: Metadata = {
      ...defaults,
      ...parsed,
      themes,
      colorSchemes,
      sizes,
      sizeBreakpoints,
    };
    if (parsed.figma) {
      const parsedCollections = parsed.figma.collections as
        | Partial<Record<keyof CollectionNames, unknown>>
        | undefined;
      merged.figma = {
        ...defaults.figma,
        ...parsed.figma,
        collections: {
          primitives: coerceToList(
            parsedCollections?.primitives,
            defaults.figma.collections.primitives,
          ),
          global: coerceToList(parsedCollections?.global, defaults.figma.collections.global),
          themes: coerceToList(parsedCollections?.themes, defaults.figma.collections.themes),
          semantic: coerceToList(parsedCollections?.semantic, defaults.figma.collections.semantic),
          sizes: coerceToList(parsedCollections?.sizes, defaults.figma.collections.sizes),
        },
      };
      warnOnDuplicateCollectionNames(merged.figma.collections);
    }
    return merged;
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the tokensPath prefix from all file paths and return a name→content map. */
function stripTokensPath(files: GitHubFile[], tokensPath: string): Map<string, string> {
  const prefix = tokensPath.endsWith("/") ? tokensPath : tokensPath + "/";
  const map = new Map<string, string>();
  for (const f of files) {
    if (f.path.startsWith(prefix)) {
      map.set(f.path.slice(prefix.length), f.content);
    }
  }
  return map;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Same sanitization figma-to-tokens.ts's sanitizeFileName / CollectionMapping.tsx's
 * sanitizeName apply when turning a real Figma mode name into a filename — a
 * space or slash becomes a hyphen. Applying it to *both* sides of a
 * candidates/target comparison (not just lowercasing) is what makes
 * findCaseInsensitive work regardless of which side happens to already be a
 * slug and which still has its real spacing — see findCaseInsensitive's own
 * comment for why this matters. */
function slugifyModeName(name: string): string {
  return name.toLowerCase().replace(/[\s/]+/g, "-");
}

/** Find `target` in `candidates` ignoring case *and* the slug-vs-real-name
 * gap — metadata.json's themes/colorSchemes/sizes lists are hand-editable
 * (docs/principles/no-lock-in.md: "config is hand-editable"), so a casing
 * slip ("Original" vs the real file "original") shouldn't silently resolve
 * against an empty tree instead of the real one. Slugifying both sides (not
 * just lowercasing) additionally covers a real mode name containing a space
 * or slash — a file is always named from the *sanitized* mode name (see
 * sanitizeFileName), so comparing a metadata entry's raw casing directly
 * against a filename-derived key silently failed for any name with a space:
 * found live with Figma's own unrenamed default mode, "Mode 1" — the
 * committed file is "mode-1.json", and "mode 1" !== "mode-1" even
 * case-insensitively. Every real call site here compares a metadata.json
 * entry against a filename-derived candidate, so slugifying unconditionally
 * is safe — for a name already free of spaces/slashes (every real-world case
 * before this one), slugifying is a no-op beyond lowercasing. */
function findCaseInsensitive(candidates: string[], target: string): string | undefined {
  const slug = slugifyModeName(target);
  return candidates.find((c) => slugifyModeName(c) === slug);
}

// ---------------------------------------------------------------------------
// Collection lookup by role — for output generators (transformers) only.
//
// Deliberately separate from collectionKind()/sync-logic.ts's own role
// matching, which the working push/pull/diff/apply pipeline already relies
// on and is out of scope here — these helpers are purely additive, used only
// to locate a collection for rendering CSS/JS/Dart/Swift output.
// ---------------------------------------------------------------------------

/** Matches the same fallback parseRepository/figmaToCollections already use
 * inline when nothing is mapped to a role (e.g. `names.global[0] ?? "Global"`)
 * — a role with an empty `names.role` list still gets a real collection
 * under this literal name. */
const ROLE_FALLBACK_NAME: Record<"primitives" | "global", string> = {
  primitives: "Primitives",
  global: "Global",
};

/** All collections backing a single-or-multi-mode role (primitives or
 * global), whether or not anything is explicitly mapped to it. Found live:
 * every output generator located these by checking `names.role.includes(...)`
 * directly — correct when the role IS mapped, but always false when nothing
 * is (a real, common config for a project whose only typography source is
 * Text Styles, or a project with no dedicated global-tokens collection at
 * all), silently dropping that collection's data from every generated file. */
function findRoleCollections(
  collections: ResolvedCollection[],
  role: "primitives" | "global",
  names: CollectionNames,
): ResolvedCollection[] {
  const configured = names[role];
  if (configured.length > 0)
    return collections.filter((c) => configured.includes(c.collectionName));
  return collections.filter((c) => c.collectionName === ROLE_FALLBACK_NAME[role]);
}

/** The single Global collection, present or not. Global is always exactly
 * one mode ("Value"), unlike Primitives — see selectDefaultPrimitives. */
export function findGlobalCollection(
  collections: ResolvedCollection[],
  names: CollectionNames,
): ResolvedCollection | undefined {
  return findRoleCollections(collections, "global", names)[0];
}

/** Picks the default-mode Primitives collection — mirrors exactly how
 * css.ts's own defaultPrimitives selection already works: config order
 * (metadata.sizes) decides which mode is "base" when Primitives is
 * genuinely multi-mode (a Size axis is configured); falls back to whichever
 * mode is found first when sizes isn't configured to match, or Primitives
 * has exactly one mode (the common case with no Size axis at all). */
export function selectDefaultPrimitives(
  collections: ResolvedCollection[],
  metadata: Metadata,
): ResolvedCollection | undefined {
  const primitivesCols = findRoleCollections(collections, "primitives", metadata.figma.collections);
  return (
    metadata.sizes
      .map((name) => primitivesCols.find((c) => c.modeName.toLowerCase() === name.toLowerCase()))
      .find((c): c is ResolvedCollection => c !== undefined) ?? primitivesCols[0]
  );
}
