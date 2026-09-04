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
import { flattenTokens, resolveAllReferences, isTokenValue } from "./token-format";
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
          `[TokenSync] Figma collection "${name}" is listed under both "${existingRole}" and "${role}" in figma.collections — using "${existingRole}".`,
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
        ? metadata.sizes.filter((name) => sizeModeNames.includes(name))
        : sizeModeNames;

    for (const sizeModeName of orderedSizeModes) {
      const sizeTree = layers.sizes[sizeModeName];
      const fullTree = deepMergeTokenTrees(primitivesTree, sizeTree);
      const fullFlatRaw = flattenTokens(fullTree);
      const fullFlatResolved = resolveAllReferences(fullFlatRaw);
      collections.push({
        collectionName: names.primitives[0],
        modeName: capitalise(sizeModeName),
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
            metadata.sizes.find((name) => sizeModeNames.includes(name)) ?? sizeModeNames[0]
          ],
        );

  // --- Global collection ---
  const globalTree = mergeTrees(Object.values(layers.global));
  const globalWithPrimitivesFlat = flattenTokens(mergeTrees([defaultPrimitivesTree, globalTree]));
  const globalResolved = resolveAllReferences(globalWithPrimitivesFlat);
  const globalPaths = Object.keys(flattenTokens(globalTree));
  collections.push({
    collectionName: names.global[0],
    modeName: "Value",
    tokens: filterByPaths(globalResolved, globalPaths),
    rawTokens: filterByPaths(globalWithPrimitivesFlat, globalPaths),
    typographyStyles: extractTypographyStyles(globalTree),
  });

  // --- Themes collection (one mode per named theme) ---
  // Each theme file has light.* and dark.* groups referencing Primitives.
  // rawTokens keep {color.X.N} refs so the plugin creates Primitives→Themes cross-collection aliases.
  for (const [themeName, themeTree] of Object.entries(layers.themes)) {
    const fullFlatUnresolved = flattenTokens(mergeTrees([defaultPrimitivesTree, themeTree]));
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved);
    const themePaths = Object.keys(flattenTokens(themeTree));
    collections.push({
      collectionName: names.themes[0],
      modeName: capitalise(themeName),
      tokens: filterByPaths(fullFlatResolved, themePaths),
      rawTokens: filterByPaths(fullFlatUnresolved, themePaths),
      typographyStyles: extractTypographyStyles(themeTree),
    });
  }

  // --- Semantic collection (one mode per color scheme) ---
  // rawTokens keep {light.*} and {dark.*} refs unresolved so the plugin creates
  // Themes→Semantic cross-collection aliases. Severity tokens ref Primitives directly.
  // Resolved tokens substitute the first theme for diff comparison and display.
  const firstThemeName = metadata.themes[0] ?? "default";
  const defaultThemeTree = layers.themes[firstThemeName] ?? {};

  for (const scheme of metadata.colorSchemes) {
    const schemeTree = layers.semantic[scheme];
    if (!schemeTree) continue;

    // rawTokens: no themes tree in merge — {light.*}/{dark.*} refs remain as literal strings
    const rawFlatUnresolved = flattenTokens(
      mergeTrees([defaultPrimitivesTree, globalTree, schemeTree]),
    );
    const schemePaths = Object.keys(flattenTokens(schemeTree));

    // resolved: include default theme so {light.background.brand} → {color.blue.25} → #hex
    const resolvedFlat = resolveAllReferences(
      flattenTokens(mergeTrees([defaultPrimitivesTree, defaultThemeTree, globalTree, schemeTree])),
    );

    collections.push({
      collectionName: names.semantic[0],
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
      console.warn(`[TokenSync] Failed to parse ${path}`);
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

/** Shallow-merge multiple TokenTree objects (later wins at key level). */
function mergeTrees(trees: TokenTree[]): TokenTree {
  const result: TokenTree = {};
  for (const tree of trees) {
    for (const [k, v] of Object.entries(tree)) {
      if (k.startsWith("$")) continue;
      result[k] = v;
    }
  }
  return result;
}

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

/** Keep only the paths that appear in the allowlist. */
function filterByPaths(
  flat: Record<string, TokenValue>,
  paths: string[],
): Record<string, TokenValue> {
  const set = new Set(paths);
  return Object.fromEntries(Object.entries(flat).filter(([k]) => set.has(k)));
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
