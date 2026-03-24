/**
 * Converts Figma Variable data into:
 *   1. ResolvedCollection[] for diffing (same shape as parseRepository output)
 *   2. TokenFile[] for writing to GitHub
 */

import type {
  FigmaVariable,
  FigmaVariableCollection,
  FigmaVariableValue,
  TokenValue,
} from './messages'
import type { ResolvedCollection } from './token-merger'
import { fromFigmaVarName } from './token-format'

export interface TokenFile {
  repoPath: string  // e.g. "tokens/primitives/color.json"
  content: string   // formatted JSON
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce ResolvedCollection[] from Figma data — used for diffing against GitHub.
 */
export function figmaToCollections(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
  figmaCollectionNames: { primitives: string; global: string; semantic: string },
): ResolvedCollection[] {
  const varById = new Map(variables.map((v) => [v.id, v]))
  const result: ResolvedCollection[] = []

  for (const collection of collections) {
    const collVars = variables.filter((v) => v.collectionId === collection.id)

    for (const mode of collection.modes) {
      const tokens = buildFlatTokens(collVars, mode.modeId, varById)

      // Determine the canonical collection name for diffing
      const collectionName = resolveCollectionName(
        collection.name,
        figmaCollectionNames,
      )

      result.push({
        collectionName,
        modeName: mode.name,
        tokens,
      })
    }
  }

  return result
}

/**
 * Produce token JSON files suitable for committing to GitHub.
 */
export function figmaToTokenFiles(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
  tokensPath: string,
  figmaCollectionNames: { primitives: string; global: string; semantic: string },
): TokenFile[] {
  const varById = new Map(variables.map((v) => [v.id, v]))
  const files: TokenFile[] = []

  for (const collection of collections) {
    const collVars = variables.filter((v) => v.collectionId === collection.id)
    const kind = collectionKind(collection.name, figmaCollectionNames)

    if (kind === 'primitives') {
      files.push(...buildPrimitiveFiles(collVars, collection.modes[0].modeId, varById, tokensPath))
    } else if (kind === 'global') {
      files.push(...buildGlobalFiles(collVars, collection.modes[0].modeId, varById, tokensPath))
    } else if (kind === 'semantic') {
      for (const mode of collection.modes) {
        const file = buildSemanticFile(collVars, mode, varById, tokensPath)
        if (file) files.push(file)
      }
    }
  }

  return files
}

// ---------------------------------------------------------------------------
// Flat token map builder
// ---------------------------------------------------------------------------

function buildFlatTokens(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {}

  for (const v of vars) {
    const raw = v.valuesByMode[modeId]
    if (raw === undefined) continue

    const path = fromFigmaVarName(v.name)
    const $type = inferType(v.name, v.resolvedType)
    const $value = rawToTokenValue(raw, $type, varById)
    if ($value === null) continue

    result[path] = { $type, $value }
  }

  return result
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function buildPrimitiveFiles(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile[] {
  // Group by first path segment: color → color.json, geometry → geometry.json
  const groups = groupByFirstSegment(vars)
  return Object.entries(groups).map(([segment, segVars]) => ({
    repoPath: joinPath(tokensPath, 'primitives', `${segment}.json`),
    content: buildJsonFile(segVars, modeId, varById),
  }))
}

function buildGlobalFiles(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile[] {
  // Heuristic grouping for global semantic tokens
  const typoSegments = new Set(['text', 'fontFamily', 'fontWeight', 'heading', 'body', 'label', 'code'])
  const spacingSegments = new Set(['spacing', 'radius', 'borderWidth', 'inline', 'layout', 'component'])

  const typoVars = vars.filter((v) => typoSegments.has(firstSegment(v.name)))
  const spacingVars = vars.filter((v) => spacingSegments.has(firstSegment(v.name)))
  const otherVars = vars.filter(
    (v) => !typoSegments.has(firstSegment(v.name)) && !spacingSegments.has(firstSegment(v.name)),
  )

  const files: TokenFile[] = []
  if (typoVars.length > 0)
    files.push({ repoPath: joinPath(tokensPath, 'semantic/global', 'typography.json'), content: buildJsonFile(typoVars, modeId, varById) })
  if (spacingVars.length > 0)
    files.push({ repoPath: joinPath(tokensPath, 'semantic/global', 'spacing.json'), content: buildJsonFile(spacingVars, modeId, varById) })
  if (otherVars.length > 0)
    files.push({ repoPath: joinPath(tokensPath, 'semantic/global', 'other.json'), content: buildJsonFile(otherVars, modeId, varById) })

  return files
}

function buildSemanticFile(
  vars: FigmaVariable[],
  mode: { modeId: string; name: string },
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (vars.length === 0) return null

  // Parse "Default/Light" → brand=default, theme=light
  // Parse "Light" → brand=default, theme=light
  // Parse "Brand-A/Light" → brand=brand-a, theme=light
  const { brand, theme } = parseModeName(mode.name)

  return {
    repoPath: joinPath(tokensPath, 'semantic', brand, `${theme}.json`),
    content: buildJsonFile(vars, mode.modeId, varById),
  }
}

// ---------------------------------------------------------------------------
// JSON file builder (nested tree from flat variables)
// ---------------------------------------------------------------------------

function buildJsonFile(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
): string {
  const tree: Record<string, unknown> = {}

  for (const v of vars) {
    const raw = v.valuesByMode[modeId]
    if (raw === undefined) continue

    const $type = inferType(v.name, v.resolvedType)
    const $value = rawToTokenValue(raw, $type, varById)
    if ($value === null) continue

    const path = fromFigmaVarName(v.name)
    setNested(tree, path.split('.'), { $type, $value })
  }

  return JSON.stringify(tree, null, 2)
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function rawToTokenValue(
  raw: FigmaVariableValue,
  $type: string,
  varById: Map<string, FigmaVariable>,
): string | null {
  // Alias → reference
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'VARIABLE_ALIAS') {
    const target = varById.get(raw.id)
    if (!target) return null
    return `{${fromFigmaVarName(target.name)}}`
  }

  // Color
  if ($type === 'color' && typeof raw === 'object' && raw !== null && 'r' in raw) {
    const c = raw as { r: number; g: number; b: number; a?: number }
    const a = c.a ?? 1
    const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0')
    if (Math.round(a * 255) === 255) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a.toFixed(2)})`
  }

  // Number → dimension string or plain number
  if (typeof raw === 'number') {
    if ($type === 'dimension') return `${raw}px`
    if ($type === 'fontWeight') return String(raw)
    return String(raw)
  }

  if (typeof raw === 'string') return raw

  return null
}

// ---------------------------------------------------------------------------
// Type inference from variable name + Figma resolvedType
// ---------------------------------------------------------------------------

function inferType(name: string, resolvedType: string): string {
  if (resolvedType === 'COLOR') return 'color'
  if (resolvedType === 'STRING') {
    if (/family|font/i.test(name)) return 'fontFamily'
    return 'string'
  }
  if (resolvedType === 'FLOAT') {
    if (/size|spacing|padding|radius|width|height|border|gap/i.test(name)) return 'dimension'
    if (/weight/i.test(name)) return 'fontWeight'
    if (/lineHeight|line.height/i.test(name)) return 'number'
    if (/letterSpacing|letter.spacing/i.test(name)) return 'dimension'
    return 'number'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Collection kind detection
// ---------------------------------------------------------------------------

type CollectionKind = 'primitives' | 'global' | 'semantic' | 'unknown'

function collectionKind(
  name: string,
  names: { primitives: string; global: string; semantic: string },
): CollectionKind {
  if (name === names.primitives) return 'primitives'
  if (name === names.global) return 'global'
  if (name === names.semantic) return 'semantic'
  return 'unknown'
}

function resolveCollectionName(
  name: string,
  names: { primitives: string; global: string; semantic: string },
): string {
  if (name === names.primitives) return names.primitives
  if (name === names.global) return names.global
  if (name === names.semantic) return names.semantic
  return name
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByFirstSegment(vars: FigmaVariable[]): Record<string, FigmaVariable[]> {
  const groups: Record<string, FigmaVariable[]> = {}
  for (const v of vars) {
    const seg = firstSegment(v.name)
    if (!groups[seg]) groups[seg] = []
    groups[seg].push(v)
  }
  return groups
}

function firstSegment(varName: string): string {
  return varName.split('/')[0]
}

function parseModeName(modeName: string): { brand: string; theme: string } {
  const parts = modeName.split('/')
  if (parts.length === 1) {
    return { brand: 'default', theme: parts[0].toLowerCase() }
  }
  const brand = parts[0].toLowerCase().replace(/\s+/g, '-')
  const theme = parts[1].toLowerCase()
  return { brand: brand === 'default' ? 'default' : brand, theme }
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/|\/$/g, ''))
    .filter(Boolean)
    .join('/')
}

function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
      current[keys[i]] = {}
    }
    current = current[keys[i]] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}
