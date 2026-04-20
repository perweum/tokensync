/**
 * CSS transformer — generates CSS custom properties.
 *
 * Output structure (Primitives → Themes → Semantic):
 *   :root { ... }                              ← primitives + global + first theme's light.* and dark.* vars
 *   [data-theme="zero"] { ... }                ← non-default theme overrides (only what differs)
 *   [data-color-scheme="light"] { ... }        ← semantic roles → var(--light-*) + resolved severity
 *   [data-color-scheme="dark"] { ... }         ← semantic roles → var(--dark-*) + resolved severity
 *   [data-color-scheme="auto"] + @media        ← follows OS preference
 *
 * Theme switching cascades automatically: changing [data-theme] on any ancestor
 * updates all --light-* and --dark-* CSS vars, which Semantic selectors pick up.
 */

import type { ResolvedCollection } from '../token-merger'
import type { TokenValue } from '../messages'

export function generateCSS(collections: ResolvedCollection[]): string {
  const blocks: string[] = [cssHeader()]

  const primitives   = collections.find((c) => isPrimitivesCollection(c))
  const global       = collections.find((c) => isGlobalCollection(c))
  const themeCols    = collections.filter((c) => isThemesCollection(c))
  const semanticCols = collections.filter((c) => isSemanticCollection(c))

  // :root — primitives, global, and the default (first) theme's complete light/dark vars
  const defaultTheme = themeCols[0]
  const rootTokens: Record<string, TokenValue> = {
    ...(primitives?.tokens ?? {}),
    ...(global?.tokens ?? {}),
    ...(defaultTheme?.rawTokens ?? {}),  // light.* and dark.* → resolved primitive values
  }
  if (Object.keys(rootTokens).length > 0) {
    blocks.push(cssBlock(':root', rootTokens))
  }

  // Non-default theme overrides — only the vars that differ from the default theme
  for (const col of themeCols.slice(1)) {
    const themeSlug = col.modeName.toLowerCase().replace(/\s+/g, '-')
    blocks.push(cssBlock(`[data-theme="${themeSlug}"]`, col.rawTokens))
  }

  // Semantic: Light/Dark modes — emit var(--light-*) / var(--dark-*) for theme-aliased tokens
  const lightCol = semanticCols.find((c) => c.modeName.toLowerCase() === 'light')
  const darkCol  = semanticCols.find((c) => c.modeName.toLowerCase() === 'dark')

  if (lightCol) {
    blocks.push(semanticBlock('[data-color-scheme="light"]', lightCol))
    blocks.push(semanticBlock('[data-color-scheme="auto"]', lightCol))
  }
  if (darkCol) {
    blocks.push(semanticBlock('[data-color-scheme="dark"]', darkCol))
    blocks.push(semanticMediaBlock('(prefers-color-scheme: dark)', '[data-color-scheme="auto"]', darkCol))
  }

  // Legacy N×M brand×theme modes (backward compat)
  const legacyModes = semanticCols.filter(
    (c) => c.modeName.toLowerCase() !== 'light' && c.modeName.toLowerCase() !== 'dark',
  )
  for (const col of legacyModes) {
    const brand = modeBrand(col.modeName)
    const theme = modeTheme(col.modeName)
    const selector = `[data-brand="${brand}"][data-color-scheme="${theme}"]`
    blocks.push(cssBlock(selector, col.tokens))
    if (theme === 'light') {
      blocks.push(cssBlock(`[data-brand="${brand}"][data-color-scheme="auto"]`, col.tokens))
    }
    if (theme === 'dark') {
      blocks.push(mediaBlock('(prefers-color-scheme: dark)', `[data-brand="${brand}"][data-color-scheme="auto"]`, col.tokens))
    }
  }

  return blocks.filter(Boolean).join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

/**
 * Semantic block: emits var(--light-*) / var(--dark-*) for {light.*} / {dark.*} raw refs
 * so theme switching cascades automatically, and resolved hex for all other tokens.
 */
function semanticBlock(selector: string, col: ResolvedCollection): string {
  const entries = Object.entries(col.tokens).filter(([, t]) => t.$type !== 'boolean')
  if (entries.length === 0) return ''

  const lines = entries.map(([path, token]) => {
    const varName = toCSSVar(path)
    const rawValue = col.rawTokens[path]?.$value
    const value = toThemeAwareValue(token.$value, rawValue)
    return `  ${varName}: ${value};`
  })

  return `${selector} {\n${lines.join('\n')}\n}`
}

function semanticMediaBlock(query: string, selector: string, col: ResolvedCollection): string {
  const inner = semanticBlock(selector, col)
  if (!inner) return ''
  const indented = inner.split('\n').map((l) => `  ${l}`).join('\n')
  return `@media ${query} {\n${indented}\n}`
}

function cssBlock(selector: string, tokens: Record<string, TokenValue>): string {
  const entries = Object.entries(tokens).filter(([, t]) => t.$type !== 'boolean')
  if (entries.length === 0) return ''
  const lines = entries.map(([path, token]) => `  ${toCSSVar(path)}: ${token.$value};`)
  return `${selector} {\n${lines.join('\n')}\n}`
}

function mediaBlock(query: string, selector: string, tokens: Record<string, TokenValue>): string {
  const inner = cssBlock(selector, tokens)
  if (!inner) return ''
  const indented = inner.split('\n').map((l) => `  ${l}`).join('\n')
  return `@media ${query} {\n${indented}\n}`
}

function cssHeader(): string {
  return `/**\n * Design tokens — generated by Token Sync\n * Do not edit manually.\n */`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a {light.X} or {dark.X} raw ref to var(--light-X) / var(--dark-X) for the CSS cascade.
 * All other values are returned as-is (resolved hex, dimension, etc.).
 */
function toThemeAwareValue(resolvedValue: string, rawValue: string | undefined): string {
  if (rawValue && /^\{(light|dark)\.[^}]+\}$/.test(rawValue)) {
    // "{light.background.brand}" → "var(--light-background-brand)"
    return `var(${toCSSVar(rawValue.slice(1, -1))})`
  }
  return resolvedValue
}

function toCSSVar(path: string): string {
  return '--' + path.replace(/\./g, '-')
}

function modeBrand(modeName: string): string {
  const parts = modeName.split('/')
  if (parts.length === 1) return 'default'
  return parts[0].toLowerCase().replace(/\s+/g, '-')
}

function modeTheme(modeName: string): string {
  const parts = modeName.split('/')
  return parts[parts.length - 1].toLowerCase()
}

function isPrimitivesCollection(c: ResolvedCollection): boolean {
  return c.collectionName.toLowerCase() === 'primitives'
}

function isGlobalCollection(c: ResolvedCollection): boolean {
  return c.collectionName.toLowerCase() === 'global'
}

function isThemesCollection(c: ResolvedCollection): boolean {
  return c.collectionName.toLowerCase() === 'themes'
}

function isSemanticCollection(c: ResolvedCollection): boolean {
  return !isPrimitivesCollection(c) && !isGlobalCollection(c) && !isThemesCollection(c)
}
