/**
 * Diff logic: compares a resolved GitHub token collection against
 * the current values in a Figma Variable collection/mode.
 */

import type { TokenValue } from './messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffStatus = 'added' | 'changed' | 'removed' | 'unchanged'

export interface DiffEntry {
  path: string
  type: string
  status: DiffStatus
  githubValue: string | null   // resolved value from GitHub token files
  figmaValue: string | null    // current resolved value in Figma
}

export interface CollectionDiff {
  collectionName: string
  modeName: string
  entries: DiffEntry[]
  counts: { added: number; changed: number; removed: number; total: number }
}

// ---------------------------------------------------------------------------
// Main diff function
// ---------------------------------------------------------------------------

/**
 * Produces a diff between GitHub tokens and Figma variable values.
 *
 * @param githubTokens  Flat resolved token map from parseRepository()
 * @param figmaValues   Flat resolved variable map: variable name (dot-notation) → raw value string
 */
export function diffTokens(
  githubTokens: Record<string, TokenValue>,
  figmaValues: Record<string, string>,
): DiffEntry[] {
  const entries: DiffEntry[] = []
  const allPaths = new Set([...Object.keys(githubTokens), ...Object.keys(figmaValues)])

  for (const path of allPaths) {
    const github = githubTokens[path] ?? null
    const figmaRaw = figmaValues[path] ?? null

    const githubValue = github?.$value ?? null
    const type = github?.$type ?? 'unknown'

    const status = deriveStatus(githubValue, figmaRaw, type)
    if (status === 'unchanged') continue

    entries.push({ path, type, status, githubValue, figmaValue: figmaRaw })
  }

  return entries.sort(byPathThenStatus)
}

export function buildCollectionDiff(
  collectionName: string,
  modeName: string,
  githubTokens: Record<string, TokenValue>,
  figmaValues: Record<string, string>,
): CollectionDiff {
  const entries = diffTokens(githubTokens, figmaValues)
  const counts = {
    added:   entries.filter((e) => e.status === 'added').length,
    changed: entries.filter((e) => e.status === 'changed').length,
    removed: entries.filter((e) => e.status === 'removed').length,
    total:   entries.length,
  }
  return { collectionName, modeName, entries, counts }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function deriveStatus(
  githubValue: string | null,
  figmaValue: string | null,
  type: string,
): DiffStatus {
  if (githubValue === null && figmaValue !== null) return 'removed'
  if (githubValue !== null && figmaValue === null) return 'added'
  if (githubValue === null || figmaValue === null) return 'unchanged'

  // Normalise before comparing
  const a = normalise(githubValue, type)
  const b = normalise(figmaValue, type)
  return a === b ? 'unchanged' : 'changed'
}

/**
 * Normalise a token value for comparison.
 * Hex colours are lowercased. Dimensions strip trailing zeros.
 */
function normalise(value: string, type: string): string {
  if (type === 'color') return normaliseColor(value)
  if (type === 'dimension') return normaliseDimension(value)
  return value.trim().toLowerCase()
}

function normaliseColor(value: string): string {
  // Convert rgba(255,255,255,1) → #ffffff
  const rgba = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/)
  if (rgba) {
    const r = parseInt(rgba[1]).toString(16).padStart(2, '0')
    const g = parseInt(rgba[2]).toString(16).padStart(2, '0')
    const b = parseInt(rgba[3]).toString(16).padStart(2, '0')
    const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1
    if (a === 1) return `#${r}${g}${b}`
    const ah = Math.round(a * 255).toString(16).padStart(2, '0')
    return `#${r}${g}${b}${ah}`
  }
  return value.toLowerCase().trim()
}

function normaliseDimension(value: string): string {
  // "16.00px" → "16px", "1.5rem" stays
  return value.replace(/(\d+)\.0+(px|rem|em)/, '$1$2').trim()
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

function byPathThenStatus(a: DiffEntry, b: DiffEntry): number {
  // Sort: changed first, then added, then removed
  const order: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 }
  const statusDiff = order[a.status] - order[b.status]
  if (statusDiff !== 0) return statusDiff
  return a.path.localeCompare(b.path)
}

// ---------------------------------------------------------------------------
// Group entries by first path segment (e.g. "background", "surface", "text")
// ---------------------------------------------------------------------------

export function groupByCategory(entries: DiffEntry[]): Map<string, DiffEntry[]> {
  const map = new Map<string, DiffEntry[]>()
  for (const entry of entries) {
    const category = entry.path.split('.')[0]
    const list = map.get(category) ?? []
    list.push(entry)
    map.set(category, list)
  }
  return map
}
