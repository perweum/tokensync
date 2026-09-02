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

export interface Metadata {
  version: string;
  /** Named theme variants — each becomes a mode in the Themes collection. */
  themes: string[];
  /** Color scheme modes — each becomes a mode in the Semantic collection (light, dark, contrast…). */
  colorSchemes: string[];
  figma: {
    fileKey: string;
    collections: { primitives: string; global: string; themes: string; semantic: string };
  };
  ignoredCollections?: string[];
}

/** Fresh defaults per call — callers may mutate nested objects safely. */
function defaultMetadata(): Metadata {
  return {
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    figma: {
      fileKey: "",
      collections: {
        primitives: "Primitives",
        global: "Global",
        themes: "Themes",
        semantic: "Semantic",
      },
    },
    ignoredCollections: [],
  };
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

  const collections: ResolvedCollection[] = [];

  // --- Primitives collection ---
  const primitivesTree = deepMergeTrees(Object.values(layers.primitives));
  const primitivesFlatRaw = flattenTokens(primitivesTree);
  const primitivesFlat = resolveAllReferences(primitivesFlatRaw);
  collections.push({
    collectionName: metadata.figma.collections.primitives,
    modeName: "Value",
    tokens: primitivesFlat,
    rawTokens: primitivesFlatRaw,
    typographyStyles: extractTypographyStyles(primitivesTree),
  });

  // --- Global collection ---
  const globalTree = mergeTrees(Object.values(layers.global));
  const globalWithPrimitivesFlat = flattenTokens(mergeTrees([primitivesTree, globalTree]));
  const globalResolved = resolveAllReferences(globalWithPrimitivesFlat);
  const globalPaths = Object.keys(flattenTokens(globalTree));
  collections.push({
    collectionName: metadata.figma.collections.global,
    modeName: "Value",
    tokens: filterByPaths(globalResolved, globalPaths),
    rawTokens: filterByPaths(globalWithPrimitivesFlat, globalPaths),
    typographyStyles: extractTypographyStyles(globalTree),
  });

  // --- Themes collection (one mode per named theme) ---
  // Each theme file has light.* and dark.* groups referencing Primitives.
  // rawTokens keep {color.X.N} refs so the plugin creates Primitives→Themes cross-collection aliases.
  for (const [themeName, themeTree] of Object.entries(layers.themes)) {
    const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, themeTree]));
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved);
    const themePaths = Object.keys(flattenTokens(themeTree));
    collections.push({
      collectionName: metadata.figma.collections.themes,
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
    const rawFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, schemeTree]));
    const schemePaths = Object.keys(flattenTokens(schemeTree));

    // resolved: include default theme so {light.background.brand} → {color.blue.25} → #hex
    const resolvedFlat = resolveAllReferences(
      flattenTokens(mergeTrees([primitivesTree, defaultThemeTree, globalTree, schemeTree])),
    );

    collections.push({
      collectionName: metadata.figma.collections.semantic,
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
}

function buildLayers(files: Map<string, string>): Layers {
  const layers: Layers = { primitives: {}, global: {}, themes: {}, semantic: {} };

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

    if (parts[0] === "primitives") {
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

    const merged: Metadata = {
      ...defaults,
      ...parsed,
      themes,
      colorSchemes,
    };
    if (parsed.figma) {
      merged.figma = {
        ...defaults.figma,
        ...parsed.figma,
        collections: {
          ...defaults.figma.collections,
          ...parsed.figma.collections,
        },
      };
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
