/**
 * DTCG fontWeight aliases → canonical numeric weight (1-1000, OpenType `wght`).
 * https://www.designtokens.org/tr/drafts/format/ — "Font Weight"
 *
 * Figma font style names rarely match this vocabulary's exact spelling
 * (PascalCase, spaces, font-specific names like "Text") even when they mean
 * the same weight — lookups are normalized (case/punctuation-insensitive)
 * rather than exact-matched, and callers decide the fallback when nothing
 * resolves, so a custom style name never fails a build.
 */

const ALIASES: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  extrablack: 950,
  ultrablack: 950,
};

/** DTCG default when a weight can't be resolved — matches the "normal"/"regular" alias. */
export const DEFAULT_FONT_WEIGHT = 400;

/** "Semi-Bold", "SemiBold", "Semi Bold" all normalize to "semibold". */
function normalizeFontWeightKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a fontWeight token value ("SemiBold", "600", "Semi Bold") to a
 * numeric OpenType weight. Returns null when it's neither a known alias nor
 * a valid number in [1, 1000] — the value is a font-specific style name
 * (e.g. "Text", "Black Italic") with no defined numeric equivalent.
 */
export function resolveFontWeightNumber(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 1 && n <= 1000 ? n : null;
  }
  const key = normalizeFontWeightKey(trimmed);
  return ALIASES[key] ?? null;
}
