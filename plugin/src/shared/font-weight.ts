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

// ---------------------------------------------------------------------------
// Font style names -> weight + width + italic
// ---------------------------------------------------------------------------

/**
 * Width words and the CSS `font-stretch` percentage each means by default.
 * "standard" is the upright-width default (100%), so it carries no stretch of
 * its own. A project whose @font-face `font-stretch` ranges differ overrides
 * these through metadata.json's `fontStretchKeywords`.
 */
const DEFAULT_STRETCH_KEYWORDS: Record<string, string> = {
  compressed: "62.5%",
  condensed: "75%",
  standard: "100%",
  extended: "112.5%",
  expanded: "125%",
};

export interface FontStyleOverride {
  weight?: number;
  /** A CSS font-stretch value, e.g. "125%". */
  stretch?: string;
  style?: "normal" | "italic";
}

/** The two optional metadata.json maps that adjust how style names are read. */
export interface FontStyleOverrides {
  /** Exact style name -> what it means, for names the parser can't read. */
  fontStyles?: Record<string, FontStyleOverride>;
  /** Width word -> font-stretch percentage, replacing the defaults above. */
  stretchKeywords?: Record<string, string>;
}

export interface ParsedFontStyle {
  weight: number;
  /** CSS font-stretch (e.g. "125%"), or null for the default (standard) width. */
  stretch: string | null;
  style: "normal" | "italic";
  /** False when some part of the name wasn't understood — weight then falls
   * back to DEFAULT_FONT_WEIGHT and the caller should warn. */
  recognized: boolean;
}

const UNRECOGNIZED: ParsedFontStyle = {
  weight: DEFAULT_FONT_WEIGHT,
  stretch: null,
  style: "normal",
  recognized: false,
};

/** "100%" is the default width — represented as null so callers can skip it. */
function stretchOrNull(stretch: string): string | null {
  return stretch.trim() === "100%" ? null : stretch.trim();
}

function lookupOverride(
  name: string,
  fontStyles: Record<string, FontStyleOverride> | undefined,
): FontStyleOverride | undefined {
  if (!fontStyles) return undefined;
  if (fontStyles[name]) return fontStyles[name];
  const key = normalizeFontWeightKey(name);
  for (const [candidate, value] of Object.entries(fontStyles)) {
    if (normalizeFontWeightKey(candidate) === key) return value;
  }
  return undefined;
}

/**
 * Splits a Figma font style name — "Expanded Medium Italic" — into the three
 * CSS axes it carries: `font-weight`, `font-stretch` and `font-style`. Figma
 * stores all three in one string; CSS needs them separately, and reading only
 * the weight (as this used to) silently dropped width and italic.
 *
 * Case-, spacing- and punctuation-insensitive ("SemiBold", "Semi Bold" and
 * "semi-bold" are the same). The name is read as a run of known words, longest
 * first, so a multi-word weight ("Ultra Light") and a run-together one
 * ("ExpandedSemiBold") both parse. Any word it doesn't know makes the whole
 * name unrecognised — it never throws and never guesses.
 *
 * `overrides` (from metadata.json) win over the parser: an exact `fontStyles`
 * entry fills in whatever it lists, and `stretchKeywords` replaces the default
 * width percentages.
 */
export function parseFontStyleName(name: string, overrides?: FontStyleOverrides): ParsedFontStyle {
  const base = parseWithoutOverrides(name.trim(), overrides?.stretchKeywords);
  const explicit = lookupOverride(name.trim(), overrides?.fontStyles);
  if (!explicit) return base;
  return {
    weight: explicit.weight ?? base.weight,
    stretch: explicit.stretch !== undefined ? stretchOrNull(explicit.stretch) : base.stretch,
    style: explicit.style ?? base.style,
    recognized: true,
  };
}

function parseWithoutOverrides(
  name: string,
  stretchKeywords: Record<string, string> | undefined,
): ParsedFontStyle {
  if (!name) return UNRECOGNIZED;

  // A bare number is a weight on its own.
  if (/^\d+(\.\d+)?$/.test(name)) {
    const n = Number(name);
    return n >= 1 && n <= 1000
      ? { weight: n, stretch: null, style: "normal", recognized: true }
      : UNRECOGNIZED;
  }

  const widths = new Map<string, string>(Object.entries(DEFAULT_STRETCH_KEYWORDS));
  for (const [word, percent] of Object.entries(stretchKeywords ?? {})) {
    widths.set(normalizeFontWeightKey(word), percent);
  }
  const vocabulary = [
    ...Object.keys(ALIASES).map((w) => ({ word: w, kind: "weight" as const })),
    ...[...widths.keys()].map((w) => ({ word: w, kind: "width" as const })),
    { word: "italic", kind: "italic" as const },
    { word: "oblique", kind: "italic" as const },
  ].sort((a, b) => b.word.length - a.word.length);

  const key = normalizeFontWeightKey(name);
  let weight: number | null = null;
  let stretch: string | null = null;
  let style: "normal" | "italic" = "normal";

  let pos = 0;
  while (pos < key.length) {
    const digits = /^\d+/.exec(key.slice(pos));
    if (digits) {
      const n = Number(digits[0]);
      if (n < 1 || n > 1000) return UNRECOGNIZED;
      weight ??= n;
      pos += digits[0].length;
      continue;
    }
    const hit = vocabulary.find((v) => key.startsWith(v.word, pos));
    if (!hit) return UNRECOGNIZED;
    if (hit.kind === "weight") weight ??= ALIASES[hit.word];
    else if (hit.kind === "width") stretch ??= stretchOrNull(widths.get(hit.word)!);
    else style = "italic";
    pos += hit.word.length;
  }

  return { weight: weight ?? DEFAULT_FONT_WEIGHT, stretch, style, recognized: true };
}

/**
 * Resolve a fontWeight token value ("SemiBold", "600", "Semi Bold",
 * "Expanded Medium") to a numeric OpenType weight. Returns null when some part
 * of the name isn't understood — it's a font-specific style name (e.g.
 * "Text") with no defined numeric equivalent. Width and italic are ignored
 * here; parseFontStyleName returns them too.
 */
export function resolveFontWeightNumber(
  value: string,
  overrides?: FontStyleOverrides,
): number | null {
  const parsed = parseFontStyleName(value, overrides);
  return parsed.recognized ? parsed.weight : null;
}
