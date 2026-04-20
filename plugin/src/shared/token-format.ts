/**
 * tokensync/v1 format utilities.
 * Shared between the plugin sandbox and the React UI — no Figma or browser APIs here.
 */

import type { TokenTree, TokenValue } from './messages'

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTokenValue(value: unknown): value is TokenValue {
  if (typeof value !== 'object' || value === null) return false
  return '$value' in value
}

export function isTokenTree(value: unknown): value is TokenTree {
  if (typeof value !== 'object' || value === null) return false
  return !('$value' in value)
}

// ---------------------------------------------------------------------------
// Flatten / unflatten
// ---------------------------------------------------------------------------

/**
 * Flattens a nested TokenTree into dot-notation entries.
 *
 * { color: { brand: { 600: { $type: 'color', $value: '#1a52d8' } } } }
 * → { 'color.brand.600': { $type: 'color', $value: '#1a52d8' } }
 */
export function flattenTokens(
  tree: TokenTree,
  prefix = '',
  inheritedType = '',
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {}
  const groupType = (tree as Record<string, unknown>)['$type'] as string | undefined
  const effectiveType = groupType ?? inheritedType

  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith('$')) continue // skip $type, $description group-level fields
    const path = prefix ? `${prefix}.${key}` : key

    if (isTokenValue(value)) {
      // Propagate group-level $type if the token doesn't have its own
      result[path] = value.$type ? value : { ...value, $type: effectiveType }
    } else if (isTokenTree(value)) {
      Object.assign(result, flattenTokens(value, path, effectiveType))
    }
  }

  return result
}

/**
 * Resolve a reference (or embedded references) against a flat token map.
 *
 * Handles two cases:
 *   Pure ref:     "{color.brand.600}"          → resolves to a single value
 *   Embedded ref: "0 1px 2px {color.black.50}" → each {ref} is substituted inline
 *
 * Returns the resolved string, or null if a pure ref target is missing.
 */
export function resolveReference(
  ref: string,
  flat: Record<string, TokenValue>,
): string | null {
  const match = ref.match(/^\{(.+)\}$/)
  if (match) {
    // Pure reference — look up and recurse
    const path = match[1]
    const token = flat[path]
    if (!token) return null
    return resolveReference(token.$value, flat)
  }

  // Embedded references inside a composite value (e.g. shadow strings)
  if (ref.includes('{')) {
    return ref.replace(/\{([^}]+)\}/g, (_match, refPath: string) => {
      const token = flat[refPath]
      if (!token) return _match
      const resolved = resolveReference(token.$value, flat)
      return resolved ?? _match
    })
  }

  return ref // not a reference — return as-is
}

/**
 * Resolve all references in a flat token map.
 * Returns a new map with all $value fields fully resolved to raw values.
 * Unresolvable references are left as-is (they will fail validation).
 */
export function resolveAllReferences(
  flat: Record<string, TokenValue>,
): Record<string, TokenValue> {
  return Object.fromEntries(
    Object.entries(flat).map(([path, token]) => {
      const resolved = resolveReference(token.$value, flat)
      return [path, { ...token, $value: resolved ?? token.$value }]
    }),
  )
}

// ---------------------------------------------------------------------------
// CSS variable name conversion
// ---------------------------------------------------------------------------

/**
 * Converts a dot-notation token path to a CSS custom property name.
 *
 * 'color.base.brand.default' → '--color-base-brand-default'
 * 'radius.md'               → '--radius-md'
 */
export function toCSSVar(path: string, prefix = '--'): string {
  return prefix + path.replace(/\./g, '-')
}

// ---------------------------------------------------------------------------
// Figma variable name conversion
// ---------------------------------------------------------------------------

/**
 * Converts a dot-notation token path to a Figma variable name (slash-separated).
 *
 * 'color.base.brand.default' → 'color/base/brand/default'
 */
export function toFigmaVarName(path: string): string {
  return path.replace(/\./g, '/')
}

/**
 * Converts a Figma variable name back to dot-notation path.
 *
 * 'color/base/brand/default' → 'color.base.brand.default'
 */
export function fromFigmaVarName(name: string): string {
  return name.replace(/\//g, '.')
}
