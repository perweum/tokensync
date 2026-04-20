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
  removedPaths?: string[],
  cleanApply?: boolean,
  resolvedValues?: Record<string, string>,
): Promise<{ count: number; removed: number; errors: string[] }> {
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
      collection.renameMode(collection.modes[0].modeId, modeId)
      mode = collection.modes[0]
    } else {
      const newModeId = collection.addMode(modeId)
      mode = collection.modes.find((m) => m.modeId === newModeId)!
    }
  }

  // Rebind modeId to the actual Figma ID
  modeId = mode.modeId

  // Flatten (keep raw {ref} strings) + build resolved map for fallback
  const flat = flattenTokens(tokens)
  const resolvedFlat = resolveAllReferences(flat)

  // Build lookup of ALL local variables — needed to find alias targets across collections
  const allLocalVars = await figma.variables.getLocalVariablesAsync()
  const allVarsByName = new Map(allLocalVars.map((v) => [v.name, v]))

  // Lookup of variables that belong to THIS collection
  const collectionVars = new Map(
    allLocalVars
      .filter((v) => v.variableCollectionId === collection.id)
      .map((v) => [v.name, v]),
  )

  let count = 0
  let removed = 0
  const errors: string[] = []

  // Clean apply: wipe all variables and remove any modes that are not the current mode.
  // This ensures leftover modes from old architectures don't persist alongside new ones.
  if (cleanApply) {
    for (const variable of collectionVars.values()) {
      try {
        variable.remove()
        allVarsByName.delete(variable.name)
      } catch { /* already deleted */ }
    }
    collectionVars.clear()

    // Remove every mode except the one we are about to populate.
    // Wrap each removal in try-catch: Figma may reject removal of the last mode.
    for (const existingMode of [...collection.modes]) {
      if (existingMode.modeId === modeId) continue
      try {
        collection.removeMode(existingMode.modeId)
      } catch { /* ignore — can't remove last mode or already gone */ }
    }

    console.log(`[TokenSync] Clean apply: cleared variables and extra modes from ${collectionId}`)
  }

  // Sort paths numerically (25, 50, 100 … 950)
  const sortedPaths = Object.keys(flat)
    .filter((p) => isTokenValue(flat[p]))
    .sort((a, b) => toSortKey(a).localeCompare(toSortKey(b)))

  console.log(`[TokenSync] Applying ${sortedPaths.length} tokens to ${collectionId}/${modeId}`)

  // ── Pass 1: create all missing variables (no values yet) ──────────────────
  for (const path of sortedPaths) {
    const token = flat[path] as TokenValue
    const figmaName = toFigmaVarName(path)
    const figmaType = figmaTypeFromTokenType(token.$type)
    if (!figmaType) continue
    if (!collectionVars.has(figmaName)) {
      try {
        const newVar = figma.variables.createVariable(figmaName, collection, figmaType)
        collectionVars.set(figmaName, newVar)
        allVarsByName.set(figmaName, newVar)
      } catch (err) {
        errors.push(`create ${figmaName}: ${String(err)}`)
      }
    }
  }

  // ── Pass 2: set values — VariableAlias for refs, literals otherwise ───────
  for (const path of sortedPaths) {
    const token = flat[path] as TokenValue
    const figmaName = toFigmaVarName(path)
    const variable = collectionVars.get(figmaName)
    if (!variable) continue
    const figmaType = figmaTypeFromTokenType(token.$type)
    if (!figmaType) continue

    try {
      if (isPureRef(token.$value)) {
        // Try to create a VariableAlias pointing to the referenced primitive/semantic variable
        const targetName = toFigmaVarName(extractRef(token.$value))
        const targetVar = allVarsByName.get(targetName)
        if (targetVar) {
          variable.setValueForMode(modeId, { type: 'VARIABLE_ALIAS', id: targetVar.id })
          count++
          continue
        }
        // Target variable not found — fall through to literal fallback
      }

      // Literal value. For strings that contain embedded {refs} (e.g. shadow values),
      // resolve them against already-applied Figma variable values.
      const rawValue = token.$value
      const literalValue = hasRef(rawValue)
        ? resolveInlineRefs(rawValue, allVarsByName)
        : rawValue

      // For the resolved fallback (when alias target wasn't found), use the fully-resolved map
      // Priority: inlined ref resolution → resolvedValues from UI → resolvedFlat (same-collection only)
      let valueToUse = (isPureRef(rawValue) && !hasRef(literalValue))
        ? literalValue
        : (hasRef(literalValue) ? (resolvedFlat[path]?.$value ?? literalValue) : literalValue)

      // If still unresolved, fall back to the pre-resolved value sent from the UI
      if (hasRef(valueToUse) && resolvedValues?.[path]) {
        valueToUse = resolvedValues[path]
      }

      const figmaValue = toFigmaValue(valueToUse, figmaType)
      if (figmaValue === null) {
        errors.push(`${figmaName}: could not parse "${token.$value}" (type: ${token.$type})`)
        continue
      }
      variable.setValueForMode(modeId, figmaValue)
      count++
    } catch (err) {
      errors.push(`${figmaName}: ${String(err)}`)
    }
  }

  // ── Delete variables removed from GitHub ──────────────────────────────────
  if (!cleanApply && removedPaths && removedPaths.length > 0) {
    for (const dotPath of removedPaths) {
      const figmaName = toFigmaVarName(dotPath)
      const variable = collectionVars.get(figmaName)
      if (variable) {
        try {
          variable.remove()
          removed++
        } catch (err) {
          errors.push(`delete ${figmaName}: ${String(err)}`)
        }
      }
    }
  }

  if (errors.length) {
    console.warn(`[TokenSync] ${errors.length} error(s) in ${collectionId}:`, errors.slice(0, 5))
  }
  console.log(`[TokenSync] Applied ${count}, removed ${removed} variables in ${collectionId}`)

  return { count, removed, errors }
}

/** Pads numeric segments so paths sort numerically: blue.25 < blue.100 */
function toSortKey(path: string): string {
  return path.replace(/(\d+)/g, (n) => n.padStart(6, '0'))
}

/** Returns true when $value is exactly a single token reference: "{color.blue.200}" */
function isPureRef(value: string): boolean {
  return /^\{[^}]+\}$/.test(value)
}

/** Returns true when $value contains any {ref} pattern (pure or embedded) */
function hasRef(value: string): boolean {
  return value.includes('{')
}

/** Strips the braces from a pure ref: "{color.blue.200}" → "color.blue.200" */
function extractRef(value: string): string {
  return value.slice(1, -1)
}

/**
 * Resolves embedded {ref} patterns in a string value by substituting the current
 * value of the matching Figma variable. Used for shadow/composite string tokens.
 */
function resolveInlineRefs(
  value: string,
  allVarsByName: Map<string, Variable>,
): string {
  return value.replace(/\{([^}]+)\}/g, (match, refPath: string) => {
    const figmaName = toFigmaVarName(refPath)
    const targetVar = allVarsByName.get(figmaName)
    if (!targetVar) return match

    // Take value from the first (and usually only) mode of the referenced variable
    const modeValues = Object.values(targetVar.valuesByMode)
    if (modeValues.length === 0) return match

    const val = modeValues[0]
    if (typeof val === 'string') return val
    if (typeof val === 'number') return String(val)
    if (typeof val === 'object' && val !== null && 'r' in val) {
      const { r, g, b, a = 1 } = val as { r: number; g: number; b: number; a?: number }
      return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
    }
    return match
  })
}

// ---------------------------------------------------------------------------
// Type conversion helpers
// ---------------------------------------------------------------------------

function figmaTypeFromTokenType(
  type: string,
): 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | null {
  switch (type) {
    case 'color':
      return 'COLOR'
    case 'boolean':
      return 'BOOLEAN'
    case 'dimension':
    case 'number':
    case 'fontWeight':
    case 'fontFamily':
    case 'shadow':
    case 'string':
    case 'text':
      return 'STRING'
    default:
      return null
  }
}

function toFigmaValue(
  value: string,
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN',
): RGBA | number | string | boolean | null {
  if (type === 'COLOR') return hexToRGBA(value)
  if (type === 'FLOAT') return parseDimension(value)
  if (type === 'BOOLEAN') return value === 'true'
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
