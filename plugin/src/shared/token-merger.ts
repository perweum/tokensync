/**
 * Merges token files from GitHub into resolved flat maps per collection.
 *
 * Collection topology:
 *   Primitives  — raw colour/geometry/typography values, 1 mode "Value"
 *   Global      — theme-invariant semantic tokens (spacing, typography), 1 mode "Value"
 *   Themes      — complete semantic token set per named theme (Original, Zero…)
 *                 Each mode contains light.* and dark.* vars referencing Primitives.
 *   Semantic    — semantic colour roles (Light/Dark/Contrast…)
 *                 References {light.*} and {dark.*} into the Themes collection.
 *                 Severity tokens (success/error/warning/info) reference Primitives directly.
 *
 * File layout on GitHub:
 *   primitives/{name}.json
 *   semantic/global/{name}.json
 *   semantic/themes/{name}.json   ← light.* + dark.* for each named theme
 *   semantic/light.json           ← {light.*} aliases + direct severity refs
 *   semantic/dark.json            ← {dark.*} aliases + direct severity refs
 *   semantic/{occasion}/*.json    ← composition overlays (sparse)
 */

import type { GitHubFile, TokenTree, TokenValue } from './messages'
import { flattenTokens, resolveAllReferences } from './token-format'

// ---------------------------------------------------------------------------
// Metadata type
// ---------------------------------------------------------------------------

export interface Composition {
  /** Figma mode name this composition produces, e.g. "Christmas/Light" */
  name: string
  /**
   * Ordered list of semantic layer paths to stack (relative to semantic/, no extension).
   * e.g. ["default/light", "occasions/christmas"]
   * Later layers override earlier ones. The last layer is the overlay file for push.
   */
  layers: string[]
}

export interface Metadata {
  version: string
  /** Named theme variants — each becomes a mode in the Themes collection. */
  themes: string[]
  /** Color scheme modes — each becomes a mode in the Semantic collection (light, dark, contrast…). */
  colorSchemes: string[]
  /** Explicit multi-layer compositions. Produces additional Figma modes in Semantic. */
  compositions?: Composition[]
  figma: {
    fileKey: string
    collections: { primitives: string; global: string; themes: string; semantic: string }
  }
}

const DEFAULT_METADATA: Metadata = {
  version: '1.0.0',
  themes: ['default'],
  colorSchemes: ['light', 'dark'],
  compositions: [],
  figma: {
    fileKey: '',
    collections: { primitives: 'Primitives', global: 'Global', themes: 'Themes', semantic: 'Semantic' },
  },
}

// ---------------------------------------------------------------------------
// Parsed repository structure
// ---------------------------------------------------------------------------

export interface ResolvedCollection {
  /** Matches figma collection name from metadata */
  collectionName: string
  /** e.g. "Value" for primitives/global, "Original" for themes, "Light" for semantic */
  modeName: string
  /** Flat, fully-resolved token map: path → { $type, $value } — used for diff comparison */
  tokens: Record<string, TokenValue>
  /** Flat, unresolved token map: $value may contain "{light.X}" or "{color.X.N}" refs — used for Figma alias creation */
  rawTokens: Record<string, TokenValue>
}

export interface ParsedRepository {
  metadata: Metadata
  collections: ResolvedCollection[]
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
export function parseRepository(
  files: GitHubFile[],
  tokensPath: string,
): ParsedRepository {
  const stripped = stripTokensPath(files, tokensPath)

  const metadata = parseMetadata(stripped)
  const layers = buildLayers(stripped)

  const collections: ResolvedCollection[] = []

  // --- Primitives collection ---
  const primitivesTree = deepMergeTrees(Object.values(layers.primitives))
  const primitivesFlatRaw = flattenTokens(primitivesTree)
  const primitivesFlat = resolveAllReferences(primitivesFlatRaw)
  collections.push({
    collectionName: metadata.figma.collections.primitives,
    modeName: 'Value',
    tokens: primitivesFlat,
    rawTokens: primitivesFlatRaw,
  })

  // --- Global collection ---
  const globalTree = mergeTrees(Object.values(layers.global))
  const globalWithPrimitivesFlat = flattenTokens(mergeTrees([primitivesTree, globalTree]))
  const globalResolved = resolveAllReferences(globalWithPrimitivesFlat)
  const globalPaths = Object.keys(flattenTokens(globalTree))
  collections.push({
    collectionName: metadata.figma.collections.global,
    modeName: 'Value',
    tokens: filterByPaths(globalResolved, globalPaths),
    rawTokens: filterByPaths(globalWithPrimitivesFlat, globalPaths),
  })

  // --- Themes collection (one mode per named theme) ---
  // Each theme file has light.* and dark.* groups referencing Primitives.
  // rawTokens keep {color.X.N} refs so the plugin creates Primitives→Themes cross-collection aliases.
  for (const [themeName, themeTree] of Object.entries(layers.themes)) {
    const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, themeTree]))
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved)
    const themePaths = Object.keys(flattenTokens(themeTree))
    collections.push({
      collectionName: metadata.figma.collections.themes,
      modeName: capitalise(themeName),
      tokens: filterByPaths(fullFlatResolved, themePaths),
      rawTokens: filterByPaths(fullFlatUnresolved, themePaths),
    })
  }

  // --- Semantic collection (one mode per color scheme) ---
  // rawTokens keep {light.*} and {dark.*} refs unresolved so the plugin creates
  // Themes→Semantic cross-collection aliases. Severity tokens ref Primitives directly.
  // Resolved tokens substitute the first theme for diff comparison and display.
  const firstThemeName = metadata.themes[0] ?? 'default'
  const defaultThemeTree = layers.themes[firstThemeName] ?? {}

  for (const scheme of metadata.colorSchemes) {
    const schemeTree = layers.semantic['default']?.[scheme]
    if (!schemeTree) continue

    // rawTokens: no themes tree in merge — {light.*}/{dark.*} refs remain as literal strings
    const rawFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, schemeTree]))
    const schemePaths = Object.keys(flattenTokens(schemeTree))

    // resolved: include default theme so {light.background.brand} → {color.blue.25} → #hex
    const resolvedFlat = resolveAllReferences(
      flattenTokens(mergeTrees([primitivesTree, defaultThemeTree, globalTree, schemeTree]))
    )

    collections.push({
      collectionName: metadata.figma.collections.semantic,
      modeName: capitalise(scheme),
      tokens: filterByPaths(resolvedFlat, schemePaths),
      rawTokens: filterByPaths(rawFlatUnresolved, schemePaths),
    })
  }

  // --- Legacy N×M semantic modes (backward compat for repos with old brand/theme pairs) ---
  const legacyBrands = Object.keys(layers.semantic).filter((b) => b !== 'default')
  for (const brand of legacyBrands) {
    for (const scheme of Object.keys(layers.semantic[brand])) {
      const semanticTree = buildSemanticTree(layers, brand, scheme)
      if (!semanticTree) continue

      const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, semanticTree]))
      const fullFlatResolved = resolveAllReferences(fullFlatUnresolved)
      const semanticPaths = Object.keys(flattenTokens(semanticTree))
      collections.push({
        collectionName: metadata.figma.collections.semantic,
        modeName: `${capitalise(brand)}/${capitalise(scheme)}`,
        tokens: filterByPaths(fullFlatResolved, semanticPaths),
        rawTokens: filterByPaths(fullFlatUnresolved, semanticPaths),
      })
    }
  }

  // --- Composition modes ---
  for (const comp of (metadata.compositions ?? [])) {
    const compTree = buildCompositionLayerTree(layers, comp.layers)
    if (!compTree) continue

    const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, defaultThemeTree, globalTree, compTree]))
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved)
    const compPaths = Object.keys(flattenTokens(compTree))
    collections.push({
      collectionName: metadata.figma.collections.semantic,
      modeName: comp.name,
      tokens: filterByPaths(fullFlatResolved, compPaths),
      rawTokens: filterByPaths(fullFlatUnresolved, compPaths),
    })
  }

  return { metadata, collections }
}

// ---------------------------------------------------------------------------
// Layer organisation
// ---------------------------------------------------------------------------

interface Layers {
  primitives: Record<string, TokenTree>
  global: Record<string, TokenTree>
  /** themeName → tree (semantic/themes/{name}.json) */
  themes: Record<string, TokenTree>
  /** brand → colorScheme → tree (semantic/light.json → default/light, legacy: brand/scheme) */
  semantic: Record<string, Record<string, TokenTree>>
}

function buildLayers(files: Map<string, string>): Layers {
  const layers: Layers = { primitives: {}, global: {}, themes: {}, semantic: {} }

  // Two-pass: process depth-3 paths first, then depth-2 (new flat files) can overwrite.
  const depth2: Array<[string, TokenTree]> = []

  for (const [path, content] of files) {
    if (path === 'metadata.json') continue

    let tree: TokenTree
    try {
      tree = JSON.parse(content) as TokenTree
    } catch {
      console.warn(`[TokenSync] Failed to parse ${path}`)
      continue
    }

    const parts = path.replace('.json', '').split('/')

    if (parts[0] === 'primitives') {
      layers.primitives[parts[1]] = tree
    } else if (parts[0] === 'semantic' && parts[1] === 'global') {
      layers.global[parts[2]] = tree
    } else if (parts[0] === 'semantic' && parts[1] === 'themes') {
      // New: semantic/themes/{themeName}.json
      layers.themes[parts[2]] = tree
    } else if (parts[0] === 'semantic' && parts.length === 3) {
      // Legacy: semantic/{brand}/{scheme}.json or semantic/{occasion}/{name}.json
      const [, brand, scheme] = parts
      if (!layers.semantic[brand]) layers.semantic[brand] = {}
      layers.semantic[brand][scheme] = tree
    } else if (parts[0] === 'semantic' && parts.length === 2) {
      // New flat: semantic/{scheme}.json → defer so it wins over legacy default/{scheme}
      depth2.push([parts[1], tree])
    }
  }

  // Apply new-style flat scheme files last (win over legacy semantic/default/{scheme}.json)
  for (const [scheme, tree] of depth2) {
    if (!layers.semantic['default']) layers.semantic['default'] = {}
    layers.semantic['default'][scheme] = tree
  }

  return layers
}

/**
 * Merge a stack of semantic layer paths into a single token tree.
 * Each path is relative to semantic/ without extension, e.g. "default/light".
 * Later layers override earlier ones (deep-merge at token level).
 */
function buildCompositionLayerTree(layers: Layers, layerPaths: string[]): TokenTree | null {
  let merged: TokenTree = {}
  for (const layerPath of layerPaths) {
    const parts = layerPath.split('/')
    const [brand, scheme] = parts.length === 2 ? parts : ['default', parts[0]]
    const tree = layers.semantic[brand]?.[scheme]
    if (tree) merged = deepMergeTokenTrees(merged, tree)
  }
  return Object.keys(merged).length > 0 ? merged : null
}

function buildSemanticTree(
  layers: Layers,
  brand: string,
  scheme: string,
): TokenTree | null {
  const defaultTree = layers.semantic['default']?.[scheme]
  const brandTree = brand !== 'default' ? layers.semantic[brand]?.[scheme] : null

  if (!defaultTree && !brandTree) return null
  if (!brandTree) return defaultTree ?? null

  return deepMergeTokenTrees(defaultTree ?? {}, brandTree)
}

// ---------------------------------------------------------------------------
// Tree utilities
// ---------------------------------------------------------------------------

/** Shallow-merge multiple TokenTree objects (later wins at key level). */
function mergeTrees(trees: TokenTree[]): TokenTree {
  const result: TokenTree = {}
  for (const tree of trees) {
    for (const [k, v] of Object.entries(tree)) {
      if (k.startsWith('$')) continue
      result[k] = v
    }
  }
  return result
}

/** Deep-merge multiple TokenTree objects. */
function deepMergeTrees(trees: TokenTree[]): TokenTree {
  return trees.reduce<TokenTree>((acc, tree) => deepMergeTokenTrees(acc, tree), {})
}

/**
 * Deep-merge two token trees. When both sides have a leaf token ($value),
 * the override wins. Groups are merged recursively.
 */
function deepMergeTokenTrees(base: TokenTree, override: TokenTree): TokenTree {
  const result: TokenTree = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('$')) continue
    const baseValue = base[key]
    if (
      baseValue &&
      !('$value' in baseValue) &&
      !('$value' in (value as object))
    ) {
      result[key] = deepMergeTokenTrees(
        baseValue as TokenTree,
        value as TokenTree,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

/** Keep only the paths that appear in the allowlist. */
function filterByPaths(
  flat: Record<string, TokenValue>,
  paths: string[],
): Record<string, TokenValue> {
  const set = new Set(paths)
  return Object.fromEntries(Object.entries(flat).filter(([k]) => set.has(k)))
}

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

function parseMetadata(files: Map<string, string>): Metadata {
  const raw = files.get('metadata.json')
  if (!raw) return DEFAULT_METADATA
  try {
    const parsed = JSON.parse(raw) as Partial<Metadata> & { brands?: string[]; themes?: string[] }

    // Support legacy 'brands' field (renamed to 'themes')
    const themes = parsed.themes ?? parsed.brands ?? DEFAULT_METADATA.themes
    // Support legacy 'themes: ["light", "dark"]' used as colorSchemes
    const colorSchemes = parsed.colorSchemes ?? DEFAULT_METADATA.colorSchemes

    const merged: Metadata = {
      ...DEFAULT_METADATA,
      ...parsed,
      themes,
      colorSchemes,
    }
    if (parsed.figma) {
      merged.figma = {
        ...DEFAULT_METADATA.figma,
        ...parsed.figma,
        collections: {
          ...DEFAULT_METADATA.figma.collections,
          ...parsed.figma.collections,
        },
      }
    }
    return merged
  } catch {
    return DEFAULT_METADATA
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the tokensPath prefix from all file paths and return a name→content map. */
function stripTokensPath(files: GitHubFile[], tokensPath: string): Map<string, string> {
  const prefix = tokensPath.endsWith('/') ? tokensPath : tokensPath + '/'
  const map = new Map<string, string>()
  for (const f of files) {
    if (f.path.startsWith(prefix)) {
      map.set(f.path.slice(prefix.length), f.content)
    }
  }
  return map
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
