/**
 * Diff logic: compares a resolved GitHub token collection against
 * the current values in a Figma Variable collection/mode.
 */

import type { TokenValue } from "./messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffStatus = "added" | "changed" | "removed" | "unchanged";

export interface DiffEntry {
  path: string;
  type: string;
  status: DiffStatus;
  githubValue: string | null; // resolved value — used for display and comparison
  githubRawValue: string | null; // unresolved value — may contain "{color.blue.200}" refs for Figma aliases
  figmaValue: string | null; // current value in Figma
  description?: string; // $description from the GitHub token, if present
}

export interface CollectionDiff {
  collectionName: string;
  modeName: string;
  entries: DiffEntry[];
  counts: { added: number; changed: number; removed: number; total: number };
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
  rawTokens?: Record<string, TokenValue>,
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const allPaths = new Set([...Object.keys(githubTokens), ...Object.keys(figmaValues)]);

  for (const path of allPaths) {
    const github = githubTokens[path] ?? null;
    const figmaRaw = figmaValues[path] ?? null;

    const githubValue = github?.$value ?? null;
    const githubRawValue = rawTokens?.[path]?.$value ?? githubValue; // falls back to resolved
    const type = github?.$type ?? "unknown";

    const status = deriveStatus(githubValue, figmaRaw, type);
    if (status === "unchanged") continue;

    const description = rawTokens?.[path]?.$description ?? github?.$description;
    entries.push({
      path,
      type,
      status,
      githubValue,
      githubRawValue,
      figmaValue: figmaRaw,
      description,
    });
  }

  return entries.sort(byPathThenStatus);
}

export function buildCollectionDiff(
  collectionName: string,
  modeName: string,
  githubTokens: Record<string, TokenValue>,
  figmaValues: Record<string, string>,
  rawTokens?: Record<string, TokenValue>,
): CollectionDiff {
  const entries = diffTokens(githubTokens, figmaValues, rawTokens);
  const counts = {
    added: entries.filter((e) => e.status === "added").length,
    changed: entries.filter((e) => e.status === "changed").length,
    removed: entries.filter((e) => e.status === "removed").length,
    total: entries.length,
  };
  return { collectionName, modeName, entries, counts };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function deriveStatus(
  githubValue: string | null,
  figmaValue: string | null,
  type: string,
): DiffStatus {
  if (githubValue === null && figmaValue !== null) return "removed";
  if (githubValue !== null && figmaValue === null) return "added";
  if (githubValue === null || figmaValue === null) return "unchanged";

  // Normalise before comparing
  const a = normalise(githubValue, type);
  const b = normalise(figmaValue, type);
  return a === b ? "unchanged" : "changed";
}

/**
 * Normalise a token value for comparison.
 * Hex colours are lowercased. Dimensions strip trailing zeros.
 */
function normalise(value: string, type: string): string {
  if (type === "color") return normaliseColor(value);
  if (type === "dimension") return normaliseDimension(value);
  return value.trim().toLowerCase();
}

function normaliseColor(value: string): string {
  const parsed = parseColorComponents(value);
  if (!parsed) return value.toLowerCase().trim();
  const { r, g, b, a } = parsed;
  if (a >= 0.9999) return `#${toH(r)}${toH(g)}${toH(b)}`;
  // Round alpha to 2 decimal places to absorb float→8-bit→float round-trip drift
  // e.g. rgba(0,0,0,0.90) and #000000e5 (229/255≈0.898) both normalise to rgba(0,0,0,0.9)
  const ar = Math.round(a * 100) / 100;
  return `rgba(${r},${g},${b},${ar})`;
}

function toH(n: number) {
  return n.toString(16).padStart(2, "0");
}

/** Parse any colour string into integer r/g/b (0-255) and float a (0-1). */
function parseColorComponents(
  value: string,
): { r: number; g: number; b: number; a: number } | null {
  // rgba(...) or rgb(...)
  const rgba = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgba) {
    return {
      r: parseInt(rgba[1]),
      g: parseInt(rgba[2]),
      b: parseInt(rgba[3]),
      a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    };
  }
  // #rrggbb or #rrggbbaa
  const clean = value.replace("#", "");
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
      a: 1,
    };
  }
  if (clean.length === 8) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
      a: parseInt(clean.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

function normaliseDimension(value: string): string {
  // "16.00px" → "16px", "1.5rem" stays
  return value.replace(/(\d+)\.0+(px|rem|em)/, "$1$2").trim();
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

function byPathThenStatus(a: DiffEntry, b: DiffEntry): number {
  // Sort: changed first, then added, then removed
  const order: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
  const statusDiff = order[a.status] - order[b.status];
  if (statusDiff !== 0) return statusDiff;
  return a.path.localeCompare(b.path);
}

// ---------------------------------------------------------------------------
// Group entries by first path segment (e.g. "background", "surface", "text")
// ---------------------------------------------------------------------------

export function groupByCategory(entries: DiffEntry[]): Map<string, DiffEntry[]> {
  const map = new Map<string, DiffEntry[]>();
  for (const entry of entries) {
    const category = entry.path.split(".")[0];
    const list = map.get(category) ?? [];
    list.push(entry);
    map.set(category, list);
  }
  return map;
}
