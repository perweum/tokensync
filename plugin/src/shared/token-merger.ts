/**
 * Merges token files from GitHub into resolved flat maps per collection.
 *
 * Collection topology (new architecture):
 *   Primitives  — raw colour/geometry/typography values, 1 mode "Value"
 *   Global      — theme-invariant semantic tokens (spacing, typography), 1 mode "Value"
 *   Brand       — palette aliases (brand.25 … brand.950), one mode per brand
 *   Semantic    — semantic colour roles referencing {brand.N}, 2 modes: Light / Dark
 *
 * File layout on GitHub:
 *   primitives/{name}.json
 *   semantic/global/{name}.json
 *   semantic/brand/{brand}.json   ← brand.N → color.X.N aliases
 *   semantic/light.json           ← uses {brand.N} refs for brand-coloured slots
 *   semantic/dark.json
 *
 * Legacy layout (also supported during migration):
 *   semantic/default/light.json   ← maps to layers.semantic['default']['light']
 *   semantic/{brand}/{theme}.json ← sparse override (old N×M model)
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
  brands: string[]
  themes: string[]
  /** Explicit multi-dimensional theme compositions. Produces additional Figma modes. */
  compositions?: Composition[]
  figma: {
    fileKey: string
    collections: { primitives: string; global: string; brand: string; semantic: string }
  }
  roles: Record<string, Record<string, string>>
}

const DEFAULT_METADATA: Metadata = {
  version: '1.0.0',
  brands: ['default'],
  themes: ['light', 'dark'],
  compositions: [],
  figma: {
    fileKey: '',
    collections: { primitives: 'Primitives', global: 'Global', brand: 'Brand', semantic: 'Semantic' },
  },
  roles: {},
}

// ---------------------------------------------------------------------------
// Parsed repository structure
// ---------------------------------------------------------------------------

export interface ResolvedCollection {
  /** Matches figma collection name from metadata */
  collectionName: string
  /** e.g. "Value" for primitives/global, "Default" for brand, "Light" for semantic */
  modeName: string
  /** Flat, fully-resolved token map: path → { $type, $value } — used for diff comparison */
  tokens: Record<string, TokenValue>
  /** Flat, unresolved token map: $value may contain "{brand.600}" or "{color.blue.200}" refs — used for Figma alias creation */
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
 *   3. Brand (refs primitives) ← must exist before Semantic is applied
 *   4. Semantic (refs brand + primitives via cross-collection aliases)
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

  // --- Brand collection (one mode per brand) ---
  // Each brand file defines brand.N → color.X.N aliases.
  // Resolved: brand.600 = #1a52d8.  Raw: brand.600 = {color.blue.600}.
  for (const [brandName, brandTree] of Object.entries(layers.brand)) {
    const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, brandTree]))
    const fullFlatResolved = resolveAllReferences(fullFlatUnresolved)
    const brandPaths = Object.keys(flattenTokens(brandTree))
    collections.push({
      collectionName: metadata.figma.collections.brand,
      modeName: capitalise(brandName),
      tokens: filterByPaths(fullFlatResolved, brandPaths),
      rawTokens: filterByPaths(fullFlatUnresolved, brandPaths),
    })
  }

  // --- Semantic collection (one mode per theme, brand-agnostic) ---
  // rawTokens keeps {brand.N} refs unresolved so the plugin creates cross-collection aliases.
  // tokens resolves through the default brand for diff comparison / display.
  const defaultBrandTree = layers.brand['default'] ?? {}
  for (const theme of metadata.themes) {
    const themeTree = layers.semantic['default']?.[theme]
    if (!themeTree) continue

    // rawTokens: NO brand tree in merge — {brand.N} refs remain as literal strings
    const rawFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, themeTree]))
    const themePaths = Object.keys(flattenTokens(themeTree))

    // resolved tokens: include default brand so {brand.600} → {color.blue.600} → #1a52d8
    const resolvedFlat = resolveAllReferences(
      flattenTokens(mergeTrees([primitivesTree, defaultBrandTree, globalTree, themeTree]))
    )

    collections.push({
      collectionName: metadata.figma.collections.semantic,
      modeName: capitalise(theme),
      tokens: filterByPaths(resolvedFlat, themePaths),
      rawTokens: filterByPaths(rawFlatUnresolved, themePaths),
    })
  }

  // --- Legacy N×M semantic modes (old-style brand/theme pairs, for backward compat) ---
  // Only emitted when a repo still uses semantic/{brand}/{theme}.json (brand ≠ 'default').
  const legacyBrands = Object.keys(layers.semantic).filter((b) => b !== 'default')
  for (const brand of legacyBrands) {
    for (const theme of Object.keys(layers.semantic[brand])) {
      const semanticTree = buildSemanticTree(layers, brand, theme)
      if (!semanticTree) continue

      const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, semanticTree]))
      const fullFlatResolved = resolveAllReferences(fullFlatUnresolved)
      const semanticPaths = Object.keys(flattenTokens(semanticTree))
      collections.push({
        collectionName: metadata.figma.collections.semantic,
        modeName: `${capitalise(brand)}/${capitalise(theme)}`,
        tokens: filterByPaths(fullFlatResolved, semanticPaths),
        rawTokens: filterByPaths(fullFlatUnresolved, semanticPaths),
      })
    }
  }

  // --- Composition modes ---
  for (const comp of (metadata.compositions ?? [])) {
    const compTree = buildCompositionLayerTree(layers, comp.layers)
    if (!compTree) continue

    const fullFlatUnresolved = flattenTokens(mergeTrees([primitivesTree, globalTree, compTree]))
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
  /** brandName → tree (new architecture: semantic/brand/{name}.json) */
  brand: Record<string, TokenTree>
  /** brand → theme → tree (legacy N×M + new flat semantic files at 'default' key) */
  semantic: Record<string, Record<string, TokenTree>>
}

function buildLayers(files: Map<string, string>): Layers {
  const layers: Layers = { primitives: {}, global: {}, brand: {}, semantic: {} }

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
    } else if (parts[0] === 'semantic' && parts[1] === 'brand') {
      // New: semantic/brand/{brandName}.json
      layers.brand[parts[2]] = tree
    } else if (parts[0] === 'semantic' && parts.length === 3) {
      // Legacy: semantic/{brand}/{theme}.json
      const [, brand, theme] = parts
      if (!layers.semantic[brand]) layers.semantic[brand] = {}
      layers.semantic[brand][theme] = tree
    } else if (parts[0] === 'semantic' && parts.length === 2) {
      // New flat: semantic/{theme}.json → defer so it wins over legacy default/{theme}
      depth2.push([parts[1], tree])
    }
  }

  // Apply new-style flat theme files last (win over legacy semantic/default/{theme}.json)
  for (const [theme, tree] of depth2) {
    if (!layers.semantic['default']) layers.semantic['default'] = {}
    layers.semantic['default'][theme] = tree
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
    const [brand, theme] = parts.length === 2 ? parts : ['default', parts[0]]
    const tree = layers.semantic[brand]?.[theme]
    if (tree) merged = deepMergeTokenTrees(merged, tree)
  }
  return Object.keys(merged).length > 0 ? merged : null
}

function buildSemanticTree(
  layers: Layers,
  brand: string,
  theme: string,
): TokenTree | null {
  const defaultTree = layers.semantic['default']?.[theme]
  const brandTree = brand !== 'default' ? layers.semantic[brand]?.[theme] : null

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
    const parsed = JSON.parse(raw) as Partial<Metadata>
    // Deep-merge figma.collections so repos that don't yet have 'brand' still get a default
    const merged: Metadata = { ...DEFAULT_METADATA, ...parsed }
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
