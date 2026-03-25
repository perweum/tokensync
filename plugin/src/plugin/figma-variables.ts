/**
 * Figma Variables API helpers.
 * Runs in the Figma plugin sandbox — has access to the global `figma` object.
 */

import type { FigmaVariable, FigmaVariableCollection, TokenTree } from '../shared/messages'
import { flattenTokens, resolveAllReferences, toFigmaVarName, isTokenValue } from '../shared/token-format'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Returns all local variable collections and their variables.
 */
export async function getCollectionsAndVariables(): Promise<{
  collections: FigmaVariableCollection[]
  variables: FigmaVariable[]
}> {
  const rawCollections = await figma.variables.getLocalVariableCollectionsAsync()
  const rawVariables = await figma.variables.getLocalVariablesAsync()

  const collections: FigmaVariableCollection[] = rawCollections.map((c) => ({
    id: c.id,
    name: c.name,
    modes: c.modes,
    variableIds: c.variableIds,
  }))

  const variables: FigmaVariable[] = rawVariables.map((v) => ({
    id: v.id,
    name: v.name,
    resolvedType: v.resolvedType as FigmaVariable['resolvedType'],
    valuesByMode: v.valuesByMode,
    collectionId: v.variableCollectionId,
    collectionName:
      rawCollections.find((c) => c.id === v.variableCollectionId)?.name ?? '',
  }))

  return { collections, variables }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Applies a TokenTree to a Figma variable collection + mode.
 * collectionId and modeId may be names (resolved here) or actual Figma IDs.
 * Creates variables that don't exist, updates values for variables that do.
 * Returns { count, errors }.
 */
export async function applyTokensToCollection(
  tokens: TokenTree,
  collectionId: string,
  modeId: string,
): Promise<{ count: number; errors: string[] }> {
  // Support name-based lookup (sent from UI as collection name / mode name)
  const allCollections = await figma.variables.getLocalVariableCollectionsAsync()
  let collection = allCollections.find((c) => c.id === collectionId)
                ?? allCollections.find((c) => c.name === collectionId)

  // Create collection if it doesn't exist yet (first-time apply)
  if (!collection) {
    collection = figma.variables.createVariableCollection(collectionId)
  }

  let mode = collection.modes.find((m) => m.modeId === modeId)
          ?? collection.modes.find((m) => m.name === modeId)

  // Create mode if it doesn't exist (Figma always creates a default "Mode 1" — rename or add)
  if (!mode) {
    if (collection.modes.length === 1 && collection.modes[0].name === 'Mode 1') {
      // Rename the placeholder mode Figma creates automatically
      collection.renameMode(collection.modes[0].modeId, modeId)
      mode = collection.modes[0]
    } else {
      const newModeId = collection.addMode(modeId)
      mode = collection.modes.find((m) => m.modeId === newModeId)!
    }
  }

  // Rebind modeId to the actual Figma ID
  modeId = mode.modeId

  // Flatten and resolve all references
  const flat = flattenTokens(tokens)
  const resolved = resolveAllReferences(flat)

  // Build a lookup of existing variables by name (slash-notation)
  const existingVars = await figma.variables.getLocalVariablesAsync()
  const varByName = new Map(
    existingVars
      .filter((v) => v.variableCollectionId === collection.id)
      .map((v) => [v.name, v]),
  )

  let count = 0
  const errors: string[] = []

  console.log(`[TokenSync] Applying ${Object.keys(resolved).length} tokens to ${collectionId}/${modeId}`)

  for (const [path, token] of Object.entries(resolved)) {
    if (!isTokenValue(token)) continue

    const figmaName = toFigmaVarName(path)
    const resolvedType = figmaTypeFromTokenType(token.$type)
    if (!resolvedType) {
      // Skip silently — unsupported type (e.g. composite shadow objects)
      continue
    }

    try {
      let variable = varByName.get(figmaName)

      if (!variable) {
        variable = figma.variables.createVariable(figmaName, collection, resolvedType)
      }

      const figmaValue = toFigmaValue(token.$value, resolvedType)
      if (figmaValue === null) {
        errors.push(`${figmaName}: could not parse value "${token.$value}" (type: ${token.$type})`)
        continue
      }

      variable.setValueForMode(modeId, figmaValue)
      count++
    } catch (err) {
      errors.push(`${figmaName}: ${String(err)}`)
    }
  }

  if (errors.length) {
    console.warn(`[TokenSync] ${errors.length} error(s) in ${collectionId}:`, errors.slice(0, 5))
  }
  console.log(`[TokenSync] Applied ${count} variables to ${collectionId}`)

  return { count, errors }
}

// ---------------------------------------------------------------------------
// Type conversion helpers
// ---------------------------------------------------------------------------

function figmaTypeFromTokenType(
  type: string,
): 'COLOR' | 'FLOAT' | 'STRING' | null {
  switch (type) {
    case 'color':
      return 'COLOR'
    case 'dimension':
    case 'number':
    case 'fontWeight':
    case 'fontFamily':
    case 'shadow':
      return 'STRING'
    default:
      return null
  }
}

function toFigmaValue(
  value: string,
  type: 'COLOR' | 'FLOAT' | 'STRING',
): RGBA | number | string | null {
  if (type === 'COLOR') return hexToRGBA(value)
  if (type === 'FLOAT') return parseDimension(value)
  if (type === 'STRING') return value
  return null
}

function hexToRGBA(hex: string): RGBA | null {
  // Handle rgba(r, g, b, a) format
  const rgbaMatch = hex.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]) / 255,
      g: parseInt(rgbaMatch[2]) / 255,
      b: parseInt(rgbaMatch[3]) / 255,
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    }
  }

  // Handle hex format #rrggbb or #rrggbbaa
  const clean = hex.replace('#', '')
  if (clean.length === 6 || clean.length === 8) {
    return {
      r: parseInt(clean.slice(0, 2), 16) / 255,
      g: parseInt(clean.slice(2, 4), 16) / 255,
      b: parseInt(clean.slice(4, 6), 16) / 255,
      a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1,
    }
  }

  return null
}

function parseDimension(value: string): number | null {
  // Strip known units — values in token files are pre-converted to unitless px/% numbers
  const stripped = value.replace(/px$/, '').replace(/rem$/, '').replace(/em$/, '')
  const num = parseFloat(stripped)
  return isNaN(num) ? null : num
}
