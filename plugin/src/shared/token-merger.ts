/**
 * Merges token files from GitHub into resolved flat maps per collection.
 *
 * Layer order (later layers override earlier):
 *   1. primitives/
 *   2. semantic/global/
 *   3. semantic/default/{theme}
 *   4. semantic/{brand}/{theme}   ← sparse override
 */

import type { GitHubFile, TokenTree, TokenValue } from './messages'
import { flattenTokens, resolveAllReferences } from './token-format'

// ---------------------------------------------------------------------------
// Metadata type
// ---------------------------------------------------------------------------

export interface Metadata {
  version: string
  brands: string[]
  themes: string[]
  figma: {
    fileKey: string
    collections: { primitives: string; global: string; semantic: string }
  }
  roles: Record<string, Record<string, string>>
}

const DEFAULT_METADATA: Metadata = {
  version: '1.0.0',
  brands: ['default'],
  themes: ['light', 'dark'],
  figma: {
    fileKey: '',
    collections: { primitives: 'Primitives', global: 'Global', semantic: 'Semantic' },
  },
  roles: {},
}

// ---------------------------------------------------------------------------
// Parsed repository structure
// ---------------------------------------------------------------------------

export interface ResolvedCollection {
  /** Matches figma collection name from metadata */
  collectionName: string
  /** e.g. "Value" for primitives/global, "Default/Light" for semantic */
  modeName: string
  /** Flat, fully-resolved token map: path → { $type, $value } */
  tokens: Record<string, TokenValue>
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
  const primitivesTree = mergeTrees(Object.values(layers.primitives))
  const primitivesFlat = resolveAllReferences(flattenTokens(primitivesTree))
  collections.push({
    collectionName: metadata.figma.collections.primitives,
    modeName: 'Value',
    tokens: primitivesFlat,
  })

  // --- Global collection ---
  const globalTree = mergeTrees(Object.values(layers.global))
  // Global tokens can reference primitives — include both for resolution
  const globalWithPrimitives = flattenTokens(mergeTrees([primitivesTree, globalTree]))
  const globalResolved = resolveAllReferences(globalWithPrimitives)
  // Keep only global tokens (strip primitives from output)
  const globalFlat = filterByPaths(globalResolved, Object.keys(flattenTokens(globalTree)))
  collections.push({
    collectionName: metadata.figma.collections.global,
    modeName: 'Value',
    tokens: globalFlat,
  })

  // --- Semantic collection (one mode per brand × theme) ---
  for (const brand of metadata.brands) {
    for (const theme of metadata.themes) {
      const semanticTree = buildSemanticTree(layers, brand, theme)
      if (!semanticTree) continue

      // Resolve against primitives + global
      const fullTree = mergeTrees([primitivesTree, globalTree, semanticTree])
      const fullFlat = resolveAllReferences(flattenTokens(fullTree))
      // Keep only semantic tokens
      const semanticFlat = filterByPaths(fullFlat, Object.keys(flattenTokens(semanticTree)))

      const modeName =
        brand === 'default'
          ? capitalise(theme)
          : `${capitalise(brand)}/${capitalise(theme)}`

      collections.push({
        collectionName: metadata.figma.collections.semantic,
        modeName,
        tokens: semanticFlat,
      })
    }
  }

  return { metadata, collections }
}

// ---------------------------------------------------------------------------
// Layer organisation
// ---------------------------------------------------------------------------

interface Layers {
  primitives: Record<string, TokenTree>
  global: Record<string, TokenTree>
  /** brand → theme → tree */
  semantic: Record<string, Record<string, TokenTree>>
}

function buildLayers(files: Map<string, string>): Layers {
  const layers: Layers = { primitives: {}, global: {}, semantic: {} }

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
    } else if (parts[0] === 'semantic' && parts.length === 3) {
      const [, brand, theme] = parts
      if (!layers.semantic[brand]) layers.semantic[brand] = {}
      layers.semantic[brand][theme] = tree
    }
  }

  return layers
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

  // Deep-merge: brand overrides default at token level
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
      // Both are subtrees — recurse
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
    return { ...DEFAULT_METADATA, ...(JSON.parse(raw) as Partial<Metadata>) }
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
