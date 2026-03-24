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
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {}

  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith('$')) continue // skip $type, $description group-level fields
    const path = prefix ? `${prefix}.${key}` : key

    if (isTokenValue(value)) {
      result[path] = value
    } else if (isTokenTree(value)) {
      Object.assign(result, flattenTokens(value, path))
    }
  }

  return result
}

/**
 * Resolve a reference like `{color.brand.600}` against a flat token map.
 * Returns the resolved $value string, or null if unresolvable.
 */
export function resolveReference(
  ref: string,
  flat: Record<string, TokenValue>,
): string | null {
  const match = ref.match(/^\{(.+)\}$/)
  if (!match) return ref // not a reference — return as-is

  const path = match[1]
  const token = flat[path]
  if (!token) return null

  // recurse if the resolved value is itself a reference
  if (token.$value.startsWith('{')) {
    return resolveReference(token.$value, flat)
  }

  return token.$value
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
