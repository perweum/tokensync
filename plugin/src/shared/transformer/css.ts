/**
 * CSS transformer — generates CSS custom properties.
 *
 * Output structure (Brand + Semantic architecture):
 *   :root { ... }                             ← primitives + global + default brand palette (brand.N vars)
 *   [data-brand="green"] { --brand-N: … }     ← brand palette overrides
 *   [data-color-scheme="light"] { --background-brand: var(--brand-25); … }
 *   [data-color-scheme="dark"]  { … }
 *   [data-color-scheme="auto"] + @media prefers-color-scheme
 *
 * Brand-coloured semantic tokens emit var(--brand-N) so switching [data-brand] on any
 * ancestor automatically cascades through all semantic tokens without extra selectors.
 */

import type { ResolvedCollection } from '../token-merger'
import type { TokenValue } from '../messages'

export function generateCSS(collections: ResolvedCollection[]): string {
  const blocks: string[] = [cssHeader()]

  const primitives   = collections.find((c) => isPrimitivesCollection(c))
  const global       = collections.find((c) => isGlobalCollection(c))
  const brandCols    = collections.filter((c) => isBrandCollection(c))
  const semanticCols = collections.filter((c) => isSemanticCollection(c))

  // :root — primitives, global, and the default brand's palette vars
  const defaultBrand = brandCols.find((c) => c.modeName.toLowerCase() === 'default')
  const rootTokens: Record<string, TokenValue> = {
    ...(primitives?.tokens ?? {}),
    ...(global?.tokens ?? {}),
    ...(defaultBrand?.rawTokens ?? {}),  // brand.N = {color.X.N} → resolved hex via cascade
  }
  if (Object.keys(rootTokens).length > 0) {
    blocks.push(cssBlock(':root', rootTokens))
  }

  // Non-default brand overrides — only the brand.N vars need to change
  for (const col of brandCols) {
    if (col.modeName.toLowerCase() === 'default') continue
    const brandSlug = col.modeName.toLowerCase().replace(/\s+/g, '-')
    blocks.push(cssBlock(`[data-brand="${brandSlug}"]`, col.rawTokens))
  }

  // Semantic: Light / Dark modes — emit var(--brand-N) for brand-coloured tokens
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

  // Legacy N×M brand×theme modes (backward compat if old-style modes are present)
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
 * Semantic block: emits var(--brand-N) for {brand.N} raw values so brand switching
 * cascades automatically, and resolved hex for all other tokens.
 */
function semanticBlock(selector: string, col: ResolvedCollection): string {
  const entries = Object.entries(col.tokens).filter(([, t]) => t.$type !== 'boolean')
  if (entries.length === 0) return ''

  const lines = entries.map(([path, token]) => {
    const varName = toCSSVar(path)
    const rawValue = col.rawTokens[path]?.$value
    const value = toBrandAwareValue(token.$value, rawValue)
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

/** Convert a {brand.N} raw value to var(--brand-N) for CSS cascade, or return the resolved hex. */
function toBrandAwareValue(resolvedValue: string, rawValue: string | undefined): string {
  if (rawValue && /^\{brand\.\d+\}$/.test(rawValue)) {
    return `var(${toCSSVar(rawValue.slice(1, -1))})`  // "{brand.600}" → "var(--brand-600)"
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

function isBrandCollection(c: ResolvedCollection): boolean {
  return c.collectionName.toLowerCase() === 'brand'
}

function isSemanticCollection(c: ResolvedCollection): boolean {
  return !isPrimitivesCollection(c) && !isGlobalCollection(c) && !isBrandCollection(c)
}
